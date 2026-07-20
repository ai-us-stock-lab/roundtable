// ===== diff 一等公民机制第一层:CAS 内容寻址存储 + Revision 记录 + 确定性硬门 =====
// 设计定稿:docs/design-diff-first-workbench.md(2026-07-20 会议裁决 + 用户终审)
// 铁律:硬门只做零误报的确定性判定;AI 判断的语义/契约冲突绝不在此拦截,
//       它们走「深入讨论 → informed 决策」流(定稿第 1 条,定位级原则)。
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

// ---- CAS blob:同内容只存一份,按哈希寻址。回收策略:目前全留(用户终审第 3 条) ----
export async function saveBlob(sessionDir, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const sha = sha256(buf);
  const dir = path.join(sessionDir, 'changes', 'blobs');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, sha);
  try { await readFile(file); } catch { await writeFile(file, buf); }
  return sha;
}

export async function readBlob(sessionDir, sha) {
  try { return await readFile(path.join(sessionDir, 'changes', 'blobs', String(sha))); } catch { return null; }
}

// 完整性校验:内容重算哈希必须等于文件名——防篡改/防损坏(硬门 blob_missing 的判定基础)
export async function verifyBlob(sessionDir, sha) {
  const buf = await readBlob(sessionDir, sha);
  return !!buf && sha256(buf) === sha;
}

// ---- Revision:一次提案 = 执行者 + 每文件的改前/改后快照引用 ----
// { revisionId, actorId, note, ts, files: [{ path, baseSha|null(新文件), resultSha|null(删除) }] }
export async function saveRevision(sessionDir, rev) {
  const dir = path.join(sessionDir, 'changes');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, 'revisions.jsonl'), JSON.stringify(rev) + '\n', 'utf8');
}

export async function loadRevisions(sessionDir) {
  try {
    const raw = await readFile(path.join(sessionDir, 'changes', 'revisions.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

// ---- 重叠计算:多个待定提案触碰同一文件 → 必进软门(处置清单/讨论流);无重叠默认接纳(终审第 2 条) ----
export function computeOverlaps(revisions) {
  const byFile = {};
  for (const r of revisions) for (const f of r.files ?? []) (byFile[f.path] ??= []).push(r.revisionId);
  return Object.fromEntries(Object.entries(byFile).filter(([, ids]) => ids.length > 1));
}

// ---- 确定性硬门:四类零误报判定,全过才可定稿。拦了就是真有问题,无需人工复核判定本身 ----
export async function deterministicGate({ sessionDir, revision, currentFileHashes = {}, authorizedActors = null, sandboxResult = null }) {
  const blocks = [];
  if (authorizedActors && !authorizedActors.includes(revision.actorId)) {
    blocks.push({ code: 'unauthorized_actor', actorId: revision.actorId });
  }
  for (const f of revision.files ?? []) {
    if (f.baseSha != null) {
      // 基线漂移:提案基于的版本 ≠ 工作区当前版本(文件在提案后被改过)
      if (currentFileHashes[f.path] !== f.baseSha) blocks.push({ code: 'base_drift', file: f.path });
      if (!(await verifyBlob(sessionDir, f.baseSha))) blocks.push({ code: 'blob_missing', file: f.path, sha: f.baseSha });
    }
    if (f.resultSha != null && !(await verifyBlob(sessionDir, f.resultSha))) {
      blocks.push({ code: 'blob_missing', file: f.path, sha: f.resultSha });
    }
  }
  // 沙箱失败=确定性事实(命令真实退出非零/应用失败);沙箱通过但无断言≠语义正确,该事实由 UI 明示,不在此判
  if (sandboxResult && !sandboxResult.ok) blocks.push({ code: 'sandbox_failed', detail: String(sandboxResult.error ?? '') });
  return { pass: blocks.length === 0, blocks };
}

// ---- 应用审计日志(仲裁补充的双方均漏风险):每次定稿落地留痕 ----
export async function logApplication(sessionDir, entry) {
  const dir = path.join(sessionDir, 'changes');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, 'applications.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}
