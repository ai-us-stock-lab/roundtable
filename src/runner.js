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
