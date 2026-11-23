const byId = (id) => document.getElementById(id);
const form = byId("debt-repayment");
const fields = form.elements;
const storageKey = "pos-pending-repayment";
const numberFormat = new Intl.NumberFormat("th-TH");
const dateFormat = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Bangkok",
});
let customers = [];
let customersLoaded = false;
let pendingProblem = false;
let pendingRawAvailable = false;
let pending = restorePending();
let pendingStored = true;
let selectedId = pending?.customerId ?? null;
let selectedDebt = null;
let detailRequest = 0;
let sending = false;
let storeId = null;
let storeMismatch = false;
let listRequest = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function satang(value) {
  const match = /^(\d*)(?:\.(\d{0,2}))?$/.exec(String(value).trim());
  if (!match || !(match[1] || match[2])) return null;
  return BigInt(match[1] || "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

function decimalAmount(cents) {
  return String(cents / 100n) + "." + String(cents % 100n).padStart(2, "0");
}

function money(value) {
  const cents = satang(value);
  if (cents === null) return "—";
  const [whole, fraction] = decimalAmount(cents).split(".");
  return numberFormat.format(BigInt(whole)) + "." + fraction + " บาท";
}

function dateText(value) {
  // SQLite CURRENT_TIMESTAMP is UTC, but has no timezone suffix.
  const utcValue = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(" ", "T") + "Z" : value;
  const date = new Date(utcValue);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}

function message(text, error = false) {
  const node = byId("debt-message");
  node.textContent = text;
  node.classList.toggle("error", error);
  node.hidden = !text;
}

async function api(path, data, binding = storeId) {
  const options = { signal: AbortSignal.timeout(15000), redirect: "manual", headers: {} };
  if (binding) options.headers["X-POS-Store-ID"] = binding;
  if (data !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(data);
  }
  const response = await fetch(path, options);
  const unconfirmed = () => Object.assign(new Error("Server response unconfirmed"), { code: "access_unconfirmed" });
  if (response.redirected || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw unconfirmed();
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") throw unconfirmed();
  let result;
  try { result = await response.json(); } catch { throw unconfirmed(); }
  if (response.ok) return result;
  if (!result || typeof result !== "object") throw unconfirmed();
  const error = new Error("Request failed");
  error.status = response.status;
  error.code = result.code;
  if ((response.status === 401 || response.status === 403) && error.code !== "store_mismatch") throw unconfirmed();
  throw error;
}

function renderCustomers() {
  const query = byId("debt-search").value.trim().toLowerCase();
  const onlyOutstanding = byId("debt-only-outstanding").checked;
  const matches = customers.filter((customer) => customer.name.toLowerCase().includes(query)
    && (!onlyOutstanding || satang(customer.outstanding) > 0n));
  byId("debt-customers").replaceChildren(...matches.map((customer) => {
    const row = element("li");
    const button = element("button");
    button.type = "button";
    button.disabled = Boolean(pending) || sending || storeMismatch || !storeId;
    button.setAttribute("aria-pressed", String(customer.id === selectedId));
    button.append(element("span", customer.name), element("span", money(customer.outstanding)));
    button.addEventListener("click", () => {
      if (customer.id === selectedId && selectedDebt) return;
      form.reset();
      message("");
      selectedId = customer.id;
      for (const other of byId("debt-customers").querySelectorAll("button")) {
        other.setAttribute("aria-pressed", String(other === button));
      }
      loadDetail();
    });
    row.append(button);
    return row;
  }));
  const state = byId("debt-customers-state");
  if (customersLoaded) state.textContent = query || onlyOutstanding ? "ไม่พบลูกค้าที่ตรงกับตัวกรอง" : "ยังไม่มีลูกค้า";
  state.hidden = matches.length > 0;
}

function recordHeading(label, amount) {
  const heading = element("div", undefined, "debt-record-heading");
  heading.append(element("strong", label), element("span", money(amount)));
  return heading;
}

function renderDetail(debt) {
  byId("debt-detail-title").textContent = debt.name;
  byId("debt-detail-state").hidden = true;
  byId("debt-detail").hidden = false;
  byId("debt-outstanding").textContent = money(debt.outstanding);
  form.hidden = !(satang(debt.outstanding) > 0n);
  byId("debt-bills").replaceChildren(...(debt.bills.length ? debt.bills.map((bill) => {
    const row = element("li");
    row.append(
      recordHeading("ค้างชำระ", bill.outstanding),
      element("small", dateText(bill.sold_at ?? bill.created_at) + " · บิล " + bill.id),
      element("small", "ยอดเชื่อ " + money(bill.credit) + " · ชำระแล้ว " + money(bill.paid))
    );
    return row;
  }) : [element("li", "ยังไม่มีบิลเงินเชื่อ", "muted")]));
  byId("debt-history").replaceChildren(...(debt.repayments.length ? debt.repayments.map((repayment) => {
    const row = element("li");
    row.append(
      recordHeading(repayment.method === "qr" ? "โอนผ่าน QR" : "เงินสด", repayment.amount),
      element("small", dateText(repayment.created_at))
    );
    if (repayment.note) row.append(element("small", "หมายเหตุ " + repayment.note));
    const allocations = element("ul", undefined, "debt-allocations");
    for (const allocation of repayment.allocations) {
      allocations.append(element("li", "บิล " + allocation.sale_id + " · " + money(allocation.amount)));
    }
    row.append(allocations);
    return row;
  }) : [element("li", "ยังไม่มีประวัติรับชำระ", "muted")]));
  updateForm();
}

function updateForm() {
  const isQr = fields.method.value === "qr";
  byId("debt-qr-check").hidden = !isQr;
  const amount = satang(fields.amount.value);
  const outstanding = satang(selectedDebt?.outstanding);
  const balance = byId("debt-form-state");
  if (!fields.amount.value.trim()) balance.textContent = "";
  else if (amount === null || amount === 0n) balance.textContent = "กรอกยอดมากกว่า 0 บาท ทศนิยมไม่เกิน 2 ตำแหน่ง";
  else if (outstanding !== null && amount > outstanding) balance.textContent = "ยอดชำระสูงกว่ายอดค้าง";
  else balance.textContent = "";
  byId("debt-submit").disabled = !amount || outstanding === null || amount > outstanding
    || (isQr && !fields.confirmed.checked) || Boolean(pending) || sending || pendingProblem || storeMismatch || !storeId;
}

async function loadCustomers() {
  if (!storeId || storeMismatch) return;
  const request = ++listRequest;
  byId("debt-summary").hidden = true;
  try {
    const result = await api("/customer-debts");
    if (request !== listRequest || storeMismatch) return;
    if (!Array.isArray(result) || result.some((customer) => !customer || typeof customer.name !== "string"
      || typeof customer.id !== "string" || typeof customer.outstanding !== "string" || satang(customer.outstanding) === null)) {
      throw new Error("Invalid customer balances");
    }
    customers = result;
    customersLoaded = true;
    const amounts = customers.map((customer) => satang(customer.outstanding));
    byId("debt-total").textContent = money(decimalAmount(amounts.reduce((sum, value) => sum + value, 0n)));
    byId("debt-count").textContent = numberFormat.format(amounts.filter((value) => value > 0n).length) + " คน";
    byId("debt-summary").hidden = false;
    renderCustomers();
  } catch (error) {
    if (request !== listRequest) return;
    if (error.code === "store_mismatch") blockStore();
    const state = byId("debt-customers-state");
    state.textContent = "โหลดรายชื่อลูกค้าไม่สำเร็จ กรุณารีเฟรชหน้า";
    state.hidden = false;
  }
}

async function loadDetail() {
  if (!selectedId || !storeId || storeMismatch) return;
  const request = ++detailRequest;
  const customerId = selectedId;
  const state = byId("debt-detail-state");
  selectedDebt = null;
  byId("debt-detail-title").textContent = "รายละเอียดลูกหนี้";
  byId("debt-detail").hidden = true;
  state.textContent = "กำลังโหลดยอดค้างและประวัติชำระ…";
  state.hidden = false;
  try {
    const debt = await api("/customers/" + encodeURIComponent(customerId) + "/debt");
    if (request !== detailRequest || storeMismatch || customerId !== selectedId || debt.id !== customerId) return;
    selectedDebt = debt;
    renderDetail(debt);
  } catch (error) {
    if (request === detailRequest && error.code === "store_mismatch") blockStore();
    if (request === detailRequest) state.textContent = "โหลดรายละเอียดไม่สำเร็จ กรุณาเลือกลูกค้าอีกครั้ง";
  }
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
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const payload = saved?.payload;
    if ((saved?.reviewRequired === undefined || typeof saved.reviewRequired === "boolean")
      && typeof saved?.binding_id === "string" && uuid.test(saved.binding_id)
      && typeof saved?.customerId === "string" && uuid.test(saved.customerId)
      && typeof payload?.id === "string" && uuid.test(payload.id)
      && typeof payload.amount === "string" && payload.amount.length <= 40 && satang(payload.amount) > 0n
      && ["cash", "qr"].includes(payload.method) && typeof payload.note === "string") return saved;
  } catch { /* Preserve raw data for manual recovery. */ }
  pendingProblem = true;
  return null;
}

function setPending(request) {
  if (pendingProblem) return;
  pending = request;
  pendingStored = true;
  try {
    if (request) sessionStorage.setItem(storageKey, JSON.stringify(request));
    else sessionStorage.removeItem(storageKey);
  } catch {
    pendingStored = !request;
  }
  renderPending();
}

function renderPending() {
  const mismatch = Boolean(pending && storeId && pending.binding_id !== storeId);
  const reviewRequired = Boolean(pending?.reviewRequired);
  const locked = Boolean(pending) || sending || pendingProblem || storeMismatch || !storeId;
  byId("debt-repayment-fields").disabled = locked;
  for (const button of byId("debt-customers").querySelectorAll("button")) {
    button.disabled = Boolean(pending) || sending || storeMismatch || !storeId;
  }
  byId("debt-pending").hidden = !pending || sending;
  byId("debt-storage-warning").hidden = !pending || pendingStored;
  byId("debt-retry").disabled = sending || mismatch || storeMismatch || !storeId || reviewRequired;
  byId("debt-mismatch").hidden = !mismatch && !storeMismatch;
  byId("debt-pending-instruction").hidden = reviewRequired;
  byId("debt-review-required").hidden = !reviewRequired;
  byId("debt-pending-export").hidden = !pending;
  byId("debt-restore-error").hidden = !pendingProblem;
  byId("debt-restore-export").hidden = !pendingProblem || !pendingRawAvailable;
  updateForm();
}

async function submitPending() {
  if (!pending || pending.reviewRequired || sending || pendingProblem || storeMismatch || !storeId || pending.binding_id !== storeId) return;
  sending = true;
  renderPending();
  message("กำลังบันทึกรับชำระ…");
  const { customerId, payload, binding_id } = pending;
  try {
    const result = await api("/customers/" + encodeURIComponent(customerId) + "/repayments", payload, binding_id);
    if (!result || typeof result !== "object" || typeof result.id !== "string" || result.id.toLowerCase() !== payload.id.toLowerCase()
        || typeof result.amount !== "string" || result.amount.length > 40 || satang(result.amount) !== satang(payload.amount)
        || result.method !== payload.method || result.note !== payload.note) throw new Error("Unconfirmed repayment response");
    setPending(null);
    form.reset();
    message("บันทึกรับชำระ " + money(payload.amount) + " แล้ว");
    await Promise.all([loadCustomers(), loadDetail()]);
  } catch (failure) {
    if (failure.code === "store_mismatch") {
      blockStore();
      message("ร้านเปลี่ยนแล้ว เก็บรายการเดิมไว้และดาวน์โหลดเพื่อตรวจสอบ", true);
    } else if (failure.code === "idempotency_conflict") {
      setPending({ ...pending, reviewRequired: true });
      message("เลขอ้างอิงชนกับรายการอื่น เก็บคำขอไว้ กรุณาดาวน์โหลดและตรวจสอบประวัติการชำระ", true);
    } else if ([400, 404, 409, 413, 415, 422].includes(failure.status)) {
      setPending(null);
      const error = failure.code === "overpayment"
        ? "ยอดค้างเปลี่ยนแล้ว กรุณาตรวจสอบยอดก่อนบันทึก"
        : failure.status === 404 ? "ไม่พบลูกค้ารายนี้" : "บันทึกรับชำระไม่สำเร็จ กรุณาตรวจสอบข้อมูล";
      message(error, true);
      if (failure.status === 404 || failure.status === 409) {
        await Promise.all([loadCustomers(), loadDetail()]);
      }
    } else if (failure.code === "access_unconfirmed") {
      message("ยังยืนยันสิทธิ์หรือการเชื่อมต่อเซิร์ฟเวอร์ไม่ได้ เก็บคำขอเดิมไว้ กรุณาตรวจสอบก่อนส่งอีกครั้ง", true);
    } else {
      message("การเชื่อมต่อขัดข้อง กรุณาส่งรายการเดิมอีกครั้ง", true);
    }
  } finally {
    sending = false;
    renderPending();
  }
}

form.addEventListener("input", (event) => {
  if (event.target === fields.method || event.target === fields.amount) fields.confirmed.checked = false;
  updateForm();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!selectedDebt || pending || sending || pendingProblem || byId("debt-submit").disabled) return;
  setPending({
    binding_id: storeId,
    customerId: selectedDebt.id,
    payload: {
      id: crypto.randomUUID(),
      amount: decimalAmount(satang(fields.amount.value)),
      method: fields.method.value,
      note: fields.note.value.trim(),
    },
  });
  submitPending();
});
byId("debt-search").addEventListener("input", renderCustomers);
byId("debt-only-outstanding").addEventListener("change", renderCustomers);
byId("debt-retry").addEventListener("click", submitPending);
byId("debt-restore-export").addEventListener("click", () => {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw === null) throw new Error("Request unavailable");
    const url = URL.createObjectURL(new Blob([JSON.stringify(raw)], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "pos-repayment-raw.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { message("ดาวน์โหลดข้อมูลเดิมไม่ได้ กรุณาอย่าปิดแท็บและติดต่อผู้ดูแล", true); }
});
function blockStore() {
  storeMismatch = true;
  byId("debt-summary").hidden = true;
  ++listRequest;
  ++detailRequest;
  customers = [];
  selectedDebt = null;
  byId("debt-detail").hidden = true;
  byId("debt-detail-state").hidden = false;
  byId("debt-detail-state").textContent = "ร้านเปลี่ยนแล้ว กรุณาโหลดหน้าใหม่เพื่อตรวจสอบ";
  renderCustomers();
  renderPending();
}

byId("debt-pending-export").addEventListener("click", () => {
  if (!pending) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(pending)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "pos-repayment-pending.json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function initialize() {
  try {
    const identity = await api("/store-identity", undefined, null);
    if (typeof identity.binding_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.binding_id)) throw new Error("Invalid store");
    storeId = identity.binding_id;
    renderPending();
    if (pending && pending.binding_id !== storeId) return;
    await Promise.all([loadCustomers(), loadDetail()]);
  } catch {
    message("ตรวจสอบร้านไม่สำเร็จ กรุณาโหลดหน้าใหม่", true);
    renderPending();
  }
}
renderPending();
initialize();

window.addEventListener("beforeunload", (event) => {
  if (pending || pendingProblem) {
    event.preventDefault();
    event.returnValue = "";
  }
});
