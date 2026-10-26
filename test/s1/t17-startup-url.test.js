import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers/start-app.js';

test('npm start 后 stdout 打印可访问的本机地址与真实端口', async () => {
  // 配置端口 0：系统实际分配端口，打印的必须是真实端口而不是配置里的 0。
  const app = await startApp({});
  try {
    const output = app.output();
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match, `stdout 没有访问地址，实际输出：\n${output}`);
    assert.equal(Number(match[1]), app.port, '打印的端口必须是实际监听端口');

    // 只出现一次（每次进程启动一行）。
    const occurrences = output.match(/http:\/\/127\.0\.0\.1:\d+/g) ?? [];
    assert.equal(occurrences.length, 1, `访问地址应只打印一次：${JSON.stringify(occurrences)}`);

    // 打印出来的地址必须真的能打开（/health）。
    const response = await fetch(`http://127.0.0.1:${app.port}/health`);
    assert.equal(response.status, 200);
  } finally {
    await app.stop();
  }
});
