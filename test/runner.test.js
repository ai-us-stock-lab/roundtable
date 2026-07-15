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

test('子进程不读 stdin 即退出时不崩溃（EPIPE 防护）', async () => {
  // 子进程立即退出、从不读 stdin；写入超过管道缓冲（Windows 默认 64KB）的大 prompt，
  // 触发 stdin 侧 EPIPE。无防护时 stdin 的 'error' 事件无监听会作为未捕获异常崩溃整个进程。
  const r = await runAgent(MOCK({ command: [process.execPath, '-e', 'process.exit(3)'] }), 'x'.repeat(1024 * 1024));
  assert.equal(r.ok, false);
  assert.match(String(r.error), /^exit:3/);
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

test('arg 输入：{PROMPT} 占位符替换进 argv', async () => {
  const r = await runAgent(MOCK({ command: [process.execPath, '-p', 'process.argv[1]', '{PROMPT}'], input: 'arg' }), 'hello-arg');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'hello-arg');
});

test('arg 输入：无占位符时追加为末参', async () => {
  const r = await runAgent(MOCK({ command: [process.execPath, '-p', 'process.argv[1]'], input: 'arg' }), 'appended-arg');
  assert.equal(r.text, 'appended-arg');
});

test('{NONCE} 每次调用生成不同值', async () => {
  const mk = () => MOCK({ command: [process.execPath, '-p', 'process.argv[1]', '{NONCE}'], input: 'arg' });
  const a = await runAgent(mk(), 'x');
  const b = await runAgent(mk(), 'x');
  assert.ok(a.text.length >= 6, 'nonce 应非空');
  assert.notEqual(a.text, b.text);
});

test('arg 输入超长（win32 argv 上限）报 prompt-too-long', { skip: process.platform !== 'win32' }, async () => {
  const r = await runAgent(MOCK({ command: [process.execPath, '-p', '1', '{PROMPT}'], input: 'arg' }), 'x'.repeat(40000));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'prompt-too-long');
});

test('dropLines 过滤匹配行', async () => {
  const r = await runAgent(MOCK({ dropLines: ['^session_id:'] }), '#echo\nsession_id: abc123\nreal answer');
  assert.equal(r.text, 'real answer');
});

test('stream-json 的 onChunk 只推助手文本，不推原始事件', async () => {
  const chunks = [];
  const r = await runAgent(MOCK({ output: 'stream-json' }), '#stream2\nfinal answer', { onChunk: s => chunks.push(s) });
  assert.equal(r.ok, true);
  const streamed = chunks.join('');
  assert.match(streamed, /assistant text piece/);
  assert.doesNotMatch(streamed, /"type"|apiKeySource|system/);
});

test('json 输出模式不推中间 chunk', async () => {
  const chunks = [];
  await runAgent(MOCK({ output: 'json' }), '#json\nparsed answer', { onChunk: s => chunks.push(s) });
  assert.equal(chunks.length, 0);
});

test('json 输出：支持 openclaw 的 payloads[].text 结构', async () => {
  const r = await runAgent(MOCK({ output: 'json' }), '#echo\n{"payloads":[{"text":"来自payloads的回答","mediaUrl":null}],"meta":{"transport":"embedded"}}');
  assert.equal(r.text, '来自payloads的回答');
});

test('json 输出：支持 gateway 路径的嵌套 result.payloads 结构', async () => {
  const r = await runAgent(MOCK({ output: 'json' }), '#echo\n{"runId":"x","status":"ok","result":{"payloads":[{"text":"网关路径回答"}],"meta":{}}}');
  assert.equal(r.text, '网关路径回答');
});

test('argv 中 ~/ 前缀展开为用户主目录（配置可移植）', async () => {
  const { homedir } = await import('node:os');
  const r = await runAgent(MOCK({ command: [process.execPath, '-p', 'process.argv[1]', '~/some/tool.mjs'], input: 'arg' }), 'x');
  assert.equal(r.ok, true);
  assert.equal(path.normalize(r.text), path.normalize(path.join(homedir(), 'some', 'tool.mjs')));
});

test('win32 .cmd 包装 + 参数含换行 → 拒绝 spawn（cmd.exe 会截断并构成注入面）', async t => {
  if (process.platform !== 'win32') return t.skip('win32 专属护栏');
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-shim-'));
  const shim = path.join(dir, 'echo.cmd');
  writeFileSync(shim, '@echo off\r\necho %1\r\n');
  const r = await runAgent(MOCK({ command: [shim, '{PROMPT}'], input: 'arg' }), '第一行\n第二行');
  assert.equal(r.ok, false);
  assert.match(r.error, /unsafe-cmd-args/);
});
