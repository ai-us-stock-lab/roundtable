import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256, saveBlob, readBlob, verifyBlob, saveRevision, loadRevisions, computeOverlaps, deterministicGate, logApplication } from '../src/changes.js';

// 会议裁决(2026-07-20)指定的最小第一步:30 分钟内零成本验证的证伪条件全部固化为测试
const dir = () => mkdtempSync(path.join(tmpdir(), 'rt-chg-'));

test('CAS 自完备:存 base/result 双 blob → 删除原文件 → 逐字节重建', async () => {
  const d = dir();
  const orig = path.join(d, 'a.txt');
  const base = 'line1\nline2\n', result = 'line1\nline2-changed\n二进制✓\x00\x01';
  await writeFile(orig, base);
  const baseSha = await saveBlob(d, base);
  const resultSha = await saveBlob(d, Buffer.from(result));
  await rm(orig); // 删掉工作区原文件
  assert.equal((await readBlob(d, baseSha)).toString(), base);      // 改前可完整重建
  assert.deepEqual(await readBlob(d, resultSha), Buffer.from(result)); // 改后含二进制逐字节一致
  assert.equal(await saveBlob(d, base), baseSha);                   // 同内容幂等,不重复存储
});

test('硬门:篡改 blob → blob_missing 阻断', async () => {
  const d = dir();
  const sha = await saveBlob(d, 'content-v1');
  await writeFile(path.join(d, 'changes', 'blobs', sha), 'tampered!'); // 篡改
  assert.equal(await verifyBlob(d, sha), false);
  const rev = { revisionId: 'r1', actorId: 'codex', files: [{ path: 'a.txt', baseSha: sha, resultSha: null }] };
  const g = await deterministicGate({ sessionDir: d, revision: rev, currentFileHashes: { 'a.txt': sha } });
  assert.equal(g.pass, false);
  assert.ok(g.blocks.some(b => b.code === 'blob_missing'));
});

test('硬门:基线漂移 → base_drift 阻断(文件在提案后被改过)', async () => {
  const d = dir();
  const baseSha = await saveBlob(d, 'v1');
  const resultSha = await saveBlob(d, 'v2');
  const rev = { revisionId: 'r1', actorId: 'claude', files: [{ path: 'a.txt', baseSha, resultSha }] };
  const drifted = await deterministicGate({ sessionDir: d, revision: rev, currentFileHashes: { 'a.txt': sha256(Buffer.from('v1-modified-by-someone')) } });
  assert.equal(drifted.pass, false);
  assert.ok(drifted.blocks.some(b => b.code === 'base_drift'));
  const clean = await deterministicGate({ sessionDir: d, revision: rev, currentFileHashes: { 'a.txt': baseSha } });
  assert.equal(clean.pass, true); // 无漂移 + blob 完好 → 放行
});

test('硬门:未授权执行者与沙箱失败均阻断;语义类判断不在硬门', async () => {
  const d = dir();
  const rev = { revisionId: 'r1', actorId: 'stranger', files: [] };
  const g1 = await deterministicGate({ sessionDir: d, revision: rev, authorizedActors: ['claude', 'codex'] });
  assert.ok(g1.blocks.some(b => b.code === 'unauthorized_actor'));
  const g2 = await deterministicGate({ sessionDir: d, revision: { revisionId: 'r2', actorId: 'claude', files: [] }, sandboxResult: { ok: false, error: 'tests exit 1' } });
  assert.ok(g2.blocks.some(b => b.code === 'sandbox_failed'));
});

test('软门路由:单提案单文件无重叠 → 不进清单;两提案触碰同一文件 → 强制进清单', () => {
  const solo = computeOverlaps([
    { revisionId: 'r1', files: [{ path: 'a.txt' }] },
    { revisionId: 'r2', files: [{ path: 'b.txt' }] },
  ]);
  assert.deepEqual(solo, {}); // 无重叠 → 默认接纳(用户终审第 2 条)
  const clash = computeOverlaps([
    { revisionId: 'r1', files: [{ path: 'a.txt' }, { path: 'shared.js' }] },
    { revisionId: 'r2', files: [{ path: 'shared.js' }] },
  ]);
  assert.deepEqual(Object.keys(clash), ['shared.js']);
  assert.deepEqual(clash['shared.js'], ['r1', 'r2']);
});

test('Revision 落盘可回读;applications.jsonl 记录定稿事件', async () => {
  const d = dir();
  await saveRevision(d, { revisionId: 'r1', actorId: 'codex', ts: 'T', files: [{ path: 'a.txt', baseSha: 'x', resultSha: 'y' }] });
  await saveRevision(d, { revisionId: 'r2', actorId: 'claude', ts: 'T', files: [] });
  const revs = await loadRevisions(d);
  assert.equal(revs.length, 2);
  assert.equal(revs[0].files[0].resultSha, 'y');
  await logApplication(d, { appliedRevisionIds: ['r1'], dispositions: [{ revId: 'r1', keep: true }] });
  const log = (await readFile(path.join(d, 'changes', 'applications.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 1);
  assert.ok(log[0].ts);
  assert.deepEqual(log[0].appliedRevisionIds, ['r1']);
});
