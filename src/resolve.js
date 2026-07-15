import { existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const expandHome = p => (p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);

// Windows 下只按 PATHEXT 逐一探测（不含裸文件名——npm 全局安装同时会在同目录放一个无扩展名的
// POSIX sh 包装脚本，供 git-bash/WSL 用；Windows CreateProcess 无法直接执行它，误配会导致 spawn 失败）；
// 非 Windows 按原名探测
function findOnPath(name) {
  const win = process.platform === 'win32';
  const exts = win ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext.toLowerCase());
      if (existsSync(full)) return full;
    }
  }
  return null;
}

// 简易 glob：只支持一层 `*` 目录通配（形如 .../bin/*/codex.exe），取 mtime 最新
function globNewest(pattern) {
  const norm = expandHome(pattern).replaceAll('\\', '/');
  const star = norm.indexOf('/*/');
  if (star === -1) return existsSync(norm) ? norm : null;
  const base = norm.slice(0, star), rest = norm.slice(star + 3);
  if (!existsSync(base)) return null;
  let best = null, bestT = 0;
  for (const d of readdirSync(base)) {
    const cand = path.join(base, d, rest);
    if (!existsSync(cand)) continue;
    const t = statSync(cand).mtimeMs;
    if (t > bestT) { bestT = t; best = cand; }
  }
  return best;
}

// 按优先级解析 CLI 可执行文件路径：①专属环境变量 ②绝对路径直用 ③PATH+PATHEXT ④版本哈希目录 glob 取最新 mtime ⑤抛带安装指引的错误
export function resolveCliPath(cfg) {
  const name = expandHome(cfg.command[0]); // command[0] 支持 ~/ 前缀，跨机器可移植
  if (cfg.commandEnvVar) {
    const p = process.env[cfg.commandEnvVar];
    if (p && existsSync(p)) return p;
  }
  if (path.isAbsolute(name) && existsSync(name)) return name;
  const onPath = findOnPath(name);
  if (onPath) return onPath;
  if (cfg.commandFallbackGlob) {
    const g = globNewest(cfg.commandFallbackGlob);
    if (g) return g;
  }
  throw new Error(`未找到 CLI「${name}」。请安装它，或设置环境变量 ${cfg.commandEnvVar ?? '（未配置）'}，或在 adapters/agents.json 中把 command[0] 写为绝对路径。`);
}
