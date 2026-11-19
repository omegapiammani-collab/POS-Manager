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

async function setup(request, pos) {
  const binding = (await (await request.get(pos + '/store-identity')).json()).binding_id;
  const headers = { 'X-POS-Store-ID': binding };
  const product = await (await request.post(pos + '/products', { data: { code: 'A', name: 'น้ำ', base_unit: 'ขวด', price: '25' } })).json();
  expect((await request.post(pos + `/products/${product.id}/receipts`, { headers, data: { id: randomUUID(), unit_id: product.base_unit_id, quantity: '1', unit_cost: '10' } })).status()).toBe(201);
  const customer = await (await request.post(pos + '/customers', { data: { name: 'ลูกค้า ก' } })).json();
  expect((await request.post(pos + '/sales', { headers, data: { id: randomUUID(), items: [{ product_id: product.id, unit_id: product.base_unit_id, quantity: '1', expected_unit_price: '25' }], payments: { cash: '0', qr: '0', credit: '25' }, customer_id: customer.id, qr_confirmed: false } })).status()).toBe(201);
  return { binding, customer };
}

async function savePending(page, pos, record) {
  await page.goto(pos + '/');
  await page.evaluate((raw) => sessionStorage.setItem('pos-pending-repayment', raw), record);
  await page.goto(pos + '/debts');
}

const pending = (customerId, bindingId) => ({ customerId, ...(bindingId ? { binding_id: bindingId } : {}), payload: { id: randomUUID(), amount: '10.00', method: 'cash', note: '' } });

test('legacy pending repayment remains intact and can be exported', async ({ page, pos }) => {
  const raw = JSON.stringify(pending(randomUUID()));
  await savePending(page, pos, raw);
  await expect(page.locator('#debt-restore-error')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#debt-restore-export').click()]);
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toBe(raw);
  expect(await page.evaluate(() => sessionStorage.getItem('pos-pending-repayment'))).toBe(raw);
  await expect(page.locator('#debt-repayment-fields')).toHaveAttribute('disabled', '');
  await expect(page.locator('#debt-repayment-fields input[name=amount]')).toBeDisabled();
});

test('pending repayment from another store is retained and cannot be replayed', async ({ page, request, pos }) => {
  const { customer } = await setup(request, pos);
  const record = pending(customer.id, randomUUID());
  const raw = JSON.stringify(record);
  let posts = 0;
  await page.route('**/repayments', (route) => { posts++; return route.continue(); });
  await savePending(page, pos, raw);
  await expect(page.locator('#debt-mismatch')).toBeVisible();
  await expect(page.locator('#debt-retry')).toBeDisabled();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#debt-pending-export').click()]);
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(record);
  expect(await page.evaluate(() => sessionStorage.getItem('pos-pending-repayment'))).toBe(raw);
  expect(posts).toBe(0);
  const detail = await (await request.get(pos + `/customers/${customer.id}/debt`)).json();
  expect(detail.outstanding).toBe('25.00');
  expect(detail.repayments).toHaveLength(0);
});

test('list, detail and normal repayment use the selected store binding', async ({ page, request, pos }) => {
  const { binding, customer } = await setup(request, pos);
  const observed = {};
  await page.route('**/customer-debts', (route) => { observed.list = route.request().headers()['x-pos-store-id']; return route.continue(); });
  await page.route(`**/customers/${customer.id}/debt`, (route) => { observed.detail = route.request().headers()['x-pos-store-id']; return route.continue(); });
  await page.route(`**/customers/${customer.id}/repayments`, (route) => { observed.repayment = route.request().headers()['x-pos-store-id']; return route.continue(); });
  await page.goto(pos + '/debts');
  await page.getByRole('button', { name: /ลูกค้า ก/ }).click();
  await expect(page.locator('#debt-outstanding')).toHaveText('25.00 บาท');
  await page.getByLabel('ยอดชำระ (บาท)').fill('10');
  await page.getByRole('button', { name: 'บันทึกรับชำระ' }).click();
  await expect(page.locator('#debt-message')).toContainText('บันทึกรับชำระ');
  expect(observed).toEqual({ list: binding, detail: binding, repayment: binding });
  expect(await page.evaluate(() => sessionStorage.getItem('pos-pending-repayment'))).toBeNull();
  const detail = await (await request.get(pos + `/customers/${customer.id}/debt`)).json();
  expect(detail.outstanding).toBe('15.00');
  expect(detail.repayments).toHaveLength(1);
});

test('a server-side store change preserves the pending request on rejection', async ({ page, request, pos }) => {
  const { binding, customer } = await setup(request, pos);
  await page.route(`**/customers/${customer.id}/repayments`, (route) => {
    expect(route.request().headers()['x-pos-store-id']).toBe(binding);
    return route.fulfill({ status: 409, json: { code: 'store_mismatch' } });
  });
  await page.goto(pos + '/debts');
  await page.getByRole('button', { name: /ลูกค้า ก/ }).click();
  await page.getByLabel('ยอดชำระ (บาท)').fill('10');
  await page.getByRole('button', { name: 'บันทึกรับชำระ' }).click();
  await expect(page.locator('#debt-mismatch')).toBeVisible();
  await expect(page.locator('#debt-retry')).toBeDisabled();
  const saved = JSON.parse(await page.evaluate(() => sessionStorage.getItem('pos-pending-repayment')));
  expect(saved.binding_id).toBe(binding);
  expect(saved.customerId).toBe(customer.id);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#debt-pending-export').click()]);
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(saved);
});

for (const resource of ['list', 'detail']) {
  test(`a store mismatch during ${resource} loading blocks repayment`, async ({ page, request, pos }) => {
    const { binding, customer } = await setup(request, pos);
    const pattern = resource === 'list' ? '**/customer-debts' : `**/customers/${customer.id}/debt`;
    await page.route(pattern, (route) => {
      expect(route.request().headers()['x-pos-store-id']).toBe(binding);
      return route.fulfill({ status: 409, json: { code: 'store_mismatch' } });
    });
    await page.goto(pos + '/debts');
    if (resource === 'detail') await page.getByRole('button', { name: /ลูกค้า ก/ }).click();
    await expect(page.locator('#debt-mismatch')).toBeVisible();
    await expect(page.locator('#debt-repayment-fields')).toHaveAttribute('disabled', '');
    await expect(page.locator('#debt-repayment-fields input[name=amount]')).toBeDisabled();
    await expect(page.locator('#debt-detail')).toBeHidden();
  });
}
