import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildEnv, runAgent } from '../src/runner.js';

const MOCK = (over = {}) => ({
  name: 'mock',
  command: [process.execPath, 'test/mock-cli.cjs'],
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

test('file 输入：{PROMPT_FILE} 占位符被替换', async () => {
  const r = await runAgent(MOCK({
    command: [process.execPath, 'test/mock-cli.cjs', '--from-file', '{PROMPT_FILE}'],
    input: 'file',
  }), 'file content here');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'file content here');
});

test('json 输出：取 result 字段', async () => {
  const r = await runAgent(MOCK({ output: 'json' }), '#json\nparsed answer');
  assert.equal(r.text, 'parsed answer');
});

test('stream-json 输出：取 result 事件', async () => {
  const r = await runAgent(MOCK({ output: 'stream-json' }), '#stream\nstreamed answer');
  assert.equal(r.text, 'streamed answer');
});

test('登录失效识别为 auth 错误', async () => {
  const r = await runAgent(MOCK(), '#auth');
  assert.equal(r.error, 'auth');
});

test('abort signal 终止子进程', async () => {
  const ac = new AbortController();
  const p = runAgent(MOCK(), '#sleep 5000\nx', { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'aborted');
});

test('signal + spawn 失败组合仍返回 spawn 错误（不抛异常）', async () => {
  const ac = new AbortController();
  const r = await runAgent(MOCK({ command: [undefined] }), 'hi', { signal: ac.signal });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /^spawn:/);
});

test('win32 下 .cmd 命令自动经 cmd /c 包装执行', { skip: process.platform !== 'win32' }, async () => {
  // 造一个真实 .cmd：回显固定文本
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-cmd-'));
  const cmdFile = path.join(dir, 'hello.cmd');
  writeFileSync(cmdFile, '@echo off\r\necho from-cmd-wrapper\r\n');
  const r = await runAgent(MOCK({ command: [cmdFile], envWhitelist: ['PATH', 'SYSTEMROOT', 'COMSPEC'] }), '');
  assert.equal(r.ok, true);
  assert.match(r.text, /from-cmd-wrapper/);
});
