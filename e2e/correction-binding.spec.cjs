const { test: base, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createInterface } = require('node:readline');

const test = base.extend({
  pos: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'pos-debt-binding-'));
    const server = spawn(process.env.POS_PYTHON || 'python3', ['inventory_api.py', '--port', '0', '--database', join(directory, 'store.sqlite3'), '--create-database'], { cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(server, 'close');
    try {
      const lines = createInterface({ input: server.stdout });
      const [line] = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error('Server failed to start'); })]);
      const match = /^Inventory API: (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
      if (!match) throw new Error('Unexpected startup output: ' + line);
      await use(match[1]);
    } finally {
      server.kill();
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
});


const pending = (binding) => ({ ...(binding ? { binding_id: binding } : {}), saleId: randomUUID(), payload: { id: randomUUID(), reason: 'ยกเลิก', replacement: null } });
async function save(page, pos, raw) {
  await page.goto(pos + '/');
  await page.evaluate(raw => sessionStorage.setItem('pos-pending-correction', raw), raw);
  await page.goto(pos + '/bills');
}
test('legacy correction remains intact and exports raw data', async ({ page, pos }) => {
  const raw = JSON.stringify(pending());
  await save(page, pos, raw);
  await expect(page.locator('#bill-restore-error')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#bill-restore-export').click()]);
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toBe(raw);
  expect(await page.evaluate(() => sessionStorage.getItem('pos-pending-correction'))).toBe(raw);
});
test('different store correction stays and exports without replay', async ({ page, pos }) => {
  const record = pending(randomUUID());
  const raw = JSON.stringify(record);
  let posts = 0;
  await page.route('**/corrections', route => { posts++; return route.continue(); });
  await save(page, pos, raw);
  await expect(page.locator('#bill-mismatch')).toBeVisible();
  await expect(page.locator('#bill-retry')).toBeDisabled();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#bill-pending-export').click()]);
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(record);
  expect(await page.evaluate(() => sessionStorage.getItem('pos-pending-correction'))).toBe(raw);
  expect(posts).toBe(0);
});

test('history and edit inputs use the bound store; mismatch clears stale history', async ({ page, request, pos }) => {
  const binding = (await (await request.get(pos + '/store-identity')).json()).binding_id;
  const headers = { 'X-POS-Store-ID': binding };
  const product = await (await request.post(pos + '/products', { data: { code: 'A', name: 'น้ำ', base_unit: 'ขวด', price: '25' } })).json();
  expect((await request.post(pos + `/products/${product.id}/receipts`, { headers, data: { id: randomUUID(), unit_id: product.base_unit_id, quantity: '1', unit_cost: '10' } })).status()).toBe(201);
  const saleId = randomUUID();
  expect((await request.post(pos + '/sales', { headers, data: { id: saleId, items: [{ product_id: product.id, unit_id: product.base_unit_id, quantity: '1', expected_unit_price: '25' }], payments: { cash: '25', qr: '0', credit: '0' }, customer_id: null, qr_confirmed: false } })).status()).toBe(201);
  const observed = {};
  await page.route('**/sale-history', route => { observed.history = route.request().headers()['x-pos-store-id']; return route.continue(); });
  await page.route('**/products', route => { observed.products = route.request().headers()['x-pos-store-id']; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'store_mismatch' }) }); });
  await page.route('**/customers', route => { observed.customers = route.request().headers()['x-pos-store-id']; return route.continue(); });
  await page.goto(pos + '/bills');
  await page.locator('#bill-list button').first().click();
  await page.locator('#bill-edit').click();
  await expect(page.locator('#bill-mismatch')).toBeVisible();
  await expect(page.locator('#bill-detail')).toBeHidden();
  await expect(page.locator('#bill-correction')).not.toHaveAttribute('open', '');
  expect(observed.history).toBe(binding);
  expect(observed.products).toBe(binding);
  expect(observed.customers).toBe(binding);
});
