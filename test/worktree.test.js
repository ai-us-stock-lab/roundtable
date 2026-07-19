import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isGitRepo, createWorktree, captureDiff, removeWorktree, applyPatch } from '../src/worktree.js';

// 造一个带一次提交的真实 git 仓库
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wt-repo-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { windowsHide: true });
  g('init');
  g('config', 'user.email', 'test@test');
  g('config', 'user.name', 'test');
  writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\n');
  g('add', '-A');
  g('commit', '-m', 'init');
  return dir;
}

test('isGitRepo: 仓库 true，普通目录 false', async () => {
  const repo = makeRepo();
  assert.equal(await isGitRepo(repo), true);
  assert.equal(await isGitRepo(mkdtempSync(path.join(tmpdir(), 'wt-plain-'))), false);
});

test('worktree 全流程：副本改动 → 捕获 patch → 销毁副本 → 应用到主仓库', async () => {
  const repo = makeRepo();
  const wt = await createWorktree(repo);
  assert.ok(existsSync(path.join(wt, 'a.txt'))); // 副本包含仓库内容

  // 模拟 agent 在副本里干活：改一个文件 + 新建一个文件
  writeFileSync(path.join(wt, 'a.txt'), 'line1\nCHANGED\n');
  writeFileSync(path.join(wt, 'new.txt'), 'brand new\n');

  const { stat, patch } = await captureDiff(wt);
  assert.match(stat, /a\.txt/);
  assert.match(stat, /new\.txt/);
  assert.match(patch, /CHANGED/);
  assert.match(patch, /brand new/);

  // 主仓库此刻必须还是干净的（隔离验证）
  assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'line1\nline2\n');
  assert.ok(!existsSync(path.join(repo, 'new.txt')));

  await removeWorktree(repo, wt);
  assert.ok(!existsSync(wt)); // 副本已销毁

  // 副本没了，patch 依然可应用（patch 是唯一事实源）；Windows autocrlf 下换行归一比较
  const norm = s => s.replaceAll('\r\n', '\n');
  await applyPatch(repo, patch);
  assert.equal(norm(readFileSync(path.join(repo, 'a.txt'), 'utf8')), 'line1\nCHANGED\n');
  assert.equal(norm(readFileSync(path.join(repo, 'new.txt'), 'utf8')), 'brand new\n');
});

test('applyPatch: 与主工作区改动冲突时整体失败，不半套用', async () => {
  const repo = makeRepo();
  const wt = await createWorktree(repo);
  writeFileSync(path.join(wt, 'a.txt'), 'line1\nFROM-AGENT\n');
  writeFileSync(path.join(wt, 'safe.txt'), 'ok\n');
  const { patch } = await captureDiff(wt);
  await removeWorktree(repo, wt);
  // 用户在主工作区同一行做了不同修改 → 冲突
  writeFileSync(path.join(repo, 'a.txt'), 'line1\nFROM-USER\n');
  await assert.rejects(() => applyPatch(repo, patch));
  // 整体失败：safe.txt 也不应出现（git apply 原子性）
  assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'line1\nFROM-USER\n');
});
