const byId = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 6 });
let products = [];
let selectedId = null;
let historyRequest = 0;

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
  if (response.status === 409) throw new Error("รหัสสินค้าหรือชื่อหน่วยขายซ้ำ");
  if (response.status === 400) throw new Error("ตรวจสอบข้อมูลที่กรอกหรือหน่วยที่เลือก");
  if (response.status === 404) throw new Error("ไม่พบสินค้าที่เลือก");
  throw new Error("เชื่อมต่อระบบสต๊อกไม่สำเร็จ");
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
      const low = element("small", "ใกล้หมด");
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
  byId("quantity").textContent = format(product.quantity) + " " + product.base_unit;
  byId("average").textContent = product.average_cost === null
    ? "ยังไม่มีต้นทุน"
    : format(product.average_cost) + " บาท / " + product.base_unit;
  byId("units").replaceChildren(...product.units.map((unit) =>
    line(unit.name + " · " + format(unit.multiplier) + " " + product.base_unit, format(unit.price) + " บาท")
  ));
  const list = byId("receipts");
  list.replaceChildren(element("li", "กำลังโหลดประวัติ…"));
  try {
    const receipts = await api(productPath(product.id) + "/receipts");
    if (request !== historyRequest) return;
    list.replaceChildren(...(receipts.length ? receipts.map((row) =>
      line(format(row.quantity) + " " + row.unit_name + " · " + row.created_at.slice(0, 10),
        format(row.unit_cost) + " บาท / " + row.unit_name)
    ) : [element("li", "ยังไม่มีรายการรับสินค้า")]));
  } catch {
    if (request === historyRequest) list.replaceChildren(element("li", "โหลดประวัติรับสินค้าไม่สำเร็จ"));
  }
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

const actions = {
  product: { path: () => "/products", success: "เพิ่มสินค้าแล้ว" },
  unit: { path: () => productPath(selectedId) + "/units", success: "เพิ่มหน่วยขายแล้ว" },
  receipt: { path: () => productPath(selectedId) + "/receipts", success: "บันทึกรับสินค้าแล้ว" },
};

document.querySelectorAll("dialog").forEach((dialog) => {
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
      const result = await api(action.path(), data);
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
      error.textContent = failure instanceof TypeError
        ? "ขาดการเชื่อมต่อ กรุณาตรวจสอบรายการก่อนบันทึกซ้ำ"
        : failure.message;
      error.hidden = false;
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  });
});

refresh().catch(() => {
  byId("list-state").textContent = "โหลดสินค้าไม่สำเร็จ กรุณารีเฟรชหน้า";
});
