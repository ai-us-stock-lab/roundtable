import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 只把白名单内的变量传给子进程——API key 等敏感变量默认全部隔离
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

// 从 stream-json 单行事件中提取可展示的助手文本（claude 的 assistant 事件）。
// system/init/result 等内部事件返回空串——它们不该出现在用户眼前的发言栏里。
export function extractChunkText(line) {
  const t = line.trim();
  if (!t.startsWith('{')) return '';
  try {
    const ev = JSON.parse(t);
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      return ev.message.content.filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('');
    }
  } catch { /* 半行/坏行忽略，等缓冲齐 */ }
  return '';
}

// 按 adapter 配置的正则逐行过滤输出（如 hermes 的 "session_id: xxx" 前缀行）
function applyDropLines(text, dropLines) {
  if (!dropLines?.length) return text;
  const patterns = dropLines.map(p => new RegExp(p));
  return text.split('\n').filter(l => !patterns.some(re => re.test(l))).join('\n').trim();
}

const AUTH_RE = /log ?in|auth|401|unauthorized|credential|expired/i;

export async function runAgent(cfg, prompt, opts = {}) {
  const started = Date.now();
  let argv = [...cfg.command];
  let tmpDir = null;
  // {NONCE}：每次调用生成唯一串。用于要求"每次调用都是全新会话"的 CLI
  //（如 openclaw 的 --session-key roundtable-{NONCE}），保证 clean room 无记忆。
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  argv = argv.map(a => (typeof a === 'string' ? a.replaceAll('{NONCE}', nonce) : a));
  if (cfg.input === 'file') {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'roundtable-'));
    const f = path.join(tmpDir, 'prompt.md');
    writeFileSync(f, prompt, 'utf8');
    if (argv.includes('{PROMPT_FILE}')) argv = argv.map(a => (a === '{PROMPT_FILE}' ? f : a));
    else argv.push(f);
  }
  if (cfg.input === 'arg') {
    // prompt 直接进 argv 的 CLI（openclaw -m / hermes -q）。Windows 命令行总长上限
    // 约 32767 字符，超限前显式报错，避免截断或诡异失败。
    if (process.platform === 'win32' && argv.join(' ').length + prompt.length > 30000) {
      return { ok: false, error: 'prompt-too-long', text: '', raw: '', stderr: '', exitCode: null, durationMs: Date.now() - started };
    }
    if (argv.includes('{PROMPT}')) argv = argv.map(a => (a === '{PROMPT}' ? prompt : a));
    else argv.push(prompt);
  }
  return await new Promise(resolve => {
    let out = '', err = '', settled = false;
    let timer;
    let onAbort;
    const cleanup = () => { if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
    const finish = r => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      cleanup();
      resolve({ raw: out, stderr: err, durationMs: Date.now() - started, ...r });
    };
    let child;
    try {
      // win32 下 .cmd/.bat 不能被 CreateProcess 直接执行（不是真正的 PE），
      // 需要在 spawn 时刻动态包一层 cmd /c；argv 仍是数组、shell 仍为 false，
      // prompt 仍走 stdin——不引入 shell 注入面。
      const isWinShimScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(argv[0] ?? '');
      const [file, args] = isWinShimScript
        ? [process.env.COMSPEC ?? 'cmd.exe', ['/c', ...argv]]
        : [argv[0], argv.slice(1)];
      child = spawn(file, args, {
        env: buildEnv(cfg.envWhitelist),
        cwd: cfg.cwd,
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      return finish({ ok: false, error: 'spawn:' + (e.code ?? e.message), text: '', exitCode: null });
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'timeout', text: out, exitCode: null });
    }, cfg.timeoutMs);
    onAbort = () => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'aborted', text: out, exitCode: null });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    // 按输出模式决定推给前端什么：text 原样流式；stream-json 逐行解析只推助手文本；
    // json 不推中间流（整体是一份 JSON，中间片段对人无意义，最终结果由 text 呈现）。
    let lineBuf = '';
    child.stdout.on('data', d => {
      const s = d.toString();
      out += s;
      if (!opts.onChunk) return;
      if (cfg.output === 'stream-json') {
        lineBuf += s;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) {
          const text = extractChunkText(line);
          if (text) opts.onChunk(text);
        }
      } else if (cfg.output !== 'json') {
        opts.onChunk(s);
      }
    });
    child.stderr.on('data', d => (err += d.toString()));
    child.on('error', e => finish({ ok: false, error: 'spawn:' + (e.code ?? e.message), text: out, exitCode: null }));
    child.on('close', code => {
      if (code !== 0) {
        const auth = AUTH_RE.test(err + out);
        return finish({ ok: false, error: auth ? 'auth' : 'exit:' + code, text: out, exitCode: code });
      }
      finish({ ok: true, text: applyDropLines(parseOutput(cfg.output, out), cfg.dropLines), exitCode: 0 });
    });
    // 子进程未读完 stdin 即退出时会在 stdin 侧 emit 'error'（EPIPE/EOF）；
    // 不监听会作为未捕获异常崩溃整个进程。这里吞掉——进程退出本身已由
    // 上面的 close 处理器归类为 exit/auth 错误，无需在这里重复处理。
    child.stdin.on('error', () => {});
    if (cfg.input === 'stdin') child.stdin.write(prompt);
    child.stdin.end();
  });
}
