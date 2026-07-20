import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDebaterR1, buildDebaterRN, buildSummarizer, buildJudge, DISAGREEMENT_TYPES, SCRIBE_MARKERS } from '../src/prompts.js';

test('R1 是 clean room：不含对手字段的任何痕迹', () => {
  const p = buildDebaterR1({ topic: '要不要加仓X', materials: '材料A', injection: '框架B', format: '格式C', userNote: '' });
  assert.match(p, /要不要加仓X/);
  assert.match(p, /材料A/);
  assert.match(p, /框架B/);
  assert.doesNotMatch(p, /对方|对手观点|OPPONENT/);
});

test('RN 包含 summary、对手发言、质询问题，并要求先答质询', () => {
  const p = buildDebaterRN({
    topic: 'T', round: 2, summary: 'SUMMARY_X', opponentName: 'Codex',
    opponentText: 'OPP_TEXT', questions: '你凭什么认为渗透率已过16%？',
    injection: '', format: '', userNote: '主持人：先聚焦事实',
  });
  for (const s of ['SUMMARY_X', 'OPP_TEXT', '你凭什么认为渗透率已过16%？', '主持人：先聚焦事实']) assert.match(p, new RegExp(s));
  assert.match(p, /先逐条回答.*质询/s);
});

test('summarizer 要求五类分歧分类表', () => {
  const p = buildSummarizer({ topic: 'T', round: 1, roundTexts: { Claude: 'a', Codex: 'b' }, previousSummary: '' });
  for (const t of DISAGREEMENT_TYPES.zh) assert.match(p, new RegExp(t));
  assert.match(p, /当前共识/);
  assert.match(p, /下一轮待问问题/);
});

test('judge 禁止输出独立观点并要求最小下一步', () => {
  const p = buildJudge({ topic: 'T', summary: 'S', finalStatements: { Claude: 'a', Codex: 'b' }, format: '' });
  assert.match(p, /禁止.*(独立观点|自己的观点)/s);
  assert.match(p, /最小可验证下一步/);
  assert.match(p, /风险偏好分歧.*不判对错/s);
});

// ---- 会话语言 en：提示词全英文、结构约定与解析标记一致 ----

test('en R1 全英文且不含中文', () => {
  const p = buildDebaterR1({ topic: 'Should we raise', materials: 'M', injection: '', format: '', userNote: '', lang: 'en' });
  assert.match(p, /# Topic/);
  assert.match(p, /kill condition/);
  assert.doesNotMatch(p, /[一-鿿]/);
});

test('en summarizer 使用英文分歧类型与 Ask 质询格式', () => {
  const p = buildSummarizer({ topic: 'T', round: 1, roundTexts: { Claude: 'a', Codex: 'b' }, previousSummary: '', lang: 'en' });
  for (const t of DISAGREEMENT_TYPES.en) assert.match(p, new RegExp(t));
  assert.match(p, /Disagreement table/);
  assert.match(p, /"Ask <debater>: <question>"/);
  assert.doesNotMatch(p, /[一-鿿]/);
});

test('en judge 全英文且要求最小下一步', () => {
  const p = buildJudge({ topic: 'T', summary: 'S', finalStatements: { Claude: 'a', Codex: 'b' }, format: '', lang: 'en' });
  assert.match(p, /Minimal verifiable next step/);
  assert.doesNotMatch(p, /[一-鿿]/);
});

test('SCRIBE_MARKERS 与 scribeTask 输出格式一致（解析依赖）', () => {
  const zh = buildSummarizer({ topic: 'T', round: 1, roundTexts: { A: 'x' }, previousSummary: '' });
  assert.ok(zh.includes(SCRIBE_MARKERS.zh.table));
  const en = buildSummarizer({ topic: 'T', round: 1, roundTexts: { A: 'x' }, previousSummary: '', lang: 'en' });
  assert.ok(en.includes(SCRIBE_MARKERS.en.table));
});
