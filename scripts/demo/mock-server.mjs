import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT_DIR, WORK_DIR } from './config.mjs';

export async function startMockServer(url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('--mock 只允许绑定本机回环地址');
  }
  const port = Number(parsed.port || 80);
  const portFree = await new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, parsed.hostname, () => probe.close(() => resolve(true)));
  });
  if (!portFree) throw new Error(`mock 端口 ${port} 已被占用；可用 --url http://127.0.0.1:<空闲端口> 指定其他端口`);
  const sessionsDir = path.join(WORK_DIR, 'mock-sessions');
  const agentsFile = path.join(WORK_DIR, 'mock-agents.json');
  await rm(sessionsDir, { recursive: true, force: true });
  await mkdir(sessionsDir, { recursive: true });

  const cliPath = fileURLToPath(new URL('./mock-cli.cjs', import.meta.url));
  const common = {
    input: 'stdin',
    output: 'text',
    timeoutMs: 30_000,
    envWhitelist: ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP'],
    cwd: ROOT_DIR,
    roles: ['debater', 'judge', 'summarizer'],
  };
  const agents = {
    claude: {
      ...common,
      name: 'Claude',
      command: [process.execPath, cliPath, 'claude'],
    },
    codex: {
      ...common,
      name: 'Codex',
      command: [process.execPath, cliPath, 'codex'],
      writeArgs: [cliPath, 'codex'],
    },
  };
  await writeFile(agentsFile, JSON.stringify(agents, null, 2), 'utf8');

  const { startServer } = await import(pathToFileURL(path.join(ROOT_DIR, 'src', 'server.js')).href);
  // server.js 的静态白名单按进程 cwd 读取 public/*；npm --prefix 会把 cwd 设为本目录。
  // mock 生命周期内切回仓库根，关闭后恢复，避免 7778 只起 API 却打不开真实 UI。
  const originalCwd = process.cwd();
  process.chdir(ROOT_DIR);
  let server;
  try {
    server = await startServer({
      port,
      agentsFile,
      templatesDir: path.join(ROOT_DIR, 'templates'),
      sessionsDir,
    });
  } catch (error) {
    process.chdir(originalCwd);
    throw error;
  }
  console.log(`[mock] 固定回复服务已启动：${url}`);
  return {
    ...server,
    close: () => {
      server.close();
      process.chdir(originalCwd);
    },
  };
}
