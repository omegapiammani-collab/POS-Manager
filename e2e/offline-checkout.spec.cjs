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
      "inventory_api.py", "--port", "0", "--database", join(directory, "test.sqlite3"), "--create-database",
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

test("debt history shows the offline sale time in Bangkok", async ({ page, pos }) => {
  const soldAt = "2026-11-01T17:00:00.000Z";
  const createdAt = "2026-11-05T05:00:00.000Z";
  await page.route("**/customer-debts", (route) => route.fulfill({ json: [
    { id: "customer", name: "ลูกค้า ก", outstanding: "20.00" },
  ] }));
  await page.route("**/customers/customer/debt", (route) => route.fulfill({ json: {
    id: "customer", name: "ลูกค้า ก", outstanding: "20.00", repayments: [], bills: [
      { id: "offline", created_at: createdAt, sold_at: soldAt, credit: "10.00", paid: "0.00", outstanding: "10.00" },
      { id: "legacy", created_at: createdAt, credit: "10.00", paid: "0.00", outstanding: "10.00" },
    ],
  } }));
  await page.goto(pos + "/debts");
  await page.getByRole("button", { name: /ลูกค้า ก/ }).click();
  const expected = await page.evaluate(([sold, created]) => {
    const format = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });
    return [format.format(new Date(sold)), format.format(new Date(created))];
  }, [soldAt, createdAt]);
  await expect(page.locator("#debt-bills li").nth(0)).toContainText(expected[0]);
  await expect(page.locator("#debt-bills li").nth(1)).toContainText(expected[1]);
});

test("debt dates use Bangkok time regardless of browser timezone", async ({ browser, pos }) => {
  const formatter = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });
  const expected = formatter.format(new Date("2026-11-01T17:00:00Z"));
  for (const timezoneId of ["UTC", "Asia/Bangkok", "America/Los_Angeles"]) {
    const context = await browser.newContext({ timezoneId });
    try {
      const page = await context.newPage();
      await page.route("**/customer-debts", (route) => route.fulfill({ json: [
        { id: "customer", name: "ลูกค้า ก", outstanding: "20.00" },
      ] }));
      await page.route("**/customers/customer/debt", (route) => route.fulfill({ json: {
        id: "customer", name: "ลูกค้า ก", outstanding: "20.00", bills: [
          { id: "online", created_at: "2026-11-01 17:00:00", sold_at: null, credit: "10.00", paid: "0.00", outstanding: "10.00" },
          { id: "offline", created_at: "2026-11-05 05:00:00", sold_at: "2026-11-01T17:00:00.000Z", credit: "10.00", paid: "0.00", outstanding: "10.00" },
        ], repayments: [{ id: "repayment", created_at: "2026-11-01 17:00:00", amount: "5.00", method: "cash", note: "", allocations: [] }],
      } }));
      await page.goto(pos + "/debts");
      await page.getByRole("button", { name: /ลูกค้า ก/ }).click();
      await expect(page.locator("#debt-bills li").nth(0)).toContainText(expected);
      await expect(page.locator("#debt-bills li").nth(1)).toContainText(expected);
      await expect(page.locator("#debt-history > li")).toContainText(expected);
    } finally {
      await context.close();
    }
  }
});

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

test("warns when the product catalog is cached until a server refresh succeeds", async ({ page, context, request, pos }) => {
  await createProduct(request, pos);
  await page.goto(pos + "/checkout");
  await expect(page.locator("#sale-connection")).toContainText("เปิดหน้าขายและบันทึกบิลออฟไลน์ได้");
  const warning = page.locator("#sale-products-cached");
  const refresh = page.getByRole("button", { name: "โหลดข้อมูลสินค้าล่าสุด" });
  await expect(warning).toBeHidden();
  await context.setOffline(true);
  await expect(warning).toContainText("ราคาและสถานะขายอาจไม่เป็นปัจจุบัน");
  await page.reload();
  await expect(warning).toBeVisible();
  await expect(page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true })).toBeVisible();
  await page.route("**/products", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
  await context.setOffline(false);
  await expect(warning).toBeVisible();
  await Promise.all([
    page.waitForResponse((response) => response.url() === pos + "/products" && response.status() === 503),
    refresh.click(),
  ]);
  await expect(warning).toBeVisible();
  await page.unroute("**/products");
  await refresh.click();
  await expect(warning).toBeHidden();
  await expect(refresh).toBeHidden();

  // If storage itself fails, keep the already displayed catalog and warn about it.
  await page.evaluate(() => {
    window.failedSnapshotReads = 0;
    window.PosOffline.getSnapshot = async () => {
      window.failedSnapshotReads++;
      throw new Error("storage unavailable");
    };
  });
  await page.route("**/products", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
  await context.setOffline(true);
  await expect(warning).toBeVisible();
  await context.setOffline(false);
  await Promise.all([
    page.waitForResponse((response) => response.url() === pos + "/products" && response.status() === 503),
    refresh.click(),
  ]);
  await expect.poll(() => page.evaluate(() => window.failedSnapshotReads)).toBeGreaterThan(0);
  await expect(warning).toBeVisible();
  await expect(page.locator("#sale-products-state")).toBeHidden();
  await expect(page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true })).toBeVisible();
});

test("confirms a changed cart price only after a fresh recheck", async ({ page, context, request, pos }) => {
  const product = await createProduct(request, pos);
  expect((await request.post(`${pos}/products/${product.id}/receipts`, {
    data: { unit_id: product.base_unit_id, quantity: "1", unit_cost: "12" },
  })).ok()).toBe(true);
  await page.goto(pos + "/checkout");
  await page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true }).click();
  await page.getByLabel("จำนวน น้ำดื่ม ขวด").fill("2");
  await page.getByRole("button", { name: "เงินสดเต็มจำนวน" }).click();
  await context.setOffline(true);
  expect((await request.post(`${pos}/products/${product.id}/units/${product.base_unit_id}/price`, {
    data: { price: "32", expected_price: "25" },
  })).ok()).toBe(true);
  await context.setOffline(false);
  await expect(page.locator("#sale-cart")).toContainText("ราคาเปลี่ยนแล้ว");
  const accept32 = page.getByRole("button", { name: "ใช้ราคาล่าสุด น้ำดื่ม ขวด 32 บาท" });
  await expect(accept32).toBeVisible();
  await expect(page.getByRole("button", { name: "ปิดบิล", exact: true })).toBeDisabled();
  await page.route("**/products", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
  await accept32.click();
  await expect(page.locator("#sale-message")).toContainText("โหลดราคาล่าสุดไม่สำเร็จ");
  await expect(page.locator("#sale-total")).toContainText("50.00");
  await expect(page.getByRole("button", { name: "ปิดบิล", exact: true })).toBeDisabled();
  await page.unroute("**/products");
  expect((await request.post(`${pos}/products/${product.id}/units/${product.base_unit_id}/price`, {
    data: { price: "36", expected_price: "32" },
  })).ok()).toBe(true);
  await accept32.click();
  await expect(page.locator("#sale-message")).toContainText("ราคาเปลี่ยนอีกครั้ง");
  await expect(page.locator("#sale-total")).toContainText("50.00");
  await page.getByRole("button", { name: "ใช้ราคาล่าสุด น้ำดื่ม ขวด 36 บาท" }).click();
  await expect(page.locator("#sale-total")).toContainText("72.00");
  await expect(page.getByLabel("จำนวน น้ำดื่ม ขวด")).toHaveValue("2");
  await expect(page.locator("#sale-balance")).toContainText("22.00");
  await expect(page.getByRole("button", { name: "ปิดบิล", exact: true })).toBeDisabled();
  expect((await (await request.get(pos + "/sale-history")).json())).toHaveLength(0);
  await page.getByRole("button", { name: "เงินสดเต็มจำนวน" }).click();
  await page.getByRole("button", { name: "ปิดบิล", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "ใบเสร็จรับเงิน" })).toContainText("72.00");
});

test("blocks a product paused after it was placed in the cart", async ({ page, context, request, pos }) => {
  const product = await createProduct(request, pos);
  await page.goto(pos + "/checkout");
  await page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true }).click();
  await page.getByRole("button", { name: "เงินสดเต็มจำนวน" }).click();
  await context.setOffline(true);
  expect((await request.post(`${pos}/products/${product.id}/availability`, {
    data: { available: false },
  })).ok()).toBe(true);
  await context.setOffline(false);
  await expect(page.locator("#sale-cart")).toContainText("สินค้านี้พักขาย");
  await expect(page.getByRole("button", { name: "ปิดบิล", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "เอา น้ำดื่ม ขวด ออก" }).click();
  await expect(page.locator("#sale-empty")).toBeVisible();
});

test("shows queued sale details offline using captured prices and safe name fallbacks", async ({ page, context, request, pos }) => {
  const product = await createProduct(request, pos);
  expect((await request.post(`${pos}/products/${product.id}/edit`, { data: {
    code: "W01", name: "น้ำแร่", minimum_quantity: "0", expected: { code: "W01", name: "น้ำดื่ม", minimum_quantity: "0" },
  } })).status()).toBe(200);
  await page.goto(pos + "/checkout");
  await expect(page.locator("#sale-connection")).toContainText("เปิดหน้าขายและบันทึกบิลออฟไลน์ได้");
  await expect.poll(() => page.evaluate(() => syncing)).toBe(false);
  await context.setOffline(true);
  const missingProduct = randomUUID(), missingUnit = randomUUID(), customer = randomUUID();
  const offline = { id: randomUUID(), offline: true, sold_at: "2026-11-12T17:00:00.000Z",
    items: [
      { product_id: product.id, unit_id: product.base_unit_id, quantity: "1.5", expected_unit_price: "25.005" },
      { product_id: missingProduct, unit_id: missingUnit, quantity: "2e0", expected_unit_price: "3e0" },
    ], payments: { cash: "30", qr: "3.51", credit: "10" }, customer_id: customer, qr_confirmed: true };
  const online = { id: randomUUID(), items: [offline.items[0]],
    payments: { cash: "37.51", qr: "0", credit: "0" }, customer_id: null, qr_confirmed: false };
  await page.evaluate(async ({ offline, online }) => {
    await window.PosOffline.put(offline);
    await window.PosOffline.update(offline.id, "conflict", "ราคาต้องตรวจสอบ");
    await window.PosOffline.put(online);
    await window.showQueue();
  }, { offline, online });
  const before = await page.evaluate(() => window.PosOffline.list());
  await page.getByRole("button", { name: `ดูรายละเอียดบิล ${offline.id}` }).click();
  const detail = page.getByRole("dialog", { name: "รายละเอียดบิลในเครื่อง" });
  await expect(detail).toContainText("ข้อมูลที่เครื่องโหลดไว้");
  await expect(detail).toContainText("ราคาต้องตรวจสอบ");
  await expect(detail).toContainText("น้ำแร่");
  await expect(detail).toContainText("25.005 บาท");
  await expect(detail).toContainText("37.51 บาท");
  await expect(detail).toContainText(missingProduct);
  await expect(detail).toContainText(missingUnit);
  await expect(detail).toContainText("6.00 บาท");
  await expect(detail).toContainText(customer);
  await expect(detail).toContainText("ยอดชำระรวม 43.51 บาท");
  await expect(detail).toContainText("เงินสด · 30.00 บาท");
  await expect(detail).toContainText("โอนผ่าน QR · 3.51 บาท");
  await expect(detail).toContainText("เงินเชื่อ · 10.00 บาท");
  const expectedTime = await page.evaluate(() => new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date("2026-11-12T17:00:00.000Z")));
  await expect(detail.locator("#sale-queue-detail-time")).toContainText(expectedTime);
  await detail.getByRole("button", { name: "ปิด", exact: true }).click();
  await page.getByRole("button", { name: `ดูรายละเอียดบิล ${online.id}` }).click();
  await expect(detail.locator("#sale-queue-detail-time")).toHaveText("ไม่มีเวลาขายที่บันทึกในบิลค้าง");
  await expect(detail.locator("#sale-queue-detail-customer")).toHaveText("ลูกค้า ไม่ระบุ");
  await detail.getByRole("button", { name: "ปิด", exact: true }).click();
  expect(await page.evaluate(() => window.PosOffline.list())).toEqual(before);
});

test("abandons a conflicting queued sale only after server confirmation, even if the response is lost", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  let attempts = 0;
  await page.route("**/sales/*/abandon", async (route) => {
    attempts++;
    if (attempts === 1) {
      expect((await route.fetch()).status()).toBe(200);
      return route.abort("connectionfailed");
    }
    return route.continue();
  });
  await page.goto(pos + "/checkout");
  const add = page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true });
  await add.click();
  await add.click();
  await page.getByRole("button", { name: "เงินสดเต็มจำนวน", exact: true }).click();
  await page.getByRole("button", { name: "ปิดบิล", exact: true }).click();
  await expect(page.locator("#sale-message")).toContainText("สินค้าคงเหลือไม่พอ");
  const [queued] = await page.evaluate(() => window.PosOffline.list());
  await page.getByRole("button", { name: "ข้ามการพิมพ์" }).click();
  const abandon = page.getByRole("button", { name: `ยกเลิกบิลค้าง ${queued.payload.id}` });
  const dialog = page.getByRole("dialog", { name: "ยกเลิกบิลที่รอตรวจสอบ" });
  await abandon.click();
  await dialog.getByRole("button", { name: "กลับ", exact: true }).click();
  expect(attempts).toBe(0);
  await abandon.click();
  await dialog.getByRole("button", { name: "ยืนยันยกเลิกบิลค้าง" }).click();
  await expect(page.locator("#sale-message")).toContainText("ยังยืนยันการยกเลิกไม่ได้");
  expect(await page.evaluate(() => window.PosOffline.list())).toHaveLength(1);
  await abandon.click();
  await dialog.getByRole("button", { name: "ยืนยันยกเลิกบิลค้าง" }).click();
  await expect(page.locator("#sale-message")).toContainText("ยกเลิกบิลค้างแล้ว");
  await expect(page.locator("#sale-pending")).toBeHidden();
  expect(attempts).toBe(2);
  expect((await request.post(pos + "/sales", { data: queued.payload })).status()).toBe(409);
  expect(await (await request.get(pos + "/sale-history")).json()).toHaveLength(0);
  expect(Number((await (await request.get(pos + "/products")).json())[0].quantity)).toBe(1);
  expect(product.id).toBe(queued.payload.items[0].product_id);
});

test("does not abandon or delete a queue entry if the sale was already recorded", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  const sale = { id: randomUUID(), items: [{ product_id: product.id, unit_id: product.base_unit_id, quantity: "1", expected_unit_price: "25" }],
    payments: { cash: "25", qr: "0", credit: "0" }, customer_id: null, qr_confirmed: false };
  expect((await request.post(pos + "/sales", { data: sale })).status()).toBe(201);
  await page.goto(pos + "/checkout");
  await expect(page.locator("#sale-connection")).toContainText("เปิดหน้าขายและบันทึกบิลออฟไลน์ได้");
  await expect.poll(() => page.evaluate(() => syncing)).toBe(false);
  await page.evaluate(async (payload) => {
    await window.PosOffline.put(payload);
    await window.PosOffline.update(payload.id, "conflict", "ต้องตรวจสอบ");
  }, sale);
  await page.reload();
  await page.getByRole("button", { name: `ยกเลิกบิลค้าง ${sale.id}` }).click();
  await page.getByRole("dialog", { name: "ยกเลิกบิลที่รอตรวจสอบ" }).getByRole("button", { name: "ยืนยันยกเลิกบิลค้าง" }).click();
  await expect(page.locator("#sale-message")).toContainText("บิลนี้บันทึกแล้ว");
  expect(await page.evaluate(() => window.PosOffline.list())).toHaveLength(1);
  expect((await request.get(pos + "/sales/" + sale.id)).status()).toBe(200);
});

test("owner confirms an online shortage and retries the same sale after a lost response", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  const attempts = [];
  await page.route("**/sales/allow-negative", async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      expect((await route.fetch()).status()).toBe(201);
      return route.abort("connectionfailed");
    }
    return route.continue();
  });
  await page.goto(pos + "/checkout");
  const add = page.getByRole("button", { name: "เพิ่ม น้ำดื่ม ขวด", exact: true });
  await add.click();
  await add.click();
  await page.getByRole("button", { name: "เงินสดเต็มจำนวน", exact: true }).click();
  await page.getByRole("button", { name: "ปิดบิล", exact: true }).click();
  await expect(page.locator("#sale-message")).toContainText("สินค้าคงเหลือไม่พอ");
  await page.getByRole("button", { name: "ข้ามการพิมพ์" }).click();
  const confirmButton = page.getByRole("button", { name: /ขายบิล .* แม้สต๊อกไม่พอ/ });
  await confirmButton.click();
  const dialog = page.getByRole("dialog", { name: "ยืนยันขายเมื่อสต๊อกไม่พอ" });
  await expect(dialog).toContainText("น้ำดื่ม");
  await expect(dialog).toContainText("50.00 บาท");
  await dialog.getByRole("button", { name: "กลับ", exact: true }).click();
  expect(attempts).toHaveLength(0);
  await confirmButton.click();
  await dialog.getByRole("button", { name: "ยืนยันขายและบันทึกสต๊อกติดลบ" }).click();
  await expect(page.locator("#sale-message")).toContainText("ยังไม่ทราบผล");
  await confirmButton.click();
  await dialog.getByRole("button", { name: "ยืนยันขายและบันทึกสต๊อกติดลบ" }).click();
  await expect(page.locator("#sale-message")).toContainText("บันทึกบิลแล้ว");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect(page.locator("#sale-pending")).toBeHidden();
  const sales = await (await request.get(pos + "/sale-history")).json();
  expect(sales).toHaveLength(1);
  expect(sales[0].id).toBe(attempts[0].id);
  const products = await (await request.get(pos + "/products")).json();
  expect(Number(products.find(({ id }) => id === product.id).quantity)).toBe(-1);
});

test("inventory history shows the Bangkok date around UTC midnight", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  await page.route(`**/products/${product.id}/receipts`, (route) => route.fulfill({ json: [
    { quantity: "1", unit_name: "ขวด", unit_cost: "12", created_at: "2026-11-12 17:00:00" },
  ] }));
  await page.route(`**/products/${product.id}/stock-counts`, (route) => route.fulfill({ json: [
    { expected_quantity: "1", counted_quantity: "2", delta: "1", reason: "ตรวจนับ", unit_cost: null, created_at: "2026-11-12T16:59:59.000Z" },
  ] }));
  await page.goto(pos + "/");
  await page.locator("#products").getByRole("button", { name: /น้ำดื่ม/ }).click();
  await expect(page.locator("#receipts")).toContainText("2026-11-13");
  await expect(page.locator("#stock-counts")).toContainText("2026-11-12");
});

for (const mode of ["edit", "void"]) {
  test(`warns when ${mode} correction cannot be stored and safely retries after a lost response`, async ({ page, request, pos }) => {
    const product = await createProduct(request, pos);
    const saleId = randomUUID();
    const saleResponse = await request.post(pos + "/sales", { data: {
      id: saleId, items: [{ product_id: product.id, unit_id: product.base_unit_id, quantity: "1", expected_unit_price: "25" }],
      payments: { cash: "25", qr: "0", credit: "0" }, qr_confirmed: false,
    } });
    expect(saleResponse.status()).toBe(201);
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === sessionStorage && key === "pos-pending-correction") throw new Error("storage unavailable");
        return original.call(this, key, value);
      };
    });
    const requests = [];
    await page.route(`**/sales/${saleId}/corrections`, async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        expect((await route.fetch()).status()).toBe(201);
        return route.abort("connectionfailed");
      }
      return route.continue();
    });
    await page.goto(pos + "/bills");
    await page.locator("#bill-list").getByRole("button", { name: new RegExp(saleId) }).click();
    await page.getByRole("button", { name: mode === "edit" ? "แก้ไขบิล" : "ยกเลิกบิล", exact: true }).click();
    const dialog = page.locator("#bill-correction");
    await dialog.getByLabel("เหตุผล", { exact: true }).fill("ตรวจสอบรายการ");
    await dialog.getByLabel("ตรวจสอบยอดเงินสดและเงินโอนที่เกี่ยวข้องแล้ว").check();
    await dialog.getByRole("button", { name: "บันทึก", exact: true }).click();
    await expect(dialog.locator("#bill-error")).toContainText("ส่งคำขอเดิมอีกครั้ง");
    await expect(dialog.locator("#bill-dialog-storage-warning")).toBeVisible();
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
    await dialog.getByRole("button", { name: "ปิด", exact: true }).click();
    await expect(page.locator("#bill-storage-warning")).toBeVisible();
    await page.getByRole("button", { name: "ส่งคำขอเดิมอีกครั้ง" }).click();
    await expect(page.locator("#bill-message")).toContainText(mode === "edit" ? "แก้ไขบิลแล้ว" : "ยกเลิกบิลแล้ว");
    await expect(page.locator("#bill-pending")).toBeHidden();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
    const history = await (await request.get(pos + "/sale-history")).json();
    expect(history).toHaveLength(mode === "edit" ? 2 : 1);
    expect(history.find((bill) => bill.id === saleId).status).toBe("voided");
    if (mode === "edit") expect(history.filter((bill) => bill.id === requests[0].replacement.id)).toHaveLength(1);
    const products = await (await request.get(pos + "/products")).json();
    expect(Number(products[0].quantity)).toBe(mode === "edit" ? 0 : 1);
  });
}

test("warns when expense request cannot be stored and safely retries after a lost response", async ({ page, request, pos }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && key === "pos-pending-expense") throw new Error("storage unavailable");
      return original.call(this, key, value);
    };
  });
  const ids = [];
  await page.route("**/expenses", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    ids.push(route.request().postDataJSON().id);
    if (ids.length === 1) {
      expect((await route.fetch()).status()).toBe(201);
      return route.abort("connectionfailed");
    }
    return route.continue();
  });
  await page.goto(pos + "/expense-entry");
  const date = await page.locator('#expense-create [name="date"]').inputValue();
  await page.getByLabel("รายการ", { exact: true }).fill("ค่าไฟ");
  await page.getByLabel("จำนวนเงิน (บาท)").fill("25");
  await page.getByLabel("แหล่งเงิน").selectOption("external");
  await page.getByRole("button", { name: "บันทึกค่าใช้จ่าย" }).click();
  await expect(page.locator("#expense-storage-warning")).toBeVisible();
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  await page.getByRole("button", { name: "ส่งคำขอเดิมอีกครั้ง" }).click();
  await expect(page.locator("#expense-message")).toContainText("บันทึกค่าใช้จ่ายแล้ว");
  await expect(page.locator("#expense-pending")).toBeHidden();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  const expenses = await (await request.get(`${pos}/expenses?from=${date}&to=${date}`)).json();
  expect(expenses).toHaveLength(1);
  expect(expenses[0]).toMatchObject({ id: ids[0], amount: "25.00", description: "ค่าไฟ" });
});

test("warns when drawer request cannot be stored and safely retries after a lost response", async ({ page, request, pos }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && key === "pos-pending-drawer") throw new Error("storage unavailable");
      return original.call(this, key, value);
    };
  });
  const ids = [];
  await page.route("**/cash-drawer/movements", async (route) => {
    ids.push(route.request().postDataJSON().id);
    if (ids.length === 1) {
      expect((await route.fetch()).status()).toBe(201);
      return route.abort("connectionfailed");
    }
    return route.continue();
  });
  await page.goto(pos + "/drawer");
  const date = await page.locator('#drawer-filter [name="date"]').inputValue();
  const opened = await request.post(pos + "/cash-drawer/open", { data: { id: randomUUID(), date, opening_cash: "100" } });
  expect(opened.status()).toBe(201);
  await page.getByRole("button", { name: "แสดงยอดล่าสุด" }).click();
  await page.getByLabel("จำนวนเงิน (บาท)").fill("20");
  await page.getByLabel("เหตุผล", { exact: true }).fill("เงินทอน");
  await page.getByRole("button", { name: "บันทึกรายการ", exact: true }).click();
  await expect(page.locator("#drawer-storage-warning")).toBeVisible();
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  await page.getByRole("button", { name: "ส่งคำขอเดิมอีกครั้ง" }).click();
  await expect(page.locator("#drawer-message")).toContainText("บันทึกรายการเงินสดแล้ว");
  await expect(page.locator("#drawer-pending")).toBeHidden();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  const drawer = await (await request.get(`${pos}/cash-drawer?date=${date}`)).json();
  expect(drawer.movements).toHaveLength(1);
  expect(drawer.movements[0]).toMatchObject({ id: ids[0], amount: "20.00", reason: "เงินทอน" });
  expect(drawer.expected_cash).toBe("120.00");
});

test("pending requests stored in a tab also warn before leaving and stop warning when cleared", async ({ page, pos }) => {
  const id = randomUUID();
  const cases = [
    { path: "/", state: "#receipt-pending", storage: "pos-pending-receipt", setter: "setPendingReceipt", value: { productId: id, payload: { id } } },
    { path: "/", state: "#stock-count-pending", storage: "pos-pending-stock-count", setter: "setPendingCount", value: { product: { id }, payload: { id } } },
    { path: "/debts", state: "#debt-pending", storage: "pos-pending-repayment", setter: "setPending", value: { customerId: id, payload: { id } } },
    { path: "/bills", state: "#bill-pending", storage: "pos-pending-correction", setter: "setPending", value: { saleId: id, payload: { id } } },
    { path: "/expense-entry", state: "#expense-pending", storage: "pos-pending-expense", setter: "savePending", value: { path: "/expenses", payload: { id } } },
    { path: "/drawer", state: "#drawer-pending", storage: "pos-pending-drawer", setter: "setPending", value: { action: "open", payload: { id, date: "2026-11-13" } } },
  ];
  for (const entry of cases) {
    await page.goto(pos + entry.path);
    await page.evaluate(({ setter, value }) => window[setter](value), entry);
    await expect(page.locator(entry.state)).toBeVisible();
    await expect(page.locator(entry.state)).toContainText("รีโหลดแท็บเดิมได้");
    expect(await page.evaluate((key) => Boolean(sessionStorage.getItem(key)), entry.storage)).toBe(true);
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
    await page.evaluate((setter) => window[setter](null), entry.setter);
    await expect(page.locator(entry.state)).toBeHidden();
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  }
});

test("warns when a pending repayment cannot be saved and retries the same request", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  const customer = await (await request.post(pos + "/customers", { data: { name: "ลูกค้า ก" } })).json();
  const sale = await request.post(pos + "/sales", { data: {
    id: randomUUID(), items: [{ product_id: product.id, unit_id: product.base_unit_id, quantity: "1", expected_unit_price: "25" }],
    payments: { cash: "0", qr: "0", credit: "25" }, customer_id: customer.id, qr_confirmed: false,
  } });
  expect(sale.status()).toBe(201);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && key === "pos-pending-repayment") throw new Error("storage unavailable");
      return original.call(this, key, value);
    };
  });
  const ids = [];
  await page.route(`**/customers/${customer.id}/repayments`, async (route) => {
    ids.push(route.request().postDataJSON().id);
    if (ids.length === 1) {
      expect((await route.fetch()).status()).toBe(201);
      return route.abort("connectionfailed");
    }
    return route.continue();
  });
  await page.goto(pos + "/debts");
  await page.getByRole("button", { name: /ลูกค้า ก/ }).click();
  await page.getByLabel("ยอดชำระ (บาท)").fill("10");
  await page.getByRole("button", { name: "บันทึกรับชำระ" }).click();
  await expect(page.locator("#debt-storage-warning")).toContainText("ก่อนรีโหลดหรือปิดแท็บ");
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  await page.getByRole("button", { name: "ส่งรายการเดิมอีกครั้ง" }).click();
  await expect(page.locator("#debt-message")).toContainText("บันทึกรับชำระ 10.00 บาท แล้ว");
  await expect(page.locator("#debt-pending")).toBeHidden();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  const debt = await (await request.get(`${pos}/customers/${customer.id}/debt`)).json();
  expect(debt.outstanding).toBe("15.00");
  expect(debt.repayments).toHaveLength(1);
  expect(debt.repayments[0].amount).toBe("10.00");
});

test("warns when pending inventory actions cannot be saved in session storage", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && ["pos-pending-receipt", "pos-pending-stock-count"].includes(key)) throw new Error("storage unavailable");
      return original.call(this, key, value);
    };
  });
  await page.goto(pos + "/");
  await page.locator("#products").getByRole("button", { name: /น้ำดื่ม/ }).click();
  let receipts = 0, counts = 0;
  const ids = { receipts: [], counts: [] };
  await page.route(`**/products/${product.id}/**`, async (route) => {
    const url = route.request().url();
    if (route.request().method() !== "POST") return route.continue();
    const kind = url.endsWith("/receipts") ? "receipts" : url.endsWith("/stock-counts") ? "counts" : null;
    if (!kind) return route.continue();
    ids[kind].push(route.request().postDataJSON().id);
    const attempt = kind === "receipts" ? ++receipts : ++counts;
    if (attempt === 1) {
      expect((await route.fetch()).status()).toBe(201);
      return route.abort("connectionfailed");
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "รับสินค้า", exact: true }).click();
  const receipt = page.locator("#receipt");
  await receipt.locator('[name="quantity"]').fill("2");
  await receipt.locator('[name="unit_cost"]').fill("10");
  await receipt.getByRole("button", { name: "บันทึกรับสินค้า" }).click();
  await expect(receipt.locator(".error")).toContainText("ห้ามรีโหลด");
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  await receipt.getByRole("button", { name: "บันทึกรับสินค้า" }).click();
  await expect(receipt).toBeHidden();
  expect(ids.receipts[0]).toBe(ids.receipts[1]);
  await page.getByRole("button", { name: "ปรับยอดจากการตรวจนับ" }).click();
  const count = page.locator("#stock-count");
  await count.locator('[name="counted_quantity"]').fill("2");
  await count.locator('[name="reason"]').fill("ตรวจนับ");
  await count.getByRole("button", { name: "บันทึกยอดตรวจนับ" }).click();
  await expect(count.locator(".error")).toContainText("ห้ามรีโหลด");
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  await count.getByRole("button", { name: "ส่งรายการเดิมอีกครั้ง" }).click();
  await expect(count).toBeHidden();
  expect(ids.counts[0]).toBe(ids.counts[1]);
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  const products = await (await request.get(pos + "/products")).json();
  expect(products.find(({ id }) => id === product.id).quantity).toBe("2");
  expect(await (await request.get(`${pos}/products/${product.id}/stock-counts`)).json()).toHaveLength(1);
});

test("retries a received stock request after its response is lost", async ({ page, request, pos }) => {
  const product = await createProduct(request, pos);
  await page.goto(pos + "/");
  await page.locator("#products").getByRole("button", { name: /น้ำดื่ม/ }).click();
  let lost = false;
  await page.route("**/receipts", async (route) => {
    if (route.request().method() === "POST" && !lost) {
      lost = true;
      expect((await route.fetch()).status()).toBe(201);
      await route.abort("connectionfailed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "รับสินค้า", exact: true }).click();
  const dialog = page.locator("#receipt");
  await dialog.locator('input[name="quantity"]').fill("2");
  await dialog.locator('input[name="unit_cost"]').fill("10");
  await dialog.getByRole("button", { name: "บันทึกรับสินค้า" }).click();
  await expect(dialog.locator(".error")).toContainText("ยังไม่ทราบผล");
  await expect(dialog.locator("#receipt-pending-close-warning")).toContainText("รีโหลดแท็บเดิมได้");
  page.once("dialog", (prompt) => prompt.accept());
  await page.reload();
  await page.getByRole("button", { name: "ตรวจสอบรายการรับสินค้าที่ค้าง" }).click();
  await expect(dialog.locator("#receipt-product")).toContainText("น้ำดื่ม");
  await dialog.getByRole("button", { name: "บันทึกรับสินค้า" }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  const products = await (await request.get(pos + "/products")).json();
  expect(products.find(({ id }) => id === product.id).quantity).toBe("3");
  const receipts = await (await request.get(pos + "/products/" + product.id + "/receipts")).json();
  expect(receipts).toHaveLength(2);
});

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

    let attempts = 0;
    await page.route("**/offline-sales", (route) => {
      attempts++;
      // Exercise the case where the online event arrives before requests work.
      if (attempts <= 2) return route.abort("connectionfailed");
      return route.continue();
    });
    await context.setOffline(false);
    await expect(page.locator("#sale-message")).toContainText("ส่งข้อมูลไม่ได้ คิวบิลยังอยู่ในเครื่องนี้");
    expect(await queue()).toEqual([{ payload, state: "pending", error: null }]);
    // After the immediate retry fails, the next automatic attempt is in 10 seconds.
    await expect(page.locator("#sale-message")).toContainText("สต๊อกติดลบ 1 บิล", { timeout: 25000 });
    expect(attempts).toBeGreaterThanOrEqual(3);
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

test("legacy bill dates use Bangkok time for filtering, CSV, and receipts", async ({ browser, request, pos }) => {
  const product = await createProduct(request, pos);
  const response = await request.post(pos + "/sales", { data: {
    id: randomUUID(), items: [{ product_id: product.id, unit_id: product.base_unit_id, quantity: "1", expected_unit_price: "25" }],
    payments: { cash: "25", qr: "0", credit: "0" }, qr_confirmed: false,
  } });
  expect(response.status()).toBe(201);
  const [sample] = await (await request.get(pos + "/sale-history")).json();
  const bills = [
    { ...sample, id: "legacy-before", created_at: "2025-06-13 16:59:59", sold_at: null },
    { ...sample, id: "legacy-midnight", created_at: "2025-06-13 17:00:00", sold_at: null },
    { ...sample, id: "offline-midnight", created_at: "2025-06-20 00:00:00", sold_at: "2025-06-13T17:00:00.000Z" },
  ];
  const expected = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" })
    .format(new Date("2025-06-13T17:00:00Z"));
  for (const timezoneId of ["UTC", "Asia/Bangkok", "America/Los_Angeles"]) {
    const context = await browser.newContext({ timezoneId });
    try {
      const page = await context.newPage();
      await page.route("**/sale-history", (route) => route.fulfill({ json: bills }));
      await page.goto(pos + "/bills");
      await page.getByLabel("ตั้งแต่วันที่", { exact: true }).fill("2025-06-14");
      await page.getByLabel("ถึงวันที่", { exact: true }).fill("2025-06-14");
      const rows = page.locator("#bill-list").getByRole("button");
      await expect(rows).toHaveCount(2);
      await expect(rows.filter({ hasText: "legacy-midnight" })).toContainText(expected);
      await expect(rows.filter({ hasText: "offline-midnight" })).toContainText(expected);
      const csv = await downloadCsv(page, "ดาวน์โหลด CSV", "bill-history.csv");
      expect(csv).toContain("legacy-midnight,2025-06-14");
      expect(csv).toContain("offline-midnight,2025-06-14");
      expect(csv).not.toContain("legacy-before");
      await rows.filter({ hasText: "legacy-midnight" }).click();
      await expect(page.locator("#bill-meta")).toContainText(expected);
      await page.getByRole("button", { name: "พิมพ์ใบเสร็จ", exact: true }).click();
      await expect(page.locator("#bill-receipt-date")).toHaveText(expected);
    } finally {
      await context.close();
    }
  }
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
