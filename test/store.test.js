import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as store from '../src/store.js';

async function makeSession() {
  const base = mkdtempSync(path.join(tmpdir(), 'rt-store-'));
  const dir = await store.createSessionDir(base, 'test-topic');
  return { base, dir };
}

test('createSessionDir 建标准结构且重名自动后缀', async () => {
  const { base, dir } = await makeSession();
  for (const sub of ['prompts', 'raw', 'summaries']) assert.ok(existsSync(path.join(dir, sub)));
  const dir2 = await store.createSessionDir(base, 'test-topic');
  assert.notEqual(dir2, dir);
  assert.match(path.basename(dir2), /-2$/);
});

test('所有落盘文本经过 redaction', async () => {
  const { dir } = await makeSession();
  await store.saveRaw(dir, 'r1', 'claude', '结论 with sk-abc123def456ghi789jkl inside');
  const txt = readFileSync(path.join(dir, 'raw', 'r1-claude.md'), 'utf8');
  assert.match(txt, /\[REDACTED\]/);
  assert.doesNotMatch(txt, /sk-abc123/);
});

test('metadata 与 session.md 汇总', async () => {
  const { dir } = await makeSession();
  await store.saveProblem(dir, { topic: '议题X', materials: '', templateName: 'general', roles: { debaters: ['claude', 'codex'], judge: 'codex', summarizer: 'claude' }, mode: 'manual', maxRounds: 4 });
  await store.saveRaw(dir, 'r1', 'claude', '甲方观点');
  await store.saveSummary(dir, 1, '摘要一');
  await store.saveJudgeCard(dir, '裁决内容');
  await store.saveMetadata(dir, { status: 'done', rounds: 1 });
  await store.assembleSessionMd(dir);
  const md = readFileSync(path.join(dir, 'session.md'), 'utf8');
  for (const s of ['议题X', '甲方观点', '摘要一', '裁决内容']) assert.match(md, new RegExp(s));
  const meta = JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  assert.equal(meta.status, 'done');
});
