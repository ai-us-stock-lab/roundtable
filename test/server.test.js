import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

// 用 mock adapter 配置与临时 sessions 目录启动真实服务
const srv = await startServer({
  port: 0, // 随机可用端口
  agentsFile: 'adapters/agents.json',
  templatesDir: 'templates',
  sessionsDir: mkdtempSync(path.join(tmpdir(), 'rt-srv-')),
});
const BASE = `http://127.0.0.1:${srv.port}`;
after(() => srv.close());

test('GET /api/config 返回 agents 与 templates 且不泄漏 command', async () => {
  const r = await (await fetch(BASE + '/api/config')).json();
  assert.ok(r.agents.mockA);
  assert.equal(r.agents.mockA.command, undefined);
  assert.ok(r.templates.general);
});

test('创建会话→跑一轮→SSE 收到 round-done', async () => {
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'T', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 3 }),
  })).json();
  assert.ok(create.id);
  await fetch(`${BASE}/api/sessions/${create.id}/round`, { method: 'POST' });
  // 轮询会话状态直到 paused（mock 很快）
  let state = '';
  for (let i = 0; i < 50 && state !== 'paused'; i++) {
    await new Promise(r => setTimeout(r, 100));
    state = (await (await fetch(`${BASE}/api/sessions/${create.id}`)).json()).state;
  }
  assert.equal(state, 'paused');
  // SSE 回放缓冲：新连接也能拿到已发生的 round-done
  const res = await fetch(`${BASE}/api/sessions/${create.id}/events`);
  const reader = res.body.getReader();
  let text = '';
  for (let i = 0; i < 20 && !text.includes('round-done'); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.cancel();
  assert.match(text, /round-done/);
});

test('未知会话返回 404', async () => {
  const r = await fetch(BASE + '/api/sessions/nope');
  assert.equal(r.status, 404);
});

test('SSE 客户端断开后广播不炸（write 异常被吞并移除 client）', async () => {
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'T2', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 2 }),
  })).json();
  // 建立 SSE 连接后立刻粗暴取消（模拟断线）
  const res = await fetch(`${BASE}/api/sessions/${create.id}/events`);
  await res.body.cancel();
  await new Promise(r => setTimeout(r, 50));
  // 断线后触发一轮（会产生大量广播事件）——若无防护，进程在此崩溃、后续断言无法执行
  await fetch(`${BASE}/api/sessions/${create.id}/round`, { method: 'POST' });
  let state = '';
  for (let i = 0; i < 50 && state !== 'paused'; i++) {
    await new Promise(r => setTimeout(r, 100));
    state = (await (await fetch(`${BASE}/api/sessions/${create.id}`)).json()).state;
  }
  assert.equal(state, 'paused'); // 服务仍活着且正常完成一轮
});
