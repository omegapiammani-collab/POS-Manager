const byId = (id) => document.getElementById(id);
const entry = byId("expense-create");
const filter = byId("expense-filter");
const list = byId("expense-history");
const dialog = byId("expense-void");
const voidForm = dialog.querySelector("form");
const from = filter.elements.namedItem("from");
const to = filter.elements.namedItem("to");
const storageKey = "pos-pending-expense";
const sourceNames = { cash_drawer: "เงินสดในลิ้นชัก", external: "จ่ายจากแหล่งอื่น" };
const amounts = new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" });
let pending = restorePending();
let pendingStored = true;
let saving = false;
let request;
let selected;

function bangkokToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Bangkok",
  }).formatToParts();
  const day = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return [day.year, day.month, day.day].join("-");
}

function restorePending() {
  try {
    return JSON.parse(sessionStorage.getItem(storageKey)) || null;
  } catch {
    return null;
  }
}

function savePending(value) {
  pending = value;
  pendingStored = true;
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  } catch {
    pendingStored = !value;
  }
  renderPending();
}

function renderPending() {
  byId("expense-pending").hidden = !pending;
  byId("expense-storage-warning").hidden = !pending || pendingStored;
  byId("expense-retry").disabled = saving;
  entry.querySelector("fieldset").disabled = Boolean(pending) || saving;
  for (const button of list.querySelectorAll("button")) button.disabled = Boolean(pending) || saving;
}

function message(text, error = false) {
  const target = byId("expense-message");
  target.textContent = text;
  target.classList.toggle("error", error);
  target.hidden = !text;
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function money(amount) {
  return amounts.format(amount) + " บาท";
}

function renderHistory(rows) {
  list.replaceChildren(...rows.map((item) => {
    const row = document.createElement("li");
    const details = element("span", item.description);
    const day = dates.format(new Date(item.date + "T00:00:00+07:00"));
    details.append(element("small", day + " · " + sourceNames[item.source]));
    const actions = element("div", money(item.amount));
    actions.className = "expense-row-actions";
    if (item.status === "voided") {
      details.append(element("small", "ยกเลิกแล้ว · " + item.void_reason));
    } else {
      const button = element("button", "ยกเลิก");
      button.type = "button";
      button.className = "secondary";
      button.setAttribute("aria-label", "ยกเลิกค่าใช้จ่าย " + item.description);
      button.addEventListener("click", () => openVoid(item));
      actions.append(button);
    }
    row.append(details, actions);
    return row;
  }));
  renderPending();
}

function openVoid(item) {
  selected = item;
  byId("expense-void-entry").textContent = item.description + " · " + money(item.amount);
  voidForm.reset();
  dialog.showModal();
}

async function loadHistory() {
  request?.abort();
  list.replaceChildren();
  const state = byId("expense-history-status");
  if (!from.value || !to.value || from.value > to.value) {
    state.textContent = "กรุณาเลือกวันสิ้นสุดให้ตรงกับหรืออยู่หลังวันเริ่มต้น";
    return;
  }
  const current = new AbortController();
  request = current;
  state.textContent = "กำลังโหลดค่าใช้จ่าย…";
  const query = new URLSearchParams({ from: from.value, to: to.value });
  try {
    const response = await fetch("/expenses?" + query, { signal: current.signal });
    if (!response.ok) throw new Error("Expense list unavailable");
    const rows = await response.json();
    if (current.signal.aborted) return;
    renderHistory(rows);
    state.textContent = rows.length ? "" : "ไม่มีค่าใช้จ่ายในช่วงที่เลือก";
  } catch {
    if (!current.signal.aborted) state.textContent = "โหลดค่าใช้จ่ายไม่สำเร็จ กรุณาลองอีกครั้ง";
  }
}

async function submitPending() {
  if (!pending || saving) return;
  const attempt = pending;
  saving = true;
  renderPending();
  message("");
  try {
    const response = await fetch(attempt.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attempt.payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
        savePending(null);
        if (response.status === 409 || response.status === 404) {
          message("รายการเปลี่ยนแปลงแล้ว กรุณาตรวจสอบประวัติก่อนส่งใหม่", true);
          loadHistory();
        } else {
          message("บันทึกไม่สำเร็จ กรุณาตรวจสอบข้อมูลที่กรอก", true);
        }
      } else {
        message("ยังไม่ทราบผลการบันทึก กรุณาส่งคำขอเดิมอีกครั้ง", true);
      }
      return;
    }

    const item = await response.json();
    savePending(null);
    if (item.status === "voided") {
      message("ยกเลิกค่าใช้จ่ายแล้ว");
    } else {
      entry.reset();
      entry.elements.namedItem("date").value = item.date;
      if (item.date < from.value || item.date > to.value) from.value = to.value = item.date;
      message("บันทึกค่าใช้จ่ายแล้ว");
    }
    loadHistory();
  } catch {
    message("ยังไม่ทราบผลการบันทึก กรุณาส่งคำขอเดิมอีกครั้ง", true);
  } finally {
    saving = false;
    renderPending();
  }
}

entry.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pending || saving) return;
  const values = Object.fromEntries(new FormData(entry));
  values.description = values.description.trim();
  if (!values.description) {
    message("กรุณากรอกรายการค่าใช้จ่าย", true);
    return;
  }
  savePending({ path: "/expenses", payload: { id: crypto.randomUUID(), ...values } });
  submitPending();
});

voidForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!selected || pending || saving) return;
  const reason = voidForm.elements.namedItem("reason").value.trim();
  if (!reason) {
    const input = voidForm.elements.namedItem("reason");
    input.setCustomValidity("กรุณาระบุเหตุผลที่ยกเลิก");
    input.reportValidity();
    return;
  }
  savePending({ path: "/expenses/" + encodeURIComponent(selected.id) + "/void", payload: { reason } });
  dialog.close();
  submitPending();
});

voidForm.elements.namedItem("reason").addEventListener("input", (event) => event.target.setCustomValidity(""));
byId("expense-void-close").addEventListener("click", () => dialog.close());
byId("expense-retry").addEventListener("click", submitPending);
filter.addEventListener("submit", (event) => {
  event.preventDefault();
  loadHistory();
});
entry.elements.namedItem("date").value = from.value = to.value = bangkokToday();
renderPending();
loadHistory();

window.addEventListener("beforeunload", (event) => {
  if (pending) {
    event.preventDefault();
    event.returnValue = "";
  }
});
