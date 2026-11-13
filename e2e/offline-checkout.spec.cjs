const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { test: base, expect } = require("@playwright/test");

const test = base.extend({
  pos: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "pos-playwright-"));
    const server = spawn(process.env.POS_PYTHON || "python3", [
      "inventory_api.py", "--port", "0", "--database", join(directory, "test.sqlite3"),
    ], {
      cwd: join(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    server.stderr.on("data", (data) => { stderr += data; });
    const exited = once(server, "close");
    // The same error is reported by the startup wait below.
    exited.catch(() => {});

    try {
      const lines = createInterface({ input: server.stdout });
      const [line] = await Promise.race([
        once(lines, "line"),
        exited.then(([code]) => { throw new Error("POS server exited " + code + "\n" + stderr); }),
      ]);
      const match = /^Inventory API: (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
      if (!match) throw new Error("Unexpected POS server startup output: " + line);
      await use(match[1]);
      if (test.info().status !== test.info().expectedStatus) console.error(stderr);
    } finally {
      server.kill();
      try {
        await exited;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
});

async function createProduct(request, pos, name = "น้ำดื่ม") {
  const added = await request.post(pos + "/products", {
    data: { code: "W01", name, base_unit: "ขวด", price: "25" },
  });
  expect(added.status()).toBe(201);
  const product = await added.json();
  const receipt = await request.post(pos + "/products/" + product.id + "/receipts", {
    data: { unit_id: product.base_unit_id, quantity: "1", unit_cost: "12" },
  });
  expect(receipt.status()).toBe(201);
  return product;
}

async function sellOne(page) {
  await page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true }).click();
  await page.getByRole("button", { name: "เงินสดเต็มจำนวน", exact: true }).click();
  await page.getByRole("button", { name: "ปิดบิล", exact: true }).click();
}

async function downloadCsv(page, label, filename, { touch = false } = {}) {
  const button = page.getByRole("button", { name: label, exact: true });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    touch ? button.tap() : button.click(),
  ]);
  expect(download.suggestedFilename()).toBe(filename);
  const contents = await readFile(await download.path());
  expect([...contents.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return contents.subarray(3).toString("utf8");
}

for (const scenario of ["granted", "denied", "unsupported", "rejected"]) {
  test("shows offline storage status when persistence is " + scenario, async ({ page, request, pos }) => {
    await createProduct(request, pos);
    await page.addInitScript((mode) => {
      let persistent = false;
      window.persistenceRequests = 0;
      Object.defineProperty(navigator.storage, "persisted", {
        configurable: true, value: mode === "unsupported" ? undefined : async () => persistent,
      });
      Object.defineProperty(navigator.storage, "persist", {
        configurable: true, value: mode === "unsupported" ? undefined : async () => {
          window.persistenceRequests += 1;
          if (mode === "rejected") throw new Error("denied");
          persistent = mode === "granted";
          return persistent;
        },
      });
    }, scenario);
    await page.goto(pos + "/checkout");
    const status = page.locator("#sale-storage-status");
    const button = page.getByRole("button", { name: "ขอเก็บข้อมูลถาวร" });
    if (scenario === "unsupported") {
      await expect(status).toContainText("ไม่รองรับ");
      await expect(button).toBeHidden();
    } else {
      await expect(status).toContainText("ยังไม่ได้รับอนุญาต");
      expect(await page.evaluate(() => window.persistenceRequests)).toBe(0);
      await button.click();
      expect(await page.evaluate(() => window.persistenceRequests)).toBe(1);
      if (scenario === "granted") {
        await expect(status).toContainText("อนุญาตให้เก็บข้อมูลถาวรแล้ว");
        await expect(button).toBeHidden();
      } else if (scenario === "denied") {
        await expect(status).toContainText("ยังไม่ได้รับอนุญาต");
        await expect(button).toBeEnabled();
      } else {
        await expect(status).toContainText("ขอเก็บข้อมูลถาวรไม่สำเร็จ");
        await expect(button).toBeEnabled();
      }
    }
    await sellOne(page);
    await expect(page.getByRole("dialog")).toHaveAccessibleName("ใบเสร็จรับเงิน");
  });
}

test("filters inventory by stock and availability together with search", async ({ page, request, pos }) => {
  const create = async (code, name) => {
    const response = await request.post(pos + "/products", {
      data: { code, name, base_unit: "ชิ้น", price: "10", minimum_quantity: "1" },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  await create("LOW", "ใกล้หมด");
  const paused = await create("PAUSE", "พักขาย");
  const negative = await create("NEG", "=ติดลบ");
  const stocked = await create("FULL", "มีสต๊อก");
  expect((await request.post(pos + "/products/" + paused.id + "/availability", {
    data: { available: false },
  })).status()).toBe(200);
  expect((await request.post(pos + "/products/" + stocked.id + "/receipts", {
    data: { unit_id: stocked.base_unit_id, quantity: "5", unit_cost: "5" },
  })).status()).toBe(201);
  expect((await request.post(pos + "/offline-sales", { data: {
    id: randomUUID(),
    items: [{ product_id: negative.id, unit_id: negative.base_unit_id, quantity: "0.5", expected_unit_price: "10" }],
    payments: { cash: "5", qr: "0", credit: "0" },
    qr_confirmed: false, sold_at: "2025-06-14T09:00:00.000Z",
  } })).status()).toBe(201);
  expect((await request.post(pos + "/products/" + negative.id + "/availability", {
    data: { available: false },
  })).status()).toBe(200);
  await page.goto(pos + "/");
  const rows = page.locator("#products").getByRole("button");
  const filter = page.getByLabel("กรองสินค้า");
  const search = page.getByRole("searchbox", { name: "ค้นหาสินค้า" });
  await expect(rows).toHaveCount(4);
  await filter.selectOption("low");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("LOW");
  await filter.selectOption("negative");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("NEG");
  const csv = await downloadCsv(page, "ดาวน์โหลดรายการสต๊อก CSV", "stock-negative.csv");
  expect(csv.trimEnd().split(/\r?\n/)).toEqual([
    "รหัสสินค้า,ชื่อสินค้า,หน่วยสต๊อก,คงเหลือ,จำนวนขั้นต่ำ,ต้นทุนเฉลี่ย,สถานะขาย,สถานะสต๊อก",
    "NEG,'=ติดลบ,ชิ้น,-0.5,1,,พักขาย,สต๊อกติดลบ",
  ]);
  await rows.first().click();
  await expect(page.locator("#detail-title")).toHaveText("=ติดลบ");
  await filter.selectOption("paused");
  await expect(rows).toHaveCount(2);
  await search.fill("PAUSE");
  await expect(rows).toHaveCount(1);
  await expect(page.locator("#detail-empty")).toBeVisible();
  await search.fill("missing");
  await expect(page.locator("#list-state")).toHaveText("ไม่พบสินค้าที่ตรงกับตัวกรอง");
  await expect(page.getByRole("button", { name: "ดาวน์โหลดรายการสต๊อก CSV" })).toBeDisabled();
  await search.fill("");
  await filter.selectOption("all");
  await expect(rows).toHaveCount(4);
});

test("owner pauses and reactivates a product across checkout and offline reload", async ({ page, context, request, pos }) => {
  await createProduct(request, pos);
  await page.goto(pos + "/");
  await page.locator("#products").getByRole("button", { name: /น้ำดื่ม/ }).click();
  await page.getByRole("button", { name: "พักขาย", exact: true }).click();
  await expect(page.locator("#availability")).toHaveText("สถานะ พักขาย");
  await expect(page.locator("#products")).toContainText("พักขาย");
  await page.goto(pos + "/checkout");
  await expect(page.locator("#sale-connection")).toContainText("เปิดหน้าขายและบันทึกบิลออฟไลน์ได้");
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const search = page.getByRole("searchbox", { name: "ค้นหาสินค้า" });
  await search.fill("W01");
  await search.press("Enter");
  await expect(search).toHaveValue("W01");
  await expect(page.locator("#sale-empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด" })).toHaveCount(0);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#sale-connection")).toContainText("ออฟไลน์");
  await expect(page.locator("#sale-products-state")).toHaveText("ยังไม่มีสินค้า");
  await search.fill("W01");
  await search.press("Enter");
  await expect(page.locator("#sale-empty")).toBeVisible();
  await context.setOffline(false);
  await page.goto(pos + "/");
  await page.locator("#products").getByRole("button", { name: /น้ำดื่ม/ }).click();
  await page.getByRole("button", { name: "เปิดขายอีกครั้ง" }).click();
  await expect(page.locator("#availability")).toHaveText("สถานะ พร้อมขาย");
  await page.goto(pos + "/checkout");
  await expect(page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด" })).toBeVisible();
  await search.fill("W01");
  await search.press("Enter");
  await expect(page.getByRole("textbox", { name: "จำนวน น้ำดื่ม ขวด" })).toHaveValue("1");
});

test("calculates cash change and keeps only net cash in the bill", async ({ page, context, request, pos }) => {
  await createProduct(request, pos);
  await page.goto(pos + "/checkout");
  await expect(page.locator("#sale-connection")).toContainText("เปิดหน้าขายและบันทึกบิลออฟไลน์ได้");
  await page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true }).click();
  await page.getByRole("button", { name: "เงินสดเต็มจำนวน" }).click();
  const tender = page.getByRole("textbox", { name: "เงินสดที่รับ (บาท)" });
  await tender.fill("20");
  await expect(page.locator("#sale-submit")).toBeDisabled();
  await expect(page.locator("#sale-change")).toContainText("น้อยกว่า");
  await tender.fill("100");
  await expect(page.locator("#sale-change")).toHaveText("เงินทอน 75.00 บาท");
  await page.getByRole("button", { name: "ปิดบิล", exact: true }).click();
  await expect(page.locator("#sale-receipt-change")).toHaveText("เงินทอน 75.00 บาท");
  const [bill] = await (await request.get(pos + "/sale-history")).json();
  expect(bill.payments.cash).toBe("25.00");
  await page.getByRole("button", { name: "ข้ามการพิมพ์" }).click();
  await context.setOffline(true);
  await expect(page.locator("#sale-connection")).toContainText("ออฟไลน์");
  await page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true }).click();
  await page.locator('input[name="cash"]').fill("10");
  await page.locator('input[name="qr"]').fill("15");
  await page.getByLabel("ตรวจสอบเงินโอนเข้าแล้ว").check();
  await tender.fill("20");
  await expect(page.locator("#sale-change")).toHaveText("เงินทอน 10.00 บาท");
  await page.getByRole("button", { name: "ปิดบิล", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName("หลักฐานการขายจากเครื่องนี้");
  const [queued] = await page.evaluate(() => window.PosOffline.list());
  expect(queued.payload.payments).toEqual({ cash: "10.00", qr: "15.00", credit: "0.00" });
  expect(queued.payload).not.toHaveProperty("tender");
});

test("adds exact product codes from search online and offline", async ({ page, context, request, pos }) => {
  const product = await createProduct(request, pos);
  const unit = await request.post(pos + "/products/" + product.id + "/units", {
    data: { name: "แพ็ก", multiplier: "6", price: "120" },
  });
  expect(unit.status()).toBe(201);
  await page.goto(pos + "/checkout");
  await expect(page.locator("#sale-connection")).toContainText("เปิดหน้าขายและบันทึกบิลออฟไลน์ได้");
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const search = page.getByRole("searchbox", { name: "ค้นหาสินค้า" });
  await search.fill("W0");
  await search.press("Enter");
  await expect(search).toHaveValue("W0");
  await expect(page.locator("#sale-empty")).toBeVisible();
  await search.fill("w01");
  await search.press("Enter");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  const quantity = page.getByRole("textbox", { name: "จำนวน น้ำดื่ม ขวด" });
  await expect(quantity).toHaveValue("1");
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#sale-connection")).toContainText("ออฟไลน์");
  await search.fill("W01");
  await search.press("Enter");
  await search.fill("W01");
  await search.press("Enter");
  await expect(quantity).toHaveValue("2");
  await expect(page.getByRole("textbox", { name: "จำนวน น้ำดื่ม แพ็ก" })).toHaveCount(0);
});

test("automatically retries a queued bill when the server recovers without an online event", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  await page.goto(pos + "/checkout");
  await expect(page.locator("#sale-connection")).toContainText("เปิดหน้าขายและบันทึกบิลออฟไลน์ได้");
  let attempts = 0;
  let serverAvailable = false;
  await page.route("**/sales", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts += 1;
    if (!serverAvailable) return route.abort("connectionfailed");
    return route.continue();
  });
  await sellOne(page);
  await expect(page.getByRole("dialog")).toHaveAccessibleName("หลักฐานการขายจากเครื่องนี้");
  const [{ payload }] = await page.evaluate(() => window.PosOffline.list());
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await expect.poll(() => attempts, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
  serverAvailable = true;
  await expect.poll(async () => (await request.get(pos + "/sales/" + payload.id)).status(), { timeout: 25000 }).toBe(200);
  await expect.poll(() => page.evaluate(() => window.PosOffline.list()), { timeout: 10000 }).toEqual([]);
  const history = await (await request.get(pos + "/sale-history")).json();
  expect(history.filter((bill) => bill.id === payload.id)).toHaveLength(1);
  const products = await (await request.get(pos + "/products")).json();
  expect(products.find(({ id }) => id === product.id).quantity).toBe("0");
});

test("offline bill survives reload and syncs once after another device sells the last unit",
  async ({ browser, context, page, request, pos }) => {
    const product = await createProduct(request, pos);
    await page.goto(pos + "/checkout");
    await expect(page.locator("#sale-connection")).toContainText("เปิดหน้าขายและบันทึกบิลออฟไลน์ได้");
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    await context.setOffline(true);
    await expect(page.locator("#sale-connection")).toContainText("ออฟไลน์ ·");
    await sellOne(page);
    await expect(page.getByRole("dialog")).toHaveAccessibleName("หลักฐานการขายจากเครื่องนี้");
    await expect(page.locator("#sale-receipt-state")).toHaveText("รอส่งข้อมูลเข้าระบบ");
    const queue = () => page.evaluate(() => window.PosOffline.list());
    const [{ payload }] = await queue();
    expect(payload.offline).toBe(true);
    expect(payload.sold_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    const beforeSync = await request.get(pos + "/sales/" + payload.id);
    expect(beforeSync.status()).toBe(404);
    const offlineNavigation = await page.reload();
    expect(offlineNavigation.fromServiceWorker()).toBe(true);
    await expect(page.locator("#sale-queue")).toContainText(payload.id);
    await expect(page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true })).toBeVisible();
    expect(await queue()).toEqual([{ payload, state: "pending", error: null }]);

    await page.getByRole("link", { name: "สำรองบิลในเครื่อง" }).click();
    await expect(page).toHaveURL(pos + "/checkout/backup");
    await expect(page.locator("#backup-queue-count")).toContainText("1 บิล");
    const [backup] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "ดาวน์โหลดบิลรอส่ง" }).click(),
    ]);
    const savedQueue = JSON.parse(await readFile(await backup.path(), "utf8"));
    expect(savedQueue).toMatchObject({ format: "pos-sale-queue", version: 1, entries: [{ payload }] });
    await page.getByRole("link", { name: "ขายสินค้า", exact: true }).click();
    await expect(page.locator("#sale-queue")).toContainText(payload.id);

    const priceChange = await request.post(pos + "/products/" + product.id + "/units/"
      + product.base_unit_id + "/price", { data: { price: "32", expected_price: "25" } });
    expect(priceChange.status()).toBe(200);

    const otherContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      await otherPage.goto(pos + "/checkout");
      await sellOne(otherPage);
      await expect(otherPage.getByRole("dialog")).toHaveAccessibleName("ใบเสร็จรับเงิน");
      await expect(otherPage.locator("#sale-receipt-total")).toContainText("32.00");
      await expect(otherPage.locator("#sale-message")).toContainText("ปิดบิลและส่งข้อมูลแล้ว");
    } finally {
      await otherContext.close();
    }

    page.on("requestfailed", (request) => {
      if (request.url().endsWith("/offline-sales")) {
        console.error("Offline sale request failed:", request.failure()?.errorText);
      }
    });
    await context.setOffline(false);
    await expect(page.locator("#sale-message")).toContainText("สต๊อกติดลบ 1 บิล");
    await expect(page.locator("#sale-pending")).toBeHidden();
    expect(await queue()).toEqual([]);

    const replay = await request.post(pos + "/offline-sales", { data: payload });
    expect(replay.status()).toBe(200);
    const sale = await replay.json();
    expect(sale).toMatchObject({ id: payload.id, sold_at: payload.sold_at, total: "25.00" });
    expect(sale.items[0].unit_price).toBe("25");
    expect(sale.stock_shortages).toEqual([expect.objectContaining({
      product_id: product.id, remaining: "1",
    })]);

    const historyResponse = await request.get(pos + "/sale-history");
    expect(historyResponse.ok()).toBe(true);
    const history = await historyResponse.json();
    expect(history).toHaveLength(2);
    expect(history.filter((bill) => bill.id === payload.id)).toHaveLength(1);

    const inventoryResponse = await request.get(pos + "/products");
    expect(inventoryResponse.ok()).toBe(true);
    expect(await inventoryResponse.json()).toEqual([
      expect.objectContaining({ id: product.id, quantity: "-1" }),
    ]);
  });

for (const viewport of [{ width: 360, height: 800 }, { width: 768, height: 1024 }]) {
  test(`checkout and reports fit a touch viewport of ${viewport.width}px`,
    async ({ browser, request, pos }) => {
      const phone = viewport.width === 360;
      const productName = phone ? "=1+1" : "น้ำดื่ม";
      await createProduct(request, pos, productName);
      if (viewport.width <= 720) {
        for (let index = 0; index < 12; index++) {
          const response = await request.post(pos + "/products", {
            data: { code: "EX" + index, name: "สินค้าทดสอบ " + index, base_unit: "ชิ้น", price: "10" },
          });
          expect(response.status()).toBe(201);
        }
      }
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
      try {
        const page = await context.newPage();
        const fitsViewport = () => page.evaluate(() =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth
        );

        await page.goto(pos + "/checkout");
        const search = page.getByRole("searchbox", { name: "ค้นหาสินค้า" });
        await search.fill("W01");
        await page.getByRole("button", { name: `เพิ่ม ${productName} ขวด`, exact: true }).tap();
        if (viewport.width <= 720) {
          await search.clear();
          await expect(page.locator("#sale-products > li")).toHaveCount(13);
          await page.getByRole("link", { name: "ไปตะกร้าสินค้า" }).tap();
          await expect(page.getByRole("heading", { name: "ตะกร้าสินค้า" })).toBeFocused();
        }
        await page.getByRole("button", { name: "เงินสดเต็มจำนวน", exact: true }).tap();
        await page.getByRole("button", { name: "ปิดบิล", exact: true }).tap();
        const receipt = page.getByRole("dialog", { name: "ใบเสร็จรับเงิน" });
        await expect(receipt).toBeVisible();
        await expect(receipt).toContainText("25.00");
        expect(await fitsViewport()).toBe(true);
        await receipt.getByRole("button", { name: "ข้ามการพิมพ์" }).tap();

        await page.getByRole("link", { name: "รายงานยอดขาย" }).tap();
        await expect(page.locator("#report-summary")).toContainText("25.00");
        await expect(page.locator("#report-products")).toContainText(productName);
        const daily = page.locator("#report-days-wrap");
        await expect(daily).toBeVisible();
        expect(await fitsViewport()).toBe(true);
        expect(await daily.evaluate((region) => {
          region.scrollLeft = region.scrollWidth;
          const lastColumn = region.querySelector("thead th:last-child");
          return region.scrollLeft > 0
            && lastColumn.getBoundingClientRect().right <= region.getBoundingClientRect().right + 1;
        })).toBe(true);

        if (phone) {
          const from = await page.locator('#report-filters input[name="from"]').inputValue();
          const to = await page.locator('#report-filters input[name="to"]').inputValue();
          const dateRange = `${from}-to-${to}`;
          const dailyCsv = await downloadCsv(page, "ดาวน์โหลดรายวัน (CSV)", `sales-daily-${dateRange}.csv`, { touch: true });
          expect(dailyCsv).toMatch(/^(?:วันที่|"วันที่"),/);
          expect(dailyCsv).toMatch(/(?:^|,)("?)25\.00\1(?:,|\r?$)/m);

          const productCsv = await downloadCsv(page, "ดาวน์โหลดรายสินค้า (CSV)", `sales-products-${dateRange}.csv`, { touch: true });
          expect(productCsv).toMatch(/^(?:สินค้า|"สินค้า"),/);
          expect(productCsv).toMatch(/(?:^|,)("?)25\.00\1(?:,|\r?$)/m);
          expect(productCsv).toMatch(/(?:^|,)("?)'=1\+1\1(?:,|\r?$)/m);
        }
      } finally {
        await context.close();
      }
    });
}

test("edits inventory and uses the new price at checkout", async ({ page, request, pos }) => {
  await createProduct(request, pos);
  await page.goto(pos + "/");
  await page.locator("#products").getByRole("button", { name: /น้ำดื่ม/ }).click();
  await page.getByRole("button", { name: "แก้ไขสินค้า", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "แก้ไขสินค้า" });
  await edit.getByLabel("ชื่อสินค้า").fill("น้ำแร่");
  await edit.getByLabel("รหัสสินค้า").fill("W02");
  await edit.getByRole("button", { name: "บันทึกสินค้า" }).click();
  await expect(page.locator("#detail-title")).toHaveText("น้ำแร่");

  await page.getByRole("button", { name: "แก้ไขราคา ขวด" }).click();
  const price = page.getByRole("dialog", { name: "แก้ไขราคาขาย" });
  await price.getByLabel("ราคาขายต่อหน่วย (บาท)").fill("32");
  await price.getByRole("button", { name: "บันทึกราคาขาย" }).click();
  await expect(page.locator("#units")).toContainText("32 บาท");

  await page.goto(pos + "/checkout");
  await page.getByRole("searchbox", { name: "ค้นหาสินค้า" }).fill("W02");
  await page.getByRole("button", { name: "เพิ่ม น้ำแร่ ขวด" }).click();
  await expect(page.locator("#sale-total")).toContainText("32.00");
  await page.getByRole("button", { name: "เงินสดเต็มจำนวน" }).click();
  await page.getByRole("button", { name: "ปิดบิล", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "ใบเสร็จรับเงิน" })).toContainText("32.00");
});

test("reprints original receipt values and labels a voided bill", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  await page.addInitScript(() => {
    window.printCount = 0;
    window.print = () => { window.printCount += 1; };
  });
  await page.goto(pos + "/checkout");
  await sellOne(page);
  await page.getByRole("button", { name: "ข้ามการพิมพ์" }).click();

  const history = await request.get(pos + "/sale-history");
  expect(history.ok()).toBe(true);
  const [bill] = await history.json();
  const edit = await request.post(`${pos}/products/${product.id}/edit`, {
    data: {
      code: "W01", name: "น้ำแร่", minimum_quantity: "0",
      expected: { code: "W01", name: "น้ำดื่ม", minimum_quantity: "0" },
    },
  });
  expect(edit.ok()).toBe(true);
  const price = await request.post(`${pos}/products/${product.id}/units/${product.base_unit_id}/price`, {
    data: { price: "32", expected_price: "25" },
  });
  expect(price.ok()).toBe(true);

  const openReceipt = async () => {
    await page.locator("#bill-list").getByRole("button", { name: new RegExp(bill.id) }).click();
    await page.getByRole("button", { name: "พิมพ์ใบเสร็จ", exact: true }).click();
  };
  const receipt = page.getByRole("dialog", { name: "พิมพ์ใบเสร็จย้อนหลัง" });
  const print = receipt.getByRole("button", { name: "พิมพ์ใบเสร็จ", exact: true });

  await page.goto(pos + "/bills");
  await openReceipt();
  await expect(receipt).toContainText(bill.id);
  await expect(receipt).toContainText("น้ำดื่ม");
  await expect(receipt.locator("#bill-receipt-items small")).toContainText("× 25.00 บาท");
  await expect(receipt.locator("#bill-receipt-total")).toHaveText("ยอดรวม 25.00 บาท");
  await expect(receipt).toContainText("เงินสด");
  await expect(receipt).not.toContainText("น้ำแร่");
  await expect(receipt).not.toContainText("32.00");
  await expect(receipt.getByText("ยกเลิกแล้ว", { exact: true })).toBeHidden();

  await page.emulateMedia({ media: "print" });
  await expect(page.locator("body > header")).toBeHidden();
  await expect(page.locator("body > main")).toBeHidden();
  await expect(receipt).toBeVisible();
  await expect(print).toBeHidden();
  await page.emulateMedia({ media: null });
  await print.click();
  expect(await page.evaluate(() => window.printCount)).toBe(1);

  const correction = await request.post(`${pos}/sales/${bill.id}/corrections`, {
    data: { id: randomUUID(), reason: "ยกเลิกบิลทดสอบ" },
  });
  expect(correction.status()).toBe(201);
  await page.reload();
  await openReceipt();
  await expect(receipt.getByText("ยกเลิกแล้ว", { exact: true })).toBeVisible();
  await expect(receipt).toContainText("น้ำดื่ม");
  await expect(receipt).toContainText("25.00");
  await print.click();
  expect(await page.evaluate(() => window.printCount)).toBe(1);
});

test("filters bill history by inclusive Bangkok sale dates and status", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  const restock = await request.post(`${pos}/products/${product.id}/receipts`, {
    data: { unit_id: product.base_unit_id, quantity: "4", unit_cost: "12" },
  });
  expect(restock.status()).toBe(201);

  const recordBill = async (soldAt) => {
    const response = await request.post(pos + (soldAt ? "/offline-sales" : "/sales"), {
      data: {
        id: randomUUID(),
        items: [{ product_id: product.id, unit_id: product.base_unit_id, quantity: "1", expected_unit_price: "25" }],
        payments: { cash: "25", qr: "0", credit: "0" },
        qr_confirmed: false,
        ...(soldAt ? { sold_at: soldAt } : {}),
      },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  // Bangkok midnight is at 17:00 UTC on the previous day.
  const previous = await recordBill("2025-06-13T16:59:59.999Z");
  const first = await recordBill("2025-06-13T17:00:00.000Z");
  const last = await recordBill("2025-06-14T16:59:59.999Z");
  const next = await recordBill("2025-06-14T17:00:00.000Z");
  const online = await recordBill();
  const cancellation = await request.post(`${pos}/sales/${last.id}/corrections`, {
    data: { id: randomUUID(), reason: "ยกเลิกบิลทดสอบ" },
  });
  expect(cancellation.status()).toBe(201);

  await page.goto(pos + "/bills");
  const rows = page.locator("#bill-list").getByRole("button");
  const from = page.getByLabel("ตั้งแต่วันที่", { exact: true });
  const to = page.getByLabel("ถึงวันที่", { exact: true });
  const status = page.getByLabel("สถานะบิล", { exact: true });
  const search = page.getByRole("searchbox", { name: "ค้นหาบิล" });
  await expect(rows).toHaveCount(5);

  await from.fill("2025-06-14");
  await to.fill("2025-06-14");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(last.id);
  await expect(rows.nth(1)).toContainText(first.id);

  await status.selectOption("active");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(first.id);
  await search.fill(last.id);
  await expect(rows).toHaveCount(0);
  await status.selectOption("voided");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(last.id);

  await page.getByRole("button", { name: "ล้างตัวกรอง", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(5);
  for (const bill of [previous, next, online]) {
    await expect(rows.filter({ hasText: bill.id })).toBeVisible();
  }

  const onlineDay = new Date(Date.parse(online.created_at) + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await from.fill(onlineDay);
  await to.fill("2025-06-14");
  await expect(page.locator("#bill-list-state")).toHaveText("วันที่เริ่มต้นต้องไม่อยู่หลังวันที่สิ้นสุด");
  await expect(rows).toHaveCount(0);
  await to.fill(onlineDay);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(online.id);
});

test("filters bill history by payment method and exports matching bills", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  const restock = await request.post(`${pos}/products/${product.id}/receipts`, {
    data: { unit_id: product.base_unit_id, quantity: "4", unit_cost: "12" },
  });
  expect(restock.status()).toBe(201);
  const customerName = '=ลูกค้า,"ทดสอบ"';
  const createdCustomer = await request.post(pos + "/customers", { data: { name: customerName } });
  expect(createdCustomer.status()).toBe(201);
  const customer = await createdCustomer.json();

  const recordBill = async ({ cash = "0", qr = "0", credit = "0" }, day) => {
    const response = await request.post(pos + "/offline-sales", {
      data: {
        id: randomUUID(),
        items: [{ product_id: product.id, unit_id: product.base_unit_id, quantity: "1", expected_unit_price: "25" }],
        payments: { cash, qr, credit },
        qr_confirmed: qr !== "0",
        ...(credit !== "0" ? { customer_id: customer.id } : {}),
        sold_at: day + "T09:00:00.000Z",
      },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const cashBill = await recordBill({ cash: "25" }, "2025-06-14");
  const qrBill = await recordBill({ qr: "25" }, "2025-06-14");
  const creditBill = await recordBill({ credit: "25" }, "2025-06-14");
  const splitBill = await recordBill({ cash: "5", qr: "10", credit: "10" }, "2025-06-14");
  const voidedBill = await recordBill({ cash: "15", qr: "10" }, "2025-06-15");
  const cancellation = await request.post(`${pos}/sales/${voidedBill.id}/corrections`, {
    data: { id: randomUUID(), reason: "ยกเลิกบิลทดสอบ" },
  });
  expect(cancellation.status()).toBe(201);

  await page.goto(pos + "/bills");
  const rows = page.locator("#bill-list").getByRole("button");
  const payment = page.getByLabel("วิธีชำระเงิน", { exact: true });
  const status = page.getByLabel("สถานะบิล", { exact: true });
  const to = page.getByLabel("ถึงวันที่", { exact: true });
  const search = page.getByRole("searchbox", { name: "ค้นหาบิล" });
  const exportLabel = "ดาวน์โหลด CSV";
  const exportButton = page.getByRole("button", { name: exportLabel, exact: true });
  const csvHeader = "เลขอ้างอิง,วันที่ขาย,สถานะบิล,ลูกค้า,ยอดรวม (บาท),เงินสด (บาท),โอนผ่าน QR (บาท),เงินเชื่อ (บาท),เลขบิลทดแทน";
  const expectBills = async (...bills) => {
    await expect(rows).toHaveCount(bills.length);
    for (const bill of bills) await expect(rows.filter({ hasText: bill.id })).toBeVisible();
  };

  await expectBills(cashBill, qrBill, creditBill, splitBill, voidedBill);
  await payment.selectOption("cash");
  await expectBills(cashBill, splitBill, voidedBill);
  await payment.selectOption("qr");
  await expectBills(qrBill, splitBill, voidedBill);
  await payment.selectOption("credit");
  await expectBills(creditBill, splitBill);
  await payment.selectOption("mixed");
  await expectBills(splitBill, voidedBill);
  await status.selectOption("voided");
  await expectBills(voidedBill);
  const voidedCsv = await downloadCsv(page, exportLabel, "bill-history.csv");
  expect(voidedCsv.trimEnd().split(/\r?\n/)).toEqual([
    csvHeader,
    `${voidedBill.id},2025-06-15,ยกเลิกแล้ว,,25.00,15.00,10.00,0.00,`,
  ]);
  await to.fill("2025-06-14");
  await expectBills();
  await expect(exportButton).toBeDisabled();
  await status.selectOption("active");
  await search.fill(customerName);
  await expectBills(splitBill);
  const splitCsv = await downloadCsv(page, exportLabel, "bill-history.csv");
  expect(splitCsv.trimEnd().split(/\r?\n/)).toEqual([
    csvHeader,
    `${splitBill.id},2025-06-14,บิลปกติ,"'=ลูกค้า,""ทดสอบ""",25.00,5.00,10.00,10.00,`,
  ]);
  await search.fill(cashBill.id);
  await expectBills();

  await page.getByRole("button", { name: "ล้างตัวกรอง", exact: true }).click();
  await expect(payment).toHaveValue("");
  await expectBills(cashBill, qrBill, creditBill, splitBill, voidedBill);
  await expect(exportButton).toBeEnabled();
});
