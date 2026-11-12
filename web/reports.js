const byId = (id) => document.getElementById(id);
const form = byId("report-filters");
const start = form.elements.namedItem("from");
const end = form.elements.namedItem("to");
const status = byId("report-status");
const results = byId("report-results");
const integers = new Intl.NumberFormat("th-TH");
const amounts = new Intl.NumberFormat("th-TH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const quantities = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 12 });
const thaiDate = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeZone: "Asia/Bangkok",
});
let request;

function bangkokToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Bangkok",
  }).formatToParts();
  const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return [date.year, date.month, date.day].join("-");
}

function displayDate(value) {
  return thaiDate.format(new Date(value + "T00:00:00+07:00"));
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function money(value) {
  return value === null ? "ยังคำนวณไม่ได้" : amounts.format(value);
}

function costLabel(row) {
  if (row.unknown_cost_bills) return "ขาดข้อมูลต้นทุน";
  if (row.pending_cost_bills) return "ใช้ต้นทุนชั่วคราว";
  return "";
}

function reportValue(tag, value, note = "") {
  const node = element(tag, value);
  if (note) node.append(element("small", note));
  return node;
}

function renderSummary(summary) {
  const note = costLabel(summary);
  const metrics = [
    ["ยอดขาย", money(summary.revenue) + " บาท"],
    ["จำนวนบิล", integers.format(summary.bill_count) + " บิล"],
    ["ต้นทุนขาย", summary.cost === null ? money(null) : money(summary.cost) + " บาท", note],
    ["กำไรขั้นต้น", summary.gross_profit === null ? money(null) : money(summary.gross_profit) + " บาท", note],
    ["เงินสด", money(summary.cash) + " บาท"],
    ["โอน", money(summary.qr) + " บาท"],
    ["เงินเชื่อ", money(summary.credit) + " บาท"],
  ];
  byId("report-summary").replaceChildren(...metrics.map(([label, value, detail]) => {
    const node = document.createElement("div");
    node.append(element("dt", label), reportValue("dd", value, detail));
    return node;
  }));

  const warning = byId("report-cost-warning");
  const messages = [];
  if (summary.pending_cost_bills) {
    messages.push("มี " + integers.format(summary.pending_cost_bills) + " บิลที่รอปรับต้นทุน");
  }
  if (summary.unknown_cost_bills) {
    messages.push("มี " + integers.format(summary.unknown_cost_bills)
      + " บิลที่ขาดข้อมูลต้นทุน ระบบจะแสดงกำไรเมื่อมีข้อมูลครบ");
  }
  warning.textContent = messages.join(" · ");
  warning.hidden = !messages.length;
}

function tableRow(label, cells) {
  const row = document.createElement("tr");
  const heading = element("th", label);
  heading.scope = "row";
  row.append(heading, ...cells.map((cell) => Array.isArray(cell)
    ? reportValue("td", ...cell)
    : element("td", cell)));
  return row;
}

function renderTable(name, rows) {
  byId("report-" + name).replaceChildren(...rows);
  byId("report-" + name + "-empty").hidden = rows.length > 0;
  byId("report-" + name + "-wrap").hidden = rows.length === 0;
}

function renderReport(report) {
  renderSummary(report.summary);
  renderTable("days", report.days.map((day) => tableRow(displayDate(day.date), [
    integers.format(day.bill_count), money(day.revenue), money(day.cash), money(day.qr), money(day.credit),
    [money(day.cost), costLabel(day)], money(day.gross_profit),
  ])));
  renderTable("products", report.products.map((product) => tableRow(product.name, [
    quantities.format(product.quantity) + " " + product.base_unit, money(product.revenue),
    [money(product.cost), costLabel(product)], money(product.gross_profit),
  ])));
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

async function loadReport() {
  request?.abort();
  results.hidden = true;
  if (!start.value || !end.value || start.value > end.value) {
    setStatus("กรุณาเลือกวันที่สิ้นสุดให้ตรงกับหรืออยู่หลังวันที่เริ่มต้น", true);
    return;
  }

  const current = new AbortController();
  request = current;
  const query = new URLSearchParams({ from: start.value, to: end.value });
  setStatus("กำลังโหลดรายงาน…");
  try {
    const response = await fetch("/sales-report?" + query, { signal: current.signal });
    if (!response.ok) throw new Error("Report request failed");
    const report = await response.json();
    if (request !== current || current.signal.aborted) return;
    renderReport(report);
    results.hidden = false;
    setStatus("แสดงรายงาน " + displayDate(report.from) + " ถึง " + displayDate(report.to));
  } catch {
    if (request === current && !current.signal.aborted) {
      setStatus("โหลดรายงานไม่สำเร็จ กรุณาลองอีกครั้ง", true);
    }
  }
}

start.value = end.value = bangkokToday();
form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadReport();
});
loadReport();
