import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnv, runAgent } from '../src/runner.js';

const MOCK = (over = {}) => ({
  name: 'mock',
  command: [process.execPath, 'test/mock-cli.js'],
  input: 'stdin',
  output: 'text',
  timeoutMs: 5000,
  envWhitelist: ['PATH', 'SYSTEMROOT'],
  cwd: process.cwd(),
  ...over,
});

test('buildEnv 只保留白名单变量', () => {
  const env = buildEnv(['GOOD'], { GOOD: '1', ANTHROPIC_API_KEY: 'sk-secret', OPENAI_API_KEY: 'x' });
  assert.deepEqual(env, { GOOD: '1' });
});

test('stdin+text：回显 prompt', async () => {
  const r = await runAgent(MOCK(), '#echo\nhello world');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'hello world');
  assert.equal(r.exitCode, 0);
});

test('子进程看不到白名单外的环境变量', async () => {
  process.env.RT_SECRET_TEST = 'leak';
  const r = await runAgent(MOCK(), '#env RT_SECRET_TEST');
  delete process.env.RT_SECRET_TEST;
  assert.equal(r.text, '<unset>');
});

test('超时 kill 并返回 timeout 错误', async () => {
  const r = await runAgent(MOCK({ timeoutMs: 200 }), '#sleep 5000\nx');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
});

test('非零退出返回 exit 错误与 stderr', async () => {
  const r = await runAgent(MOCK(), '#fail 3');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'exit:3');
  assert.match(r.stderr, /mock failure/);
});

test('spawn 失败（同步抛错）返回 spawn 错误而非异常', async () => {
  const r = await runAgent(MOCK({ command: [undefined] }), 'hi');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /^spawn:/);
});
