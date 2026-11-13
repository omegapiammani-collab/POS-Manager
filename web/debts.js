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
let pending = restorePending();
let pendingStored = true;
let selectedId = pending?.customerId ?? null;
let selectedDebt = null;
let detailRequest = 0;
let sending = false;

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

async function api(path, data) {
  const options = { signal: AbortSignal.timeout(15000) };
  if (data !== undefined) {
    options.method = "POST";
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(data);
  }
  const response = await fetch(path, options);
  const result = await response.json();
  if (response.ok) return result;
  const error = new Error("Request failed");
  error.status = response.status;
  error.code = result.code;
  throw error;
}

function renderCustomers() {
  const query = byId("debt-search").value.trim().toLowerCase();
  const matches = customers.filter((customer) => customer.name.toLowerCase().includes(query));
  byId("debt-customers").replaceChildren(...matches.map((customer) => {
    const row = element("li");
    const button = element("button");
    button.type = "button";
    button.disabled = Boolean(pending) || sending;
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
  if (customersLoaded) state.textContent = query ? "ไม่พบลูกค้าที่ตรงกับคำค้น" : "ยังไม่มีลูกค้า";
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
    || (isQr && !fields.confirmed.checked) || Boolean(pending) || sending;
}

async function loadCustomers() {
  try {
    customers = await api("/customer-debts");
    customersLoaded = true;
    renderCustomers();
  } catch {
    const state = byId("debt-customers-state");
    state.textContent = "โหลดรายชื่อลูกค้าไม่สำเร็จ กรุณารีเฟรชหน้า";
    state.hidden = false;
  }
}

async function loadDetail() {
  if (!selectedId) return;
  const request = ++detailRequest;
  const state = byId("debt-detail-state");
  selectedDebt = null;
  byId("debt-detail-title").textContent = "รายละเอียดลูกหนี้";
  byId("debt-detail").hidden = true;
  state.textContent = "กำลังโหลดยอดค้างและประวัติชำระ…";
  state.hidden = false;
  try {
    const debt = await api("/customers/" + encodeURIComponent(selectedId) + "/debt");
    if (request !== detailRequest) return;
    selectedDebt = debt;
    renderDetail(debt);
  } catch {
    if (request === detailRequest) state.textContent = "โหลดรายละเอียดไม่สำเร็จ กรุณาเลือกลูกค้าอีกครั้ง";
  }
}

function restorePending() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    return typeof saved?.customerId === "string" && typeof saved.payload?.id === "string"
      ? saved : null;
  } catch {
    return null;
  }
}

function setPending(request) {
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
  const locked = Boolean(pending) || sending;
  byId("debt-repayment-fields").disabled = locked;
  for (const button of byId("debt-customers").querySelectorAll("button")) {
    button.disabled = locked;
  }
  byId("debt-pending").hidden = !pending || sending;
  byId("debt-storage-warning").hidden = !pending || pendingStored;
  byId("debt-retry").disabled = sending;
  updateForm();
}

async function submitPending() {
  if (!pending || sending) return;
  sending = true;
  renderPending();
  message("กำลังบันทึกรับชำระ…");
  const { customerId, payload } = pending;
  try {
    await api("/customers/" + encodeURIComponent(customerId) + "/repayments", payload);
    setPending(null);
    form.reset();
    message("บันทึกรับชำระ " + money(payload.amount) + " แล้ว");
    await Promise.all([loadCustomers(), loadDetail()]);
  } catch (failure) {
    if ([400, 404, 409, 413, 415, 422].includes(failure.status)) {
      setPending(null);
      const error = failure.code === "overpayment"
        ? "ยอดค้างเปลี่ยนแล้ว กรุณาตรวจสอบยอดก่อนบันทึก"
        : failure.code === "idempotency_conflict"
          ? "เลขอ้างอิงนี้ถูกใช้แล้ว กรุณาตรวจสอบประวัติรับชำระ"
          : failure.status === 404 ? "ไม่พบลูกค้ารายนี้" : "บันทึกรับชำระไม่สำเร็จ กรุณาตรวจสอบข้อมูล";
      message(error, true);
      if (failure.status === 404 || failure.status === 409) {
        await Promise.all([loadCustomers(), loadDetail()]);
      }
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
  if (!selectedDebt || pending || sending || byId("debt-submit").disabled) return;
  setPending({
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
byId("debt-retry").addEventListener("click", submitPending);
renderPending();
loadCustomers();
loadDetail();

window.addEventListener("beforeunload", (event) => {
  if (pending && !pendingStored) {
    event.preventDefault();
    event.returnValue = "";
  }
});
