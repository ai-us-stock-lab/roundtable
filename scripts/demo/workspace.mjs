import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXPECTED_README_LINE } from './config.mjs';
import { run, runOrThrow } from './lib.mjs';

const DRIVE_CANDIDATES = ['R:', 'S:', 'T:', 'V:'];

async function mapNeutralWindowsDrive(parentDir) {
  for (const drive of DRIVE_CANDIDATES) {
    if (existsSync(`${drive}\\`)) continue;
    const result = await run('subst.exe', [drive, parentDir]);
    if (result.code === 0 && existsSync(`${drive}\\`)) return drive;
  }
  throw new Error('无法创建中性演示盘符；为避免录入真实用户路径，录制已停止');
}

export async function createDemoWorkspace() {
  const tempBase = await mkdtemp(path.join(os.tmpdir(), 'roundtable-demo-'));
  const repoPath = path.join(tempBase, 'roundtable-demo');
  await mkdir(repoPath);
  const init = await run('git', ['init', '-b', 'main'], { cwd: repoPath });
  if (init.code !== 0) {
    await runOrThrow('git', ['init'], { cwd: repoPath });
    await runOrThrow('git', ['branch', '-M', 'main'], { cwd: repoPath });
  }
  await runOrThrow('git', ['config', 'user.name', 'Roundtable Demo'], { cwd: repoPath });
  await runOrThrow('git', ['config', 'user.email', 'demo@example.invalid'], { cwd: repoPath });
  await writeFile(
    path.join(repoPath, 'README.md'),
    '# Tiny Demo Project\n\nA deliberately small repository used only for the Roundtable recording.\n',
    'utf8',
  );
  await writeFile(path.join(repoPath, 'app.js'), 'export const ready = true;\n', 'utf8');
  await runOrThrow('git', ['add', 'README.md', 'app.js'], { cwd: repoPath });
  await runOrThrow('git', ['commit', '-m', 'demo: initial state'], { cwd: repoPath });
  const initialHead = (await runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: repoPath })).stdout.trim();

  let mappedDrive = null;
  let displayPath = repoPath;
  if (process.platform === 'win32') {
    mappedDrive = await mapNeutralWindowsDrive(tempBase);
    displayPath = `${mappedDrive}\\roundtable-demo`;
  } else {
    // /tmp 不包含用户主目录，适合出现在公开演示中。
    displayPath = repoPath;
  }

  const cleanup = async () => {
    if (mappedDrive) await run('subst.exe', [mappedDrive, '/d']);
    const resolved = path.resolve(tempBase);
    const tempRoot = path.resolve(os.tmpdir());
    if (resolved.startsWith(tempRoot + path.sep) && path.basename(resolved).startsWith('roundtable-demo-')) {
      await rm(resolved, { recursive: true, force: true });
    }
  };

  // 即使 Node 被普通异常终止，也尽量撤销盘符；强制关机等情况见 README 的手工清理命令。
  if (mappedDrive) {
    process.once('exit', () => spawnSync('subst.exe', [mappedDrive, '/d'], { windowsHide: true }));
  }

  return { repoPath, displayPath, initialHead, expectedLine: EXPECTED_README_LINE, mappedDrive, cleanup };
}
