const byId = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 6 });
const historyDateFormat = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Bangkok",
});
let products = [];
let displayedProducts = [];
let selectedId = null;
let historyRequest = 0;
let editingProduct;
let editingUnit;
let changingAvailability = false;

const format = (value) => numberFormat.format(Number(value));
// SQLite CURRENT_TIMESTAMP has no zone suffix but is in UTC.
function historyDate(value) {
  const timestamp = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(timestamp.getTime()) ? value.slice(0, 10) : historyDateFormat.format(timestamp);
}
const productPath = (id) => "/products/" + encodeURIComponent(id);

async function api(path, data) {
  const options = data ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  } : undefined;
  if (options) options.signal = AbortSignal.timeout(15000);
  const response = await fetch(path, options);
  if (response.ok) return response.json();
  const { code } = await response.json().catch(() => ({}));
  const message = {
    400: "ตรวจสอบข้อมูลที่กรอกหรือหน่วยที่เลือก",
    404: "ไม่พบสินค้าที่เลือก",
    409: "รหัสสินค้าหรือชื่อหน่วยขายซ้ำ",
  }[response.status] ?? "เชื่อมต่อระบบสต๊อกไม่สำเร็จ";
  throw Object.assign(new Error(message), { status: response.status, code });
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function notice(message, error = false) {
  const node = byId("notice");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = !message;
}

function renderList() {
  const query = byId("search").value.trim().toLowerCase();
  const filter = byId("stock-filter").value;
  const matches = products.filter((product) => {
    if (!product.name.toLowerCase().includes(query) && !product.code.toLowerCase().includes(query)) return false;
    if (filter === "low") return product.available !== false && Number(product.quantity) >= 0 && product.low_stock;
    if (filter === "negative") return Number(product.quantity) < 0;
    if (filter === "paused") return product.available === false;
    return true;
  });
  displayedProducts = matches;
  byId("stock-download").disabled = !matches.length;
  if (selectedId && !matches.some((product) => product.id === selectedId)) {
    selectedId = null;
    renderDetail();
  }
  byId("products").replaceChildren(...matches.map((product) => {
    const item = document.createElement("li");
    const button = element("button", "");
    button.type = "button";
    button.setAttribute("aria-pressed", String(product.id === selectedId));
    const name = element("span", product.name);
    name.append(element("small", product.code));
    if (product.available === false) name.append(element("small", "พักขาย"));
    const stock = element("span", format(product.quantity) + " " + product.base_unit);
    if (product.low_stock) {
      const low = element("small", Number(product.quantity) < 0 ? "สต๊อกติดลบ" : "ใกล้หมด");
      low.className = "low";
      stock.append(low);
    }
    button.append(name, stock);
    button.addEventListener("click", () => {
      selectedId = product.id;
      for (const row of byId("products").querySelectorAll("button")) {
        row.setAttribute("aria-pressed", String(row === button));
      }
      renderDetail();
    });
    item.append(button);
    return item;
  }));
  const state = byId("list-state");
  state.textContent = query || filter !== "all" ? "ไม่พบสินค้าที่ตรงกับตัวกรอง" : "ยังไม่มีสินค้า";
  state.hidden = matches.length > 0;
}

function line(label, value) {
  const row = document.createElement("li");
  row.append(element("span", label), element("span", value));
  return row;
}

async function renderDetail() {
  const request = ++historyRequest;
  const product = products.find((entry) => entry.id === selectedId);
  byId("detail").hidden = !product;
  byId("detail-empty").hidden = Boolean(product);
  byId("detail-title").textContent = product?.name ?? "รายละเอียดสินค้า";
  if (!product) return;
  byId("code").textContent = product.code;
  byId("availability").textContent = product.available === false ? "สถานะ พักขาย" : "สถานะ พร้อมขาย";
  byId("toggle-availability").textContent = product.available === false ? "เปิดขายอีกครั้ง" : "พักขาย";
  byId("toggle-availability").disabled = changingAvailability;
  byId("minimum-quantity").textContent =
    "แจ้งเตือนเมื่อเหลือไม่เกิน " + format(product.minimum_quantity) + " " + product.base_unit;
  const negative = Number(product.quantity) < 0;
  byId("quantity").textContent = format(product.quantity) + " " + product.base_unit;
  byId("stock-shortage").hidden = !negative;
  byId("stock-shortage").textContent = negative
    ? "สต๊อกติดลบ ตรวจนับเพื่อปรับยอด หรือบันทึกรับสินค้าเมื่อมีสินค้าเข้า"
    : "";
  byId("average").textContent = product.average_cost === null
    ? "ยังไม่มีต้นทุน"
    : format(product.average_cost) + " บาท / " + product.base_unit;
  byId("units").replaceChildren(...product.units.map((unit) => {
    const row = line(unit.name + " · " + format(unit.multiplier) + " " + product.base_unit, format(unit.price) + " บาท");
    const price = row.lastElementChild;
    price.className = "unit-price-actions";
    const edit = element("button", "แก้ไขราคา");
    edit.type = "button";
    edit.className = "secondary";
    edit.setAttribute("aria-label", "แก้ไขราคา " + unit.name);
    edit.addEventListener("click", () => {
      editingUnit = { productId: product.id, id: unit.id, price: unit.price };
      byId("unit-price-description").textContent = product.name + " · " + unit.name;
      openEdit("unit-price", { price: unit.price });
    });
    price.append(edit);
    return row;
  }));
  await Promise.all([
    renderHistory("receipts", product, request, "ยังไม่มีรายการรับสินค้า", "โหลดประวัติรับสินค้าไม่สำเร็จ", (row) =>
      line(format(row.quantity) + " " + row.unit_name + " · " + historyDate(row.created_at),
        format(row.unit_cost) + " บาท / " + row.unit_name)),
    renderHistory("stock-counts", product, request, "ยังไม่มีรายการปรับยอด", "โหลดประวัติปรับยอดไม่สำเร็จ", (row) =>
      stockCountRow(row, product.base_unit)),
  ]);
}

async function renderHistory(resource, product, request, emptyText, errorText, renderRow) {
  const list = byId(resource);
  list.replaceChildren(element("li", "กำลังโหลดประวัติ…"));
  try {
    const rows = await api(productPath(product.id) + "/" + resource);
    if (request !== historyRequest) return;
    list.replaceChildren(...(rows.length ? rows.map(renderRow) : [element("li", emptyText)]));
  } catch {
    if (request === historyRequest) list.replaceChildren(element("li", errorText));
  }
}

function stockCountRow(row, unit) {
  const change = Number(row.delta) > 0 ? "+" + format(row.delta) : format(row.delta);
  const rowNode = line(format(row.expected_quantity) + " → " + format(row.counted_quantity) + " " + unit, change + " " + unit);
  const summary = rowNode.firstElementChild;
  summary.append(element("small", row.reason + " · " + historyDate(row.created_at)));
  if (row.unit_cost != null) {
    summary.append(element("small", "ต้นทุนที่ใช้ปรับยอด " + format(row.unit_cost) + " บาท / " + unit));
  }
  return rowNode;
}

async function refresh() {
  products = await api("/products");
  renderList();
  await renderDetail();
}

byId("search").addEventListener("input", renderList);
byId("stock-filter").addEventListener("change", renderList);
byId("stock-download").addEventListener("click", () => {
  if (!displayedProducts.length) return;
  const { cell, download } = window.PosCsv;
  const headers = ["รหัสสินค้า", "ชื่อสินค้า", "หน่วยสต๊อก", "คงเหลือ", "จำนวนขั้นต่ำ", "ต้นทุนเฉลี่ย", "สถานะขาย", "สถานะสต๊อก"];
  const rows = displayedProducts.map((product) => [
    cell(product.code, true), cell(product.name, true), cell(product.base_unit, true),
    cell(product.quantity), cell(product.minimum_quantity), cell(product.average_cost),
    product.available === false ? "พักขาย" : "พร้อมขาย",
    Number(product.quantity) < 0 ? "สต๊อกติดลบ" : product.low_stock ? "ใกล้หมด" : "ปกติ",
  ]);
  download("stock-" + byId("stock-filter").value + ".csv", [headers, ...rows]);
});
byId("toggle-availability").addEventListener("click", async () => {
  const product = products.find((entry) => entry.id === selectedId);
  if (!product || changingAvailability) return;
  const desired = product.available === false;
  changingAvailability = true;
  byId("toggle-availability").disabled = true;
  notice("");
  try {
    const result = await api(productPath(product.id) + "/availability", { available: desired });
    product.available = result.available;
    const current = products.find((entry) => entry.id === product.id);
    if (current) current.available = result.available;
    try {
      await refresh();
    } catch {
      renderList();
      await renderDetail();
      notice("บันทึกสถานะแล้ว แต่โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณารีเฟรชหน้า", true);
      return;
    }
    notice(desired ? "เปิดขายสินค้าแล้ว" : "พักขายสินค้าแล้ว");
  } catch {
    notice("บันทึกสถานะไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อและรีเฟรชหน้า", true);
  } finally {
    changingAvailability = false;
    byId("toggle-availability").disabled = false;
  }
});
document.querySelectorAll("[data-open]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = byId(button.dataset.open);
    if (dialog.id === "receipt" && receiptProblem) return;
    if (dialog.id === "receipt" && pendingReceipt) {
      openPendingReceipt();
      return;
    }
    const form = dialog.querySelector("form");
    form.reset();
    form.querySelector(".error").hidden = true;
    if (dialog.id === "receipt") {
      form.querySelectorAll("input, select").forEach((field) => { field.disabled = false; });
      const product = products.find((entry) => entry.id === selectedId);
      receiptProduct = product;
      byId("receipt-product").textContent = product.name + " · " + product.code;
      const options = product.units.map((unit) => {
        const option = element("option", unit.name);
        option.value = unit.id;
        return option;
      });
      form.elements.unit_id.replaceChildren(...options);
    }
    dialog.showModal();
  });
});

function openEdit(dialogId, fields) {
  const dialog = byId(dialogId);
  const form = dialog.querySelector("form");
  form.reset();
  form.querySelector(".error").hidden = true;
  for (const [field, value] of Object.entries(fields)) form.elements[field].value = value;
  dialog.showModal();
}

byId("open-product-edit").addEventListener("click", () => {
  const product = products.find((entry) => entry.id === selectedId);
  if (!product) return;
  const { id, code, name, minimum_quantity } = product;
  const expected = { code, name, minimum_quantity };
  editingProduct = { id, expected };
  openEdit("product-edit", expected);
});

const actions = {
  product: { path: () => "/products", success: "เพิ่มสินค้าแล้ว" },
  unit: { path: () => productPath(selectedId) + "/units", success: "เพิ่มหน่วยขายแล้ว" },
  "product-edit": {
    path: () => productPath(editingProduct.id) + "/edit",
    payload: (data) => ({ ...data, expected: editingProduct.expected }),
    success: "แก้ไขสินค้าแล้ว",
    staleCode: "product_changed",
  },
  "unit-price": {
    path: () => productPath(editingUnit.productId) + "/units/" + encodeURIComponent(editingUnit.id) + "/price",
    payload: (data) => ({ ...data, expected_price: editingUnit.price }),
    success: "แก้ไขราคาขายแล้ว",
    staleCode: "price_changed",
  },
};

document.querySelectorAll("dialog:not(#stock-count):not(#receipt)").forEach((dialog) => {
  const form = dialog.querySelector("form");
  const buttons = [...form.querySelectorAll("button")];
  const error = form.querySelector(".error");
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (buttons.some((button) => button.disabled)) event.preventDefault();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (buttons.some((button) => button.disabled)) return;
    const data = Object.fromEntries(new FormData(form));
    if (data.minimum_quantity === "") delete data.minimum_quantity;
    const action = actions[dialog.id];
    buttons.forEach((button) => { button.disabled = true; });
    error.hidden = true;
    try {
      const result = await api(action.path(), action.payload ? action.payload(data) : data);
      if (dialog.id === "product") {
        selectedId = result.id;
        byId("search").value = "";
        byId("stock-filter").value = "all";
      }
      dialog.close();
      notice(action.success);
      try {
        await refresh();
      } catch {
        notice(action.success + " แต่โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณารีเฟรชหน้า", true);
      }
    } catch (failure) {
      if (action.staleCode && failure.code === action.staleCode) {
        dialog.close();
        notice("ข้อมูลเปลี่ยนระหว่างแก้ไข กรุณาตรวจสอบข้อมูลล่าสุดก่อนบันทึกอีกครั้ง", true);
        try {
          await refresh();
        } catch {
          notice("โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณารีเฟรชหน้าก่อนแก้ไขอีกครั้ง", true);
        }
        return;
      }
      error.textContent = failure instanceof TypeError
        ? "ขาดการเชื่อมต่อ กรุณาตรวจสอบรายการก่อนบันทึกซ้ำ"
        : failure.message;
      error.hidden = false;
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  });
});

const receiptDialog = byId("receipt");
const receiptForm = receiptDialog.querySelector("form");
const receiptError = receiptForm.querySelector(".error");
function readStoredRequest(key, valid) {
  let raw;
  try { raw = sessionStorage.getItem(key); } catch { return { problem: true, available: false, value: null }; }
  if (raw === null) return { problem: false, available: false, value: null };
  try {
    const value = JSON.parse(raw);
    if (valid(value)) return { problem: false, available: true, value };
  } catch { /* Preserve raw data for export. */ }
  return { problem: true, available: true, value: null };
}
function exportStoredRequest(key, filename) {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) throw new Error("Request unavailable");
    const url = URL.createObjectURL(new Blob([JSON.stringify(raw)], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { notice("ดาวน์โหลดข้อมูลเดิมไม่ได้ กรุณาอย่าปิดแท็บและติดต่อผู้ดูแล", true); }
}
const receiptStorageKey = "pos-pending-receipt";
const receiptRestore = readStoredRequest(receiptStorageKey, (value) =>
  typeof value?.productId === "string" && typeof value.unitName === "string"
  && ["id", "unit_id", "quantity", "unit_cost"].every((key) => typeof value.payload?.[key] === "string"));
let pendingReceipt = receiptRestore.value;
const receiptProblem = receiptRestore.problem;
let receiptStored = true;
let savingReceipt = false;
let receiptProduct = null;
function setPendingReceipt(value) {
  if (receiptProblem) return;
  pendingReceipt = value;
  receiptStored = true;
  try {
    if (value) sessionStorage.setItem(receiptStorageKey, JSON.stringify(value));
    else sessionStorage.removeItem(receiptStorageKey);
  } catch {
    receiptStored = !value;
  }
  byId("receipt-pending").hidden = !value;
  byId("receipt-pending-close-warning").hidden = !value;
  byId("receipt-storage-warning").hidden = !value || receiptStored;
}
function openPendingReceipt() {
  byId("receipt-product").textContent = pendingReceipt.productName ?? pendingReceipt.productId;
  receiptForm.elements.unit_id.replaceChildren(new Option(pendingReceipt.unitName, pendingReceipt.payload.unit_id));
  for (const name of ["quantity", "unit_cost"]) receiptForm.elements[name].value = pendingReceipt.payload[name];
  receiptForm.querySelectorAll("input, select").forEach((field) => { field.disabled = true; });
  receiptError.textContent = "ยังไม่ทราบผลการบันทึก ส่งรายการเดิมเพื่อตรวจสอบผล"
    + (receiptStored ? "" : " · เก็บรายการค้างไม่ได้ ห้ามรีโหลดหรือปิดแท็บก่อนส่งรายการเดิม");
  receiptError.hidden = false;
  receiptDialog.showModal();
}
byId("receipt-pending").hidden = !pendingReceipt;
byId("receipt-restore-error").hidden = !receiptProblem;
byId("receipt-restore-export").hidden = !receiptProblem || !receiptRestore.available;
byId("receipt-restore-export").addEventListener("click", () => exportStoredRequest(receiptStorageKey, "pos-receipt-raw.txt"));
if (receiptProblem) document.querySelector('[data-open="receipt"]').disabled = true;
byId("retry-receipt").addEventListener("click", () => {
  if (pendingReceipt && !receiptDialog.open) openPendingReceipt();
});
receiptForm.querySelector("[data-close]").addEventListener("click", () => receiptDialog.close());
receiptDialog.addEventListener("cancel", (event) => { if (savingReceipt) event.preventDefault(); });
receiptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingReceipt || receiptProblem) return;
  if (!pendingReceipt) {
    const product = receiptProduct;
    if (!product) return;
    const payload = Object.fromEntries(new FormData(receiptForm));
    payload.id = crypto.randomUUID();
    const unitName = receiptForm.elements.unit_id.selectedOptions[0].textContent;
    setPendingReceipt({ productId: product.id, productName: product.name + " · " + product.code, unitName, payload });
  }
  savingReceipt = true;
  const buttons = receiptForm.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  receiptForm.querySelectorAll("input, select").forEach((field) => { field.disabled = true; });
  try {
    await api(productPath(pendingReceipt.productId) + "/receipts", pendingReceipt.payload);
    setPendingReceipt(null);
    receiptDialog.close();
    notice("บันทึกรับสินค้าแล้ว");
    try { await refresh(); } catch { notice("บันทึกแล้ว แต่โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณารีเฟรชหน้า", true); }
  } catch (failure) {
    if (failure.status >= 400 && failure.status < 500 && failure.status !== 408 && failure.status !== 429) {
      setPendingReceipt(null);
      receiptDialog.close();
      notice("บันทึกรับสินค้าไม่สำเร็จ กรุณาเลือกสินค้าและตรวจสอบข้อมูลก่อนบันทึกอีกครั้ง", true);
      return;
    } else {
      receiptError.textContent = "ยังไม่ทราบผลการบันทึก ส่งรายการเดิมเพื่อตรวจสอบผล"
    + (receiptStored ? "" : " · เก็บรายการค้างไม่ได้ ห้ามรีโหลดหรือปิดแท็บก่อนส่งรายการเดิม");
    }
    receiptError.hidden = false;
  } finally {
    savingReceipt = false;
    buttons.forEach((button) => { button.disabled = false; });
  }
});

const countDialog = byId("stock-count");
const countForm = countDialog.querySelector("form");
const countError = countForm.querySelector(".error");
const countSubmit = byId("submit-stock-count");
const countClose = countForm.querySelector("[data-close]");
const countFields = [...countForm.querySelectorAll("input")];
const countStorageKey = "pos-pending-stock-count";
const countRestore = readStoredRequest(countStorageKey, (value) =>
  ["id", "name", "quantity", "base_unit"].every((key) => typeof value?.product?.[key] === "string")
  && ["id", "expected_quantity", "counted_quantity", "reason"].every((key) => typeof value?.payload?.[key] === "string"));
let pendingCount = countRestore.value;
const countProblem = countRestore.problem;
let countStored = true;
let countProduct = null;
let savingCount = false;

function setPendingCount(pending) {
  if (countProblem) return;
  pendingCount = pending;
  countStored = true;
  try {
    if (pending) sessionStorage.setItem(countStorageKey, JSON.stringify(pending));
    else sessionStorage.removeItem(countStorageKey);
  } catch {
    countStored = !pending;
  }
  byId("stock-count-pending").hidden = !pending;
  byId("count-pending-close-warning").hidden = !pending;
  byId("count-storage-warning").hidden = !pending || countStored;
}

function countMessage(message) {
  countError.textContent = message + (message && pendingCount && !countStored
    ? " · เก็บรายการค้างไม่ได้ ห้ามรีโหลดหรือปิดแท็บก่อนส่งรายการเดิม" : "");
  countError.hidden = !message;
}

function updateCountControls() {
  const counted = countForm.elements.counted_quantity;
  const cost = countForm.elements.unit_cost;
  const increase = counted.value !== "" && Number(counted.value) > Number(countProduct?.quantity);
  cost.required = increase && countProduct.average_cost === null;
  byId("stock-count-cost-label").hidden = !increase;
  byId("stock-count-cost-help").hidden = !increase;
  byId("stock-count-cost-help").textContent = cost.required
    ? "ระบุต้นทุนต่อหน่วยสำหรับจำนวนที่ปรับเพิ่ม"
    : "เว้นว่างเพื่อใช้ต้นทุนเฉลี่ยปัจจุบัน";
  for (const field of countFields) field.disabled = savingCount || Boolean(pendingCount);
  cost.disabled ||= !increase;
  countClose.disabled = savingCount;
  countSubmit.disabled = savingCount || !countProduct;
  countSubmit.textContent = pendingCount ? "ส่งรายการเดิมอีกครั้ง" : "บันทึกยอดตรวจนับ";
}

function openCount(product, pending = null) {
  countProduct = product;
  byId("count-pending-close-warning").hidden = !pending;
  countForm.reset();
  byId("stock-count-product").textContent = product.name;
  byId("stock-count-before").textContent = "ยอดในระบบก่อนปรับ " + format(product.quantity) + " " + product.base_unit;
  byId("stock-count-unit").textContent = "(" + product.base_unit + ")";
  if (pending) {
    for (const field of countFields) field.value = pending.payload[field.name] ?? "";
  }
  countMessage(pending ? "ยังไม่ทราบผลการบันทึก ส่งรายการเดิมเพื่อตรวจสอบผล" : "");
  updateCountControls();
  countDialog.showModal();
}

byId("open-stock-count").addEventListener("click", () => {
  if (countProblem) return;
  if (pendingCount) {
    openCount(pendingCount.product, pendingCount);
    return;
  }
  const product = products.find((entry) => entry.id === selectedId);
  if (product) openCount(product);
});
byId("retry-stock-count").addEventListener("click", () => {
  if (pendingCount) openCount(pendingCount.product, pendingCount);
});
countForm.elements.counted_quantity.addEventListener("input", updateCountControls);
countClose.addEventListener("click", () => countDialog.close());
countDialog.addEventListener("cancel", (event) => {
  if (savingCount) event.preventDefault();
});

countForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingCount || countProblem || !countProduct) return;
  if (!pendingCount) {
    const fields = Object.fromEntries(new FormData(countForm));
    const reason = fields.reason.trim();
    if (!reason) {
      countMessage("กรุณาระบุเหตุผลที่ปรับยอด");
      return;
    }
    const payload = {
      id: crypto.randomUUID(),
      expected_quantity: countProduct.quantity,
      counted_quantity: fields.counted_quantity,
      reason,
    };
    if (fields.unit_cost) payload.unit_cost = fields.unit_cost;
    setPendingCount({ product: countProduct, payload });
  }

  const { product, payload } = pendingCount;
  savingCount = true;
  updateCountControls();
  countMessage("");
  try {
    await api(productPath(product.id) + "/stock-counts", payload);
    setPendingCount(null);
    selectedId = product.id;
    countDialog.close();
    notice("บันทึกยอดตรวจนับแล้ว");
    try {
      await refresh();
    } catch {
      notice("บันทึกยอดตรวจนับแล้ว แต่โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณารีเฟรชหน้า", true);
    }
  } catch (failure) {
    if ([400, 404, 409, 422].includes(failure.status)) {
      setPendingCount(null);
      if (failure.code === "stock_changed" || failure.status === 404) {
        countDialog.close();
        notice("ยอดสต๊อกเปลี่ยนหรือไม่พบสินค้า กรุณาตรวจนับใหม่ก่อนปรับยอด", true);
        try {
          await refresh();
        } catch {
          countProduct = null;
          byId("open-stock-count").disabled = true;
          notice("โหลดสต๊อกล่าสุดไม่สำเร็จ กรุณารีเฟรชหน้าก่อนตรวจนับใหม่", true);
        }
      } else if (failure.code === "idempotency_conflict") {
        countDialog.close();
        notice("รหัสรายการซ้ำกับข้อมูลอื่น กรุณาตรวจสอบประวัติและยอดสต๊อกก่อนบันทึกใหม่", true);
        refresh().catch(() => {});
      } else {
        countMessage(failure.code === "stock_count_cost_required"
          ? "กรุณาระบุต้นทุนต่อหน่วยสต๊อก"
          : "ตรวจสอบจำนวนที่นับได้และต้นทุนต่อหน่วย");
      }
    } else {
      countMessage("ยังไม่ทราบผลการบันทึก ส่งรายการเดิมอีกครั้งเพื่อดูผล");
    }
  } finally {
    savingCount = false;
    updateCountControls();
  }
});

byId("stock-count-pending").hidden = !pendingCount;
byId("count-restore-error").hidden = !countProblem;
byId("count-restore-export").hidden = !countProblem || !countRestore.available;
byId("count-restore-export").addEventListener("click", () => exportStoredRequest(countStorageKey, "pos-stock-count-raw.txt"));
if (countProblem) byId("open-stock-count").disabled = true;
refresh().catch(() => {
  byId("list-state").textContent = "โหลดสินค้าไม่สำเร็จ กรุณารีเฟรชหน้า";
});

window.addEventListener("beforeunload", (event) => {
  if (pendingReceipt || pendingCount || receiptProblem || countProblem) {
    event.preventDefault();
    event.returnValue = "";
  }
});
