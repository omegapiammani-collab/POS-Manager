const byId = (id) => document.getElementById(id);
const form = byId("report-filters");
const start = form.elements.namedItem("from");
const end = form.elements.namedItem("to");
const status = byId("report-status");
const results = byId("report-results");
const integers = new Intl.NumberFormat("th-TH");
const quantities = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 12 });
const thaiDate = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeZone: "Asia/Bangkok",
});
let request;
let displayedReport;

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
  if (value === null) return "ยังคำนวณไม่ได้";
  const match = typeof value === "string" && /^(-?)(\d+)\.(\d{2})$/.exec(value);
  if (!match) return "ข้อมูลไม่พร้อม";
  return match[1] + integers.format(BigInt(match[2])) + "." + match[3];
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
    ["ค่าใช้จ่ายร้าน", money(summary.expenses) + " บาท",
      "ลิ้นชัก " + money(summary.cash_drawer_expenses) + " บาท · แหล่งอื่น " + money(summary.external_expenses) + " บาท"],
    ["กำไรหลังหักค่าใช้จ่าย", summary.profit_after_expenses === null
      ? money(null) : money(summary.profit_after_expenses) + " บาท", note],
    ["เงินสดจากการขาย", money(summary.cash) + " บาท"],
    ["โอนจากการขาย", money(summary.qr) + " บาท"],
    ["เงินเชื่อ", money(summary.credit) + " บาท"],
    ["รับชำระหนี้เงินสด", money(summary.debt_repayments_cash) + " บาท"],
    ["รับชำระหนี้โอน", money(summary.debt_repayments_qr) + " บาท"],
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

function compareDecimal(a, b) {
  const parse = (value) => {
    const [whole, fraction = ""] = value.split(".");
    return [BigInt(whole), fraction];
  };
  const [aw, af] = parse(a);
  const [bw, bf] = parse(b);
  if (aw !== bw) return aw > bw ? 1 : -1;
  const width = Math.max(af.length, bf.length);
  const left = af.padEnd(width, "0");
  const right = bf.padEnd(width, "0");
  return left === right ? 0 : left > right ? 1 : -1;
}

function sortedProducts(report) {
  const products = [...report.products];
  if (byId("report-product-sort").value === "revenue") {
    products.sort((a, b) => compareDecimal(b.revenue, a.revenue)
      || a.name.localeCompare(b.name, "th") || a.product_id.localeCompare(b.product_id));
  }
  return products;
}

function renderProducts(report) {
  renderTable("products", sortedProducts(report).map((product) => tableRow(product.name, [
    quantities.format(product.quantity) + " " + product.base_unit, money(product.revenue),
    [money(product.cost), costLabel(product)], money(product.gross_profit),
  ])));
}

byId("report-product-sort").addEventListener("change", () => {
  if (displayedReport) renderProducts(displayedReport);
});

function renderReport(report) {
  renderSummary(report.summary);
  renderTable("days", report.days.map((day) => tableRow(displayDate(day.date), [
    integers.format(day.bill_count), money(day.revenue), money(day.cash), money(day.qr), money(day.credit),
    money(day.debt_repayments_cash), money(day.debt_repayments_qr),
    [money(day.cost), costLabel(day)], money(day.gross_profit), money(day.expenses), money(day.profit_after_expenses),
  ])));
  renderProducts(report);
}

const dailyColumns = [
  ["วันที่", "date"], ["จำนวนบิล", "bill_count"], ["ยอดขาย (บาท)", "revenue"],
  ["เงินสดจากการขาย (บาท)", "cash"], ["โอนจากการขาย (บาท)", "qr"], ["เงินเชื่อ (บาท)", "credit"],
  ["รับชำระหนี้เงินสดก่อนหักเงินคืน (บาท)", "debt_repayments_cash"],
  ["รับชำระหนี้โอนก่อนหักเงินคืน (บาท)", "debt_repayments_qr"],
  ["ต้นทุนขาย (บาท)", "cost"], ["กำไรขั้นต้น (บาท)", "gross_profit"],
  ["ค่าใช้จ่าย (บาท)", "expenses"], ["กำไรหลังหักค่าใช้จ่าย (บาท)", "profit_after_expenses"],
];
const productColumns = [
  ["สินค้า", "name", true], ["จำนวนขาย", "quantity"], ["หน่วยสต๊อก", "base_unit", true],
  ["ยอดขาย (บาท)", "revenue"], ["ต้นทุนขาย (บาท)", "cost"], ["กำไรขั้นต้น (บาท)", "gross_profit"],
];

function downloadReport(group, fileType, columns) {
  if (!displayedReport || results.hidden) return;
  const { from, to } = displayedReport;
  const { cell, download } = window.PosCsv;
  const headers = [...columns.map(([title]) => cell(title)),
    "วันเริ่มต้น", "วันสิ้นสุด", "บิลรอปรับต้นทุน", "บิลขาดข้อมูลต้นทุน", "สถานะต้นทุน"];
  const data = group === "products" ? sortedProducts(displayedReport) : displayedReport[group];
  const rows = data.map((row) => [
    ...columns.map(([, field, userText]) => cell(row[field], userText)),
    from, to, row.pending_cost_bills, row.unknown_cost_bills, cell(costLabel(row)),
  ]);
  download("sales-" + fileType + "-" + from + "-to-" + to + ".csv", [headers, ...rows]);
}

byId("report-download-days").addEventListener("click", () => downloadReport("days", "daily", dailyColumns));
byId("report-download-products").addEventListener("click", () => downloadReport("products", "products", productColumns));

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

async function loadReport() {
  request?.abort();
  results.hidden = true;
  displayedReport = null;
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
    displayedReport = report;
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
