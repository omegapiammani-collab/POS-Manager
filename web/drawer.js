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
let pending = restorePending();
let pendingStored = true;
let saving = false;

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
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    return saved && Object.hasOwn(actionForms, saved.action) && saved.payload?.id ? saved : null;
  } catch {
    return null;
  }
}

function setPending(value) {
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
  const blocked = saving || Boolean(pending);
  byId("drawer-pending").hidden = !pending;
  byId("drawer-storage-warning").hidden = !pending || pendingStored;
  byId("drawer-retry").disabled = saving;
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
  byId("drawer-close-expected").textContent = "ยอดที่ควรมี " + money(next.expected_cash);
  updateControls();
}

async function loadDrawer() {
  activeRequest?.abort();
  const day = dateInput.value;
  const loadStatus = byId("drawer-load-status");
  content.hidden = true;
  state = undefined;
  if (!day) {
    loadStatus.textContent = "กรุณาเลือกวันที่";
    return;
  }
  const request = new AbortController();
  activeRequest = request;
  loadStatus.textContent = "กำลังโหลดยอดเงินสด…";
  try {
    const query = new URLSearchParams({ date: day });
    const response = await fetch("/cash-drawer?" + query, { signal: request.signal });
    if (!response.ok) throw new Error("Drawer unavailable");
    const data = await response.json();
    if (request.signal.aborted || dateInput.value !== day) return;
    loadStatus.textContent = "";
    render(data);
  } catch {
    if (!request.signal.aborted && dateInput.value === day) {
      loadStatus.textContent = "โหลดข้อมูลไม่สำเร็จ กรุณากดแสดงยอดล่าสุดอีกครั้ง";
    }
  }
}

async function submitPending() {
  if (!pending || saving) return;
  const attempt = pending;
  saving = true;
  updateControls();
  message("");
  try {
    const response = await fetch("/cash-drawer/" + attempt.action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attempt.payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
        const failure = await response.json().catch(() => ({}));
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
    if (!state || state.date !== dateInput.value || saving || pending) return;
    const fields = Object.fromEntries(new FormData(form));
    if (action === "movements") {
      fields.reason = fields.reason.trim();
      if (!fields.reason) {
        message("กรุณาระบุเหตุผลที่เติมหรือถอนเงิน", true);
        return;
      }
    }
    if (action === "close") fields.expected_cash = state.expected_cash;
    setPending({ action, payload: { id: crypto.randomUUID(), date: state.date, ...fields } });
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
dateInput.value = pending?.payload.date || bangkokToday();
updateControls();
loadDrawer();

window.addEventListener("beforeunload", (event) => {
  if (pending) {
    event.preventDefault();
    event.returnValue = "";
  }
});
