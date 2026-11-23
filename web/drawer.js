const byId = (id) => document.getElementById(id);
const filter = byId("drawer-filter");
const dateInput = filter.elements.namedItem("date");
const content = byId("drawer-content");
const actionForms = {
  open: byId("drawer-open"),
  movements: byId("drawer-movement"),
  close: byId("drawer-close"),
};
const storageKey = "pos-pending-drawer";
const cash = new Intl.NumberFormat("th-TH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dates = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium", timeZone: "Asia/Bangkok",
});
const timestamps = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok",
});
const labels = [
  ["sales_cash", "เงินสดจากการขาย"],
  ["sale_corrections_cash", "ผลต่างเงินสดจากการแก้ไขหรือยกเลิกบิล"],
  ["repayments_cash", "รับชำระหนี้เป็นเงินสด"],
  ["added_cash", "เติมเงินสด"],
  ["withdrawn_cash", "ถอนเงินสด"],
  ["expenses_cash", "ค่าใช้จ่ายจากลิ้นชัก"],
  ["refunds_cash", "คืนเงินสดจากยอดชำระหนี้เกิน"],
];
const unavailable = "—";
let state;
let activeRequest;
let storeId = null;
let pendingProblem = false;
let pendingRawAvailable = false;
let pending = restorePending();
let pendingStored = true;
let saving = false;
let drawerQueueRequest = 0;

async function inspectDrawerQueue() {
  const request = ++drawerQueueRequest;
  const expectedStore = storeId;
  const output = byId("drawer-queue-status");
  output.textContent = "กำลังตรวจรายการขายค้างในเบราว์เซอร์นี้";
  try {
    if (!expectedStore || !window.PosOffline) throw new Error("Unavailable");
    const snapshot = await Promise.race([
      window.PosOffline.exportQueue(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000)),
    ]);
    if (request !== drawerQueueRequest || expectedStore !== storeId) return;
    if (!snapshot || !Array.isArray(snapshot.entries)
      || snapshot.entries.some((entry) => !entry || !["pending", "conflict"].includes(entry.state))) throw new Error("Invalid queue");
    if (snapshot.storeId !== expectedStore) {
      output.textContent = "ยืนยันคิวของร้านปัจจุบันในเบราว์เซอร์นี้ไม่ได้ กรุณาไปตรวจที่หน้าขาย";
    } else if (snapshot.entries.length) {
      output.textContent = "ขณะตรวจพบรายการขายที่รอซิงก์หรือตรวจสอบในเบราว์เซอร์นี้ " + snapshot.entries.length + " รายการ กรุณาตรวจที่หน้าขายก่อนปิด";
    } else {
      output.textContent = "ขณะตรวจไม่พบรายการขายค้างในเบราว์เซอร์นี้";
    }
  } catch (_) {
    if (request === drawerQueueRequest) output.textContent = "ตรวจรายการขายค้างในเบราว์เซอร์นี้ไม่ได้ กรุณาไปตรวจที่หน้าขาย";
  }
}

function bangkokToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Bangkok",
  }).formatToParts();
  const day = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return [day.year, day.month, day.day].join("-");
}

function businessDate(value) {
  return dates.format(new Date(value + "T00:00:00+07:00"));
}

function money(value) {
  return value == null ? unavailable : cash.format(value) + " บาท";
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function restorePending() {
  let raw;
  try {
    raw = sessionStorage.getItem(storageKey);
  } catch {
    pendingProblem = true;
    return null;
  }
  if (raw === null) return null;
  pendingRawAvailable = true;
  try {
    const saved = JSON.parse(raw);
    if (validPending(saved)) return saved;
  } catch { /* Keep raw data for manual recovery. */ }
  pendingProblem = true;
  return null;
}

function validPending(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved) || !Object.hasOwn(actionForms, saved.action)) return false;
  const payload = saved.payload;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof saved.binding_id !== "string" || !uuid.test(saved.binding_id)
      || !payload || typeof payload !== "object" || Array.isArray(payload)
      || typeof payload.id !== "string" || !uuid.test(payload.id)
      || typeof payload.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)
      || payload.date.startsWith("0000-")) return false;
  const day = new Date(payload.date + "T00:00:00Z");
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== payload.date) return false;
  const amount = (value, { positive = false, signed = false, max = 1000000000n } = {}) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && !signed) value = String(value);
    if (typeof value !== "string" || value.length > 60) return false;
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(value.trim());
    if (!match) return false;
    const fraction = match[3] ?? match[4] ?? "";
    const exponent = Number(match[5] || 0) - fraction.length;
    if (!Number.isSafeInteger(exponent) || exponent < -2) return false;
    const digits = BigInt((match[2] || "0") + fraction);
    if (digits === 0n) return !positive;
    if ((match[1] === "-" && !signed) || exponent > 30) return false;
    const scaled = digits * 10n ** BigInt(exponent + 2);
    return (!positive || scaled > 0n) && scaled <= max * 100n;
  };
  if (saved.action === "open") return amount(payload.opening_cash);
  if (saved.action === "movements") return ["in", "out"].includes(payload.direction) && amount(payload.amount, { positive: true })
    && typeof payload.reason === "string" && payload.reason.trim().length > 0 && Array.from(payload.reason.trim()).length <= 300;
  return amount(payload.actual_cash) && amount(payload.expected_cash, { signed: true, max: 10n ** 25n });
}

function setPending(value) {
  if (pendingProblem) return;
  pending = value;
  pendingStored = true;
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  } catch {
    pendingStored = !value;
  }
  updateControls();
}

function updateControls() {
  const mismatch = Boolean(pending && (!storeId || pending.binding_id !== storeId));
  const blocked = saving || Boolean(pending) || pendingProblem || !storeId;
  byId("drawer-pending").hidden = !pending;
  byId("drawer-storage-warning").hidden = !pending || pendingStored;
  byId("drawer-retry").disabled = saving || !storeId || mismatch;
  byId("drawer-restore-error").hidden = !pendingProblem && !mismatch;
  byId("drawer-restore-export").hidden = !(pendingProblem && pendingRawAvailable) && !mismatch;
  byId("drawer-pending-date").textContent = pending ? businessDate(pending.payload.date) : "";
  for (const form of Object.values(actionForms)) form.querySelector("fieldset").disabled = blocked;
}

function message(text, error = false) {
  const node = byId("drawer-message");
  node.textContent = text;
  node.hidden = !text;
  node.classList.toggle("error", error);
}

function metric(title, value) {
  const group = document.createElement("div");
  group.append(element("dt", title), element("dd", money(value)));
  return group;
}

function row(label, amount, detail) {
  const item = document.createElement("li");
  const title = element("span", label);
  if (detail) title.append(element("small", detail));
  item.append(title, element("strong", money(amount)));
  return item;
}

function render(next) {
  state = next;
  content.hidden = false;
  const closed = next.status === "closed";
  const open = next.status === "open";
  const stateLabel = closed ? "ปิดลิ้นชักแล้ว" : open ? "เปิดลิ้นชักแล้ว" : "ยังไม่ได้เปิดลิ้นชัก";
  const timestamp = closed ? next.closed_at : next.opened_at;
  byId("drawer-state").textContent = stateLabel + (timestamp ? " · " + timestamps.format(new Date(timestamp)) : "");
  const metrics = [metric("เงินทอนตั้งต้น", next.opening_cash)];
  if (closed) {
    metrics.push(
      metric("ยอดที่ควรมีตอนปิด", next.closed_expected_cash),
      metric("เงินสดที่นับได้ตอนปิด", next.actual_cash),
      metric("ผลต่างตอนปิด (นับได้ − ยอดที่ควรมี)", next.variance),
    );
  }
  metrics.push(metric("ยอดที่ควรมีตามข้อมูลล่าสุด", next.expected_cash));
  byId("drawer-summary").replaceChildren(...metrics);
  const late = byId("drawer-late");
  late.hidden = !closed || Number(next.late_difference) === 0;
  late.textContent = late.hidden ? "" : "ยอดตามระบบเปลี่ยนหลังปิดลิ้นชัก " + money(next.late_difference) + " ยอดตรวจนับตอนปิดยังอ้างอิงข้อมูลขณะปิด";
  byId("drawer-breakdown").replaceChildren(
    ...labels.map(([key, label]) => row(label, next.breakdown[key])),
  );
  byId("drawer-movements").replaceChildren(
    ...next.movements.map((entry) => row(
      (entry.direction === "in" ? "เติม · " : "ถอน · ") + entry.reason,
      entry.amount,
      timestamps.format(new Date(entry.created_at)),
    )),
  );
  byId("drawer-movement-empty").hidden = next.movements.length > 0;
  byId("drawer-actions").hidden = closed;
  actionForms.open.hidden = open || closed;
  actionForms.movements.hidden = actionForms.close.hidden = !open;
  byId("drawer-close-ack").checked = false;
  if (open) inspectDrawerQueue();
  byId("drawer-close-expected").textContent = "ยอดที่ควรมี " + money(next.expected_cash);
  updateControls();
}

async function loadDrawer() {
  activeRequest?.abort();
  const day = dateInput.value;
  const loadStatus = byId("drawer-load-status");
  content.hidden = true;
  state = undefined;
  storeId = null;
  updateControls();
  if (!day) {
    loadStatus.textContent = "กรุณาเลือกวันที่";
    return;
  }
  const request = new AbortController();
  activeRequest = request;
  loadStatus.textContent = "กำลังโหลดยอดเงินสด…";
  try {
    const identity = async () => {
      const response = await fetch("/store-identity", { signal: request.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Store unavailable");
      const binding = (await response.json()).binding_id;
      if (typeof binding !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding)) throw new Error("Store unavailable");
      return binding;
    };
    const before = await identity();
    const query = new URLSearchParams({ date: day });
    const response = await fetch("/cash-drawer?" + query, { signal: request.signal });
    if (!response.ok) throw new Error("Drawer unavailable");
    const data = await response.json();
    const after = await identity();
    if (before !== after) throw new Error("Store changed");
    if (request.signal.aborted || dateInput.value !== day) return;
    storeId = after;
    loadStatus.textContent = "";
    render(data);
  } catch {
    if (!request.signal.aborted && dateInput.value === day) {
      loadStatus.textContent = "โหลดข้อมูลไม่สำเร็จ กรุณากดแสดงยอดล่าสุดอีกครั้ง";
    }
  }
}

async function submitPending() {
  if (!pending || saving || pendingProblem || !storeId || pending.binding_id !== storeId) return;
  const attempt = pending;
  saving = true;
  updateControls();
  message("");
  try {
    const response = await fetch("/cash-drawer/" + attempt.action, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-POS-Store-ID": attempt.binding_id },
      body: JSON.stringify(attempt.payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
        const failure = await response.json().catch(() => ({}));
        if (failure.code === "store_mismatch" || (response.status === 409 && !failure.code)) {
          storeId = null;
          message("ฐานข้อมูลเปลี่ยนหรือยืนยันไม่ได้ คำขอเดิมยังอยู่ กรุณาตรวจสอบก่อนส่ง", true);
          return;
        }
        setPending(null);
        if (failure.code === "drawer_changed") {
          message("ยอดที่ควรมีเปลี่ยนแล้ว กรุณาตรวจยอดล่าสุดและยืนยันปิดลิ้นชักอีกครั้ง", true);
          await loadDrawer();
        } else if (response.status === 409 || response.status === 404) {
          message("สถานะลิ้นชักเปลี่ยนแล้ว กรุณาตรวจยอดล่าสุดก่อนบันทึกใหม่", true);
          await loadDrawer();
        } else {
          message("บันทึกไม่สำเร็จ กรุณาตรวจสอบข้อมูลที่กรอก", true);
        }
      } else {
        message("ยังไม่ทราบผลการบันทึก กรุณาส่งคำขอเดิมอีกครั้ง", true);
      }
      return;
    }

    const next = await response.json();
    setPending(null);
    actionForms[attempt.action].reset();
    if (dateInput.value === next.date) {
      activeRequest?.abort();
      byId("drawer-load-status").textContent = "";
      render(next);
    }
    const notices = { open: "เปิดลิ้นชักแล้ว", movements: "บันทึกรายการเงินสดแล้ว", close: "บันทึกยอดและปิดลิ้นชักแล้ว" };
    message(notices[attempt.action]);
  } catch {
    message("ยังไม่ทราบผลการบันทึก กรุณาส่งคำขอเดิมอีกครั้ง", true);
  } finally {
    saving = false;
    updateControls();
  }
}

for (const [action, form] of Object.entries(actionForms)) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state || !storeId || state.date !== dateInput.value || saving || pending || pendingProblem) return;
    const fields = Object.fromEntries(new FormData(form));
    if (action === "movements") {
      fields.reason = fields.reason.trim();
      if (!fields.reason) {
        message("กรุณาระบุเหตุผลที่เติมหรือถอนเงิน", true);
        return;
      }
    }
    if (action === "close") fields.expected_cash = state.expected_cash;
    setPending({ action, binding_id: storeId, payload: { id: crypto.randomUUID(), date: state.date, ...fields } });
    submitPending();
  });
}

filter.addEventListener("submit", (event) => {
  event.preventDefault();
  loadDrawer();
});
dateInput.addEventListener("change", () => {
  for (const form of Object.values(actionForms)) form.reset();
  message("");
  loadDrawer();
});
byId("drawer-retry").addEventListener("click", submitPending);
byId("drawer-queue-refresh").addEventListener("click", inspectDrawerQueue);
byId("drawer-restore-export").addEventListener("click", () => {
  try {
    const raw = pending && !pendingStored ? JSON.stringify(pending) : sessionStorage.getItem(storageKey);
    if (raw === null) throw new Error("Request unavailable");
    const url = URL.createObjectURL(new Blob([JSON.stringify(raw)], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "pos-drawer-raw.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { message("ดาวน์โหลดข้อมูลเดิมไม่ได้ กรุณาอย่าปิดแท็บและติดต่อผู้ดูแล", true); }
});
dateInput.value = pending?.payload.date || bangkokToday();
updateControls();
loadDrawer();

window.addEventListener("beforeunload", (event) => {
  if (pending || pendingProblem) {
    event.preventDefault();
    event.returnValue = "";
  }
});
