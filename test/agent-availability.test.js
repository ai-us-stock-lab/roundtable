import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

// 一个能解析的 agent（node 在 PATH 上）与一个不可能解析的 agent 混合，
// 验证启动时不可用的 agent 被标记且不阻塞服务启动，/api/config 会暴露 unavailable。
const dir = mkdtempSync(path.join(tmpdir(), 'rt-avail-'));
const agentsFile = path.join(dir, 'agents.json');
writeFileSync(agentsFile, JSON.stringify({
  ok: { name: 'OK', command: ['node', 'test/mock-cli.cjs'], input: 'stdin', output: 'text', timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT'], cwd: '.', roles: ['debater'] },
  bad: { name: 'Bad', command: ['nonexistent-cli-xyz'], input: 'stdin', output: 'text', timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT'], cwd: '.', roles: ['debater'] },
}));

const srv = await startServer({
  port: 0,
  agentsFile,
  templatesDir: 'templates',
  sessionsDir: mkdtempSync(path.join(tmpdir(), 'rt-avail-sessions-')),
});
const BASE = `http://127.0.0.1:${srv.port}`;
after(() => srv.close());

test('可解析的 agent 无 unavailable，不可解析的 agent 标记 unavailable 并带指引', async () => {
  const r = await (await fetch(BASE + '/api/config')).json();
  assert.equal(r.agents.ok.unavailable, undefined);
  assert.match(r.agents.bad.unavailable, /未找到/);
});

test('服务照常启动（不可用 agent 不阻塞）', async () => {
  const r = await fetch(BASE + '/api/config');
  assert.equal(r.status, 200);
});
