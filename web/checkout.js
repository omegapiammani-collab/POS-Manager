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
let legacyPending = restorePending();
let staging = false;
let syncing = false;
let connected = navigator.onLine !== false;
const snapshotKeys = new Set();
const cacheProblems = new Set();
let shellReady = false;
let syncRequested = false;
let stagedDuringSync = new Set();
let queueRequest = 0;
let queueProblem = false;
let productsRequest = 0;
let customersRequest = 0;
const store = window.PosOffline;

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
  let response;
  try {
    response = await fetch(path, options);
  } catch (failure) {
    setConnected(false);
    throw failure;
  }
  setConnected(response.status < 500);
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

function lineTotal(item) {
  const quantity = boundedDecimal(item.quantity, 6);
  const price = boundedDecimal(item.unit.price, 6, true);
  if (!quantity || price === null) return null;
  // Two six-decimal values yield twelve decimals. Round each line to a satang.
  return (quantity * price + 5000000000n) / 10000000000n;
}

function cartTotal() {
  let total = 0n;
  for (const item of cart.values()) {
    const amount = lineTotal(item);
    if (amount === null) return null;
    total += amount;
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
  byId("sale-submit").disabled = staging || !cart.size || difference !== 0n
    || (paid.credit > 0n && !payment.customer_id.value)
    || (paid.qr > 0n && !payment.qr_confirmed.checked);
}

function clearQr() {
  byId("sale-qr-image").replaceChildren();
  byId("sale-qr-image").hidden = true;
  byId("sale-qr-state").hidden = true;
  payment.qr_confirmed.checked = false;
  if (!connected) setConnected(false);
}

byId("sale-show-qr").addEventListener("click", () => {
  const amount = amounts().qr;
  if (!connected || !(amount > 0n)) return;
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

function setConnected(value) {
  connected = value && navigator.onLine !== false;
  const connection = byId("sale-connection");
  const connectionMessage = connected ? "เชื่อมต่อแล้ว" : "ออฟไลน์ · ใช้ข้อมูลสินค้าและลูกค้าที่บันทึกไว้ในเครื่อง";
  const prepared = shellReady && snapshotKeys.has("products") && snapshotKeys.has("customers");
  const preparation = cacheProblems.size
    ? " · เตรียมข้อมูลสำหรับออฟไลน์ไม่สำเร็จ"
    : prepared ? " · เปิดหน้าขายและบันทึกบิลออฟไลน์ได้" : " · กำลังเตรียมข้อมูลสำหรับออฟไลน์";
  connection.textContent = connectionMessage + preparation;
  connection.classList.toggle("sale-offline", !connected || cacheProblems.size > 0);
  byId("sale-show-qr").disabled = !connected;
  byId("sale-new-customer").disabled = !connected;
  if (!connected && byId("sale-qr-image").hidden) {
    byId("sale-qr-state").textContent = "สร้าง QR ตามยอดได้เมื่อออนไลน์ ใช้ QR ร้านและตรวจสอบเงินโอนด้วยตนเอง";
    byId("sale-qr-state").hidden = false;
  } else if (connected && byId("sale-qr-state").textContent.startsWith("สร้าง QR ตามยอดได้เมื่อออนไลน์")) {
    byId("sale-qr-state").hidden = true;
  }
}

function lockSaleFields() {
  for (const id of ["sale-picker", "sale-cart-fields", "sale-payment-fields"]) {
    byId(id).disabled = staging;
  }
  updatePayment();
}

async function showQueue() {
  const request = ++queueRequest;
  const queue = byId("sale-queue");
  const summary = byId("sale-queue-summary");
  let entries;
  try {
    entries = await store.list();
    if (request !== queueRequest) return;
    queueProblem = false;
  } catch {
    if (request !== queueRequest) return;
    queueProblem = true;
    entries = [];
  }
  const pendingCount = entries.filter(({ state }) => state === "pending").length;
  const conflictCount = entries.filter(({ state }) => state === "conflict").length;
  byId("sale-pending").hidden = !entries.length && !legacyPending && !queueProblem;
  byId("sale-retry").disabled = syncing || staging || (!pendingCount && !legacyPending);
  summary.textContent = queueProblem
    ? "อ่านคิวในเครื่องไม่สำเร็จ กรุณาตรวจสอบพื้นที่จัดเก็บของเบราว์เซอร์"
    : "รอส่ง " + (pendingCount + Number(Boolean(legacyPending))) + " บิล · ต้องตรวจสอบ " + conflictCount + " บิล";
  queue.replaceChildren(...entries.map(({ payload, state, error }) => {
    const row = element("li");
    const total = paymentMethods.reduce((sum, method) =>
      sum + (scaledDecimal(payload.payments[method], 2, true) ?? 0n), 0n
    );
    const title = element("span", money(total));
    title.append(element("small", payload.id),
      element("small", state === "conflict" ? error || "ต้องตรวจสอบ" : "รอส่งข้อมูล"));
    row.append(title);
    if (state === "conflict") {
      const retry = element("button", "ลองส่งอีกครั้ง", "secondary");
      retry.type = "button";
      retry.disabled = syncing || staging;
      retry.setAttribute("aria-label", "ลองส่งบิล " + payload.id + " อีกครั้ง");
      retry.addEventListener("click", () => retryQueue(payload.id));
      row.append(retry);
    }
    return row;
  }));
}

async function migrateLegacy() {
  if (!legacyPending) return;
  await store.put(legacyPending);
  legacyPending = null;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // The staged copy retains the same identifier if this tab retries migration.
  }
}

function localReceipt(payload) {
  return {
    ...payload,
    created_at: new Date().toISOString(),
    total: moneyString(cartTotal()),
    customer_name: customers.find(({ id }) => id === payload.customer_id)?.name,
    items: [...cart.values()].map((item) => ({
      name: item.product.name, unit_name: item.unit.name, quantity: item.quantity,
      total: moneyString(lineTotal(item)),
    })),
  };
}

function showReceipt(sale, state = "synced") {
  const temporary = state !== "synced";
  byId("sale-receipt-title").textContent = temporary ? "หลักฐานการขายจากเครื่องนี้" : "ใบเสร็จรับเงิน";
  byId("sale-receipt-state").textContent = state === "conflict"
    ? "ต้องตรวจสอบก่อนบันทึกเข้าระบบ" : "รอส่งข้อมูลเข้าระบบ";
  byId("sale-receipt-state").hidden = !temporary;
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

async function syncSale(payload) {
  let sale;
  try {
    sale = await api("/sales", payload);
  } catch (failure) {
    if (![400, 404, 409, 413, 415, 422].includes(failure.status)) return { state: "pending" };
    const reason = saleErrors[failure.code] ?? "บันทึกบิลไม่สำเร็จ กรุณาตรวจสอบรายการและยอดชำระ";
    await store.update(payload.id, "conflict", reason);
    return { state: "conflict", reason };
  }
  try {
    await store.remove(payload.id);
  } catch {
    // The server has confirmed the sale. Retrying the retained identifier is safe.
    status("บันทึกบิลแล้ว แต่ล้างคิวในเครื่องไม่สำเร็จ", true);
  }
  return { state: "synced", sale };
}

async function syncQueue(onlyId) {
  if (syncing || staging) return;
  syncing = true;
  stagedDuringSync = new Set();
  let synced = 0;
  let conflicts = 0;
  let deferred = false;
  try {
    await showQueue();
    await migrateLegacy();
    if (navigator.onLine === false) return;
    for (const entry of await store.list()) {
      if (stagedDuringSync.has(entry.payload.id)) continue;
      if (onlyId ? entry.payload.id !== onlyId : entry.state !== "pending") continue;
      const result = await syncSale(entry.payload);
      if (result.state === "synced") synced++;
      if (result.state === "conflict") conflicts++;
      if (result.state === "pending") {
        deferred = true;
        break;
      }
    }
    if (synced) loadProducts();
    if (synced || conflicts || deferred) {
      const parts = [];
      if (synced) parts.push("ส่งสำเร็จ " + synced + " บิล");
      if (conflicts) parts.push("ต้องตรวจสอบ " + conflicts + " บิล");
      if (deferred) parts.push("ส่งข้อมูลไม่ได้ คิวบิลยังอยู่ในเครื่องนี้");
      status(parts.join(" · "), Boolean(conflicts || deferred));
    }
  } catch {
    status("จัดการคิวในเครื่องไม่สำเร็จ กรุณาลองอีกครั้ง", true);
  } finally {
    syncing = false;
    await showQueue();
    flushRequestedSync();
  }
}

function flushRequestedSync() {
  if (!syncRequested || syncing || staging || !connected) return;
  syncRequested = false;
  syncQueue();
}

paymentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (staging || byId("sale-submit").disabled) return;
  const paid = amounts();
  const payload = {
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
  };
  const receipt = localReceipt(payload);
  const queuedDuringSync = syncing;
  if (queuedDuringSync) stagedDuringSync.add(payload.id);
  staging = true;
  lockSaleFields();
  let staged = false;
  try {
    await store.put(payload);
    staged = true;
    let result = { state: "pending" };
    if (!queuedDuringSync && connected && navigator.onLine !== false) result = await syncSale(payload);
    if (queuedDuringSync) syncRequested = true;
    cart.clear();
    paymentForm.reset();
    clearQr();
    renderCart();
    if (result.state === "synced") {
      status("ปิดบิลและส่งข้อมูลแล้ว");
      loadProducts();
    } else if (result.state === "conflict") {
      status("บิลอยู่ในคิวตรวจสอบ · " + result.reason, true);
      if (connected) loadProducts();
    } else {
      status("บันทึกบิลในเครื่องแล้ว · รอส่งข้อมูล");
    }
    showReceipt(result.sale ?? receipt, result.state);
  } catch {
    if (staged) {
      cart.clear();
      paymentForm.reset();
      clearQr();
      renderCart();
      status("บันทึกบิลในเครื่องแล้ว · ตรวจสอบคิวก่อนส่งอีกครั้ง", true);
      showReceipt(receipt, "pending");
    } else {
      status("บันทึกบิลในเครื่องไม่สำเร็จ กรุณาลองอีกครั้ง", true);
    }
  } finally {
    staging = false;
    lockSaleFields();
    await showQueue();
    flushRequestedSync();
  }
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
function retryQueue(onlyId) {
  if (navigator.onLine === false) {
    status("ยังออฟไลน์อยู่ บิลยังเก็บไว้ในเครื่องนี้", true);
    return;
  }
  syncQueue(onlyId);
}

byId("sale-retry").addEventListener("click", () => retryQueue());
byId("sale-search").addEventListener("input", renderProducts);
byId("sale-receipt-close").addEventListener("click", () => byId("sale-receipt").close());
byId("sale-print").addEventListener("click", () => window.print());

const customerDialog = byId("sale-customer");
const customerForm = customerDialog.querySelector("form");
const customerError = customerForm.querySelector(".error");
const customerSave = customerForm.querySelector("button:not([type])");
byId("sale-new-customer").addEventListener("click", () => {
  if (!connected) return;
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
  if (!connected) {
    customerError.textContent = "เพิ่มลูกค้าได้เมื่อเชื่อมต่อกับระบบ";
    customerError.hidden = false;
    return;
  }
  const name = customerForm.elements.name.value.trim();
  if (!name) return;
  customerSave.disabled = customerClose.disabled = true;
  customerError.hidden = true;
  try {
    const customer = await api("/customers", { name });
    customers.push(customer);
    renderCustomers(customer.id);
    saveSnapshot("customers", customers);
    customerDialog.close();
  } catch {
    customerError.textContent = "บันทึกลูกค้าไม่สำเร็จ กรุณาลองอีกครั้ง";
    customerError.hidden = false;
  } finally {
    customerSave.disabled = customerClose.disabled = false;
  }
});

async function saveSnapshot(key, value) {
  try {
    await store.putSnapshot(key, value);
    snapshotKeys.add(key);
    cacheProblems.delete(key);
  } catch {
    cacheProblems.add(key);
  }
  setConnected(connected);
}

async function cachedRead(key, path) {
  if (navigator.onLine !== false) {
    try {
      return { data: await api(path), fresh: true };
    } catch {
      // Keep the last successful server snapshot for disconnected sales.
    }
  }
  const data = await store.getSnapshot(key);
  if (Array.isArray(data)) snapshotKeys.add(key);
  setConnected(connected);
  return { data, fresh: false };
}

async function loadProducts() {
  const request = ++productsRequest;
  try {
    const { data, fresh } = await cachedRead("products", "/products");
    if (request !== productsRequest) return;
    if (!Array.isArray(data)) throw new Error("Missing products");
    products = data;
    renderProducts();
    if (fresh) saveSnapshot("products", data);
  } catch {
    if (request !== productsRequest) return;
    byId("sale-products-state").textContent = "ยังไม่มีข้อมูลสินค้าในเครื่อง กรุณาเปิดหน้านี้ขณะออนไลน์";
    byId("sale-products-state").hidden = false;
  }
}

async function loadCustomers() {
  const request = ++customersRequest;
  try {
    const { data, fresh } = await cachedRead("customers", "/customers");
    if (request !== customersRequest) return;
    if (!Array.isArray(data)) throw new Error("Missing customers");
    const knownIds = new Set(data.map(({ id }) => id));
    customers = [...data, ...customers.filter(({ id }) => !knownIds.has(id))];
    renderCustomers(payment.customer_id.value);
    byId("sale-customer-state").hidden = true;
    if (fresh) saveSnapshot("customers", customers);
  } catch {
    if (request !== customersRequest) return;
    byId("sale-customer-state").hidden = false;
  }
}

window.addEventListener("online", () => {
  setConnected(true);
  loadProducts();
  loadCustomers();
  syncRequested = true;
  flushRequestedSync();
});
window.addEventListener("offline", () => setConnected(false));
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/checkout" })
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      shellReady = true;
      setConnected(connected);
    })
    .catch(() => {
      cacheProblems.add("shell");
      setConnected(connected);
    });
} else {
  cacheProblems.add("shell");
}
setConnected(connected);
renderCustomers();
loadProducts();
loadCustomers();
syncQueue();
