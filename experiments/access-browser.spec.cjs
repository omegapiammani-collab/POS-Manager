// Synthetic Access edge, RSA-signed test assertions, real POS/SQLite and Chromium.
// Both servers bind loopback only. Never use this proxy with a real POS database.
const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { once } = require('node:events');
const { join } = require('node:path');
const http = require('node:http');

async function upstream(port, token, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers: { 'Cf-Access-Jwt-Assertion': token } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

for (const mode of ['expired', '401', '403', 'redirect', 'html']) {
  test(`offline sale survives unconfirmed access (${mode}) and syncs once`, async ({ page, context }) => {
    const child = spawn(process.env.POS_PYTHON || 'python3', ['-m', 'experiments.access_browser_fixture'], {
      cwd: join(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'close');
    exited.catch(() => {});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    let proxy;
    try {
      const lines = createInterface({ input: child.stdout });
      const [line] = await Promise.race([once(lines, 'line'), exited.then(([code]) => { throw Error(`fixture exited ${code}: ${stderr}`); })]);
      const fixture = JSON.parse(line);
      let state = 'valid', blocked = 0, postsWhileBlocked = 0;
      proxy = http.createServer((req, res) => {
        if (state !== 'valid') {
          blocked++;
          if (req.method === 'POST' && req.url.startsWith('/offline-sales')) postsWhileBlocked++;
          if (state === '401' || state === '403') { req.resume(); res.writeHead(Number(state), { 'Content-Type': 'application/json' }); return res.end('{"error":"unavailable"}'); }
          if (state === 'redirect') { req.resume(); res.writeHead(302, { Location: '/__synthetic_login' }); return res.end(); }
          if (state === 'html') { req.resume(); res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<p>synthetic login</p>'); }
        }
        const headers = { ...req.headers, host: `127.0.0.1:${fixture.port}`, 'cf-access-jwt-assertion': state === 'expired' ? fixture.expired : fixture.valid };
        // This synthetic translation represents HTTPS origin at an Access edge;
        // it is not a trusted proxy or a production origin configuration.
        if (headers.origin === `http://127.0.0.1:${proxy.address().port}`) headers.origin = 'https://pos.example';
        const forward = http.request({ hostname: '127.0.0.1', port: fixture.port, path: req.url, method: req.method, headers }, response => {
          res.writeHead(response.statusCode, response.headers); response.pipe(res);
        });
        forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(forward);
      });
      await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${proxy.address().port}`;
      await page.goto(origin + '/checkout');
      await expect(page.locator('#sale-new-customer')).toBeEnabled();
      await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
      await page.evaluate(() => navigator.locks.request('pos-customer-and-store', () => {}));
      await context.setOffline(true);
      await page.getByRole('button', { name: 'เพิ่ม น้ำดื่ม ขวด', exact: true }).click();
      await page.locator('#sale-cash-all').click();
      await page.locator('#sale-submit').click();
      await expect(page.locator('#sale-receipt')).toBeVisible();
      const queued = await page.evaluate(() => PosOffline.list());
      expect(queued).toHaveLength(1);
      expect(queued[0].payload.offline).toBe(true);
      const id = queued[0].payload.id;
      await page.locator('#sale-receipt-close').click();
      state = mode;
      await context.setOffline(false);
      await expect.poll(() => blocked).toBeGreaterThan(0);
      await expect(page.locator('#sale-message')).toContainText('ยังยืนยันสิทธิ์หรือการเชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
      expect((await page.evaluate(() => PosOffline.list()))[0].payload.id).toBe(id);
      expect((await upstream(fixture.port, fixture.valid, '/sales/' + id)).status).toBe(404);
      expect(postsWhileBlocked).toBe(0);
      state = 'valid';
      await page.locator('#sale-retry').click();
      await expect.poll(() => page.evaluate(async () => (await PosOffline.list()).length)).toBe(0);
      expect((await upstream(fixture.port, fixture.valid, '/sales/' + id)).status).toBe(200);
      const history = JSON.parse((await upstream(fixture.port, fixture.valid, '/sale-history')).body);
      expect(history.filter(sale => sale.id === id)).toHaveLength(1);
      const products = JSON.parse((await upstream(fixture.port, fixture.valid, '/products')).body);
      expect(products[0].quantity).toBe('0');
    } finally {
      if (proxy) await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
      child.stdin.end();
      await exited;
    }
  });
}
