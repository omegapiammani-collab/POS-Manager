const queueFormat = "pos-sale-queue";
const queueVersion = 2;
const byId = (id) => document.getElementById(id);
const queueStore = window.PosOffline;
const queueCount = byId("backup-queue-count");
const exportButton = byId("backup-queue-export");
const form = byId("backup-queue-import");
const fileInput = byId("backup-queue-file");
const selected = byId("backup-queue-selected");
const confirm = byId("backup-queue-confirm");
const submitButton = byId("backup-queue-submit");
const status = byId("backup-queue-message");
const integers = new Intl.NumberFormat("th-TH");
let working = false;
let entriesCount = 0;

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function updateControls() {
  fileInput.disabled = working || !queueStore?.importQueue;
  confirm.disabled = fileInput.disabled;
  exportButton.disabled = working || !entriesCount;
  submitButton.disabled = fileInput.disabled || !fileInput.files.length || !confirm.checked;
}

async function refreshQueue() {
  try {
    const entries = await queueStore.list();
    entriesCount = entries.length;
    queueCount.textContent = integers.format(entriesCount) + " บิลในเบราว์เซอร์นี้";
  } catch {
    entriesCount = 0;
    queueCount.textContent = "อ่านบิลในเบราว์เซอร์ไม่ได้ กรุณาเปิดใช้งานพื้นที่จัดเก็บของเว็บไซต์แล้วลองอีกครั้ง";
  }
  updateControls();
}

function downloadQueue(entries, storeId) {
  const backup = { format: queueFormat, version: queueVersion, store_id: storeId, entries };
  const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  link.download = "pos-sale-queue-" + timestamp + ".json";
  link.href = url;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser time to start reading the object before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

exportButton.addEventListener("click", async () => {
  if (working) return;
  working = true;
  updateControls();
  message("");
  try {
    const { entries, storeId } = await queueStore.exportQueue();
    if (entries.length) {
      downloadQueue(entries, storeId);
      message("สร้างไฟล์สำรอง " + integers.format(entries.length) + " บิลแล้ว");
    } else {
      message("ไม่มีบิลรอส่งให้สำรอง");
    }
  } catch {
    message("สร้างไฟล์สำรองไม่สำเร็จ กรุณาลองอีกครั้ง", true);
  } finally {
    working = false;
    await refreshQueue();
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  selected.textContent = file ? "ไฟล์ที่เลือก " + file.name : "";
  confirm.checked = false;
  message("");
  updateControls();
});
confirm.addEventListener("change", updateControls);

function validBackup(value) {
  return value?.format === queueFormat && [1, queueVersion].includes(value.version) && Array.isArray(value.entries)
    && (value.version === 1 || value.store_id === null || typeof value.store_id === "string");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (working || !file || !confirm.checked) return;
  working = true;
  updateControls();
  message("");
  try {
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      message("อ่านไฟล์ JSON ไม่สำเร็จ กรุณาเลือกไฟล์สำรองบิลที่ถูกต้อง", true);
      return;
    }
    if (!validBackup(backup)) {
      message("รูปแบบหรือรุ่นไฟล์นี้ไม่รองรับ กรุณาใช้ไฟล์ที่ดาวน์โหลดจากหน้าสำรองบิล", true);
      return;
    }
    const storeId = await queueStore.getBinding();
    if (!storeId) {
      message("ยังไม่ได้ยืนยันฐานข้อมูลร้าน กรุณาเปิดหน้าขายออนไลน์และตรวจสอบร้านก่อนนำเข้า", true);
      return;
    }
    if (backup.version === 2 && backup.store_id && backup.store_id !== storeId) {
      const ancestors = await queueStore.getRestoreAncestors(storeId);
      if (!ancestors.includes(backup.store_id)) {
        message("ไฟล์นี้เป็นของฐานข้อมูลร้านอื่น กรุณาตรวจสอบฐานข้อมูลก่อนนำเข้า", true);
        return;
      }
    }
    const result = await queueStore.importQueue(backup.entries, storeId);
    form.reset();
    selected.textContent = "";
    message("นำเข้า " + integers.format(result.imported) + " บิลเพื่อตรวจสอบก่อนส่ง · มีอยู่แล้ว " + integers.format(result.duplicates) + " บิล (คงสถานะเดิม)");
  } catch {
    message("นำเข้าไม่สำเร็จ กรุณาตรวจสอบไฟล์หรือบิลที่มีเลขอ้างอิงซ้ำก่อนลองอีกครั้ง", true);
  } finally {
    working = false;
    await refreshQueue();
  }
});

updateControls();
refreshQueue();
