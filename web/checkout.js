const byId = (id) => document.getElementById(id);
const paymentForm = byId("sale-payment");
const payment = paymentForm.elements;
const paymentLabels = { cash: "เงินสด", qr: "โอนผ่าน QR", credit: "เงินเชื่อ" };
const paymentMethods = Object.keys(paymentLabels);
const storageKey = "pos-pending-sale";
const maxWhole = 1000000000n;
const formatter = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 6 });
const cart = new Map();
let products = [];
let customers = [];
let pending = restorePending();
let sending = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function status(message, error = false) {
  const node = byId("sale-message");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = !message;
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
  const error = new Error(result.error || "บันทึกไม่สำเร็จ");
  error.status = response.status;
  error.code = result.code;
  throw error;
}

function scaledDecimal(value, digits, allowExponent = false) {
  const match = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match || !(match[1] || match[2]) || (!allowExponent && match[3])) return null;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0) + digits - fraction.length;
  if (exponent > 12 || exponent < -12 || value.length > 32) return null;
  const whole = BigInt(match[1] + fraction);
  const factor = 10n ** BigInt(Math.abs(exponent));
  if (exponent < 0 && whole % factor !== 0n) return null;
  return exponent < 0 ? whole / factor : whole * factor;
}

function boundedDecimal(value, digits, allowExponent = false, maximum = maxWhole) {
  const scaled = scaledDecimal(value, digits, allowExponent);
  return scaled !== null && scaled <= maximum * 10n ** BigInt(digits) ? scaled : null;
}

function moneyString(amount) {
  return String(amount / 100n) + "." + String(amount % 100n).padStart(2, "0");
}

function money(amount) {
  const [whole, cents] = moneyString(amount).split(".");
  return formatter.format(BigInt(whole)) + "." + cents + " บาท";
}

function displayDecimal(value) {
  return formatter.format(Number(value));
}

function cartTotal() {
  let total = 0n;
  for (const item of cart.values()) {
    const quantity = boundedDecimal(item.quantity, 6);
    const price = boundedDecimal(item.unit.price, 6, true);
    if (!quantity || price === null) return null;
    // Two six-decimal values yield twelve decimals. Round each line to a satang.
    total += (quantity * price + 5000000000n) / 10000000000n;
  }
  return total;
}

function renderProducts() {
  const query = byId("sale-search").value.trim().toLowerCase();
  const list = byId("sale-products");
  const matches = products.filter((product) =>
    product.name.toLowerCase().includes(query) || product.code.toLowerCase().includes(query)
  );
  list.replaceChildren(...matches.map((product) => {
    const row = element("li");
    const buttons = element("div", undefined, "sale-unit-buttons");
    for (const unit of product.units) {
      const button = element("button", unit.name + " · " + displayDecimal(unit.price) + " บาท", "secondary");
      button.type = "button";
      button.setAttribute("aria-label", "เพิ่ม " + product.name + " " + unit.name);
      button.addEventListener("click", () => addItem(product, unit));
      buttons.append(button);
    }
    row.append(
      element("span", product.name, "sale-product-name"),
      element("small", product.code + " · คงเหลือ " + displayDecimal(product.quantity) + " " + product.base_unit, "sale-product-code"),
      buttons
    );
    return row;
  }));
  const state = byId("sale-products-state");
  state.textContent = query ? "ไม่พบสินค้าที่ตรงกับคำค้น" : "ยังไม่มีสินค้า";
  state.hidden = matches.length > 0;
}

function addItem(product, unit) {
  const item = cart.get(unit.id);
  if (item) {
    const quantity = boundedDecimal(item.quantity, 6) ?? 0n;
    const next = quantity + 1000000n;
    if (next > maxWhole * 1000000n) return;
    const fraction = String(next % 1000000n).padStart(6, "0").replace(/0+$/, "");
    item.quantity = String(next / 1000000n) + (fraction ? "." + fraction : "");
  } else {
    cart.set(unit.id, { product, unit, quantity: "1" });
  }
  renderCart();
}

function renderCart() {
  byId("sale-cart").replaceChildren(...[...cart.values()].map((item) => {
    const row = element("li", undefined, "sale-cart-row");
    const title = element("div", item.product.name);
    title.append(element("small", item.unit.name + " · " + displayDecimal(item.unit.price) + " บาท"));
    const label = element("label", "จำนวน");
    const input = element("input");
    input.inputMode = "decimal";
    input.value = item.quantity;
    input.setAttribute("aria-label", "จำนวน " + item.product.name + " " + item.unit.name);
    input.addEventListener("input", () => {
      item.quantity = input.value.trim();
      updatePayment();
    });
    label.append(input);
    const remove = element("button", "เอาออก", "secondary");
    remove.type = "button";
    remove.setAttribute("aria-label", "เอา " + item.product.name + " " + item.unit.name + " ออก");
    remove.addEventListener("click", () => {
      cart.delete(item.unit.id);
      renderCart();
    });
    row.append(title, label, remove);
    return row;
  }));
  byId("sale-empty").hidden = cart.size !== 0;
  updatePayment();
}

function amounts() {
  return Object.fromEntries(paymentMethods.map((method) =>
    [method, boundedDecimal(payment[method].value.trim() || "0", 2, false, 10n ** 22n)]
  ));
}

function updatePayment() {
  const total = cartTotal();
  const paid = amounts();
  const invalid = Object.values(paid).includes(null);
  const difference = total === null || invalid ? null : total - paid.cash - paid.qr - paid.credit;
  byId("sale-total").textContent = total === null ? "ตรวจสอบจำนวนสินค้า" : money(total);
  byId("sale-qr").hidden = !(paid.qr > 0n);
  byId("sale-credit").hidden = !(paid.credit > 0n);
  const balance = byId("sale-balance");
  if (!cart.size) balance.textContent = "";
  else if (invalid) balance.textContent = "กรอกยอดเงินเป็นตัวเลขทศนิยมไม่เกิน 2 ตำแหน่ง";
  else if (difference === null) balance.textContent = "กรอกจำนวนสินค้ามากกว่า 0";
  else if (difference > 0n) balance.textContent = "เหลือต้องชำระ " + money(difference);
  else if (difference < 0n) balance.textContent = "ยอดชำระเกิน " + money(-difference);
  else balance.textContent = "ยอดชำระครบ";

  byId("sale-cash-all").disabled = !cart.size || total === null;
  byId("sale-submit").disabled = !cart.size || difference !== 0n
    || (paid.credit > 0n && !payment.customer_id.value)
    || (paid.qr > 0n && !payment.qr_confirmed.checked);
}

function clearQr() {
  byId("sale-qr-image").replaceChildren();
  byId("sale-qr-image").hidden = true;
  byId("sale-qr-state").hidden = true;
  payment.qr_confirmed.checked = false;
}

byId("sale-show-qr").addEventListener("click", () => {
  const amount = amounts().qr;
  if (!(amount > 0n)) return;
  const container = byId("sale-qr-image");
  const message = byId("sale-qr-state");
  const image = element("img");
  image.alt = "QR รับโอน " + money(amount);
  image.addEventListener("load", () => {
    if (image.parentNode === container) message.hidden = true;
  });
  image.addEventListener("error", () => {
    if (image.parentNode !== container) return;
    container.hidden = true;
    message.textContent = "แสดง QR ไม่สำเร็จ ตรวจสอบการตั้งค่าพร้อมเพย์หรือใช้ QR ของร้าน";
  });
  message.textContent = "กำลังโหลด QR…";
  message.hidden = false;
  container.replaceChildren(image);
  container.hidden = false;
  image.src = "/payment-qr?" + new URLSearchParams({ amount: moneyString(amount) });
});

function renderCustomers(selected = "") {
  const select = payment.customer_id;
  const prompt = element("option", "เลือกลูกค้า");
  prompt.value = "";
  select.replaceChildren(prompt, ...customers.map((customer) => {
    const option = element("option", customer.name);
    option.value = customer.id;
    return option;
  }));
  select.value = selected;
  updatePayment();
}

function restorePending() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    return typeof saved?.id === "string" && Array.isArray(saved.items) && saved.payments ? saved : null;
  } catch {
    return null;
  }
}

function setPending(payload) {
  pending = payload;
  try {
    if (pending) sessionStorage.setItem(storageKey, JSON.stringify(pending));
    else sessionStorage.removeItem(storageKey);
  } catch {
    // The current tab still retains the request when browser storage is unavailable.
  }
  renderPending();
}

function renderPending() {
  for (const id of ["sale-picker", "sale-cart-fields", "sale-payment-fields"]) {
    byId(id).disabled = Boolean(pending);
  }
  byId("sale-pending").hidden = !pending || sending;
  byId("sale-retry").disabled = sending;
}

function showReceipt(sale) {
  byId("sale-receipt-id").textContent = "เลขอ้างอิง " + sale.id;
  const timestamp = new Date(sale.created_at.replace(" ", "T"));
  byId("sale-receipt-date").textContent = Number.isNaN(timestamp.getTime())
    ? sale.created_at
    : new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(timestamp);
  byId("sale-receipt-lines").replaceChildren(...sale.items.map((item) => {
    const row = element("li");
    row.append(element("span", item.name + " × " + displayDecimal(item.quantity) + " " + item.unit_name),
      element("span", money(scaledDecimal(item.total, 2))));
    return row;
  }));
  byId("sale-receipt-total").textContent = money(scaledDecimal(sale.total, 2));
  byId("sale-receipt-payments").replaceChildren(...paymentMethods.flatMap((method) => {
    const amount = scaledDecimal(sale.payments[method], 2);
    if (!amount) return [];
    const row = element("li");
    const label = method === "credit" && sale.customer_name
      ? paymentLabels[method] + " · " + sale.customer_name
      : paymentLabels[method];
    row.append(element("span", label), element("span", money(amount)));
    return [row];
  }));
  byId("sale-receipt").showModal();
}

const saleErrors = {
  price_changed: "ราคาสินค้าเปลี่ยน กรุณาตรวจสอบราคาและยอดชำระใหม่",
  insufficient_stock: "สินค้าคงเหลือไม่พอ กรุณาตรวจสอบจำนวนในตะกร้า",
  item_unavailable: "สินค้าหรือหน่วยขายบางรายการไม่พร้อมขาย กรุณาตรวจสอบตะกร้า",
  idempotency_conflict: "เลขอ้างอิงนี้ถูกใช้แล้ว กรุณาตรวจสอบบิลก่อนปิดบิลใหม่",
};

async function submitPending() {
  if (!pending || sending) return;
  sending = true;
  renderPending();
  status("กำลังบันทึกบิล…");
  let sale;
  try {
    sale = await api("/sales", pending);
  } catch (failure) {
    if ([400, 404, 409, 413, 415, 422].includes(failure.status)) {
      setPending(null);
      status(saleErrors[failure.code] ?? "บันทึกบิลไม่สำเร็จ กรุณาตรวจสอบรายการและยอดชำระ", true);
      if (["price_changed", "insufficient_stock", "item_unavailable"].includes(failure.code)) {
        await loadProducts();
        if (failure.code === "price_changed") {
          for (const item of cart.values()) {
            const product = products.find(({ id }) => id === item.product.id);
            const unit = product?.units.find(({ id }) => id === item.unit.id);
            if (unit) item.unit = unit;
          }
          clearQr();
          renderCart();
        }
      }
    } else {
      status("การเชื่อมต่อขัดข้อง กรุณาส่งบิลเดิมอีกครั้ง", true);
    }
    return;
  } finally {
    sending = false;
    renderPending();
  }
  setPending(null);
  cart.clear();
  paymentForm.reset();
  clearQr();
  renderCart();
  status("ปิดบิลแล้ว");
  showReceipt(sale);
  loadProducts();
}

paymentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pending || sending || byId("sale-submit").disabled) return;
  const paid = amounts();
  setPending({
    id: crypto.randomUUID(),
    items: [...cart.values()].map(({ product, unit, quantity }) => ({
      product_id: product.id,
      unit_id: unit.id,
      quantity,
      expected_unit_price: unit.price,
    })),
    payments: Object.fromEntries(paymentMethods.map((method) => [method, moneyString(paid[method])])),
    customer_id: paid.credit > 0n ? payment.customer_id.value : null,
    qr_confirmed: paid.qr > 0n && payment.qr_confirmed.checked,
  });
  submitPending();
});

paymentForm.addEventListener("input", (event) => {
  if (event.target === payment.qr) clearQr();
  updatePayment();
});
byId("sale-cash-all").addEventListener("click", () => {
  payment.cash.value = moneyString(cartTotal());
  payment.qr.value = "";
  payment.credit.value = "";
  clearQr();
  updatePayment();
});
byId("sale-retry").addEventListener("click", submitPending);
byId("sale-search").addEventListener("input", renderProducts);
byId("sale-receipt-close").addEventListener("click", () => byId("sale-receipt").close());
byId("sale-print").addEventListener("click", () => window.print());

const customerDialog = byId("sale-customer");
const customerForm = customerDialog.querySelector("form");
const customerError = customerForm.querySelector(".error");
const customerSave = customerForm.querySelector("button:not([type])");
byId("sale-new-customer").addEventListener("click", () => {
  customerForm.reset();
  customerError.hidden = true;
  customerDialog.showModal();
});
const customerClose = customerDialog.querySelector("[data-customer-close]");
customerClose.addEventListener("click", () => customerDialog.close());
customerDialog.addEventListener("cancel", (event) => {
  if (customerSave.disabled) event.preventDefault();
});
customerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (customerSave.disabled) return;
  const name = customerForm.elements.name.value.trim();
  if (!name) return;
  customerSave.disabled = customerClose.disabled = true;
  customerError.hidden = true;
  try {
    const customer = await api("/customers", { name });
    customers.push(customer);
    renderCustomers(customer.id);
    customerDialog.close();
  } catch {
    customerError.textContent = "บันทึกลูกค้าไม่สำเร็จ กรุณาลองอีกครั้ง";
    customerError.hidden = false;
  } finally {
    customerSave.disabled = customerClose.disabled = false;
  }
});

async function loadProducts() {
  try {
    products = await api("/products");
    renderProducts();
  } catch {
    byId("sale-products-state").textContent = "โหลดสินค้าไม่สำเร็จ กรุณารีเฟรชหน้า";
    byId("sale-products-state").hidden = false;
  }
}

renderCustomers();
renderPending();
loadProducts();
api("/customers").then((rows) => {
  const knownIds = new Set(customers.map((customer) => customer.id));
  customers.push(...rows.filter((customer) => !knownIds.has(customer.id)));
  renderCustomers(payment.customer_id.value);
}).catch(() => {
  status("โหลดรายชื่อลูกค้าไม่สำเร็จ กรุณารีเฟรชก่อนขายเงินเชื่อ", true);
});
