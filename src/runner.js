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
      child = spawn(argv[0], argv.slice(1), {
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
