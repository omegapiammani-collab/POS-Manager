const byId = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 6 });
let products = [];
let selectedId = null;
let historyRequest = 0;
let editingProduct;
let editingUnit;

const format = (value) => numberFormat.format(Number(value));
const productPath = (id) => "/products/" + encodeURIComponent(id);

async function api(path, data) {
  const options = data ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  } : undefined;
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
  const matches = products.filter((product) =>
    product.name.toLowerCase().includes(query) || product.code.toLowerCase().includes(query)
  );
  byId("products").replaceChildren(...matches.map((product) => {
    const item = document.createElement("li");
    const button = element("button", "");
    button.type = "button";
    button.setAttribute("aria-pressed", String(product.id === selectedId));
    const name = element("span", product.name);
    name.append(element("small", product.code));
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
  state.textContent = query ? "ไม่พบสินค้าที่ตรงกับคำค้น" : "ยังไม่มีสินค้า";
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
      line(format(row.quantity) + " " + row.unit_name + " · " + row.created_at.slice(0, 10),
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
  summary.append(element("small", row.reason + " · " + row.created_at.slice(0, 10)));
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
document.querySelectorAll("[data-open]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = byId(button.dataset.open);
    const form = dialog.querySelector("form");
    form.reset();
    form.querySelector(".error").hidden = true;
    if (dialog.id === "receipt") {
      const product = products.find((entry) => entry.id === selectedId);
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
  receipt: { path: () => productPath(selectedId) + "/receipts", success: "บันทึกรับสินค้าแล้ว" },
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

document.querySelectorAll("dialog:not(#stock-count)").forEach((dialog) => {
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

const countDialog = byId("stock-count");
const countForm = countDialog.querySelector("form");
const countError = countForm.querySelector(".error");
const countSubmit = byId("submit-stock-count");
const countClose = countForm.querySelector("[data-close]");
const countFields = [...countForm.querySelectorAll("input")];
const countStorageKey = "pos-pending-stock-count";
let pendingCount = restorePendingCount();
let countProduct = null;
let savingCount = false;

function restorePendingCount() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(countStorageKey));
    if (typeof pending?.product?.id === "string" && typeof pending.payload?.id === "string") return pending;
  } catch {
    // This session may not have storage access.
  }
  return null;
}

function setPendingCount(pending) {
  pendingCount = pending;
  try {
    if (pending) sessionStorage.setItem(countStorageKey, JSON.stringify(pending));
    else sessionStorage.removeItem(countStorageKey);
  } catch {
    // The same request can still be retried while the page remains open.
  }
  byId("stock-count-pending").hidden = !pending;
}

function countMessage(message) {
  countError.textContent = message;
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
  if (savingCount || !countProduct) return;
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
refresh().catch(() => {
  byId("list-state").textContent = "โหลดสินค้าไม่สำเร็จ กรุณารีเฟรชหน้า";
});
