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
let catalogLoaded = false;
let confirmingPrice = false;
let customers = [];
let legacyPending = restorePending();
let staging = false;
let syncing = false;
let connected = navigator.onLine !== false;
const snapshotKeys = new Set();
const cacheProblems = new Set();
let shellReady = false;
let syncRequested = false;
let retryTimer = null;
const retryDelay = 10000;
let stagedDuringSync = new Set();
let queueRequest = 0;
let queueProblem = false;
let productsRequest = 0;
let customersRequest = 0;
let storeId = null;
let storeReady = false;
let observedStoreId = null;
let initializingStore = false;
let negativePayload = null;
let abandonPayload = null;
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

async function api(path, data, expectedStore = storeId) {
  const options = { signal: AbortSignal.timeout(15000) };
  if (expectedStore) options.headers = { "X-POS-Store-ID": expectedStore };
  if (data !== undefined) {
    options.method = "POST";
    options.headers = { ...options.headers, "Content-Type": "application/json" };
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
  if (error.code === "store_mismatch") blockStore("ฐานข้อมูลร้านเปลี่ยน กรุณาตรวจสอบก่อนขายหรือส่งบิล");
  throw error;
}

function blockStore(text, canBind = false, refreshQueue = true) {
  storeReady = false;
  byId("sale-new-customer").disabled = true;
  byId("sale-store-message").textContent = text;
  byId("sale-store-blocked").hidden = false;
  byId("sale-store-bind").hidden = !canBind;
  updatePayment();
  if (refreshQueue) showQueue();
}

async function verifyServerStore() {
  if (!storeReady || !storeId || navigator.onLine === false) return false;
  try {
    const observed = (await api("/store-identity")).id;
    if (observed !== storeId) {
      blockStore("ฐานข้อมูลร้านเปลี่ยน กรุณากลับไปเปิดฐานข้อมูลเดิมแล้วโหลดหน้านี้ใหม่เพื่อตรวจสอบบิลค้าง");
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function initializeStore() {
  if (initializingStore) return;
  initializingStore = true;
  try {
    storeId = await store.getBinding();
    const queued = await store.list();
    if (navigator.onLine !== false) {
      try { observedStoreId = (await api("/store-identity")).id; } catch { observedStoreId = null; }
    }
    if (observedStoreId) {
      if (!storeId && !queued.length && !legacyPending) {
        const result = await store.bindStore(observedStoreId);
        if (!result.bound) throw new Error("Store binding changed");
        storeId = observedStoreId;
      }
      if (storeId !== observedStoreId || legacyPending) {
        const canBind = (!storeId || storeId === observedStoreId || (!queued.length && !legacyPending));
        blockStore(storeId && storeId !== observedStoreId
          ? "ฐานข้อมูลร้านไม่ตรงกับข้อมูลในเครื่อง (ในเครื่อง " + storeId + " · เซิร์ฟเวอร์ " + observedStoreId + ") กรุณาตรวจสอบบิลค้างก่อนเปลี่ยนร้าน"
          : "บิลเดิมยังไม่ระบุร้าน กรุณาตรวจสอบว่าเป็นของฐานข้อมูลนี้ก่อนยืนยัน", canBind);
        return;
      }
    } else if (!storeId || legacyPending) {
      blockStore("ยังไม่ทราบฐานข้อมูลของเครื่องนี้ กรุณาเชื่อมต่อและตรวจสอบก่อนขาย");
      return;
    }
    storeReady = true;
    byId("sale-store-blocked").hidden = true;
    setConnected(connected);
    updatePayment();
    loadProducts();
    loadCustomers();
    syncQueue();
  } catch {
    blockStore("ตรวจสอบข้อมูลร้านในเครื่องไม่ได้ กรุณาตรวจสอบพื้นที่จัดเก็บและสำรองบิล");
  } finally {
    initializingStore = false;
  }
}

byId("sale-store-bind")?.addEventListener("click", () => {
  if (!observedStoreId) return;
  byId("sale-store-confirm-id").textContent = "รหัสฐานข้อมูล " + observedStoreId;
  byId("sale-store-confirm-message").textContent = storeId && storeId !== observedStoreId
    ? "เปลี่ยนไปใช้ฐานข้อมูลนี้ได้เมื่อไม่มีบิลค้าง ข้อมูลสินค้าและลูกค้าในเครื่องจะถูกโหลดใหม่"
    : "บิลเดิมไม่มีรหัสร้าน กรุณายืนยันว่าบิลค้างทั้งหมดเป็นของฐานข้อมูลนี้ การยืนยันผิดอาจส่งบิลเข้าร้านผิด";
  byId("sale-store-confirm").showModal();
});
byId("sale-store-cancel")?.addEventListener("click", () => byId("sale-store-confirm").close());
byId("sale-store-confirm-button")?.addEventListener("click", async () => {
  const button = byId("sale-store-confirm-button");
  button.disabled = true;
  try {
    const current = (await api("/store-identity")).id;
    if (current !== observedStoreId) throw new Error("Store changed");
    const result = await store.bindStore(current, { acceptLegacy: !storeId, allowSwitch: Boolean(storeId), expectedCurrent: storeId });
    if (!result.bound) throw new Error("Pending queue or store changed");
    storeId = current;
    if (legacyPending) await migrateLegacy();
    byId("sale-store-confirm").close();
    location.reload();
  } catch {
    byId("sale-store-confirm-message").textContent = "ยืนยันไม่สำเร็จ กรุณาตรวจสอบฐานข้อมูลและบิลค้างแล้วลองใหม่";
  } finally { button.disabled = false; }
});

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

function lineTotal(item, allowQuantityExponent = false) {
  const quantity = boundedDecimal(item.quantity, 6, allowQuantityExponent);
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
  const matches = products.filter((product) => product.available !== false && (
    product.name.toLowerCase().includes(query) || product.code.toLowerCase().includes(query)
  ));
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
    if (item.issue) title.append(element("small", item.issue === "price"
      ? "ราคาเปลี่ยนแล้ว กรุณาตรวจสอบและยืนยันราคาล่าสุด หรือเอาสินค้าออก"
      : "สินค้านี้พักขายหรือหน่วยขายไม่พร้อมใช้ กรุณาเอาออกจากตะกร้า", "error"));
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
    row.append(title, label);
    if (item.issue === "price") {
      const latestUnit = item.priceUnit;
      if (latestUnit) {
        const accept = element("button", "ใช้ราคาล่าสุด " + displayDecimal(latestUnit.price) + " บาท", "secondary");
        accept.type = "button";
        accept.disabled = confirmingPrice || staging;
        accept.setAttribute("aria-label", "ใช้ราคาล่าสุด " + item.product.name + " " + item.unit.name + " " + displayDecimal(latestUnit.price) + " บาท");
        accept.addEventListener("click", () => acceptLatestPrice(item, latestUnit.price));
        row.append(accept);
      }
    }
    row.append(remove);
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
  const tenderField = payment.tender;
  const tenderSection = byId("sale-tender");
  const change = byId("sale-change");
  let tenderInvalid = false;
  if (tenderField && tenderSection && change) {
    tenderSection.hidden = !(paid.cash > 0n);
    if (paid.cash === 0n) tenderField.value = "";
    const text = tenderField.value.trim();
    const tender = text ? boundedDecimal(text, 2, false, 10n ** 22n) : null;
    tenderInvalid = Boolean(text) && (tender === null || tender < paid.cash);
    change.textContent = !text ? "" : tender === null
      ? "กรอกเงินสดที่รับเป็นตัวเลขทศนิยมไม่เกิน 2 ตำแหน่ง"
      : tender < paid.cash ? "เงินสดที่รับน้อยกว่ายอดเงินสดที่ชำระ" : "เงินทอน " + money(tender - paid.cash);
  }
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
  byId("sale-submit").disabled = !storeReady || staging || confirmingPrice || !cart.size || [...cart.values()].some((item) => item.issue) || difference !== 0n || tenderInvalid
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
  byId("sale-new-customer").disabled = !connected || !storeReady;
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
    entries = storeReady ? await store.listForStore(storeId) : await store.list();
    if (request !== queueRequest) return;
    queueProblem = false;
  } catch (error) {
    if (request !== queueRequest) return;
    if (error.message === "Store binding changed") blockStore("ฐานข้อมูลที่ผูกกับแท็บนี้เปลี่ยน กรุณาโหลดหน้าใหม่เพื่อตรวจสอบ", false, false);
    queueProblem = true;
    entries = [];
  }
  const pendingCount = entries.filter(({ state }) => state === "pending").length;
  const conflictCount = entries.filter(({ state }) => state === "conflict").length;
  if ((!pendingCount && !legacyPending) || navigator.onLine === false || queueProblem) {
    clearTimeout(retryTimer);
    retryTimer = null;
  } else if (retryTimer === null) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (navigator.onLine === false) return;
      if (syncing || staging) {
        showQueue();
      } else {
        syncQueue();
      }
    }, retryDelay);
  }
  byId("sale-pending").hidden = !entries.length && !legacyPending && !queueProblem;
  byId("sale-retry").disabled = !storeReady || syncing || staging || (!pendingCount && !legacyPending);
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
    if (byId("sale-queue-detail")) {
      const details = element("button", "ดูรายละเอียด", "secondary");
      details.type = "button";
      details.setAttribute("aria-label", "ดูรายละเอียดบิล " + payload.id);
      details.addEventListener("click", () => showQueuedSale(payload, state, error));
      row.append(details);
    }
    if (state === "conflict") {
      const retry = element("button", "ลองส่งอีกครั้ง", "secondary");
      retry.type = "button";
      retry.disabled = !storeReady || syncing || staging;
      retry.setAttribute("aria-label", "ลองส่งบิล " + payload.id + " อีกครั้ง");
      retry.addEventListener("click", () => retryQueue(payload.id));
      row.append(retry);
      if (byId("sale-abandon")) {
        const abandon = element("button", "ยกเลิกบิลค้าง", "secondary");
        abandon.type = "button";
        abandon.disabled = !storeReady || syncing || staging;
        abandon.setAttribute("aria-label", "ยกเลิกบิลค้าง " + payload.id);
        abandon.addEventListener("click", () => {
          if (syncing || staging) return;
          abandonPayload = payload;
          byId("sale-abandon-reference").textContent = "เลขบิล " + payload.id;
          byId("sale-abandon").showModal();
        });
        row.append(abandon);
      }
      if (!payload.offline && error === saleErrors.insufficient_stock && byId("sale-negative")) {
        const confirm = element("button", "ขายต่อแม้สต๊อกไม่พอ", "secondary");
        confirm.type = "button";
        confirm.disabled = !storeReady || syncing || staging;
        confirm.setAttribute("aria-label", "ขายบิล " + payload.id + " แม้สต๊อกไม่พอ");
        confirm.addEventListener("click", () => openNegativeConfirmation(payload));
        row.append(confirm);
      }
    }
    return row;
  }));
}

function showQueuedSale(payload, state, error) {
  byId("sale-queue-detail-reference").textContent = "เลขบิล " + payload.id;
  byId("sale-queue-detail-state").textContent = state === "conflict" ? "ต้องตรวจสอบ · " + (error || "ไม่ทราบสาเหตุ") : "รอส่งข้อมูล";
  const time = payload.sold_at ? new Date(payload.sold_at) : null;
  byId("sale-queue-detail-time").textContent = time && Number.isFinite(time.getTime())
    ? "เวลาขาย (เวลาไทย) " + new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(time)
    : "ไม่มีเวลาขายที่บันทึกในบิลค้าง";
  byId("sale-queue-detail-items").replaceChildren(...payload.items.map((item) => {
    const product = products.find(({ id }) => id === item.product_id);
    const unit = product?.units.find(({ id }) => id === item.unit_id);
    const amount = lineTotal({ quantity: item.quantity, unit: { price: item.expected_unit_price } }, true);
    const row = element("li");
    row.append(element("span", (product?.name ?? item.product_id) + " · " + (unit?.name ?? item.unit_id)
      + " × " + displayDecimal(item.quantity) + " · ราคาที่บันทึก " + displayDecimal(item.expected_unit_price) + " บาท"),
      element("strong", amount === null ? "ตรวจสอบจำนวนหรือราคา" : money(amount)));
    return row;
  }));
  const paid = paymentMethods.map((method) => scaledDecimal(payload.payments[method], 2, true));
  const total = paid.includes(null) ? null : paid.reduce((sum, amount) => sum + amount, 0n);
  byId("sale-queue-detail-total").textContent = "ยอดชำระรวม " + (total === null ? "ตรวจสอบยอดในไฟล์สำรอง" : money(total));
  byId("sale-queue-detail-payments").replaceChildren(...paymentMethods.map((method, index) =>
    element("li", paymentLabels[method] + " · " + (paid[index] === null ? "ตรวจสอบยอดในไฟล์สำรอง" : money(paid[index])))));
  byId("sale-queue-detail-customer").textContent = "ลูกค้า " + (payload.customer_id
    ? customers.find(({ id }) => id === payload.customer_id)?.name ?? payload.customer_id : "ไม่ระบุ");
  byId("sale-queue-detail").showModal();
}

byId("sale-queue-detail-close")?.addEventListener("click", () => byId("sale-queue-detail").close());

async function migrateLegacy() {
  if (!legacyPending) return;
  await store.put(legacyPending, storeId);
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
    created_at: payload.sold_at ?? new Date().toISOString(),
    total: moneyString(cartTotal()),
    customer_name: customers.find(({ id }) => id === payload.customer_id)?.name,
    items: [...cart.values()].map((item) => ({
      name: item.product.name, unit_name: item.unit.name, quantity: item.quantity,
      total: moneyString(lineTotal(item)),
    })),
  };
}

function hasStockShortage(sale) {
  return sale?.stock_shortages?.some(({ remaining }) => Number(remaining) > 0) ?? false;
}

function showReceipt(sale, state = "synced", change = null) {
  const temporary = state !== "synced";
  byId("sale-receipt-title").textContent = temporary ? "หลักฐานการขายจากเครื่องนี้" : "ใบเสร็จรับเงิน";
  byId("sale-receipt-state").textContent = state === "conflict"
    ? "ต้องตรวจสอบก่อนบันทึกเข้าระบบ" : "รอส่งข้อมูลเข้าระบบ";
  const shortage = hasStockShortage(sale);
  if (shortage) byId("sale-receipt-state").textContent = "ส่งบิลแล้ว · ตรวจสอบสต๊อกติดลบที่หน้าสินค้าและสต๊อก";
  byId("sale-receipt-state").hidden = !temporary && !shortage;
  byId("sale-receipt-id").textContent = "เลขอ้างอิง " + sale.id;
  const soldAt = sale.sold_at ?? sale.created_at;
  const timestamp = new Date(soldAt.replace(" ", "T"));
  byId("sale-receipt-date").textContent = Number.isNaN(timestamp.getTime())
    ? soldAt
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
  const changeLine = byId("sale-receipt-change");
  if (changeLine) {
    changeLine.hidden = change === null;
    changeLine.textContent = change === null ? "" : "เงินทอน " + money(change);
  }
  byId("sale-receipt").showModal();
}

const saleErrors = {
  price_changed: "ราคาสินค้าเปลี่ยน กรุณาตรวจสอบราคาและยอดชำระใหม่",
  insufficient_stock: "สินค้าคงเหลือไม่พอ กรุณาตรวจสอบจำนวนในตะกร้า",
  item_unavailable: "สินค้าหรือหน่วยขายบางรายการไม่พร้อมขาย กรุณาตรวจสอบตะกร้า",
  idempotency_conflict: "เลขอ้างอิงนี้ถูกใช้แล้ว กรุณาตรวจสอบบิลก่อนปิดบิลใหม่",
  sale_abandoned: "บิลนี้ถูกยกเลิกแล้ว กรุณายกเลิกบิลค้างออกจากเครื่อง",
};

byId("sale-abandon-cancel")?.addEventListener("click", () => byId("sale-abandon").close());
byId("sale-abandon-confirm")?.addEventListener("click", async () => {
  const payload = abandonPayload;
  if (!storeReady || !payload || syncing || staging) return;
  const expectedStore = storeId;
  syncing = true;
  byId("sale-abandon").close();
  try {
    await showQueue();
    await api("/sales/" + encodeURIComponent(payload.id) + "/abandon", {}, expectedStore);
    await store.remove(payload.id, expectedStore);
    status("ยกเลิกบิลค้างแล้ว สามารถเริ่มบิลใหม่ได้");
  } catch (error) {
    if (error.code === "sale_already_recorded") {
      status("บิลนี้บันทึกแล้ว กรุณาส่งบิลเดิมอีกครั้งเพื่อตรวจสอบผล", true);
    } else {
      status("ยังยืนยันการยกเลิกไม่ได้ บิลยังอยู่ในเครื่อง กรุณาลองอีกครั้ง", true);
    }
  } finally {
    syncing = false;
    abandonPayload = null;
    await showQueue();
    flushRequestedSync();
  }
});

async function syncSale(payload, allowNegative = false, expectedStore = storeId) {
  let sale;
  try {
    sale = await api(allowNegative ? "/sales/allow-negative" : payload.offline ? "/offline-sales" : "/sales", payload, expectedStore);
  } catch (failure) {
    if (failure.code === "store_mismatch" || ![400, 404, 409, 413, 415, 422].includes(failure.status)) return { state: "pending" };
    const reason = saleErrors[failure.code] ?? "บันทึกบิลไม่สำเร็จ กรุณาตรวจสอบรายการและยอดชำระ";
    await store.update(payload.id, "conflict", reason, expectedStore);
    return { state: "conflict", reason };
  }
  try {
    await store.remove(payload.id, expectedStore);
  } catch {
    // The server has confirmed the sale. Retrying the retained identifier is safe.
    status("บันทึกบิลแล้ว แต่ล้างคิวในเครื่องไม่สำเร็จ", true);
  }
  return { state: "synced", sale };
}

function openNegativeConfirmation(payload) {
  if (!storeReady || syncing || staging || payload.offline) return;
  negativePayload = payload;
  byId("sale-negative-reference").textContent = "เลขบิล " + payload.id;
  byId("sale-negative-items").replaceChildren(...payload.items.map((item) => {
    const product = products.find(({ id }) => id === item.product_id);
    const unit = product?.units.find(({ id }) => id === item.unit_id);
    return element("li", (product?.name ?? item.product_id) + " · " + (unit?.name ?? item.unit_id)
      + " × " + item.quantity + " · ราคา " + item.expected_unit_price + " บาท");
  }));
  byId("sale-negative-payments").replaceChildren(...paymentMethods.map((method) =>
    element("li", paymentLabels[method] + " · " + money(scaledDecimal(payload.payments[method], 2, true) ?? 0n))));
  const total = paymentMethods.reduce((sum, method) => sum + (scaledDecimal(payload.payments[method], 2, true) ?? 0n), 0n);
  byId("sale-negative-total").textContent = "ยอดชำระ " + money(total);
  byId("sale-negative").showModal();
}

byId("sale-negative-cancel")?.addEventListener("click", () => byId("sale-negative").close());
byId("sale-negative-confirm")?.addEventListener("click", async () => {
  const payload = negativePayload;
  if (!storeReady || !payload || syncing || staging) return;
  const expectedStore = storeId;
  syncing = true;
  byId("sale-negative").close();
  try {
    await showQueue();
    const result = await syncSale(payload, true, expectedStore);
    if (result.state === "synced") {
      const shortage = hasStockShortage(result.sale);
      status(shortage ? "บันทึกบิลแล้ว · ตรวจสอบสต๊อกติดลบที่หน้าสินค้าและสต๊อก" : "บันทึกบิลแล้ว", shortage);
      loadProducts();
      showReceipt(result.sale);
    } else if (result.state === "conflict") {
      status("บิลยังต้องตรวจสอบ · " + result.reason, true);
    } else {
      status("ยังไม่ทราบผล กรุณาตรวจสอบและยืนยันส่งบิลเดิมอีกครั้ง", true);
    }
  } catch {
    status("จัดการคิวในเครื่องไม่สำเร็จ กรุณาตรวจสอบบิลเดิมก่อนลองอีกครั้ง", true);
  } finally {
    syncing = false;
    negativePayload = null;
    await showQueue();
    flushRequestedSync();
  }
});

async function syncQueue(onlyId) {
  if (!storeReady || syncing || staging) return;
  const expectedStore = storeId;
  syncing = true;
  stagedDuringSync = new Set();
  let synced = 0;
  let conflicts = 0;
  let shortages = 0;
  let deferred = false;
  try {
    await showQueue();
    await migrateLegacy();
    if (navigator.onLine === false || !(await verifyServerStore()) || storeId !== expectedStore) return;
    for (const entry of await store.listForStore(expectedStore)) {
      if (stagedDuringSync.has(entry.payload.id)) continue;
      if (onlyId ? entry.payload.id !== onlyId : entry.state !== "pending") continue;
      let result = await syncSale(entry.payload, false, expectedStore);
      if (result.state === "pending" && navigator.onLine !== false) {
        // The online event can arrive before the network can carry requests.
        // Reuse the queued identifier if the server accepted the first attempt.
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (navigator.onLine !== false) result = await syncSale(entry.payload, false, expectedStore);
      }
      if (result.state === "synced") {
        synced++;
        if (hasStockShortage(result.sale)) shortages++;
      }
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
      if (shortages) parts.push("สต๊อกติดลบ " + shortages + " บิล · ตรวจที่หน้าสินค้าและสต๊อก");
      if (conflicts) parts.push("ต้องตรวจสอบ " + conflicts + " บิล");
      if (deferred) parts.push("ส่งข้อมูลไม่ได้ คิวบิลยังอยู่ในเครื่องนี้");
      status(parts.join(" · "), Boolean(conflicts || deferred || shortages));
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
  if (!storeReady || staging || byId("sale-submit").disabled) return;
  const expectedStore = storeId;
  const paid = amounts();
  const tenderText = payment.tender?.value.trim() ?? "";
  const tender = tenderText ? boundedDecimal(tenderText, 2, false, 10n ** 22n) : null;
  const change = tender === null ? null : tender - paid.cash;
  const payload = {
    id: crypto.randomUUID(),
    ...((!connected || navigator.onLine === false) ? { offline: true, sold_at: new Date().toISOString() } : {}),
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
    await store.put(payload, expectedStore);
    staged = true;
    let result = { state: "pending" };
    if (!queuedDuringSync && connected && navigator.onLine !== false) result = await syncSale(payload, false, expectedStore);
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
    showReceipt(result.sale ?? receipt, result.state, change);
  } catch (error) {
    if (staged) {
      cart.clear();
      paymentForm.reset();
      clearQr();
      renderCart();
      status("บันทึกบิลในเครื่องแล้ว · ตรวจสอบคิวก่อนส่งอีกครั้ง", true);
      showReceipt(receipt, "pending", change);
    } else if (error.message === "Store binding changed") {
      blockStore("ฐานข้อมูลที่ผูกกับแท็บนี้เปลี่ยน กรุณาโหลดหน้าใหม่เพื่อตรวจสอบ");
      status("ยังไม่ได้บันทึกบิล กรุณาตรวจสอบฐานข้อมูล", true);
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
byId("sale-search").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || staging) return;
  event.preventDefault();
  const search = event.currentTarget;
  const code = search.value.trim();
  if (!code) return;
  let matches = products.filter((product) => product.code.trim() === code);
  if (!matches.length) {
    matches = products.filter((product) => product.code.trim().toLowerCase() === code.toLowerCase());
  }
  if (matches.length !== 1) return;
  const product = matches[0];
  if (product.available === false) return;
  const unit = product.units.find((entry) => entry.name === product.base_unit);
  if (!unit) return;
  addItem(product, unit);
  search.value = "";
  renderProducts();
});
byId("sale-receipt-close").addEventListener("click", () => byId("sale-receipt").close());
byId("sale-print").addEventListener("click", () => window.print());

const customerDialog = byId("sale-customer");
const customerForm = customerDialog.querySelector("form");
const customerError = customerForm.querySelector(".error");
const customerSave = customerForm.querySelector("button:not([type])");
byId("sale-new-customer").addEventListener("click", () => {
  if (!connected || !storeReady) return;
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
  if (!connected || !storeReady) {
    customerError.textContent = "เพิ่มลูกค้าได้เมื่อเชื่อมต่อกับระบบ";
    customerError.hidden = false;
    return;
  }
  const name = customerForm.elements.name.value.trim();
  if (!name) return;
  customerSave.disabled = customerClose.disabled = true;
  const expectedStore = storeId;
  customerError.hidden = true;
  try {
    const customer = await api("/customers", { name }, expectedStore);
    if (storeId !== expectedStore || !storeReady) throw new Error("Store changed");
    customers.push(customer);
    renderCustomers(customer.id);
    saveSnapshot("customers", customers, expectedStore);
    customerDialog.close();
  } catch {
    customerError.textContent = "บันทึกลูกค้าไม่สำเร็จ กรุณาลองอีกครั้ง";
    customerError.hidden = false;
  } finally {
    customerSave.disabled = customerClose.disabled = false;
  }
});

async function saveSnapshot(key, value, expectedStore = storeId) {
  try {
    await store.putSnapshot(key, value, expectedStore);
    snapshotKeys.add(key);
    cacheProblems.delete(key);
  } catch (error) {
    if (error.message === "Store binding changed") blockStore("ฐานข้อมูลที่ผูกกับแท็บนี้เปลี่ยน กรุณาโหลดหน้าใหม่เพื่อตรวจสอบ");
    cacheProblems.add(key);
  }
  setConnected(connected);
}

async function cachedRead(key, path, expectedStore) {
  if (navigator.onLine !== false) {
    try {
      return { data: await api(path, undefined, expectedStore), fresh: true };
    } catch {
      // Keep the last successful server snapshot for disconnected sales.
    }
  }
  const data = await store.getSnapshot(key, expectedStore);
  if (Array.isArray(data)) snapshotKeys.add(key);
  setConnected(connected);
  return { data, fresh: false };
}

async function loadProducts() {
  const request = ++productsRequest;
  const expectedStore = storeId;
  try {
    const { data, fresh } = await cachedRead("products", "/products", expectedStore);
    if (request !== productsRequest || storeId !== expectedStore || !storeReady) return false;
    if (!Array.isArray(data)) throw new Error("Missing products");
    products = data;
    catalogLoaded = true;
    setCatalogStale(!fresh || navigator.onLine === false);
    renderProducts();
    if (fresh && navigator.onLine !== false) {
      for (const item of cart.values()) {
        const product = data.find((entry) => entry.id === item.product.id);
        const unit = product?.units.find((entry) => entry.id === item.unit.id);
        item.issue = !product || product.available === false || !unit ? "unavailable"
          : boundedDecimal(unit.price, 6, true) !== boundedDecimal(item.unit.price, 6, true) ? "price" : null;
        item.priceUnit = item.issue === "price" ? unit : null;
      }
      renderCart();
    }
    if (fresh) saveSnapshot("products", data, expectedStore);
    return fresh && navigator.onLine !== false;
  } catch {
    if (request !== productsRequest) return;
    setCatalogStale(catalogLoaded);
    if (!catalogLoaded) {
      byId("sale-products-state").textContent = "ยังไม่มีข้อมูลสินค้าในเครื่อง กรุณาเปิดหน้านี้ขณะออนไลน์";
      byId("sale-products-state").hidden = false;
    }
    return false;
  }
}

async function acceptLatestPrice(item, shownPrice) {
  if (confirmingPrice || staging) return;
  confirmingPrice = true;
  renderCart();
  try {
    const fresh = await loadProducts();
    if (!fresh) {
      status("โหลดราคาล่าสุดไม่สำเร็จ กรุณาลองอีกครั้ง", true);
      return;
    }
    if (cart.get(item.unit.id) !== item || item.issue !== "price") return;
    const product = products.find((entry) => entry.id === item.product.id);
    const unit = product?.units.find((entry) => entry.id === item.unit.id);
    if (!unit || boundedDecimal(unit.price, 6, true) !== boundedDecimal(shownPrice, 6, true)) {
      status("ราคาเปลี่ยนอีกครั้ง กรุณาตรวจสอบราคาล่าสุดก่อนยืนยัน", true);
      return;
    }
    item.product = product;
    item.unit = unit;
    item.issue = null;
    item.priceUnit = null;
    status("อัปเดตราคาแล้ว กรุณาตรวจสอบยอดชำระ");
  } finally {
    confirmingPrice = false;
    renderCart();
  }
}

function setCatalogStale(stale) {
  // The cached shell can temporarily be older than the script during an update.
  const warning = byId("sale-products-cached");
  const refresh = byId("sale-products-refresh");
  if (warning) warning.hidden = !stale;
  if (refresh) refresh.hidden = !stale;
}

byId("sale-products-refresh")?.addEventListener("click", loadProducts);

async function loadCustomers() {
  const request = ++customersRequest;
  const expectedStore = storeId;
  try {
    const { data, fresh } = await cachedRead("customers", "/customers", expectedStore);
    if (request !== customersRequest || storeId !== expectedStore || !storeReady) return;
    if (!Array.isArray(data)) throw new Error("Missing customers");
    const knownIds = new Set(data.map(({ id }) => id));
    customers = [...data, ...customers.filter(({ id }) => !knownIds.has(id))];
    renderCustomers(payment.customer_id.value);
    byId("sale-customer-state").hidden = true;
    if (fresh) saveSnapshot("customers", customers, expectedStore);
  } catch {
    if (request !== customersRequest) return;
    byId("sale-customer-state").hidden = false;
  }
}

const storageStatus = byId("sale-storage-status");
const persistButton = byId("sale-storage-persist");
async function checkStorage() {
  if (!navigator.storage?.persisted || !navigator.storage?.persist) {
    storageStatus.textContent = "เบราว์เซอร์นี้ไม่รองรับการขอเก็บข้อมูลถาวร กรุณาสำรองบิลในเครื่อง";
    persistButton.hidden = true;
    return;
  }
  try {
    const persistent = await navigator.storage.persisted();
    storageStatus.textContent = persistent
      ? "เบราว์เซอร์อนุญาตให้เก็บข้อมูลถาวรแล้ว การล้างข้อมูลเว็บไซต์ยังลบบิลในเครื่องได้"
      : "ยังไม่ได้รับอนุญาตให้เก็บข้อมูลถาวร กรุณาสำรองบิลในเครื่อง";
    persistButton.hidden = persistent;
  } catch {
    storageStatus.textContent = "ตรวจสอบพื้นที่เก็บข้อมูลไม่ได้ กรุณาสำรองบิลในเครื่อง";
    persistButton.hidden = true;
  }
}
persistButton?.addEventListener("click", async () => {
  persistButton.disabled = true;
  try {
    await navigator.storage.persist();
    await checkStorage();
  } catch {
    storageStatus.textContent = "ขอเก็บข้อมูลถาวรไม่สำเร็จ กรุณาสำรองบิลในเครื่อง";
  } finally {
    persistButton.disabled = false;
  }
});
if (storageStatus && persistButton) checkStorage();

window.addEventListener("online", async () => {
  setConnected(true);
  if (!storeReady) { initializeStore(); return; }
  if (!(await verifyServerStore())) {
    // The online event can fire before the server is reachable. Keep the
    // automatic retry timer active even when the identity check fails.
    await showQueue();
    if (storeReady) {
      try {
        const entries = await store.listForStore(storeId);
        if (entries.some(({ state }) => state === "pending") || legacyPending) {
          status("ส่งข้อมูลไม่ได้ คิวบิลยังอยู่ในเครื่องนี้", true);
        }
      } catch {
        status("อ่านคิวในเครื่องไม่สำเร็จ กรุณาตรวจสอบพื้นที่จัดเก็บของเบราว์เซอร์", true);
      }
    }
    return;
  }
  loadProducts();
  loadCustomers();
  syncRequested = true;
  flushRequestedSync();
});
window.addEventListener("offline", () => {
  clearTimeout(retryTimer);
  retryTimer = null;
  setConnected(false);
  setCatalogStale(catalogLoaded);
});
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
initializeStore();
