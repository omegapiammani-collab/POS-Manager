const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, rm } = require("node:fs/promises");
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

async function createProduct(request, pos) {
  const added = await request.post(pos + "/products", {
    data: { code: "W01", name: "น้ำดื่ม", base_unit: "ขวด", price: "25" },
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

    const otherContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      await otherPage.goto(pos + "/checkout");
      await sellOne(otherPage);
      await expect(otherPage.getByRole("dialog")).toHaveAccessibleName("ใบเสร็จรับเงิน");
      await expect(otherPage.locator("#sale-message")).toContainText("ปิดบิลและส่งข้อมูลแล้ว");
    } finally {
      await otherContext.close();
    }

    await context.setOffline(false);
    await expect(page.locator("#sale-message")).toContainText("สต๊อกติดลบ 1 บิล");
    await expect(page.locator("#sale-pending")).toBeHidden();
    expect(await queue()).toEqual([]);

    const replay = await request.post(pos + "/offline-sales", { data: payload });
    expect(replay.status()).toBe(200);
    const sale = await replay.json();
    expect(sale).toMatchObject({ id: payload.id, sold_at: payload.sold_at });
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
