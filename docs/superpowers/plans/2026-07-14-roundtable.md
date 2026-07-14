# Roundtable 多智能体决策委员会 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本地浏览器窗口里的多智能体决策委员会：独立判断 → 交叉质询 → 分歧分类 → 证据仲裁 → 最小下一步。

**Architecture:** Node.js 本地服务（127.0.0.1:7777，纯 node:http + SSE，零 npm 依赖）+ 零构建单页前端。Agent 全部通过插拔式 adapter 配置驱动本地 CLI 子进程（claude / codex / mock / 未来任意 CLI）。orchestrator 是轮次状态机；每轮由 summarizer 产出带五类分歧分类表的 rolling summary；judge 是独立仲裁角色；所有产物经 redactor 擦除凭据后按可复盘结构落盘。

**Tech Stack:** Node 24（ESM、node:test、node:http、node:child_process），无任何 npm 运行时依赖。前端 vanilla JS + EventSource。

**Spec:** `docs/superpowers/specs/2026-07-14-roundtable-design.md`（本计划的需求真源，实现与 spec 冲突时以 spec 为准）

## Global Constraints

- 零 npm 运行时依赖；测试只用 `node --test`
- 服务只绑定 `127.0.0.1`，端口 7777
- 子进程 `spawn(argv[0], argv.slice(1), {shell:false})`——argv 数组，绝不经 shell
- 子进程 env 只含 adapter 配置的 `envWhitelist` 列出的变量，其余一律不传
- 所有落盘文本必须先过 `redact()`
- 第 1 轮辩手简报中不得含对方任何输出（测试硬性断言）
- 模型输出仅作 HTML 转义后的文本渲染，永不执行
- 所有 JS 文件为 ESM（package.json `"type":"module"`）
- 代码注释与 UI 文案用中文，标识符用英文

## File Structure

```
Roundtable/
├── package.json
├── .gitignore                  (node_modules, sessions/*, workdir/*, 保留 .gitkeep)
├── src/
│   ├── runner.js               adapter 子进程执行器（Task 1-2）
│   ├── redactor.js             凭据擦除（Task 3）
│   ├── prompts.js              四类 prompt 构建器（Task 4）
│   ├── templates.js            模板加载与注入解析（Task 5）
│   ├── store.js                会话落盘（Task 6）
│   ├── orchestrator.js         委员会状态机（Task 7-8）
│   └── server.js               HTTP + SSE（Task 9）
├── adapters/agents.json        adapter 配置（Task 1 建 mock，Task 11 加真实）
├── templates/
│   ├── general/template.json   (Task 5)
│   └── nantian/template.json   (Task 5)
├── public/                     前端（Task 10）
│   ├── index.html  app.js  style.css
├── test/
│   ├── mock-cli.js             可控 mock CLI（Task 1）
│   ├── runner.test.js  redactor.test.js  prompts.test.js
│   ├── templates.test.js  store.test.js  orchestrator.test.js  server.test.js
├── sessions/.gitkeep
└── workdir/.gitkeep
```

---

### Task 1: 项目脚手架 + mock CLI + runner 核心

**Files:**
- Create: `package.json`, `.gitignore`, `sessions/.gitkeep`, `workdir/.gitkeep`
- Create: `test/mock-cli.js`
- Create: `src/runner.js`
- Test: `test/runner.test.js`

**Interfaces:**
- Consumes: 无（首任务）
- Produces:
  - `buildEnv(whitelist: string[], source?: object) => object`
  - `runAgent(cfg, prompt: string, opts?: {onChunk?: (s)=>void, signal?: AbortSignal}) => Promise<Result>`
  - `Result = {ok: boolean, text: string, raw: string, stderr: string, exitCode: number|null, error?: string, durationMs: number}`
  - cfg 字段：`{name, command: string[], input: 'stdin'|'file', output: 'text'|'json'|'stream-json', timeoutMs, envWhitelist: string[], cwd}`
  - mock-cli 协议（后续所有任务的测试都用它）：读 stdin 到 EOF，行为由 prompt 首行控制：`#echo` 原样回显其余内容；`#sleep <ms>` 睡后回显；`#fail <code>` 以该码退出并向 stderr 写 "mock failure"；`#auth` 退出码 1 且 stderr 写 "please login"；`#env <VAR>` 输出该环境变量值；默认回显全部输入

- [ ] **Step 1: 建脚手架文件**

`package.json`:
```json
{
  "name": "roundtable",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  }
}
```

`.gitignore`:
```
node_modules/
sessions/*
!sessions/.gitkeep
workdir/*
!workdir/.gitkeep
```

空文件 `sessions/.gitkeep`、`workdir/.gitkeep`。

- [ ] **Step 2: 写 mock CLI**

`test/mock-cli.js`:
```js
// 可控 mock CLI：按 prompt 首行指令行为，供全部测试复用
let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', async () => {
  const nl = input.indexOf('\n');
  const first = (nl === -1 ? input : input.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : input.slice(nl + 1);
  if (first.startsWith('#fail')) {
    process.stderr.write('mock failure');
    process.exit(Number(first.split(/\s+/)[1] ?? 1));
  }
  if (first === '#auth') {
    process.stderr.write('please login: session expired');
    process.exit(1);
  }
  if (first.startsWith('#sleep')) {
    await new Promise(r => setTimeout(r, Number(first.split(/\s+/)[1] ?? 100)));
    process.stdout.write(rest);
    process.exit(0);
  }
  if (first.startsWith('#env')) {
    process.stdout.write(String(process.env[first.split(/\s+/)[1]] ?? '<unset>'));
    process.exit(0);
  }
  if (first === '#echo') { process.stdout.write(rest); process.exit(0); }
  process.stdout.write(input);
  process.exit(0);
});
```

- [ ] **Step 3: 写失败测试**

`test/runner.test.js`:
```js
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
```

- [ ] **Step 4: 跑测试确认失败**

Run: `node --test test/runner.test.js`
Expected: FAIL —— `Cannot find module '../src/runner.js'`

- [ ] **Step 5: 写 runner 核心实现**

`src/runner.js`:
```js
import { spawn } from 'node:child_process';

// 只把白名单内的变量传给子进程——API key 等敏感变量默认全部隔离
export function buildEnv(whitelist, source = process.env) {
  const env = {};
  for (const k of whitelist) if (source[k] !== undefined) env[k] = source[k];
  return env;
}

export async function runAgent(cfg, prompt, opts = {}) {
  const started = Date.now();
  return await new Promise(resolve => {
    let out = '', err = '', settled = false;
    const finish = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ raw: out, stderr: err, durationMs: Date.now() - started, ...r });
    };
    let child;
    try {
      child = spawn(cfg.command[0], cfg.command.slice(1), {
        env: buildEnv(cfg.envWhitelist),
        cwd: cfg.cwd,
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      return finish({ ok: false, error: 'spawn:' + e.code, text: '', exitCode: null });
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'timeout', text: out, exitCode: null });
    }, cfg.timeoutMs);
    child.stdout.on('data', d => {
      const s = d.toString();
      out += s;
      opts.onChunk?.(s);
    });
    child.stderr.on('data', d => (err += d.toString()));
    child.on('error', e => finish({ ok: false, error: 'spawn:' + (e.code ?? e.message), text: out, exitCode: null }));
    child.on('close', code => {
      if (code !== 0) return finish({ ok: false, error: 'exit:' + code, text: out, exitCode: code });
      finish({ ok: true, text: out.trim(), exitCode: 0 });
    });
    if (cfg.input === 'stdin') child.stdin.write(prompt);
    child.stdin.end();
  });
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test test/runner.test.js`
Expected: 5 tests PASS

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore sessions/.gitkeep workdir/.gitkeep test/mock-cli.js src/runner.js test/runner.test.js
git commit -m "feat: 项目脚手架 + mock CLI + adapter runner 核心（env 白名单/超时/退出码）"
```

---

### Task 2: runner 扩展 —— file 输入、json/stream-json 解析、auth 检测、abort

**Files:**
- Modify: `src/runner.js`
- Modify: `test/mock-cli.js`（加 `#file` 与 `#json` 模式）
- Test: `test/runner.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `runAgent`/`Result`
- Produces:
  - `input:'file'`：prompt 写入临时文件；argv 中的 `{PROMPT_FILE}` 占位符被替换为该路径，若无占位符则追加为最后一个参数
  - `output:'json'`：stdout 整体 `JSON.parse`，取 `.result ?? .text ?? 原文` 为 text
  - `output:'stream-json'`：逐行解析 JSON 事件；`{type:'result', result}` 事件的 result 为最终 text（claude `--output-format stream-json` 的收尾事件格式）；解析失败降级为原文
  - 失败时若 stderr+stdout 匹配 `/log ?in|auth|401|unauthorized|credential|expired/i` → `error:'auth'`
  - `opts.signal`（AbortSignal）触发时 kill 子进程，`error:'aborted'`
  - 导出 `extractStreamText(raw) => string` 供测试

- [ ] **Step 1: mock-cli 加两个模式**

在 `test/mock-cli.js` 的指令分支中（`#echo` 分支之前）插入：
```js
  if (first === '#json') {
    process.stdout.write(JSON.stringify({ result: rest.trim() }));
    process.exit(0);
  }
  if (first === '#stream') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', result: rest.trim() }) + '\n');
    process.exit(0);
  }
  if (first === '#file') {
    // 最后一个 argv 是文件路径：读它并回显，验证 file 输入模式
    const { readFileSync } = await import('node:fs');
    process.stdout.write(readFileSync(process.argv[process.argv.length - 1], 'utf8'));
    process.exit(0);
  }
```
注意：`#file` 模式下 prompt 经文件传入，但 mock 仍从 stdin 读指令——因此 file 模式测试的 cfg.command 直接带 `#file` 语义不可行。改为：mock-cli 开头检查 `process.argv[2] === '--from-file'`，是则读 `argv[3]` 输出后退出（不等 stdin）：
```js
// 文件输入模式：node mock-cli.js --from-file {PROMPT_FILE}
if (process.argv[2] === '--from-file') {
  const { readFileSync } = await import('node:fs');
  process.stdout.write(readFileSync(process.argv[3], 'utf8'));
  process.exit(0);
}
```
（此段放在文件顶部、stdin 监听之前；需要把整个文件体包进顶层 async IIFE 或直接用顶层 await——ESM 下顶层 await 可用，mock-cli.js 无 package 上下文默认 CJS，故把 `test/mock-cli.js` 首行改用动态 import 或直接 `require('node:fs')`。最简单：mock-cli.js 顶部改为 `const { readFileSync } = require('node:fs');` 并全文件保持 CJS——node 默认将 .js 视为 package.json type 定义的 module，本项目是 ESM，因此 mock-cli.js 重命名为 `test/mock-cli.cjs`，所有引用同步更新。）

**决定：`test/mock-cli.cjs`（CJS），顶部 `const { readFileSync } = require('node:fs');`，Task 1 中的引用路径同步为 `test/mock-cli.cjs`。**

- [ ] **Step 2: 追加失败测试**

`test/runner.test.js` 追加：
```js
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
```

- [ ] **Step 3: 跑测试确认新增用例失败**

Run: `node --test test/runner.test.js`
Expected: Task 1 的 5 个 PASS，新增 5 个 FAIL

- [ ] **Step 4: 实现扩展**

`src/runner.js` 完整替换为：
```js
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function buildEnv(whitelist, source = process.env) {
  const env = {};
  for (const k of whitelist) if (source[k] !== undefined) env[k] = source[k];
  return env;
}

// 从 stream-json 输出中提取最终文本：type=result 事件优先，无则回退原文
export function extractStreamText(raw) {
  let text = '';
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.type === 'result' && typeof ev.result === 'string') text = ev.result;
    } catch { /* 单行坏 JSON 忽略 */ }
  }
  return text || raw.trim();
}

function parseOutput(mode, raw) {
  if (mode === 'json') {
    try { const j = JSON.parse(raw); return String(j.result ?? j.text ?? raw).trim(); }
    catch { return raw.trim(); }
  }
  if (mode === 'stream-json') return extractStreamText(raw);
  return raw.trim();
}

const AUTH_RE = /log ?in|auth|401|unauthorized|credential|expired/i;

export async function runAgent(cfg, prompt, opts = {}) {
  const started = Date.now();
  let argv = [...cfg.command];
  let tmpDir = null;
  if (cfg.input === 'file') {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'roundtable-'));
    const f = path.join(tmpDir, 'prompt.md');
    writeFileSync(f, prompt, 'utf8');
    if (argv.includes('{PROMPT_FILE}')) argv = argv.map(a => (a === '{PROMPT_FILE}' ? f : a));
    else argv.push(f);
  }
  return await new Promise(resolve => {
    let out = '', err = '', settled = false;
    const cleanup = () => { if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
    const finish = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      cleanup();
      resolve({ raw: out, stderr: err, durationMs: Date.now() - started, ...r });
    };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        env: buildEnv(cfg.envWhitelist),
        cwd: cfg.cwd,
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      return finish({ ok: false, error: 'spawn:' + (e.code ?? e.message), text: '', exitCode: null });
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'timeout', text: out, exitCode: null });
    }, cfg.timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'aborted', text: out, exitCode: null });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', d => {
      const s = d.toString();
      out += s;
      opts.onChunk?.(s);
    });
    child.stderr.on('data', d => (err += d.toString()));
    child.on('error', e => finish({ ok: false, error: 'spawn:' + (e.code ?? e.message), text: out, exitCode: null }));
    child.on('close', code => {
      if (code !== 0) {
        const auth = AUTH_RE.test(err + out);
        return finish({ ok: false, error: auth ? 'auth' : 'exit:' + code, text: out, exitCode: code });
      }
      finish({ ok: true, text: parseOutput(cfg.output, out), exitCode: 0 });
    });
    if (cfg.input === 'stdin') child.stdin.write(prompt);
    child.stdin.end();
  });
}
```

同步把 Task 1 已提交文件中 `test/mock-cli.js` 重命名为 `test/mock-cli.cjs`（`git mv`），文件首部加：
```js
const { readFileSync } = require('node:fs');
// 文件输入模式：node mock-cli.cjs --from-file <path>
if (process.argv[2] === '--from-file') {
  process.stdout.write(readFileSync(process.argv[3], 'utf8'));
  process.exit(0);
}
```
并在指令分支中加入 `#json`、`#stream` 两个分支（见 Step 1 代码），`#sleep` 分支中的 `await` 改为 `setTimeout(() => { process.stdout.write(rest); process.exit(0); }, ms)` 回调式（CJS 无顶层 await）。`test/runner.test.js` 中所有 `mock-cli.js` 引用改为 `mock-cli.cjs`。

- [ ] **Step 5: 跑全部 runner 测试**

Run: `node --test test/runner.test.js`
Expected: 10 tests PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: runner 支持 file 输入/json/stream-json 解析/auth 识别/abort"
```

---

### Task 3: redactor 凭据擦除

**Files:**
- Create: `src/redactor.js`
- Test: `test/redactor.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `redact(text: string) => string`——凭据形态替换为 `[REDACTED]`，键值型保留键名

- [ ] **Step 1: 写失败测试**

`test/redactor.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redactor.js';

test('擦除常见凭据形态', () => {
  const cases = [
    ['key sk-abc123def456ghi789jkl end', /\[REDACTED\]/],
    ['ghp_ABCDEFGHIJKLMNOPQRSTUV123456', /\[REDACTED\]/],
    ['xoxb-1234567890-abcdefghij', /\[REDACTED\]/],
    ['Authorization: Bearer abcdef123456789012345678', /\[REDACTED\]/],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P', /\[REDACTED\]/],
  ];
  for (const [input, want] of cases) assert.match(redact(input), want, input);
});

test('键值型凭据保留键名', () => {
  const out = redact('api_key: super-secret-value-123');
  assert.match(out, /api_key/);
  assert.doesNotMatch(out, /super-secret-value-123/);
});

test('普通文本不受影响', () => {
  const s = '南添认为规模效应是北极星，N1 阶段增速 >18%。';
  assert.equal(redact(s), s);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/redactor.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`src/redactor.js`:
```js
// 落盘前统一擦除凭据。宁可误伤，不可漏放。
const BARE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,                                           // OpenAI/Anthropic 风格
  /ghp_[A-Za-z0-9]{20,}/g,                                            // GitHub PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,                                    // Slack
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,                              // Bearer token
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/g,      // JWT
];
const KEYED = /((?:api[_-]?key|token|secret|password|passwd|cookie)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi;

export function redact(text) {
  let out = String(text);
  for (const p of BARE_PATTERNS) out = out.replace(p, '[REDACTED]');
  out = out.replace(KEYED, '$1[REDACTED]');
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/redactor.test.js`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/redactor.js test/redactor.test.js
git commit -m "feat: redactor 凭据擦除"
```

---

### Task 4: prompt 构建器（clean room 硬性保证）

**Files:**
- Create: `src/prompts.js`
- Test: `test/prompts.test.js`

**Interfaces:**
- Consumes: 无
- Produces（全部返回 string）：
  - `buildDebaterR1({topic, materials, injection, format, userNote})`
  - `buildDebaterRN({topic, round, summary, opponentName, opponentText, questions, injection, format, userNote})`
  - `buildSummarizer({topic, round, roundTexts, previousSummary})`——roundTexts 为 `{agentName: text}`
  - `buildJudge({topic, summary, finalStatements, format})`——finalStatements 为 `{agentName: text}`
  - 五类分歧常量 `DISAGREEMENT_TYPES = ['事实分歧','假设分歧','框架分歧','风险偏好分歧','行动分歧']`

- [ ] **Step 1: 写失败测试**

`test/prompts.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDebaterR1, buildDebaterRN, buildSummarizer, buildJudge, DISAGREEMENT_TYPES } from '../src/prompts.js';

test('R1 是 clean room：不含对手字段的任何痕迹', () => {
  const p = buildDebaterR1({ topic: '要不要加仓X', materials: '材料A', injection: '框架B', format: '格式C', userNote: '' });
  assert.match(p, /要不要加仓X/);
  assert.match(p, /材料A/);
  assert.match(p, /框架B/);
  assert.doesNotMatch(p, /对方|对手观点|OPPONENT/);
});

test('RN 包含 summary、对手发言、质询问题，并要求先答质询', () => {
  const p = buildDebaterRN({
    topic: 'T', round: 2, summary: 'SUMMARY_X', opponentName: 'Codex',
    opponentText: 'OPP_TEXT', questions: '你凭什么认为渗透率已过16%？',
    injection: '', format: '', userNote: '主持人：先聚焦事实',
  });
  for (const s of ['SUMMARY_X', 'OPP_TEXT', '你凭什么认为渗透率已过16%？', '主持人：先聚焦事实']) assert.match(p, new RegExp(s));
  assert.match(p, /先逐条回答.*质询/s);
});

test('summarizer 要求五类分歧分类表', () => {
  const p = buildSummarizer({ topic: 'T', round: 1, roundTexts: { Claude: 'a', Codex: 'b' }, previousSummary: '' });
  for (const t of DISAGREEMENT_TYPES) assert.match(p, new RegExp(t));
  assert.match(p, /当前共识/);
  assert.match(p, /下一轮待问问题/);
});

test('judge 禁止输出独立观点并要求最小下一步', () => {
  const p = buildJudge({ topic: 'T', summary: 'S', finalStatements: { Claude: 'a', Codex: 'b' }, format: '' });
  assert.match(p, /禁止.*(独立观点|自己的观点)/s);
  assert.match(p, /最小可验证下一步/);
  assert.match(p, /风险偏好分歧.*不判对错/s);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/prompts.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`src/prompts.js`:
```js
export const DISAGREEMENT_TYPES = ['事实分歧', '假设分歧', '框架分歧', '风险偏好分歧', '行动分歧'];

const DEBATER_COMMON = `你是决策委员会的一名独立辩手。规则：
- 严格区分：客观事实（给出处）/ 未证实假设（标注）/ 你的推断 / 建议
- 结论必须给出证伪点（kill condition）：什么信号出现说明你错了
- 结尾给出你主张的最小可验证下一步（时间/金钱成本最低的验证动作）
- 只输出正文，不要寒暄`;

export function buildDebaterR1({ topic, materials, injection, format, userNote }) {
  return [
    DEBATER_COMMON,
    '# 议题', topic,
    materials ? `# 背景材料\n${materials}` : '',
    injection ? `# 你的分析框架（按此框架作答）\n${injection}` : '',
    format ? `# 输出格式要求\n${format}` : '',
    userNote ? `# 主持人补充\n${userNote}` : '',
    '# 任务\n这是第 1 轮独立判断。你看不到其他辩手的任何内容，请完全独立作答。',
  ].filter(Boolean).join('\n\n');
}

export function buildDebaterRN({ topic, round, summary, opponentName, opponentText, questions, injection, format, userNote }) {
  return [
    DEBATER_COMMON,
    '# 议题', topic,
    `# 截至上一轮的滚动摘要\n${summary}`,
    `# ${opponentName} 上一轮的发言\n${opponentText}`,
    questions ? `# 对你的质询问题\n${questions}` : '',
    injection ? `# 你的分析框架\n${injection}` : '',
    format ? `# 输出格式要求\n${format}` : '',
    userNote ? `# 主持人补充\n${userNote}` : '',
    `# 任务\n这是第 ${round} 轮交叉质询。请先逐条回答对你的质询问题，然后输出：同意点 / 被说服的修正 / 坚持的分歧及理由 / 新证据。`,
  ].filter(Boolean).join('\n\n');
}

export function buildSummarizer({ topic, round, roundTexts, previousSummary }) {
  const texts = Object.entries(roundTexts).map(([n, t]) => `## ${n} 的发言\n${t}`).join('\n\n');
  return [
    '你是决策委员会的书记员。只归纳，不评论，不添加自己的观点。',
    '# 议题', topic,
    previousSummary ? `# 上一版滚动摘要\n${previousSummary}` : '',
    `# 第 ${round} 轮发言\n${texts}`,
    `# 任务\n更新滚动摘要，严格按以下结构输出：
## Rolling Summary（第 ${round} 轮后）
- 当前共识：
- 分歧分类表：每行一条，格式「类型 | 分歧内容 | 各方立场 | 处置」。类型必须是：${DISAGREEMENT_TYPES.join('、')} 之一。
  处置规则：事实分歧→标注查证途径；假设分歧→标注双方假设；框架分歧→呈现双方框架依据；风险偏好分歧→标注"由用户按自身偏好选择"；行动分歧→比较反馈成本。
- 已证实事实：（含出处）
- 未证实假设：（谁的假设、如何验证）
- 证伪点：
- 下一轮待问问题：给每位辩手各拟 1-3 个交叉质询问题，格式「问 <辩手名>：<问题>」`,
  ].filter(Boolean).join('\n\n');
}

export function buildJudge({ topic, summary, finalStatements, format }) {
  const texts = Object.entries(finalStatements).map(([n, t]) => `## ${n} 的最终陈述\n${t}`).join('\n\n');
  return [
    `你是决策委员会的独立仲裁者。你的职责是比较与裁决，禁止输出你自己对议题的独立观点，禁止替任何一方补充论据。`,
    '# 议题', topic,
    `# 滚动摘要（含分歧分类表）\n${summary}`,
    texts,
    `# 仲裁标准
1. 比较证据强弱：事实引用的数量与质量
2. 比较假设多少：谁的结论依赖更多未证实前提
3. 比较证伪点质量：谁的 kill condition 更可检验、反馈成本更低
4. 评估下一步反馈成本
5. 按分歧分类表逐条处置：事实分歧给出裁决与依据；假设分歧标注验证方式；框架分歧比较证伪点质量；风险偏好分歧不判对错、明确交还用户选择；行动分歧倾向反馈成本最低者`,
    format ? `# 裁决卡格式\n${format}` : `# 裁决卡格式
## 裁决卡
- 一致结论（置信度↑）：
- 被说服的修正：
- 分歧逐条处置：（引用分歧分类表逐条给出）
- 综合证伪条件：
- 最小可验证下一步：`,
  ].filter(Boolean).join('\n\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/prompts.test.js`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/prompts.js test/prompts.test.js
git commit -m "feat: 四类 prompt 构建器（clean room / 交叉质询 / 分歧分类 / 独立仲裁）"
```

---

### Task 5: 模板系统 + 两个内置模板

**Files:**
- Create: `src/templates.js`
- Create: `templates/general/template.json`
- Create: `templates/nantian/template.json`
- Test: `test/templates.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `loadTemplates(dir) => Promise<{[name]: Template}>`——扫描 `templates/*/template.json`
  - `Template = {name, title, injections: {[agentId]: string[]}, debaterFormat: string, judgeFormat: string, copyJudgeCardTo: string|null}`
  - `resolveInjection(template, agentId) => Promise<string>`——读取并拼接该 agent 的注入文件内容；路径中 `~` 展开为用户主目录；文件缺失时抛带路径的明确错误
  - `expandHome(p) => string`

- [ ] **Step 1: 写失败测试**

`test/templates.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { loadTemplates, resolveInjection, expandHome } from '../src/templates.js';

function makeTplDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-tpl-'));
  mkdirSync(path.join(dir, 'demo'));
  const skillPath = path.join(dir, 'skillA.md').replaceAll('\\', '/');
  writeFileSync(path.join(dir, 'demo', 'template.json'), JSON.stringify({
    name: 'demo', title: '演示', injections: { claude: [skillPath] },
    debaterFormat: 'F', judgeFormat: 'J', copyJudgeCardTo: null,
  }));
  writeFileSync(path.join(dir, 'skillA.md'), 'SKILL_A_CONTENT');
  return dir;
}

test('expandHome 展开 ~', () => {
  assert.equal(expandHome('~/x'), path.join(homedir(), 'x'));
  assert.equal(expandHome('/abs/x'), '/abs/x');
});

test('loadTemplates 扫描目录', async () => {
  const tpls = await loadTemplates(makeTplDir());
  assert.equal(tpls.demo.title, '演示');
});

test('resolveInjection 拼接文件内容；无配置返回空串', async () => {
  const tpls = await loadTemplates(makeTplDir());
  assert.match(await resolveInjection(tpls.demo, 'claude'), /SKILL_A_CONTENT/);
  assert.equal(await resolveInjection(tpls.demo, 'codex'), '');
});

test('注入文件缺失时报带路径的错误', async () => {
  const dir = makeTplDir();
  const tpls = await loadTemplates(dir);
  tpls.demo.injections.claude = [path.join(dir, 'missing.md')];
  await assert.rejects(() => resolveInjection(tpls.demo, 'claude'), /missing\.md/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/templates.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 + 写两个内置模板**

`src/templates.js`:
```js
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export function expandHome(p) {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
}

export async function loadTemplates(dir) {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(path.join(dir, entry.name, 'template.json'), 'utf8');
      const t = JSON.parse(raw);
      out[t.name] = { injections: {}, debaterFormat: '', judgeFormat: '', copyJudgeCardTo: null, ...t };
    } catch { /* 无 template.json 的目录跳过 */ }
  }
  return out;
}

export async function resolveInjection(template, agentId) {
  const files = template.injections?.[agentId] ?? [];
  const parts = [];
  for (const f of files) {
    const p = expandHome(f);
    try {
      parts.push(await readFile(p, 'utf8'));
    } catch (e) {
      throw new Error(`模板「${template.name}」的注入文件读取失败: ${p} (${e.code ?? e.message})`);
    }
  }
  return parts.join('\n\n---\n\n');
}
```

`templates/general/template.json`:
```json
{
  "name": "general",
  "title": "通用辩论",
  "injections": {},
  "debaterFormat": "输出必须包含三节：## 证据（每条含出处）、## 假设（未证实前提逐条列出）、## 证伪点（什么信号出现说明你错了）。最后给出你的结论与最小可验证下一步。",
  "judgeFormat": "",
  "copyJudgeCardTo": null
}
```

`templates/nantian/template.json`:
```json
{
  "name": "nantian",
  "title": "南添决策辩论（双引擎）",
  "injections": {
    "claude": ["~/.claude/skills/nantian-decision/SKILL.md"],
    "codex": [
      "~/.codex/skills/nantian-decision-framework/SKILL.md",
      "~/.codex/skills/nantian-decision-framework/references/framework.md"
    ]
  },
  "debaterFormat": "严格按五步结构输出：## 1.增量事实（区分：事实/假设/推断，事实必须给出处）；## 2.N0/N1/N2 分类及依据；## 3.商业验证要点（竞争优势与规模效应两条线）；## 4.渗透率/阶段定位；## 5.仓位建议（2% 算法：认知止损点 + 以损定量）。结尾必须给出：kill condition + 最小可验证下一步。",
  "judgeFormat": "## 裁决卡\n- 一致结论（置信度↑）：\n- 被说服的修正：\n- 分歧逐条处置：（事实性分歧若涉及南添原话，标注可回源 ~/.claude/skills/nantian-decision/E112-transcript.txt 按时间戳查证）\n- 综合证伪条件：\n- 建议行动与下注规模（2% 算法）：\n- 最小可验证下一步：",
  "copyJudgeCardTo": "~/.claude/skills/nantian-decision/decisions"
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/templates.test.js`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/templates.js templates/ test/templates.test.js
git commit -m "feat: 模板系统 + 通用/南添两个内置模板"
```

---

### Task 6: store 会话持久化（可复盘结构）

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: Task 3 `redact`
- Produces（所有文本落盘前先 redact）：
  - `createSessionDir(baseDir, slug) => Promise<string>`——建 `<baseDir>/<YYYY-MM-DD>-<slug>/` 及 `prompts/ raw/ summaries/` 子目录；重名自动加 `-2`、`-3` 后缀
  - `saveProblem(dir, {topic, materials, templateName, roles, mode, maxRounds})` → `problem.md`
  - `savePrompt(dir, label, agentId, text)` → `prompts/<label>-<agentId>.md`（label 如 `r1`、`judge`）
  - `saveRaw(dir, label, agentId, text)` → `raw/<label>-<agentId>.md`
  - `saveSummary(dir, round, text)` → `summaries/r<round>.md`
  - `saveDisagreements(dir, text)` → `disagreements.md`
  - `saveJudgeCard(dir, text)` → `judge-card.md`
  - `saveMetadata(dir, obj)` → `metadata.json`
  - `assembleSessionMd(dir) => Promise<void>`——按 problem → 各轮(raw+summary) → disagreements → judge 原文 → judge-card 顺序拼 `session.md`

- [ ] **Step 1: 写失败测试**

`test/store.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as store from '../src/store.js';

async function makeSession() {
  const base = mkdtempSync(path.join(tmpdir(), 'rt-store-'));
  const dir = await store.createSessionDir(base, 'test-topic');
  return { base, dir };
}

test('createSessionDir 建标准结构且重名自动后缀', async () => {
  const { base, dir } = await makeSession();
  for (const sub of ['prompts', 'raw', 'summaries']) assert.ok(existsSync(path.join(dir, sub)));
  const dir2 = await store.createSessionDir(base, 'test-topic');
  assert.notEqual(dir2, dir);
  assert.match(path.basename(dir2), /-2$/);
});

test('所有落盘文本经过 redaction', async () => {
  const { dir } = await makeSession();
  await store.saveRaw(dir, 'r1', 'claude', '结论 with sk-abc123def456ghi789jkl inside');
  const txt = readFileSync(path.join(dir, 'raw', 'r1-claude.md'), 'utf8');
  assert.match(txt, /\[REDACTED\]/);
  assert.doesNotMatch(txt, /sk-abc123/);
});

test('metadata 与 session.md 汇总', async () => {
  const { dir } = await makeSession();
  await store.saveProblem(dir, { topic: '议题X', materials: '', templateName: 'general', roles: { debaters: ['claude', 'codex'], judge: 'codex', summarizer: 'claude' }, mode: 'manual', maxRounds: 4 });
  await store.saveRaw(dir, 'r1', 'claude', '甲方观点');
  await store.saveSummary(dir, 1, '摘要一');
  await store.saveJudgeCard(dir, '裁决内容');
  await store.saveMetadata(dir, { status: 'done', rounds: 1 });
  await store.assembleSessionMd(dir);
  const md = readFileSync(path.join(dir, 'session.md'), 'utf8');
  for (const s of ['议题X', '甲方观点', '摘要一', '裁决内容']) assert.match(md, new RegExp(s));
  const meta = JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  assert.equal(meta.status, 'done');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/store.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`src/store.js`:
```js
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { redact } from './redactor.js';

const today = () => new Date().toISOString().slice(0, 10);

export async function createSessionDir(baseDir, slug) {
  const safe = String(slug).replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
  let dir = path.join(baseDir, `${today()}-${safe}`);
  for (let i = 2; existsSync(dir); i++) dir = path.join(baseDir, `${today()}-${safe}-${i}`);
  for (const sub of ['', 'prompts', 'raw', 'summaries']) await mkdir(path.join(dir, sub), { recursive: true });
  return dir;
}

const w = (file, text) => writeFile(file, redact(String(text)), 'utf8');

export async function saveProblem(dir, { topic, materials, templateName, roles, mode, maxRounds }) {
  await w(path.join(dir, 'problem.md'),
    `# 议题\n${topic}\n\n# 背景材料\n${materials || '（无）'}\n\n# 配置\n- 模板：${templateName}\n- 辩手：${roles.debaters.join(', ')}\n- 仲裁：${roles.judge}\n- 书记：${roles.summarizer}\n- 模式：${mode}\n- 最大轮数：${maxRounds}\n`);
}
export const savePrompt = (dir, label, agentId, text) => w(path.join(dir, 'prompts', `${label}-${agentId}.md`), text);
export const saveRaw = (dir, label, agentId, text) => w(path.join(dir, 'raw', `${label}-${agentId}.md`), text);
export const saveSummary = (dir, round, text) => w(path.join(dir, 'summaries', `r${round}.md`), text);
export const saveDisagreements = (dir, text) => w(path.join(dir, 'disagreements.md'), text);
export const saveJudgeCard = (dir, text) => w(path.join(dir, 'judge-card.md'), text);
export const saveMetadata = (dir, obj) => writeFile(path.join(dir, 'metadata.json'), JSON.stringify(obj, null, 2), 'utf8');

export async function assembleSessionMd(dir) {
  const parts = [];
  const tryRead = async f => { try { return await readFile(f, 'utf8'); } catch { return null; } };
  const problem = await tryRead(path.join(dir, 'problem.md'));
  if (problem) parts.push(problem);
  let raws = [];
  try { raws = (await readdir(path.join(dir, 'raw'))).sort(); } catch { /* 目录可能为空 */ }
  let sums = [];
  try { sums = (await readdir(path.join(dir, 'summaries'))).sort(); } catch { /* 同上 */ }
  const rounds = [...new Set(raws.map(f => f.split('-')[0]))].filter(r => /^r\d+$/.test(r)).sort();
  for (const r of rounds) {
    parts.push(`\n---\n\n# 第 ${r.slice(1)} 轮`);
    for (const f of raws.filter(x => x.startsWith(r + '-') && !x.includes('summary')))
      parts.push(`## ${f.replace('.md', '').replace(r + '-', '')} 发言\n\n${await tryRead(path.join(dir, 'raw', f))}`);
    const s = sums.find(x => x === `${r}.md`);
    if (s) parts.push(await tryRead(path.join(dir, 'summaries', s)));
  }
  const dis = await tryRead(path.join(dir, 'disagreements.md'));
  if (dis) parts.push(`\n---\n\n# 分歧分类表（全场累计）\n\n${dis}`);
  const card = await tryRead(path.join(dir, 'judge-card.md'));
  if (card) parts.push(`\n---\n\n${card}`);
  await writeFile(path.join(dir, 'session.md'), parts.filter(Boolean).join('\n\n'), 'utf8');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/store.test.js`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: 可复盘的会话持久化（redaction 全覆盖）"
```

---

### Task 7: orchestrator 核心 —— 状态机与轮次

**Files:**
- Create: `src/orchestrator.js`
- Create: `adapters/agents.json`（本任务只放 mock 条目，真实条目 Task 11 加）
- Test: `test/orchestrator.test.js`

**Interfaces:**
- Consumes: `runAgent`（Task 2）、`buildDebaterR1/RN/buildSummarizer/buildJudge`（Task 4）、`resolveInjection`（Task 5）、store 全部（Task 6）
- Produces:
  - `class Committee`，构造参数 `{topic, materials, agents, roles, template, mode, maxRounds, baseDir, emit}`
    - `agents`: `{[agentId]: adapterCfg}`；`roles`: `{debaters: [id, id], judge: id, summarizer: id}`
    - `emit(event)`：`{type, agentId?, round?, data?}`，type ∈ `chunk | agent-status | round-done | summary | judge-card | error | state`
  - 属性：`state`（created/running/paused/judging/done/partial）、`round`、`history`（每项 `{briefs, outputs, summary}`）、`dir`、`errors`
  - 方法：`async init()`、`async runNextRound()`、`async summarizeRound()`、`async runJudge()`、`interject(text)`、`latestSummary()`、`questionsFor(agentId)`、`agentName(id)`
  - 简报规则：第 1 轮用 `buildDebaterR1`（**代码路径上不可能引用对方输出**）；第 N 轮用 `buildDebaterRN`（rolling summary + 对方最新原文 + 质询 + 主持人插话）；`userNote` 用后即清
  - `questionsFor`：从最新 summary 中提取含「问 <辩手名>」的行

`adapters/agents.json`（本任务版本）:
```json
{
  "mockA": { "name": "MockA", "command": ["node", "test/mock-cli.cjs"], "input": "stdin", "output": "text", "timeoutMs": 5000, "envWhitelist": ["PATH", "SYSTEMROOT"], "cwd": ".", "roles": ["debater", "judge", "summarizer"] },
  "mockB": { "name": "MockB", "command": ["node", "test/mock-cli.cjs"], "input": "stdin", "output": "text", "timeoutMs": 5000, "envWhitelist": ["PATH", "SYSTEMROOT"], "cwd": ".", "roles": ["debater", "judge", "summarizer"] }
}
```

- [ ] **Step 1: 写失败测试**

`test/orchestrator.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Committee } from '../src/orchestrator.js';

// mock-cli 默认回显输入 → 辩手输出 = 简报原文，正好用来断言简报内容
const AGENT = name => ({
  name, command: [process.execPath, 'test/mock-cli.cjs'], input: 'stdin', output: 'text',
  timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT'], cwd: process.cwd(), roles: ['debater', 'judge', 'summarizer'],
});

function makeCommittee(over = {}) {
  const events = [];
  const c = new Committee({
    topic: '测试议题', materials: '',
    agents: { a: AGENT('AgentA'), b: AGENT('AgentB'), s: AGENT('AgentS') },
    roles: { debaters: ['a', 'b'], judge: 's', summarizer: 's' },
    template: { name: 'general', injections: {}, debaterFormat: '', judgeFormat: '', copyJudgeCardTo: null },
    mode: 'manual', maxRounds: 4,
    baseDir: mkdtempSync(path.join(tmpdir(), 'rt-orch-')),
    emit: e => events.push(e),
    ...over,
  });
  return { c, events };
}

test('第 1 轮是 clean room：双方简报互不含对方内容', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  const briefA = c.history[0].briefs.a, briefB = c.history[0].briefs.b;
  assert.doesNotMatch(briefA, /AgentB/);
  assert.doesNotMatch(briefB, /AgentA/);
  assert.match(briefA, /第 1 轮独立判断/);
  assert.equal(c.state, 'paused');
  assert.ok(c.history[0].summary.length > 0);
});

test('第 2 轮简报含 summary、对方发言与主持人插话', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  c.interject('主持人：请聚焦渗透率');
  await c.runNextRound();
  const briefA = c.history[1].briefs.a;
  assert.match(briefA, /AgentB 上一轮的发言/);
  assert.match(briefA, /主持人：请聚焦渗透率/);
});

test('runJudge 产出裁决卡并落盘', async () => {
  const { c, events } = makeCommittee();
  await c.init();
  await c.runNextRound();
  await c.runJudge();
  assert.equal(c.state, 'done');
  assert.ok(readFileSync(path.join(c.dir, 'judge-card.md'), 'utf8').length > 0);
  assert.ok(events.some(e => e.type === 'judge-card'));
  assert.ok(readdirSync(c.dir).includes('session.md'));
});

test('全过程落盘 prompts 与 raw', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  const prompts = readdirSync(path.join(c.dir, 'prompts'));
  const raws = readdirSync(path.join(c.dir, 'raw'));
  for (const f of ['r1-a.md', 'r1-b.md']) {
    assert.ok(prompts.includes(f), 'prompts 缺 ' + f);
    assert.ok(raws.includes(f), 'raw 缺 ' + f);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/orchestrator.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现（完整代码）**

`src/orchestrator.js`:
```js
import { runAgent } from './runner.js';
import { buildDebaterR1, buildDebaterRN, buildSummarizer, buildJudge } from './prompts.js';
import { resolveInjection } from './templates.js';
import * as store from './store.js';

export class Committee {
  constructor({ topic, materials, agents, roles, template, mode, maxRounds, baseDir, emit }) {
    Object.assign(this, { topic, materials, agents, roles, template, mode, maxRounds, baseDir });
    this.emit = emit ?? (() => {});
    this.state = 'created';
    this.round = 0;
    this.history = [];
    this.userNote = '';
    this.dir = null;
    this.abort = null;
    this.errors = [];
  }

  setState(s) { this.state = s; this.emit({ type: 'state', data: s }); }
  agentName(id) { return this.agents[id].name; }
  latestSummary() { return this.history.at(-1)?.summary ?? ''; }
  interject(text) { this.userNote = text; }

  async init() {
    this.dir = await store.createSessionDir(this.baseDir, this.topic.slice(0, 30));
    await store.saveProblem(this.dir, {
      topic: this.topic, materials: this.materials, templateName: this.template.name,
      roles: this.roles, mode: this.mode, maxRounds: this.maxRounds,
    });
    await this.saveMeta('created');
  }

  async saveMeta(status) {
    await store.saveMetadata(this.dir, {
      status, topic: this.topic, template: this.template.name, roles: this.roles,
      mode: this.mode, maxRounds: this.maxRounds, rounds: this.round,
      agents: this.agents, errors: this.errors, updatedAt: new Date().toISOString(),
    });
  }

  // 从 summary 提取给某辩手的质询行（「问 <辩手名>：xxx」）
  questionsFor(agentId) {
    const name = this.agentName(agentId);
    return this.latestSummary().split('\n')
      .filter(l => l.includes(`问 ${name}`) || l.includes(`问${name}`)).join('\n');
  }

  async buildBrief(agentId, opponentId) {
    const injection = await resolveInjection(this.template, agentId);
    if (this.round === 1) {
      // clean room：R1 构建路径上没有任何对手数据可引用
      return buildDebaterR1({
        topic: this.topic, materials: this.materials, injection,
        format: this.template.debaterFormat, userNote: this.userNote,
      });
    }
    const prev = this.history.at(-1);
    return buildDebaterRN({
      topic: this.topic, round: this.round, summary: prev.summary,
      opponentName: this.agentName(opponentId),
      opponentText: prev.outputs[opponentId]?.text || '（对方上一轮缺席）',
      questions: this.questionsFor(agentId), injection,
      format: this.template.debaterFormat, userNote: this.userNote,
    });
  }

  async call(agentId, label, prompt) {
    await store.savePrompt(this.dir, label, agentId, prompt);
    this.emit({ type: 'agent-status', agentId, data: 'running' });
    const r = await runAgent(this.agents[agentId], prompt, {
      onChunk: s => this.emit({ type: 'chunk', agentId, data: s }),
      signal: this.abort?.signal,
    });
    await store.saveRaw(this.dir, label, agentId,
      r.ok ? r.text : `[${r.error}]\n${r.text}\n--- stderr ---\n${r.stderr}`);
    if (!r.ok) {
      this.errors.push({ label, agentId, error: r.error, at: new Date().toISOString() });
      this.emit({ type: 'error', agentId, data: r.error });
    }
    this.emit({ type: 'agent-status', agentId, data: r.ok ? 'done' : 'failed:' + r.error });
    return r;
  }

  async runNextRound() {
    if (!['created', 'paused'].includes(this.state)) throw new Error('当前状态不能开始新一轮: ' + this.state);
    this.round += 1;
    this.abort = new AbortController();
    this.setState('running');
    const [a, b] = this.roles.debaters;
    const briefs = { [a]: await this.buildBrief(a, b), [b]: await this.buildBrief(b, a) };
    this.userNote = '';
    const label = 'r' + this.round;
    const [ra, rb] = await Promise.all([this.call(a, label, briefs[a]), this.call(b, label, briefs[b])]);
    if ([ra, rb].some(r => r.error === 'aborted')) return null; // stopRound 已处理状态与轮次回退
    const entry = { briefs, outputs: { [a]: ra, [b]: rb }, summary: '' };
    this.history.push(entry);
    await this.summarizeRound();
    this.setState('paused');
    this.emit({ type: 'round-done', round: this.round });
    await this.saveMeta('paused');
    return entry;
  }

  async summarizeRound() {
    const entry = this.history.at(-1);
    const roundTexts = {};
    for (const d of this.roles.debaters) {
      const o = entry.outputs[d];
      roundTexts[this.agentName(d)] = o?.ok ? o.text : `（本轮缺席：${o?.error ?? 'skipped'}）`;
    }
    const prompt = buildSummarizer({
      topic: this.topic, round: this.round, roundTexts,
      previousSummary: this.history.at(-2)?.summary ?? '',
    });
    const r = await this.call(this.roles.summarizer, `r${this.round}summary`, prompt);
    entry.summary = r.ok ? r.text : '（本轮摘要失败：' + r.error + '）';
    await store.saveSummary(this.dir, this.round, entry.summary);
    await store.saveDisagreements(this.dir, entry.summary);
    this.emit({ type: 'summary', round: this.round, data: entry.summary });
  }

  async runJudge() {
    this.setState('judging');
    const finalStatements = {};
    const last = this.history.at(-1);
    for (const d of this.roles.debaters) {
      const o = last.outputs[d];
      finalStatements[this.agentName(d)] = o?.ok ? o.text : '（最终轮缺席）';
    }
    const prompt = buildJudge({
      topic: this.topic, summary: this.latestSummary(), finalStatements,
      format: this.template.judgeFormat,
    });
    const r = await this.call(this.roles.judge, 'judge', prompt);
    if (r.ok) {
      await store.saveJudgeCard(this.dir, r.text);
      this.emit({ type: 'judge-card', data: r.text });
    }
    await store.assembleSessionMd(this.dir);
    this.setState(r.ok ? 'done' : 'partial');
    await this.saveMeta(this.state);
    return r;
  }
}
```

注意：raw/prompts 的 summarizer 落盘 label 用 `r1summary`（无连字符），避免 `assembleSessionMd` 按 `-` 切分时把它误认成辩手发言。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/orchestrator.test.js`
Expected: 4 tests PASS

- [ ] **Step 5: 写 adapters/agents.json（mock 版）并提交**

```bash
git add src/orchestrator.js adapters/agents.json test/orchestrator.test.js
git commit -m "feat: 委员会状态机核心（clean room 轮次/摘要/仲裁/全程落盘）"
```

---

### Task 8: orchestrator 控制 —— 重试/跳过/停止/半成品/自动/收敛

**Files:**
- Modify: `src/orchestrator.js`
- Test: `test/orchestrator.test.js`（追加）

**Interfaces:**
- Consumes: Task 7 `Committee`
- Produces（追加方法）：
  - `async retrySide(agentId)`——用已存简报重跑该辩手最近一轮，成功后重新 summarize
  - `async skipSide(agentId)`——标记缺席 `{ok:false, error:'skipped', text:''}` 并重新 summarize
  - `stopRound()`——abort 当前轮全部子进程；若在 running 中，轮次号回退 1、state→paused、本轮不入 history
  - `async savePartial()`——assembleSessionMd + metadata.status='partial'
  - `requestAutoStop()`；`async runAuto()`——循环至 maxRounds 或分歧收敛（连续两轮分歧分类表文本一致）后自动 runJudge；autoStopRequested 置位则停在 paused
  - `extractDisagreementBlock(summary) => string`（模块级导出）

- [ ] **Step 1: 追加失败测试**

`test/orchestrator.test.js` 追加：
```js
import { extractDisagreementBlock } from '../src/orchestrator.js';

test('skipSide 后 summary 记录缺席', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  await c.skipSide('b');
  assert.match(c.history[0].summary, /缺席/);
});

test('retrySide 用原简报重跑并刷新摘要', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  await c.skipSide('b');
  await c.retrySide('b');
  assert.equal(c.history[0].outputs.b.ok, true);
  assert.doesNotMatch(c.history[0].summary, /缺席/);
});

test('stopRound 中止并回退轮次', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  // 用慢速 mock 制造可中断的一轮
  c.agents.a.command = [process.execPath, 'test/mock-cli.cjs'];
  const p = c.runNextRound();
  setTimeout(() => c.stopRound(), 50);
  await p;
  assert.equal(c.round, 1);
  assert.equal(c.state, 'paused');
  assert.equal(c.history.length, 1);
});

test('savePartial 落盘半成品', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  await c.savePartial();
  const meta = JSON.parse(readFileSync(path.join(c.dir, 'metadata.json'), 'utf8'));
  assert.equal(meta.status, 'partial');
  assert.ok(readdirSync(c.dir).includes('session.md'));
});

test('runAuto 达到 maxRounds 后自动裁决', async () => {
  const { c } = makeCommittee({ maxRounds: 2, mode: 'auto' });
  await c.init();
  await c.runAuto();
  assert.equal(c.round, 2);
  assert.equal(c.state, 'done');
});

test('extractDisagreementBlock 截取分歧段', () => {
  const s = '- 当前共识：x\n- 分歧分类表：\n  事实分歧 | A | B | 查证\n- 已证实事实：y';
  assert.match(extractDisagreementBlock(s), /事实分歧 \| A \| B/);
  assert.doesNotMatch(extractDisagreementBlock(s), /已证实事实/);
});
```

说明：stopRound 测试中慢速中断依赖 `#sleep`——第二轮简报以 rolling summary 开头而非 `#sleep` 指令，mock 会走默认回显（很快）。为使该测试可靠，把 stopRound 测试的 agents.a/agents.b 的 command 换成 `[process.execPath, 'test/mock-cli.cjs']` 且 timeoutMs 保持 5000，同时在 `c.interject('#sleep 3000')` 之类的注入不可行——**改用直接可靠的做法**：给 mock-cli.cjs 增加环境变量开关 `MOCK_DELAY_MS`（存在则先睡再回显），stopRound 测试中 `c.agents.a.envWhitelist = ['PATH','SYSTEMROOT','MOCK_DELAY_MS']`、`process.env.MOCK_DELAY_MS='3000'`，测试结束 `delete process.env.MOCK_DELAY_MS`。mock-cli.cjs 顶部加：
```js
const delay = Number(process.env.MOCK_DELAY_MS ?? 0);
```
并在写出结果前 `setTimeout(..., delay)` 包裹（默认 0 不影响其他测试）。

- [ ] **Step 2: 跑测试确认新增失败**

Run: `node --test test/orchestrator.test.js`
Expected: 原 4 个 PASS，新增 6 个 FAIL

- [ ] **Step 3: 实现控制方法**

在 `Committee` 类内追加：
```js
  async retrySide(agentId) {
    const entry = this.history.at(-1);
    if (!entry) throw new Error('尚无可重试的轮次');
    this.abort = new AbortController();
    const r = await this.call(agentId, `r${this.round}retry`, entry.briefs[agentId]);
    entry.outputs[agentId] = r;
    await this.summarizeRound();
    await this.saveMeta(this.state);
    return r;
  }

  async skipSide(agentId) {
    const entry = this.history.at(-1);
    if (!entry) throw new Error('尚无可跳过的轮次');
    entry.outputs[agentId] = { ok: false, error: 'skipped', text: '' };
    this.emit({ type: 'agent-status', agentId, data: 'skipped' });
    await this.summarizeRound();
  }

  stopRound() {
    this.autoStopRequested = true;
    this.abort?.abort();
    if (this.state === 'running') {
      this.round -= 1; // 本轮作废
      this.setState('paused');
    }
  }

  async savePartial() {
    await store.assembleSessionMd(this.dir);
    await this.saveMeta('partial');
    this.state = 'partial';
  }

  requestAutoStop() { this.autoStopRequested = true; }

  async runAuto() {
    this.autoStopRequested = false;
    while (this.round < this.maxRounds && !this.autoStopRequested) {
      const entry = await this.runNextRound();
      if (!entry) return; // 被 stopRound 中止
      const [s1, s2] = [this.history.at(-2)?.summary, this.history.at(-1)?.summary];
      if (s1 && s2 && extractDisagreementBlock(s1) === extractDisagreementBlock(s2)) break; // 分歧收敛
    }
    if (!this.autoStopRequested) await this.runJudge();
  }
```

模块底部：
```js
export function extractDisagreementBlock(summary) {
  const lines = String(summary).split('\n');
  const start = lines.findIndex(l => l.includes('分歧分类表'));
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) break; // 下一个顶层条目
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}
```

- [ ] **Step 4: 跑全部测试**

Run: `node --test test/`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 重试/跳过/停止/半成品/自动模式与分歧收敛判定"
```

---

### Task 9: HTTP 服务 + SSE

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `Committee`（Task 7-8）、`loadTemplates`（Task 5）、`adapters/agents.json`
- Produces（HTTP API，全部 JSON；服务只绑 127.0.0.1:7777，可用环境变量 PORT 覆盖端口）：
  - `GET /` → public/index.html；`GET /app.js`、`GET /style.css` 同理（静态三文件白名单，无通用静态服务，杜绝路径穿越）
  - `GET /api/config` → `{agents: {id: {name, roles}}, templates: {name: {title}}}`（不暴露 command/env 细节到前端）
  - `POST /api/sessions` body `{topic, materials, template, roles, mode, maxRounds}` → `{id}`；创建 Committee 并 init
  - `GET /api/sessions/:id/events` → SSE 流；连接即回放该会话已发生的全部事件（事件缓冲区）再实时推送
  - `POST /api/sessions/:id/round` → 手动下一轮（异步启动，立即返回 `{ok:true}`）
  - `POST /api/sessions/:id/auto` → runAuto 启动
  - `POST /api/sessions/:id/interject` body `{text}`
  - `POST /api/sessions/:id/judge`、`/retry` body `{agentId}`、`/skip` body `{agentId}`、`/stop`、`/save-partial`
  - `GET /api/sessions/:id` → `{state, round, topic, dir}`
  - 错误统一 `{error: string}` + 4xx/5xx
- 内部：`sessions = new Map<id, {committee, events: [], clients: Set<res>}>`；Committee 的 emit 写入 events 缓冲并广播给所有 SSE client；id 用 `Date.now().toString(36)`

- [ ] **Step 1: 写失败测试**

`test/server.test.js`:
```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/server.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`src/server.js`:
```js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Committee } from './orchestrator.js';
import { loadTemplates } from './templates.js';

const STATIC = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'] };

export async function startServer({ port = 7777, agentsFile = 'adapters/agents.json', templatesDir = 'templates', sessionsDir = 'sessions' } = {}) {
  const agents = JSON.parse(await readFile(agentsFile, 'utf8'));
  const templates = await loadTemplates(templatesDir);
  const sessions = new Map();

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const readBody = req => new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      // 静态文件（白名单，无路径穿越面）
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        try {
          res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
          return res.end(await readFile(file));
        } catch { return json(res, 404, { error: 'not found' }); }
      }
      if (url.pathname === '/api/config') {
        const pub = Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, { name: a.name, roles: a.roles }]));
        const tpl = Object.fromEntries(Object.entries(templates).map(([n, t]) => [n, { title: t.title }]));
        return json(res, 200, { agents: pub, templates: tpl });
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const template = templates[body.template];
        if (!template) return json(res, 400, { error: '未知模板: ' + body.template });
        for (const id of [...(body.roles?.debaters ?? []), body.roles?.judge, body.roles?.summarizer])
          if (!agents[id]) return json(res, 400, { error: '未知 agent: ' + id });
        const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
        const entry = { events: [], clients: new Set() };
        const committee = new Committee({
          topic: body.topic, materials: body.materials ?? '',
          agents: Object.fromEntries([...body.roles.debaters, body.roles.judge, body.roles.summarizer].map(x => [x, agents[x]])),
          roles: body.roles, template, mode: body.mode ?? 'manual',
          maxRounds: Math.min(Math.max(Number(body.maxRounds) || 4, 1), 10),
          baseDir: sessionsDir,
          emit: ev => {
            entry.events.push(ev);
            const line = `data: ${JSON.stringify(ev)}\n\n`;
            for (const c of entry.clients) c.write(line);
          },
        });
        entry.committee = committee;
        await committee.init();
        sessions.set(id, entry);
        return json(res, 200, { id });
      }
      const m = url.pathname.match(/^\/api\/sessions\/([a-z0-9]+)(\/([a-z-]+))?$/);
      if (m) {
        const entry = sessions.get(m[1]);
        if (!entry) return json(res, 404, { error: '会话不存在' });
        const c = entry.committee, action = m[3];
        if (!action && req.method === 'GET')
          return json(res, 200, { state: c.state, round: c.round, topic: c.topic, dir: c.dir });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readBody(req);
        const fire = fn => { fn().catch(e => c.emit({ type: 'error', data: String(e.message ?? e) })); return json(res, 200, { ok: true }); };
        switch (action) {
          case 'round': return fire(() => c.runNextRound());
          case 'auto': return fire(() => c.runAuto());
          case 'judge': return fire(() => c.runJudge());
          case 'retry': return fire(() => c.retrySide(body.agentId));
          case 'skip': return fire(() => c.skipSide(body.agentId));
          case 'interject': c.interject(String(body.text ?? '')); return json(res, 200, { ok: true });
          case 'stop': c.stopRound(); return json(res, 200, { ok: true });
          case 'save-partial': return fire(() => c.savePartial());
          case 'events': {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            for (const ev of entry.events) res.write(`data: ${JSON.stringify(ev)}\n\n`); // 回放缓冲
            entry.clients.add(res);
            req.on('close', () => entry.clients.delete(res));
            return;
          }
          default: return json(res, 404, { error: '未知操作: ' + action });
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e.message ?? e) });
    }
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port: server.address().port, close: () => server.close(), sessions };
}

// 直接运行时启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/server.js')) {
  const { port } = await startServer({ port: Number(process.env.PORT) || 7777 });
  console.log(`Roundtable 已启动: http://127.0.0.1:${port}`);
}
```

注意：`events` action 是 GET 语义但上面统一走了 POST 检查——把 `if (req.method !== 'POST')` 检查移到 switch 之后、对 `events` 单独放行 GET：
```js
        if (action === 'events' && req.method === 'GET') { /* SSE 分支代码 */ }
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
```
（实现时按此顺序组织，测试里 events 用 GET 访问。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/server.test.js`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: HTTP API + SSE（事件缓冲回放，127.0.0.1 only）"
```

---

### Task 10: 前端三栏界面

**Files:**
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `public/style.css`

**Interfaces:**
- Consumes: Task 9 的全部 HTTP API 与 SSE 事件（`chunk / agent-status / round-done / summary / judge-card / error / state`）
- Produces: 浏览器 UI。**所有模型输出用 textContent 或转义后插入，绝不 innerHTML 未转义内容**

功能清单（全部必做）：
1. 顶栏：模板下拉、辩手 A/B 下拉、judge 下拉、summarizer 下拉（选项来自 `/api/config`，按 roles 过滤）、最大轮数输入（1-10，默认 4）
2. 新建会话表单：议题 textarea + 背景材料 textarea + 「开始第 1 轮」按钮
3. 三栏主体：左=辩手A流、右=辩手B流（按轮分节，流式追加 chunk）、中=主持席（rolling summary 渲染、插话输入框、按钮组：下一轮/自动跑完/停止/进入裁决/保存半成品；每个辩手栏头部有 重试/跳过 按钮与状态徽标）
4. 裁决卡：judge-card 事件后在中栏高亮展示 + 「复制」按钮
5. 状态条：state 事件驱动（running 时旋转指示，error 时红条显示错误与建议——auth 错误提示"请在终端重新登录后点重试"）
6. 深浅色：`prefers-color-scheme` media query

- [ ] **Step 1: 写三个文件**

`public/index.html`:
```html
<meta charset="utf-8">
<title>Roundtable 决策委员会</title>
<link rel="stylesheet" href="/style.css">
<header id="topbar">
  <strong>Roundtable</strong>
  <label>模板 <select id="tpl"></select></label>
  <label>辩手A <select id="debA"></select></label>
  <label>辩手B <select id="debB"></select></label>
  <label>仲裁 <select id="judge"></select></label>
  <label>书记 <select id="summ"></select></label>
  <label>最大轮数 <input id="maxR" type="number" min="1" max="10" value="4"></label>
</header>
<section id="setup">
  <textarea id="topic" placeholder="议题：要决策什么？"></textarea>
  <textarea id="materials" placeholder="背景材料（可选）"></textarea>
  <button id="start">开始第 1 轮（clean room）</button>
</section>
<main id="arena" hidden>
  <div class="col" id="colA"><h2><span class="name"></span> <span class="badge"></span>
    <button class="retry">重试</button><button class="skip">跳过</button></h2><div class="feed"></div></div>
  <div class="col mid">
    <div id="statebar"></div>
    <div id="summary"></div>
    <div id="judgecard" hidden><h3>裁决卡</h3><pre></pre><button id="copycard">复制</button></div>
    <textarea id="note" placeholder="主持人插话（进入下一轮双方简报）"></textarea>
    <div id="controls">
      <button id="next">下一轮</button><button id="auto">自动跑完</button>
      <button id="stop">停止当前轮</button><button id="dojudge">进入裁决</button>
      <button id="partial">保存半成品</button>
    </div>
  </div>
  <div class="col" id="colB"><h2><span class="name"></span> <span class="badge"></span>
    <button class="retry">重试</button><button class="skip">跳过</button></h2><div class="feed"></div></div>
</main>
<script src="/app.js"></script>
```

`public/app.js`（核心逻辑，完整实现）:
```js
const $ = s => document.querySelector(s);
let cfg, sid, sideOf = {}; // agentId -> 'A' | 'B'

async function boot() {
  cfg = await (await fetch('/api/config')).json();
  const opts = role => Object.entries(cfg.agents)
    .filter(([, a]) => a.roles.includes(role))
    .map(([id, a]) => `<option value="${id}">${a.name}</option>`).join('');
  $('#debA').innerHTML = opts('debater');
  $('#debB').innerHTML = opts('debater');
  if ($('#debB').options.length > 1) $('#debB').selectedIndex = 1;
  $('#judge').innerHTML = opts('judge');
  $('#summ').innerHTML = opts('summarizer');
  $('#tpl').innerHTML = Object.entries(cfg.templates).map(([n, t]) => `<option value="${n}">${t.title}</option>`).join('');
}

function feed(side) { return $(side === 'A' ? '#colA .feed' : '#colB .feed'); }
function badge(side) { return $(side === 'A' ? '#colA .badge' : '#colB .badge'); }
let roundDivs = {};

function ensureRoundDiv(side, label) {
  const key = side + label;
  if (!roundDivs[key]) {
    const d = document.createElement('div');
    d.className = 'round';
    d.innerHTML = `<h4>${label}</h4><pre></pre>`;
    feed(side).appendChild(d);
    roundDivs[key] = d.querySelector('pre');
  }
  return roundDivs[key];
}

let currentRound = 1;
function onEvent(ev) {
  if (ev.type === 'chunk') {
    const side = sideOf[ev.agentId];
    if (!side) return; // summarizer/judge 的流不进辩手栏
    const pre = ensureRoundDiv(side, '第 ' + currentRound + ' 轮');
    pre.textContent += ev.data;             // textContent：天然防 XSS
    pre.scrollIntoView({ block: 'end' });
  }
  if (ev.type === 'agent-status' && sideOf[ev.agentId]) badge(sideOf[ev.agentId]).textContent = ev.data;
  if (ev.type === 'summary') { $('#summary').textContent = ev.data; }
  if (ev.type === 'round-done') { currentRound = ev.round + 1; setStatebar('第 ' + ev.round + ' 轮结束——可插话后继续'); }
  if (ev.type === 'state') setStatebar('状态: ' + ev.data);
  if (ev.type === 'error') setStatebar('错误: ' + ev.data + (ev.data === 'auth' ? '（请在终端重新登录该 CLI 后点「重试」）' : ''), true);
  if (ev.type === 'judge-card') { $('#judgecard').hidden = false; $('#judgecard pre').textContent = ev.data; }
}
function setStatebar(msg, isErr) { const b = $('#statebar'); b.textContent = msg; b.classList.toggle('err', !!isErr); }

const api = (action, body) => fetch(`/api/sessions/${sid}/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

async function sendNote() {
  const t = $('#note').value.trim();
  if (t) { await api('interject', { text: t }); $('#note').value = ''; }
}

$('#start').onclick = async () => {
  const roles = { debaters: [$('#debA').value, $('#debB').value], judge: $('#judge').value, summarizer: $('#summ').value };
  if (roles.debaters[0] === roles.debaters[1]) return setStatebar('两个辩手不能是同一个 agent', true);
  const r = await (await fetch('/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: $('#topic').value, materials: $('#materials').value, template: $('#tpl').value, roles, mode: 'manual', maxRounds: Number($('#maxR').value) }),
  })).json();
  if (r.error) return setStatebar(r.error, true);
  sid = r.id;
  sideOf = { [roles.debaters[0]]: 'A', [roles.debaters[1]]: 'B' };
  $('#colA .name').textContent = cfg.agents[roles.debaters[0]].name;
  $('#colB .name').textContent = cfg.agents[roles.debaters[1]].name;
  $('#setup').hidden = true; $('#arena').hidden = false;
  new EventSource(`/api/sessions/${sid}/events`).onmessage = e => onEvent(JSON.parse(e.data));
  await api('round');
};
$('#next').onclick = async () => { await sendNote(); await api('round'); };
$('#auto').onclick = async () => { await sendNote(); await api('auto'); };
$('#stop').onclick = () => api('stop');
$('#dojudge').onclick = () => api('judge');
$('#partial').onclick = () => api('save-partial');
$('#copycard').onclick = () => navigator.clipboard.writeText($('#judgecard pre').textContent);
for (const [sel, side] of [['#colA', 'A'], ['#colB', 'B']]) {
  $(sel + ' .retry').onclick = () => api('retry', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
  $(sel + ' .skip').onclick = () => api('skip', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
}
boot();
```

`public/style.css`（要点：三栏 grid、深浅色、错误红条；完整写出）:
```css
:root { --bg:#fff; --fg:#1a1a1a; --line:#ddd; --accent:#2563eb; --err:#dc2626; }
@media (prefers-color-scheme: dark) { :root { --bg:#111417; --fg:#e5e7eb; --line:#2d333b; --accent:#60a5fa; --err:#f87171; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 system-ui, "Microsoft YaHei", sans-serif; }
#topbar { display:flex; gap:12px; flex-wrap:wrap; align-items:center; padding:8px 12px; border-bottom:1px solid var(--line); }
#topbar input, #topbar select, textarea, button { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 8px; }
#setup { max-width:760px; margin:24px auto; display:grid; gap:12px; padding:0 12px; }
#setup textarea { min-height:90px; }
button { cursor:pointer; } button:hover { border-color:var(--accent); }
#arena { display:grid; grid-template-columns:1fr 1fr 1fr; gap:0; height:calc(100vh - 50px); }
.col { overflow-y:auto; padding:10px; border-right:1px solid var(--line); }
.col h2 { font-size:15px; position:sticky; top:0; background:var(--bg); padding:4px 0; }
.badge { font-size:12px; color:var(--accent); }
.round pre, #judgecard pre { white-space:pre-wrap; word-break:break-word; background:color-mix(in srgb, var(--fg) 4%, var(--bg)); padding:8px; border-radius:8px; }
.mid #summary { white-space:pre-wrap; font-size:13px; }
#statebar { padding:6px 8px; border-radius:6px; margin-bottom:8px; background:color-mix(in srgb, var(--accent) 12%, var(--bg)); }
#statebar.err { background:color-mix(in srgb, var(--err) 15%, var(--bg)); color:var(--err); }
#note { width:100%; min-height:60px; margin:8px 0; }
#controls { display:flex; gap:6px; flex-wrap:wrap; }
#judgecard { border:2px solid var(--accent); border-radius:10px; padding:10px; margin:10px 0; }
```

- [ ] **Step 2: 手动验证（mock 全流程）**

```bash
npm start
```
浏览器打开 `http://127.0.0.1:7777`：用 MockA/MockB 建会话（议题随意）→ 确认三栏出现第 1 轮回显、中栏出现 summary → 插话后点下一轮 → 确认第 2 轮辩手栏含插话内容 → 点进入裁决 → 裁决卡出现且可复制 → 检查 `sessions/<今天>-*/` 目录结构齐全（problem/prompts/raw/summaries/disagreements/judge-card/metadata/session.md）。

- [ ] **Step 3: Commit**

```bash
git add public/
git commit -m "feat: 三栏前端（流式渲染/主持控制/裁决卡/深浅色）"
```

---

### Task 11: 真实 CLI 接入（claude 冒烟 + codex 预置）

**Files:**
- Modify: `adapters/agents.json`
- Create: `scripts/smoke.js`（单 agent 冒烟脚本）

**Interfaces:**
- Consumes: `runAgent`
- Produces: agents.json 增加 `claude` 与 `codex` 条目；`node scripts/smoke.js <agentId>` 对单个 agent 发一条测试 prompt 并打印结果

- [ ] **Step 1: 实测验证 claude CLI 旗标**

```bash
claude --help
```
逐项确认（以实际输出为准，与下面预设不符时修正 agents.json 并在 README 记录）：
- `-p/--print` 非交互输出模式
- `--output-format stream-json` 是否需要搭配 `--verbose`
- 禁用工具的准确旗标（候选：`--disallowedTools`；若支持通配符则用之，否则逐个列出 `Bash,Edit,Write,WebFetch,WebSearch` 等）

```bash
codex --help 2>$null; codex exec --help 2>$null
```
- codex 未安装则跳过（条目仍写入，`"pending": true` 标记），装好后删除该标记即可
- 确认 `--sandbox read-only` 与是否存在 `--ephemeral`/等效旗标

- [ ] **Step 2: 写冒烟脚本**

`scripts/smoke.js`:
```js
import { readFile } from 'node:fs/promises';
import { runAgent } from '../src/runner.js';

const id = process.argv[2];
const agents = JSON.parse(await readFile('adapters/agents.json', 'utf8'));
if (!agents[id]) { console.error('未知 agent:', id, '可选:', Object.keys(agents).join(', ')); process.exit(1); }
console.log(`[smoke] 调用 ${id} ...`);
const r = await runAgent(agents[id], '请只回答一句话：1+1 等于几？');
console.log(JSON.stringify({ ok: r.ok, error: r.error, exitCode: r.exitCode, durationMs: r.durationMs }, null, 2));
console.log('--- text ---\n' + r.text.slice(0, 500));
process.exit(r.ok ? 0 : 1);
```

- [ ] **Step 3: 更新 agents.json（以 Step 1 实测修正）**

在现有 mock 条目基础上追加：
```json
{
  "claude": {
    "name": "Claude",
    "command": ["claude", "-p", "--output-format", "stream-json", "--verbose", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Glob,Grep,Read,Task"],
    "input": "stdin",
    "output": "stream-json",
    "timeoutMs": 300000,
    "envWhitelist": ["PATH", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP"],
    "cwd": "workdir",
    "roles": ["debater", "judge", "summarizer"]
  },
  "codex": {
    "name": "Codex",
    "command": ["codex", "exec", "--sandbox", "read-only"],
    "input": "stdin",
    "output": "text",
    "timeoutMs": 300000,
    "envWhitelist": ["PATH", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP"],
    "cwd": "workdir",
    "roles": ["debater", "judge", "summarizer"],
    "pending": true
  }
}
```
注意 Windows 下 spawn 外部 `.cmd` 包装器（npm 全局装的 claude/codex 是 .cmd）：`spawn('claude', ...)` 在 `shell:false` 时可能报 ENOENT——实测若失败，将 command[0] 改为绝对路径（`where claude` 的 `.cmd` 全路径）并用 `spawn` 的 `{shell:false}` + `.cmd` 需要 `windowsVerbatimArguments` 或改 `['cmd','/c','claude',...]` 方案；**以实测通过为准，把最终可用形态写进 README 与 agents.json**。

- [ ] **Step 4: claude 冒烟**

```bash
node scripts/smoke.js claude
```
Expected: `ok: true`，text 含"2"。若 codex 已装：`node scripts/smoke.js codex` 同样验证。

- [ ] **Step 5: Commit**

```bash
git add adapters/agents.json scripts/smoke.js
git commit -m "feat: 真实 CLI adapter 配置与冒烟脚本（claude 已验证，codex 待装）"
```

---

### Task 12: 南添决策日志联动 + README

**Files:**
- Modify: `src/orchestrator.js`（runJudge 内加 copyJudgeCardTo 落盘）
- Test: `test/orchestrator.test.js`（追加 1 个用例）
- Create: `README.md`

**Interfaces:**
- Consumes: `Template.copyJudgeCardTo`（Task 5）、`expandHome`（Task 5）
- Produces: 模板配置了 `copyJudgeCardTo` 时，裁决卡额外落盘一份到该目录（文件名 `<日期>-<slug>.md`，目录不存在则递归创建）

- [ ] **Step 1: 写失败测试**

`test/orchestrator.test.js` 追加：
```js
test('copyJudgeCardTo：裁决卡额外落盘到指定目录', async () => {
  const extra = mkdtempSync(path.join(tmpdir(), 'rt-decisions-'));
  const { c } = makeCommittee({
    template: { name: 'x', injections: {}, debaterFormat: '', judgeFormat: '', copyJudgeCardTo: extra },
  });
  await c.init();
  await c.runNextRound();
  await c.runJudge();
  const files = readdirSync(extra);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.md$/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/orchestrator.test.js`
Expected: 新增用例 FAIL

- [ ] **Step 3: 实现**

`src/orchestrator.js` 顶部加 import：
```js
import { expandHome } from './templates.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redact } from './redactor.js';
```
`runJudge` 中 `saveJudgeCard` 之后追加：
```js
      if (this.template.copyJudgeCardTo) {
        const dest = expandHome(this.template.copyJudgeCardTo);
        await mkdir(dest, { recursive: true });
        const name = path.basename(this.dir) + '.md';
        await writeFile(path.join(dest, name), redact(`# 裁决卡：${this.topic}\n\n来源会话：${this.dir}\n\n${r.text}`), 'utf8');
      }
```

- [ ] **Step 4: 跑全部测试**

Run: `node --test test/`
Expected: 全部 PASS

- [ ] **Step 5: 写 README**

`README.md` 内容（完整写出）：
```markdown
# Roundtable 多智能体决策委员会

独立判断 → 交叉质询 → 分歧分类 → 证据仲裁 → 最小下一步。

## 启动
npm start 后打开 http://127.0.0.1:7777

## 前提
- Node ≥ 20
- claude CLI 已登录（claude -p "hi" 能出结果）
- codex CLI 已登录（npm i -g @openai/codex；未装时可用 Mock 或单边模式）

## 添加新 agent（Gemini / 本地模型 / 任意 CLI）
编辑 adapters/agents.json 增加条目：command 为 argv 数组，input 选 stdin 或 file
（file 模式用 {PROMPT_FILE} 占位符），output 选 text/json/stream-json，
envWhitelist 只列该 CLI 必需的环境变量。跑 node scripts/smoke.js <id> 验证。

## 模板
templates/<name>/template.json。nantian 模板会把两边各自蒸馏的南添 skill 注入
对应辩手，并把裁决卡额外存一份到 ~/.claude/skills/nantian-decision/decisions/。

## 安全
子进程只拿到白名单环境变量；所有落盘经凭据擦除；模型输出只作为文本展示，
永不执行；服务只监听 127.0.0.1。

## 已知事项
- Windows 下若 spawn 报 ENOENT，把 agents.json 里 command[0] 换成 where <cli>
  输出的完整 .cmd 路径（见 Task 11 注记 / 本文件历史）。
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: 裁决卡联动南添决策日志 + README"
```

---

## Self-Review 记录

**Spec 覆盖检查**（spec 章节 → 任务）：§2 架构→T1/T9；§3 adapter 插拔→T1/T2/T11；§4 角色模型（judge 独立）→T4/T7；§5 状态机+clean room+人工主持→T7/T8/T9/T10；§6 分歧分类器→T4（summarizer prompt 五类+处置规则）/T8（收敛判定）；§7 错误处理→T2（超时/auth/崩溃检测）/T8（重试/跳过/停止/半成品）/T10（UI 呈现）；§8 安全→T1（env 白名单）/T3（redaction）/T9（127.0.0.1、静态白名单）/T10（textContent 防 XSS）/T11（read-only/禁工具）；§9 模板→T5/T12（copyJudgeCardTo）；§10 前端→T10；§11 可复盘持久化→T6（目录结构/metadata/session.md）；§12 测试→各任务 TDD + mock CLI；§13 里程碑→M1=T1-8、M2=T11、M3=T9-10、M4=T5/T12。

**已知偏差（有意为之）**：spec §11 的 metadata「每次调用的耗时与退出码」在 errors 数组与 raw 文件头部体现，未做逐调用完整台账——runner 返回值已含 durationMs/exitCode，若需要完整台账在 call() 中追加即可，YAGNI 先不做。spec §10「会话列表」延后：MVP 单会话流程完整，列表页在 sessions/ 目录已可人工浏览，UI 列表作为后续增强。

**类型一致性检查**：`runAgent` 返回 `{ok,text,raw,stderr,exitCode,error,durationMs}` 在 T2/T7/T11 一致；`Committee` 的 emit 事件 type 集合与 T9 SSE、T10 前端 onEvent 一致；`Template` 字段在 T5/T7/T12 一致；store 函数签名在 T6/T7/T8/T12 一致；mock-cli 统一为 `.cjs`（T2 起，T7/T8 测试引用一致）。
