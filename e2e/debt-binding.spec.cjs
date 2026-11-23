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
  const customer = await (await request.post(pos + '/customers', { headers, data: { name: 'ลูกค้า ก' } })).json();
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
  const [response] = await Promise.all([
    page.waitForResponse((result) => result.url() === pos + `/customers/${customer.id}/repayments` && result.request().method() === 'POST'),
    page.getByRole('button', { name: 'บันทึกรับชำระ' }).click(),
  ]);
  expect(response.status()).toBe(201);
  const recorded = await response.json();
  await expect(page.locator('#debt-message')).toHaveText('บันทึกรับชำระ 10.00 บาท แล้ว');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pos-pending-repayment'))).toBeNull();
  expect(observed).toEqual({ list: binding, detail: binding, repayment: binding });
  const detail = await (await request.get(pos + `/customers/${customer.id}/debt`)).json();
  expect(detail.outstanding).toBe('15.00');
  expect(detail.repayments).toHaveLength(1);
  expect(detail.repayments[0].id).toBe(recorded.id);
});

for (const mode of ['null', 'wrong-id', 'wrong-amount', 'wrong-method', 'wrong-note', '401', '403', 'redirect', 'html']) {
  test(`repayment retains original request when confirmation is untrusted: ${mode}`, async ({ page, request, pos }) => {
    const { binding, customer } = await setup(request, pos);
    const record = pending(customer.id, binding);
    const raw = JSON.stringify(record);
    let attempts = [], redirected = 0;
    await page.route('**/synthetic-login', route => { redirected++; return route.fulfill({ status: 200, json: {} }); });
    await page.route(`**/customers/${customer.id}/repayments`, async route => {
      attempts.push(route.request().postDataJSON().id);
      if (attempts.length > 1) return route.continue();
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(201);
      const actual = await upstream.json();
      if (mode === '401' || mode === '403') return route.fulfill({ status: Number(mode), json: { error: 'unavailable' } });
      if (mode === 'redirect') return route.fulfill({ status: 302, headers: { location: '/synthetic-login' } });
      if (mode === 'html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>login</p>' });
      const altered = mode === 'null' ? null : { ...actual,
        ...(mode === 'wrong-id' ? { id: randomUUID() } : {}),
        ...(mode === 'wrong-amount' ? { amount: '10.01' } : {}),
        ...(mode === 'wrong-method' ? { method: 'qr' } : {}),
        ...(mode === 'wrong-note' ? { note: 'different' } : {}) };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(altered) });
    });
    await savePending(page, pos, raw);
    await expect(page.locator('#debt-retry')).toBeEnabled();
    await page.locator('#debt-retry').click();
    await expect.poll(() => attempts.length).toBe(1);
    await expect(page.locator('#debt-retry')).toBeEnabled();
    expect(await page.evaluate(() => sessionStorage.getItem('pos-pending-repayment'))).toBe(raw);
    expect(redirected).toBe(0);
    if (['401', '403', 'redirect', 'html'].includes(mode)) await expect(page.locator('#debt-message')).toContainText('ยืนยันสิทธิ์หรือการเชื่อมต่อ');
    await page.locator('#debt-retry').click();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pos-pending-repayment'))).toBeNull();
    expect(attempts).toEqual([record.payload.id, record.payload.id]);
    const detail = await (await request.get(pos + `/customers/${customer.id}/debt`)).json();
    expect(detail.outstanding).toBe('15.00');
    expect(detail.repayments).toHaveLength(1);
    expect(detail.repayments[0].id).toBe(record.payload.id);
  });
}

test('confirmation compares equivalent decimal amounts exactly', async ({ page, request, pos }) => {
  const { binding, customer } = await setup(request, pos);
  const record = pending(customer.id, binding);
  await page.route(`**/customers/${customer.id}/repayments`, async route => {
    const upstream = await route.fetch();
    expect(upstream.status()).toBe(201);
    return route.fulfill({ json: { ...await upstream.json(), amount: '10.0' } });
  });
  await savePending(page, pos, JSON.stringify(record));
  await expect(page.locator('#debt-retry')).toBeEnabled();
  await page.locator('#debt-retry').click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pos-pending-repayment'))).toBeNull();
  const detail = await (await request.get(pos + `/customers/${customer.id}/debt`)).json();
  expect(detail.outstanding).toBe('15.00');
  expect(detail.repayments).toHaveLength(1);
});

test('a restored uppercase UUID accepts the canonical server response', async ({ page, request, pos }) => {
  const { binding, customer } = await setup(request, pos);
  const record = pending(customer.id, binding);
  record.payload.id = record.payload.id.toUpperCase();
  await savePending(page, pos, JSON.stringify(record));
  await expect(page.locator('#debt-retry')).toBeEnabled();
  await page.locator('#debt-retry').click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pos-pending-repayment'))).toBeNull();
  const detail = await (await request.get(pos + `/customers/${customer.id}/debt`)).json();
  expect(detail.repayments).toHaveLength(1);
  expect(detail.repayments[0].id).toBe(record.payload.id.toLowerCase());
});

test('conflicting repayment ID is retained for review and export after reload', async ({ page, request, pos }) => {
  const { binding, customer } = await setup(request, pos);
  const record = pending(customer.id, binding);
  const prior = { ...record.payload, amount: '5.00' };
  expect((await request.post(pos + `/customers/${customer.id}/repayments`, { headers: { 'X-POS-Store-ID': binding }, data: prior })).status()).toBe(201);
  await savePending(page, pos, JSON.stringify(record));
  await expect(page.locator('#debt-retry')).toBeEnabled();
  await page.locator('#debt-retry').click();
  await expect(page.locator('#debt-review-required')).toBeVisible();
  await expect(page.locator('#debt-retry')).toBeDisabled();
  const saved = JSON.parse(await page.evaluate(() => sessionStorage.getItem('pos-pending-repayment')));
  expect(saved).toMatchObject({ ...record, reviewRequired: true });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#debt-pending-export').click()]);
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(saved);
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.locator('#debt-review-required')).toBeVisible();
  await expect(page.locator('#debt-retry')).toBeDisabled();
  expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem('pos-pending-repayment')))).toEqual(saved);
  const detail = await (await request.get(pos + `/customers/${customer.id}/debt`)).json();
  expect(detail.outstanding).toBe('20.00');
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

test('checkout creates a customer with the current store binding', async ({ page, request, pos }) => {
  const binding = (await (await request.get(pos + '/store-identity')).json()).binding_id;
  await page.goto(pos + '/checkout');
  await page.getByLabel('เงินเชื่อ (บาท)').fill('1');
  await page.locator('#sale-new-customer').click();
  await page.getByLabel('ชื่อลูกค้า').fill('ลูกค้าใหม่');
  const [response] = await Promise.all([
    page.waitForResponse(result => result.url() === pos + '/customers' && result.request().method() === 'POST'),
    page.getByRole('button', { name: 'บันทึกลูกค้า' }).click(),
  ]);
  expect(response.status()).toBe(201);
  expect(response.request().headers()['x-pos-store-id']).toBe(binding);
  await expect(page.locator('#sale-customer')).not.toBeVisible();
  await expect(page.locator('select[name=customer_id]')).toHaveValue((await response.json()).id);
});
