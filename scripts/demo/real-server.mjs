import { readdir, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR, WORK_DIR } from './config.mjs';
import { run } from './lib.mjs';

async function ensurePortFree(hostname, port) {
  const free = await new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, hostname, () => probe.close(() => resolve(true)));
  });
  if (!free) throw new Error(`临时真实服务端口 ${port} 已被占用；请用 --url http://127.0.0.1:<空闲端口>`);
}

export async function findRunnableCodexCli() {
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  let entries = [];
  try { entries = await readdir(base, { withFileTypes: true }); } catch { /* handled below */ }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(base, entry.name, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try {
      const info = await stat(candidate);
      candidates.push({ path: candidate, mtimeMs: info.mtimeMs });
    } catch { /* missing candidate */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    try {
      const result = await run(candidate.path, ['--version'], { timeoutMs: 15_000 });
      if (result.code === 0) return { path: candidate.path, version: result.stdout.trim() };
    } catch { /* protected or broken candidate; try older version */ }
  }
  throw new Error('未找到可由 Roundtable 子进程启动的用户目录 Codex CLI；不会使用受保护的 WindowsApps 副本');
}

export async function startRealDemoServer(url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('--isolated-server 只允许绑定本机回环地址');
  }
  const port = Number(parsed.port || 80);
  await ensurePortFree(parsed.hostname, port);
  const codex = await findRunnableCodexCli();
  const previousOverride = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = codex.path; // 仅当前 Node 进程及子进程；关闭时恢复。

  const sessionsDir = path.join(WORK_DIR, 'real-sessions');
  await rm(sessionsDir, { recursive: true, force: true });
  const originalCwd = process.cwd();
  process.chdir(ROOT_DIR);
  let server;
  try {
    const { startServer } = await import(pathToFileURL(path.join(ROOT_DIR, 'src', 'server.js')).href);
    server = await startServer({
      port,
      agentsFile: path.join(ROOT_DIR, 'adapters', 'agents.json'),
      templatesDir: path.join(ROOT_DIR, 'templates'),
      sessionsDir,
    });
  } catch (error) {
    process.chdir(originalCwd);
    if (previousOverride === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previousOverride;
    throw error;
  }
  console.log(`[real-server] 临时真实服务：${url}`);
  console.log(`[real-server] Codex：${codex.version}（进程级覆盖，退出即恢复）`);
  return {
    ...server,
    close: () => {
      server.close();
      process.chdir(originalCwd);
      if (previousOverride === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousOverride;
    },
  };
}
