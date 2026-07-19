import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 全部走 argv 数组 + 无 shell——与 runner 同一条安全底线
const git = (cwd, ...args) => new Promise((resolve, reject) => {
  // core.quotepath=false：非 ASCII 路径（中文文件名）按原始 UTF-8 输出，不转义成 "\346..." 引号形式
  execFile('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message).trim().slice(0, 500)));
    else resolve(stdout);
  });
});

export async function isGitRepo(dir) {
  try { return (await git(dir, 'rev-parse', '--is-inside-work-tree')).trim() === 'true'; }
  catch { return false; }
}

// 建隔离副本（detached HEAD，不产生分支）；副本放系统临时目录，主仓库零接触
export async function createWorktree(repoDir) {
  const wt = await mkdtemp(path.join(tmpdir(), 'roundtable-wt-'));
  // mkdtemp 已建目录，git worktree add 要求目标不存在——先删掉空目录再交给 git
  await rm(wt, { recursive: true, force: true });
  await git(repoDir, 'worktree', 'add', '--detach', wt);
  return wt;
}

// 让副本继承主工作区的未提交状态（已改未提交的文件 + 未跟踪的新文件），
// 然后在副本内打一个基线提交（detached HEAD 本地提交，销毁副本后自然回收，绝不触碰主仓库分支）。
// 之后 captureDiff 相对基线比较——agent 的 diff 只含它自己的增量，不会把用户未提交的改动重复打包。
export async function syncWorktreeWithMain(repoDir, wtDir) {
  let changed = false;
  const diff = await git(repoDir, 'diff', 'HEAD', '--binary');
  if (diff.trim()) {
    const f = path.join(await mkdtemp(path.join(tmpdir(), 'roundtable-sync-')), 'sync.patch');
    await writeFile(f, diff, 'utf8');
    try { await git(wtDir, 'apply', '--binary', f); changed = true; }
    finally { await rm(path.dirname(f), { recursive: true, force: true }).catch(() => {}); }
  }
  const untracked = (await git(repoDir, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean);
  for (const rel of untracked) {
    const dest = path.join(wtDir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(repoDir, rel), dest);
    changed = true;
  }
  if (changed) {
    await git(wtDir, 'add', '-A');
    await git(wtDir, '-c', 'user.email=roundtable@local', '-c', 'user.name=roundtable', 'commit', '--no-verify', '-m', 'roundtable-baseline');
  }
  return changed;
}

// 捕获副本里的全部改动（含新增/删除文件与二进制）为 patch 文本 + 变更统计。
// 副本有独立 index，这里的 add 不影响主仓库。
export async function captureDiff(wtDir) {
  await git(wtDir, 'add', '-A');
  const stat = (await git(wtDir, 'diff', '--cached', '--stat')).trim();
  const patch = await git(wtDir, 'diff', '--cached', '--binary');
  return { stat, patch };
}

// 用完即毁：patch 已捕获，副本没有继续存在的理由（应用走 git apply patch，不依赖副本）
export async function removeWorktree(repoDir, wtDir) {
  try { await git(repoDir, 'worktree', 'remove', '--force', wtDir); }
  catch { await rm(wtDir, { recursive: true, force: true }).catch(() => {}); }
  await git(repoDir, 'worktree', 'prune').catch(() => {});
}

// 把 patch 应用到主工作区（工作树层面，不自动提交——commit 权始终在用户自己的 git 流程里）
// --3way：主工作区在动手之后有了新改动时尽量三方合并，冲突则整体失败并报错，绝不半套用
export async function applyPatch(repoDir, patchText) {
  const f = path.join(await mkdtemp(path.join(tmpdir(), 'roundtable-patch-')), 'build.patch');
  await writeFile(f, patchText, 'utf8');
  try {
    await git(repoDir, 'apply', '--3way', '--binary', f);
  } finally {
    await rm(path.dirname(f), { recursive: true, force: true }).catch(() => {});
  }
}
