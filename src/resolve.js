import { existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

export const expandHome = p => (p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);

// Windows 商店分发（WindowsApps）里的 exe 常是执行别名/重解析点，Node 子进程 spawn 会 EPERM——
// 文件存在 ≠ 可被 Node 启动。这类候选降到最低优先级（真实可用的用户目录版排前面）。
const isWindowsApps = p => /[\\/]WindowsApps[\\/]/i.test(p);

// 返回 PATH 上所有命中（不止第一个），按 PATH 顺序。Windows 只按 PATHEXT 探测（不含裸文件名——
// npm 全局装会放一个无扩展名的 POSIX sh 包装脚本，Windows CreateProcess 无法直接执行）。
function findAllOnPath(name) {
  const win = process.platform === 'win32';
  const exts = win ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const out = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext.toLowerCase());
      if (existsSync(full) && !out.includes(full)) out.push(full);
    }
  }
  return out;
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

// 探测候选能否被 Node 子进程真正启动：spawn `--version`。
// - 进程起来了（无论退出码是否为 0、无论 --version 是否被识别、乃至超时被杀）→ 可用
// - spawn 层错误（EPERM/EACCES/ENOENT）→ 不可用（正是 WindowsApps 别名的 EPERM 场景）
export function canSpawn(file) {
  try {
    const isShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    const [cmd, args] = isShim ? [process.env.COMSPEC ?? 'cmd.exe', ['/c', file, '--version']] : [file, ['--version']];
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 6000, windowsHide: true });
    return true; // 退出码 0
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOENT', 'UNKNOWN'].includes(e.code)) return false; // spawn 起不来
    if (typeof e.status === 'number') return true; // 有退出码 = 进程确实启动了（只是 --version 非 0）
    if (e.signal || e.code === 'ETIMEDOUT') return true; // 超时被杀 = 进程起来了
    return false;
  }
}

// 按优先级收集候选路径（去重，保留最高优先级位置）。纯路径逻辑，可独立测。
export function collectCandidates(cfg, { env = process.env } = {}) {
  const name = expandHome(cfg.command[0]); // command[0] 支持 ~/ 前缀
  const cands = [];
  const add = p => { if (p && existsSync(p) && !cands.includes(p)) cands.push(p); };
  if (cfg.commandEnvVar && env[cfg.commandEnvVar]) add(env[cfg.commandEnvVar]); // ① 专属环境变量最优先
  if (path.isAbsolute(name)) add(name);                                          // ② 绝对路径
  const onPath = findAllOnPath(name);
  for (const p of onPath) if (!isWindowsApps(p)) add(p);                         // ③ PATH 命中（非 WindowsApps）
  if (cfg.commandFallbackGlob) add(globNewest(cfg.commandFallbackGlob));         // ④ 版本目录 glob
  for (const p of onPath) if (isWindowsApps(p)) add(p);                          // ⑤ WindowsApps（降到最低）
  return cands;
}

const redactHome = p => p.replaceAll(homedir(), '~');

// 解析 CLI 可执行路径：收集候选 → 逐个验证能否 spawn → 返回第一个可用。
// 正常情况（唯一非 WindowsApps 候选）走快路径不探测，零启动开销。
export function resolveCliPath(cfg, { probe = canSpawn } = {}) {
  const cands = collectCandidates(cfg);
  const name = expandHome(cfg.command[0]);
  if (cands.length === 0) {
    throw new Error(`未找到 CLI「${name}」。请安装它，或设置环境变量 ${cfg.commandEnvVar ?? '（未配置）'}，或在 adapters/agents.json 中把 command[0] 写为绝对路径。`);
  }
  // 快路径：唯一候选且不在 WindowsApps → 直接用（不为正常 agent 增加探测开销）
  if (cands.length === 1 && !isWindowsApps(cands[0])) return cands[0];
  // 多候选 / 唯一候选在 WindowsApps → 逐个探测能否真正启动
  for (const c of cands) if (probe(c)) return c;
  throw new Error(
    `找到了「${name}」的候选但都无法被 Node 启动（如 WindowsApps 别名会 EPERM）：\n` +
    cands.map(c => '  - ' + redactHome(c)).join('\n') +
    `\n请设置环境变量 ${cfg.commandEnvVar ?? '（未配置）'} 指向真实可执行文件，或在 adapters/agents.json 中把 command[0] 写为绝对路径。`
  );
}
