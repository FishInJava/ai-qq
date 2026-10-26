import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startApp } from '../helpers/start-app.js';

let app;

before(async () => {
  app = await startApp();
});

after(async () => {
  await app?.stop();
});

test('用户打开页面时能确认服务活着', async () => {
  const response = await fetch(`${app.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.port, app.port);
  assert.equal(typeof body.version, 'string');
  assert.equal(typeof body.uptime_ms, 'number');
});

test('用户打开根地址能看到占位页', async () => {
  const response = await fetch(`${app.baseUrl}/`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);

  const html = await response.text();
  assert.match(html, /她已经在自己的时间里了/);
});

test('非本机 Host 的请求被拒绝', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: app.port,
        path: '/health',
        headers: { Host: 'evil.example' },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });

  assert.equal(status, 403);
});
