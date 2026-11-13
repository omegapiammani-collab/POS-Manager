const byId = (id) => document.getElementById(id);
const dialog = byId("bill-correction");
const form = dialog.querySelector("form");
const fields = form.elements;
const methods = { cash: "เงินสด", qr: "โอนผ่าน QR", credit: "เงินเชื่อ" };
const excessActions = {
  refund_cash: "บันทึกคืนเงินสด",
  refund_qr: "บันทึกคืนเงินโอน",
  apply: "ตัดยอดหนี้บิลอื่น",
};
const storageKey = "pos-pending-correction";
const numberFormat = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 6 });
const dateFormat = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok",
});
let bills = [];
let catalog = new Map();
let customers = [];
let pending = restorePending();
let selectedId = pending?.saleId ?? null;
let sending = false;
let opening = false;
let loadingList = true;
let editing = false;
let cart = new Map();
let nextLine = 0;
let expectedExcess = null;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function decimal(value, digits, allowExponent = false) {
  const text = String(value ?? "").trim();
  const match = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || !(match[1] || match[2]) || (!allowExponent && match[3])) return null;
  const fraction = match[2] ?? "";
  if (!allowExponent && fraction.length > digits) return null;
  const exponent = Number(match[3] ?? 0) + digits - fraction.length;
  if (Math.abs(exponent) > 32 || text.length > 40) return null;
  const integer = BigInt(match[1] + fraction);
  const factor = 10n ** BigInt(Math.abs(exponent));
  if (exponent < 0 && integer % factor) return null;
  return exponent < 0 ? integer / factor : integer * factor;
}

function amountString(cents) {
  return String(cents / 100n) + "." + String(cents % 100n).padStart(2, "0");
}

function quantityString(value) {
  const scaled = decimal(value, 6, true);
  if (scaled === null) return String(value);
  const fraction = String(scaled % 1000000n).padStart(6, "0").replace(/0+$/, "");
  return String(scaled / 1000000n) + (fraction ? "." + fraction : "");
}

function money(cents) {
  if (cents === null) return "—";
  const [whole, fraction] = amountString(cents).split(".");
  return numberFormat.format(BigInt(whole)) + "." + fraction + " บาท";
}

function moneyText(value) {
  return money(decimal(value, 2, true));
}

function dateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}

function message(text, error = false) {
  const node = byId("bill-message");
  node.textContent = text;
  node.classList.toggle("error", error);
  node.hidden = !text;
}

function formError(text) {
  byId("bill-error").textContent = text;
  byId("bill-error").hidden = !text;
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
  error.excess = result.excess;
  throw error;
}

function currentBill() {
  return bills.find(({ id }) => id === selectedId);
}

function selectBill(id) {
  selectedId = id;
  message("");
  renderList();
  renderDetail();
}

function renderList() {
  const query = byId("bill-search").value.trim().toLowerCase();
  const matches = bills.filter((bill) =>
    bill.id.toLowerCase().includes(query) || (bill.customer_name ?? "").toLowerCase().includes(query)
  );
  byId("bill-list").replaceChildren(...matches.map((bill) => {
    const row = element("li");
    const button = element("button");
    button.type = "button";
    button.disabled = Boolean(pending) || sending || opening;
    button.setAttribute("aria-pressed", String(selectedId === bill.id));
    const title = element("span", dateText(bill.sold_at ?? bill.created_at));
    title.append(element("small", bill.id));
    const total = element("span", moneyText(bill.total));
    if (bill.status === "voided") total.append(element("small", "ยกเลิกแล้ว", "low"));
    else if (bill.stock_shortages?.some(({ remaining }) => Number(remaining) > 0)) {
      total.append(element("small", "รอรับสินค้าเพื่อปรับต้นทุน", "low"));
    }
    button.append(title, total);
    button.addEventListener("click", () => selectBill(bill.id));
    row.append(button);
    return row;
  }));
  const state = byId("bill-list-state");
  if (!loadingList) state.textContent = query ? "ไม่พบบิลที่ตรงกับคำค้น" : "ยังไม่มีบิล";
  state.hidden = matches.length > 0;
}

function line(left, right) {
  const row = element("li");
  row.append(element("span", left), element("span", right));
  return row;
}

function renderDetail() {
  const bill = currentBill();
  byId("bill-detail").hidden = !bill;
  byId("bill-detail-state").hidden = Boolean(bill);
  if (!bill) return;
  const voided = bill.status === "voided";
  byId("bill-reference").textContent = "เลขอ้างอิง " + bill.id;
  byId("bill-meta").textContent = dateText(bill.sold_at ?? bill.created_at) + (voided ? " · ยกเลิกแล้ว" : " · บิลปกติ");
  byId("bill-items").replaceChildren(...bill.items.map((item) =>
    line(item.name + " × " + numberFormat.format(Number(item.quantity)) + " " + item.unit_name, moneyText(item.total))
  ));
  const shortages = byId("bill-stock-shortages");
  const rows = bill.stock_shortages ?? [];
  shortages.hidden = !rows.length;
  shortages.replaceChildren(...rows.flatMap((shortage) => {
    const name = bill.items[shortage.position]?.name ?? "สินค้า";
    const remaining = Number(shortage.remaining);
    const details = shortage.fills.map(({ quantity, unit_cost, stock_count_id }) =>
      line(name + (stock_count_id ? " · ต้นทุนจากการตรวจนับ " : " · ต้นทุนจริง ") + numberFormat.format(Number(quantity)) + " หน่วยสต๊อก",
        numberFormat.format(Number(unit_cost)) + " บาท/หน่วยสต๊อก")
    );
    if (remaining > 0) {
      const cost = shortage.provisional_unit_cost;
      details.push(line(
        name + " · ขาด " + numberFormat.format(remaining) + " หน่วยสต๊อก",
        cost === null ? "รอต้นทุน" : "ทุนชั่วคราว " + numberFormat.format(Number(cost)) + " บาท/หน่วยสต๊อก"
      ));
    }
    return details;
  }));
  byId("bill-total").textContent = "ยอดรวม " + moneyText(bill.total);
  byId("bill-payments").replaceChildren(...Object.entries(methods).flatMap(([method, label]) =>
    decimal(bill.payments[method], 2, true) > 0n ? [line(label, moneyText(bill.payments[method]))] : []
  ));
  byId("bill-customer").textContent = "ลูกค้า " + (bill.customer_name ?? "");
  byId("bill-customer").hidden = !bill.customer_name;
  const reason = byId("bill-reason");
  reason.textContent = bill.correction_reason ? "เหตุผล " + bill.correction_reason : "";
  if (decimal(bill.correction_excess, 2, true) > 0n) {
    const disposition = excessActions[bill.correction_excess_action];
    reason.textContent += " · ยอดชำระเกิน " + moneyText(bill.correction_excess)
      + (disposition ? " · " + disposition : "");
  }
  reason.hidden = !reason.textContent;
  const original = bills.find((entry) => entry.replacement_id === bill.id);
  const related = byId("bill-related");
  related.replaceChildren();
  for (const [id, title] of [[original?.id, "ดูบิลเดิม"], [bill.replacement_id, "ดูบิลทดแทน"]]) {
    if (!id) continue;
    const button = element("button", title, "secondary");
    button.type = "button";
    button.disabled = Boolean(pending) || sending || opening;
    button.addEventListener("click", () => selectBill(id));
    related.append(button);
  }
  byId("bill-actions").hidden = voided;
  for (const id of ["bill-edit", "bill-void"]) byId(id).disabled = Boolean(pending) || sending || opening;
}

async function loadBills() {
  try {
    bills = await api("/sale-history");
    loadingList = false;
    renderList();
    renderDetail();
  } catch {
    byId("bill-list-state").textContent = "โหลดรายการบิลไม่สำเร็จ กรุณารีเฟรชหน้า";
    byId("bill-list-state").hidden = false;
  }
}

function buildCatalog(products) {
  catalog = new Map(products.flatMap((product) =>
    product.units.map((unit) => [unit.id, { productId: product.id, name: product.name, unit }])
  ));
  const prompt = element("option", "เลือกสินค้าและหน่วยขาย");
  prompt.value = "";
  byId("bill-catalog").replaceChildren(prompt, ...[...catalog.values()].map((item) => {
    const option = element("option", item.name + " · " + item.unit.name + " · "
      + numberFormat.format(Number(item.unit.price)) + " บาท");
    option.value = item.unit.id;
    return option;
  }));
}

function renderCustomers(customerId) {
  const prompt = element("option", "เลือกลูกค้า");
  prompt.value = "";
  fields.customer_id.replaceChildren(prompt, ...customers.map((customer) => {
    const option = element("option", customer.name);
    option.value = customer.id;
    return option;
  }));
  fields.customer_id.value = customerId ?? "";
}

function resetExcess() {
  expectedExcess = null;
  fields.excess_action.value = "";
  fields.refund_confirmed.checked = false;
  byId("bill-excess").hidden = true;
}

function resetConfirmation() {
  fields.reconciled.checked = false;
  fields.qr_confirmed.checked = false;
  resetExcess();
}

function renderCart() {
  byId("bill-edit-items").replaceChildren(...[...cart].map(([key, item]) => {
    const row = element("li");
    const title = element("div", item.name);
    const price = item.available ? numberFormat.format(Number(item.unit.price)) + " บาท" : "หน่วยขายไม่พร้อมใช้งาน";
    title.append(element("small", item.unit.name + " · " + price));
    const label = element("label", "จำนวน");
    const input = element("input");
    input.inputMode = "decimal";
    input.maxLength = 20;
    input.value = item.quantity;
    input.setAttribute("aria-label", "จำนวน " + item.name + " " + item.unit.name);
    input.addEventListener("input", () => {
      item.quantity = input.value.trim();
      resetConfirmation();
      updateForm();
    });
    label.append(input);
    const remove = element("button", "เอาออก", "secondary");
    remove.type = "button";
    remove.setAttribute("aria-label", "เอา " + item.name + " " + item.unit.name + " ออก");
    remove.addEventListener("click", () => {
      cart.delete(key);
      resetConfirmation();
      renderCart();
    });
    row.append(title, label, remove);
    return row;
  }));
  updateForm();
}

function cartTotal() {
  let total = 0n;
  for (const item of cart.values()) {
    const quantity = decimal(item.quantity, 6);
    const price = decimal(item.unit.price, 6, true);
    if (!item.available || !quantity || quantity > 1000000000000000n || price === null) return null;
    total += (quantity * price + 5000000000n) / 10000000000n;
  }
  return total;
}

function amounts() {
  return Object.fromEntries(Object.keys(methods).map((method) =>
    [method, editing ? decimal(fields[method].value.trim() || "0", 2) : 0n]
  ));
}

function changeLabel(method, next) {
  const previous = decimal(currentBill()?.payments[method], 2, true);
  const prefix = methods[method] + " เดิม " + money(previous) + " · ใหม่ " + money(next);
  if (previous === null || next === null || previous === next) return prefix;
  return prefix + (next > previous ? " · รับเพิ่ม " + money(next - previous) : " · คืน " + money(previous - next));
}

function updateForm() {
  const paid = amounts();
  const total = cartTotal();
  const validAmounts = Object.values(paid).every((amount) => amount !== null && amount <= 10n ** 24n);
  const difference = total === null || !validAmounts ? null : total - paid.cash - paid.qr - paid.credit;
  byId("bill-edit-total").textContent = "ยอดบิลทดแทน " + money(total);
  byId("bill-money-change").textContent = changeLabel("cash", paid.cash) + "\n" + changeLabel("qr", paid.qr)
    + "\nตรวจสอบและจัดการส่วนต่างกับลูกค้าด้วยตนเองก่อนบันทึก";
  byId("bill-customer-field").hidden = !(paid.credit > 0n);
  byId("bill-qr-field").hidden = !(paid.qr > 0n);
  const refund = fields.excess_action.value.startsWith("refund_");
  byId("bill-refund-field").hidden = !refund;
  let balance = "ยอดชำระครบ";
  if (!cart.size) balance = "เพิ่มสินค้าอย่างน้อยหนึ่งรายการ";
  else if (total === null) balance = "ตรวจสอบจำนวนและหน่วยขาย";
  else if (difference === null) balance = "ตรวจสอบยอดชำระ ทศนิยมไม่เกิน 2 ตำแหน่ง";
  else if (difference > 0n) balance = "เหลือต้องชำระ " + money(difference);
  else if (difference < 0n) balance = "ยอดชำระเกิน " + money(-difference);
  byId("bill-balance").textContent = balance;
  byId("bill-add-item").disabled = !byId("bill-catalog").value;
  byId("bill-submit").disabled = Boolean(pending) || sending || !fields.reason.value.trim() || !fields.reconciled.checked
    || (editing && (!cart.size || difference !== 0n || (paid.credit > 0n && !fields.customer_id.value)
      || (paid.qr > 0n && !fields.qr_confirmed.checked)))
    || (!byId("bill-excess").hidden && !fields.excess_action.value) || (refund && !fields.refund_confirmed.checked);
}

async function openCorrection(edit) {
  const bill = currentBill();
  if (!bill || bill.status !== "active" || pending || sending || opening) return;
  opening = true;
  renderList();
  renderDetail();
  message("");
  try {
    if (edit) {
      const [products, rows] = await Promise.all([api("/products"), api("/customers")]);
      buildCatalog(products);
      customers = rows;
    }
    editing = edit;
    cart = new Map();
    nextLine = 0;
    form.reset();
    formError("");
    resetExcess();
    byId("bill-correction-title").textContent = edit ? "แก้ไขบิล" : "ยกเลิกบิล";
    byId("bill-correction-ref").textContent = "บิลเดิม " + bill.id;
    byId("bill-replacement").hidden = !edit;
    if (edit) {
      for (const item of bill.items) {
        const current = catalog.get(item.unit_id);
        cart.set(nextLine++, current
          ? { ...current, quantity: quantityString(item.quantity), available: true }
          : { name: item.name, unit: { id: item.unit_id, name: item.unit_name, price: item.unit_price },
              quantity: quantityString(item.quantity), available: false });
      }
      for (const method of Object.keys(methods)) {
        fields[method].value = amountString(decimal(bill.payments[method], 2, true) ?? 0n);
      }
      renderCustomers(bill.customer_id);
    }
    renderCart();
    dialog.showModal();
  } catch {
    message("โหลดสินค้าและลูกค้าไม่สำเร็จ กรุณาลองอีกครั้ง", true);
  } finally {
    opening = false;
    renderList();
    renderDetail();
  }
}

function restorePending() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    return typeof saved?.saleId === "string" && typeof saved.payload?.id === "string" ? saved : null;
  } catch {
    return null;
  }
}

function setPending(request) {
  pending = request;
  try {
    if (request) sessionStorage.setItem(storageKey, JSON.stringify(request));
    else sessionStorage.removeItem(storageKey);
  } catch {
    // Keep the request in this tab if browser storage is unavailable.
  }
  renderPending();
}

function renderPending() {
  const locked = Boolean(pending) || sending;
  byId("bill-fields").disabled = locked;
  byId("bill-pending").hidden = !pending || sending;
  byId("bill-retry").disabled = sending;
  byId("bill-close").disabled = sending;
  renderList();
  renderDetail();
  updateForm();
}

const errors = {
  price_changed: "ราคาสินค้าเปลี่ยน กรุณาปิดแล้วเปิดฟอร์มใหม่เพื่อตรวจสอบราคา",
  insufficient_stock: "สินค้าคงเหลือไม่พอ กรุณาตรวจสอบจำนวน",
  item_unavailable: "สินค้าหรือหน่วยขายบางรายการไม่พร้อมใช้งาน",
  idempotency_conflict: "เลขอ้างอิงนี้ถูกใช้แล้ว กรุณาตรวจสอบประวัติบิล",
  stock_shortage_unresolved: "กรุณารับสินค้าหรือปรับยอดจากการตรวจนับก่อนแก้ไขหรือยกเลิกบิล",
  sale_already_voided: "บิลนี้ถูกยกเลิกแล้ว กรุณาตรวจสอบประวัติบิล",
};

function showExcess(error) {
  resetExcess();
  const amount = decimal(error.excess, 2, true);
  expectedExcess = amount === null ? null : amountString(amount);
  if (error.code === "excess_changed") fields.reconciled.checked = false;
  if (amount === 0n) {
    formError("ยอดชำระเกินเปลี่ยนเป็น 0.00 บาท กรุณาตรวจสอบก่อนบันทึกอีกครั้ง");
    return;
  }
  byId("bill-excess").hidden = false;
  byId("bill-excess-text").textContent = amount === null
    ? "พบยอดชำระเกิน กรุณาตรวจสอบยอดก่อนเลือกวิธีจัดการ"
    : "ยอดชำระเกิน " + money(amount) + " เลือกวิธีจัดการก่อนบันทึก";
  formError(error.code === "insufficient_other_debt"
    ? "ยอดหนี้บิลอื่นไม่พอให้ตัด กรุณาเลือกวิธีคืนเงิน"
    : error.code === "excess_changed" ? "ยอดชำระเกินเปลี่ยน กรุณาตรวจสอบยอดใหม่" : "");
}

async function submitPending() {
  if (!pending || sending) return;
  sending = true;
  renderPending();
  const { saleId, payload } = pending;
  formError("");
  message("กำลังบันทึกการเปลี่ยนแปลง…");
  try {
    const result = await api("/sales/" + encodeURIComponent(saleId) + "/corrections", payload);
    setPending(null);
    if (dialog.open) dialog.close();
    selectedId = result.replacement_id ?? saleId;
    const disposition = excessActions[result.excess_action];
    message((result.replacement_id ? "แก้ไขบิลแล้ว" : "ยกเลิกบิลแล้ว")
      + (disposition ? " · " + disposition + " " + moneyText(result.excess) : ""));
    await loadBills();
  } catch (error) {
    if ([400, 404, 409, 413, 415, 422].includes(error.status)) {
      setPending(null);
      const needsExcess = ["excess_action_required", "insufficient_other_debt", "excess_changed"].includes(error.code);
      if (needsExcess && dialog.open) {
        message("");
        showExcess(error);
      } else {
        const text = needsExcess
          ? "พบยอดชำระเกิน กรุณาเปิดฟอร์มอีกครั้งเพื่อเลือกวิธีจัดการ"
          : errors[error.code] ?? "บันทึกการเปลี่ยนแปลงไม่สำเร็จ กรุณาตรวจสอบข้อมูล";
        if (dialog.open) {
          message("");
          formError(text);
        } else message(text, true);
        if ([404, 409].includes(error.status)) await loadBills();
      }
    } else {
      const text = "การเชื่อมต่อขัดข้อง กรุณาส่งคำขอเดิมอีกครั้ง";
      message(text, true);
      if (dialog.open) formError(text + " จากหน้าประวัติบิล");
    }
  } finally {
    sending = false;
    renderPending();
  }
}

byId("bill-search").addEventListener("input", renderList);
byId("bill-edit").addEventListener("click", () => openCorrection(true));
byId("bill-void").addEventListener("click", () => openCorrection(false));
byId("bill-close").addEventListener("click", () => dialog.close());
byId("bill-retry").addEventListener("click", submitPending);
dialog.addEventListener("cancel", (event) => { if (sending) event.preventDefault(); });
byId("bill-catalog").addEventListener("change", updateForm);
byId("bill-add-item").addEventListener("click", () => {
  const item = catalog.get(byId("bill-catalog").value);
  if (!item) return;
  cart.set(nextLine++, { ...item, quantity: "1", available: true });
  byId("bill-catalog").value = "";
  resetConfirmation();
  renderCart();
});
form.addEventListener("input", (event) => {
  if (Object.keys(methods).includes(event.target.name) || event.target === fields.customer_id) resetConfirmation();
  if (event.target === fields.excess_action) fields.refund_confirmed.checked = false;
  updateForm();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (byId("bill-submit").disabled || !currentBill()) return;
  const paid = amounts();
  setPending({
    saleId: selectedId,
    payload: {
      id: crypto.randomUUID(),
      reason: fields.reason.value.trim(),
      excess_action: fields.excess_action.value || null,
      expected_excess: expectedExcess,
      replacement: editing ? {
        id: crypto.randomUUID(),
        items: [...cart.values()].map((item) => ({
          product_id: item.productId, unit_id: item.unit.id, quantity: item.quantity,
          expected_unit_price: item.unit.price,
        })),
        payments: Object.fromEntries(Object.keys(methods).map((method) => [method, amountString(paid[method])])),
        customer_id: paid.credit > 0n ? fields.customer_id.value : null,
        qr_confirmed: paid.qr > 0n && fields.qr_confirmed.checked,
      } : null,
    },
  });
  submitPending();
});
renderPending();
loadBills();
