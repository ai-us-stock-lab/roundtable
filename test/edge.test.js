import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isGitRepo, createWorktree, captureDiff, removeWorktree, applyPatch } from '../src/worktree.js';
import { splitPatchByFile } from '../src/workbench.js';

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'edge-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { windowsHide: true });
  g('init'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  g('add', '-A'); g('commit', '-m', 'init');
  return dir;
}

test('edge: 中文文件名——diff 捕获/按文件切分/应用 全链路', async () => {
  const r = repo();
  const wt = await createWorktree(r);
  writeFileSync(path.join(wt, '设计文档.md'), '中文内容\n');
  mkdirSync(path.join(wt, '资料'), { recursive: true });
  writeFileSync(path.join(wt, '资料', '笔记.txt'), 'note\n');
  const { stat, patch } = await captureDiff(wt);
  await removeWorktree(r, wt);
  const segs = splitPatchByFile(patch);
  const paths = segs.map(s => s.path);
  assert.ok(paths.includes('设计文档.md'), '中文文件名应被正确解析，实际: ' + JSON.stringify(paths));
  assert.ok(paths.includes('资料/笔记.txt'), '中文目录应被正确解析，实际: ' + JSON.stringify(paths));
  await applyPatch(r, patch);
  assert.ok(existsSync(path.join(r, '设计文档.md')));
  assert.ok(existsSync(path.join(r, '资料', '笔记.txt')));
});

test('edge: 空仓库（无任何提交）——建副本给出可懂错误而非神秘失败', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edge-empty-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { windowsHide: true });
  g('init');
  assert.equal(await isGitRepo(dir), true);
  await assert.rejects(() => createWorktree(dir)); // 至少不能静默成功；错误信息可懂性在 UI 层兜底
});

test('edge: 合并冲突进行中的仓库——副本仍可创建（基于 HEAD，不受未完成操作影响）', async () => {
  const r = repo();
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { windowsHide: true });
  // 制造合并冲突状态
  g('checkout', '-b', 'feat');
  writeFileSync(path.join(r, 'base.txt'), 'feat\n');
  g('commit', '-am', 'feat');
  g('checkout', 'master');
  writeFileSync(path.join(r, 'base.txt'), 'main\n');
  g('commit', '-am', 'main');
  try { g('merge', 'feat'); } catch { /* 预期冲突 */ }
  // 冲突状态下建副本：worktree 基于 HEAD，应当照常工作
  const wt = await createWorktree(r);
  writeFileSync(path.join(wt, 'new.txt'), 'x\n');
  const { patch } = await captureDiff(wt);
  await removeWorktree(r, wt);
  assert.match(patch, /new\.txt/);
});

test('edge: 嵌套子目录作为 workspace——diff 路径与应用位置一致性', async () => {
  const r = repo();
  mkdirSync(path.join(r, 'sub'), { recursive: true });
  writeFileSync(path.join(r, 'sub', 'inner.txt'), 'inner\n');
  execFileSync('git', ['-C', r, 'add', '-A'], { windowsHide: true });
  execFileSync('git', ['-C', r, 'commit', '-m', 'sub'], { windowsHide: true });
  const sub = path.join(r, 'sub');
  // 以子目录为 workspace 建副本：git worktree add 作用于整个仓库
  const wt = await createWorktree(sub);
  writeFileSync(path.join(wt, 'sub', 'inner.txt'), 'changed\n');
  const { patch } = await captureDiff(wt);
  await removeWorktree(sub, wt);
  // 应用时 workspace=子目录：patch 路径是仓库根相对（sub/inner.txt）——git -C sub apply 会怎样？
  await applyPatch(sub, patch);
  assert.equal(readFileSync(path.join(r, 'sub', 'inner.txt'), 'utf8').replaceAll('\r\n', '\n'), 'changed\n');
});

test('edge: 巨型 patch（400KB）应用不损坏', async () => {
  const r = repo();
  const wt = await createWorktree(r);
  const big = ('x'.repeat(80) + '\n').repeat(5000); // ~400KB
  writeFileSync(path.join(wt, 'big.txt'), big);
  const { patch } = await captureDiff(wt);
  await removeWorktree(r, wt);
  assert.ok(patch.length > 300000);
  await applyPatch(r, patch);
  assert.equal(readFileSync(path.join(r, 'big.txt'), 'utf8').replaceAll('\r\n', '\n').length, big.length);
});

// ---- 副本继承主工作区未提交状态 ----
test('edge: syncWorktreeWithMain——继承已改未提交+未跟踪文件，agent 增量与之隔离', async () => {
  const { syncWorktreeWithMain } = await import('../src/worktree.js');
  const r = repo();
  // 主工作区：改一个已跟踪文件（不提交）+ 新建一个未跟踪文件 + 一个被忽略的文件
  writeFileSync(path.join(r, 'base.txt'), 'user-edited\n');
  writeFileSync(path.join(r, 'draft.md'), 'untracked\n');
  writeFileSync(path.join(r, '.gitignore'), 'ignored.tmp\n');
  writeFileSync(path.join(r, 'ignored.tmp'), 'noise\n');
  const wt = await createWorktree(r);
  const changed = await syncWorktreeWithMain(r, wt);
  assert.equal(changed, true);
  const norm = s => s.replaceAll('\r\n', '\n');
  assert.equal(norm(readFileSync(path.join(wt, 'base.txt'), 'utf8')), 'user-edited\n'); // 未提交编辑可见
  assert.ok(existsSync(path.join(wt, 'draft.md'))); // 未跟踪文件可见
  assert.ok(!existsSync(path.join(wt, 'ignored.tmp'))); // 被忽略文件不带
  // agent 只加一个文件 → diff 只含 agent 增量，不含用户未提交的改动
  writeFileSync(path.join(wt, 'agent.txt'), 'delta\n');
  const { patch } = await captureDiff(wt);
  await removeWorktree(r, wt);
  assert.match(patch, /agent\.txt/);
  assert.ok(!patch.includes('user-edited'), 'diff 不应重复打包用户未提交的改动');
  assert.ok(!patch.includes('draft.md'), 'diff 不应重复打包未跟踪文件');
  // 应用后主工作区：agent 文件落地，用户未提交改动原样
  await applyPatch(r, patch);
  assert.ok(existsSync(path.join(r, 'agent.txt')));
  assert.equal(norm(readFileSync(path.join(r, 'base.txt'), 'utf8')), 'user-edited\n');
});

// ---- 本地 API 防 DNS rebinding ----
test('edge: 伪造 Host 头的请求被 403，正常回环 Host 放行', async () => {
  const { startServer } = await import('../src/server.js');
  const http = (await import('node:http')).default;
  const sessionsDir = mkdtempSync(path.join(tmpdir(), 'edge-host-'));
  const srv = await startServer({ port: 0, agentsFile: 'test/agents.fixture.json', sessionsDir });
  const reqWithHost = host => new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/config', headers: { host } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', () => resolve(-1));
    r.end();
  });
  try {
    assert.equal(await reqWithHost('evil.example.com'), 403); // DNS rebinding 姿势
    assert.equal(await reqWithHost('evil.example.com:7777'), 403);
    assert.equal(await reqWithHost(`127.0.0.1:${srv.port}`), 200);
    assert.equal(await reqWithHost('localhost:1234'), 200); // 端口不限，host 名必须回环
  } finally { srv.close(); }
});
