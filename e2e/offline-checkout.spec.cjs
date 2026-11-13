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

async function downloadCsv(page, label, filename) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: label, exact: true }).tap(),
  ]);
  expect(download.suggestedFilename()).toBe(filename);
  const contents = await readFile(await download.path());
  expect([...contents.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return contents.subarray(3).toString("utf8");
}

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
          const dailyCsv = await downloadCsv(page, "ดาวน์โหลดรายวัน (CSV)", `sales-daily-${dateRange}.csv`);
          expect(dailyCsv).toMatch(/^(?:วันที่|"วันที่"),/);
          expect(dailyCsv).toMatch(/(?:^|,)("?)25\.00\1(?:,|\r?$)/m);

          const productCsv = await downloadCsv(page, "ดาวน์โหลดรายสินค้า (CSV)", `sales-products-${dateRange}.csv`);
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
