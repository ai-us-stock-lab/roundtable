import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Committee, extractDisagreementBlock } from '../src/orchestrator.js';

// mock-cli 默认回显输入 → 辩手输出 = 简报原文，正好用来断言简报内容
const AGENT = name => ({
  name, command: [process.execPath, 'test/mock-cli.cjs'], input: 'stdin', output: 'text',
  timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT'], cwd: process.cwd(), roles: ['debater', 'judge', 'summarizer'],
});

function makeCommittee(over = {}) {
  const events = [];
  const c = new Committee({
    topic: '测试议题', materials: '',
    agents: { a: AGENT('AgentA'), b: AGENT('AgentB'), s: AGENT('AgentS') },
    roles: { debaters: ['a', 'b'], judge: 's', summarizer: 's' },
    template: { name: 'general', injections: {}, debaterFormat: '', judgeFormat: '', copyJudgeCardTo: null },
    mode: 'manual', maxRounds: 4,
    baseDir: mkdtempSync(path.join(tmpdir(), 'rt-orch-')),
    emit: e => events.push(e),
    ...over,
  });
  return { c, events };
}

test('chunk 与 agent-status 事件携带 label（供前端按角色路由）', async () => {
  const { c, events } = makeCommittee();
  await c.init();
  await c.runNextRound();
  const chunk = events.find(e => e.type === 'chunk');
  assert.match(chunk.label, /^r1/);
  const summaryChunk = events.find(e => e.type === 'chunk' && e.label === 'r1summary');
  assert.ok(summaryChunk, 'summarizer 的 chunk 也应带 label r1summary');
  const status = events.find(e => e.type === 'agent-status');
  assert.ok(status.label);
});

test('第 1 轮是 clean room：双方简报互不含对方内容', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  const briefA = c.history[0].briefs.a, briefB = c.history[0].briefs.b;
  assert.doesNotMatch(briefA, /AgentB/);
  assert.doesNotMatch(briefB, /AgentA/);
  assert.match(briefA, /第 1 轮独立判断/);
  assert.equal(c.state, 'paused');
  assert.ok(c.history[0].summary.length > 0);
});

test('第 2 轮简报含 summary、对方发言与主持人插话', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  c.interject('主持人：请聚焦渗透率');
  await c.runNextRound();
  const briefA = c.history[1].briefs.a;
  assert.match(briefA, /AgentB 上一轮的发言/);
  assert.match(briefA, /主持人：请聚焦渗透率/);
});

test('runJudge 产出裁决卡并落盘', async () => {
  const { c, events } = makeCommittee();
  await c.init();
  await c.runNextRound();
  await c.runJudge();
  assert.equal(c.state, 'done');
  assert.ok(readFileSync(path.join(c.dir, 'judge-card.md'), 'utf8').length > 0);
  assert.ok(events.some(e => e.type === 'judge-card'));
  assert.ok(readdirSync(c.dir).includes('session.md'));
});

test('全过程落盘 prompts 与 raw', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  const prompts = readdirSync(path.join(c.dir, 'prompts'));
  const raws = readdirSync(path.join(c.dir, 'raw'));
  for (const f of ['r1-a.md', 'r1-b.md']) {
    assert.ok(prompts.includes(f), 'prompts 缺 ' + f);
    assert.ok(raws.includes(f), 'raw 缺 ' + f);
  }
});

test('skipSide 后 summary 记录缺席', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  await c.skipSide('b');
  assert.match(c.history[0].summary, /缺席/);
});

test('skipSide 的 agent-status 事件带辩手轮次 label', async () => {
  const { c, events } = makeCommittee();
  await c.init();
  await c.runNextRound();
  await c.skipSide('b');
  const ev = events.find(e => e.type === 'agent-status' && e.data === 'skipped');
  assert.ok(ev, '应有 skipped 状态事件');
  assert.match(ev.label ?? '', /^r\d+$/);
});

test('retrySide 用原简报重跑并刷新摘要', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  await c.skipSide('b');
  await c.retrySide('b');
  assert.equal(c.history[0].outputs.b.ok, true);
  assert.doesNotMatch(c.history[0].summary, /缺席/);
});

test('stopRound 中止并回退轮次', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  // 用慢速 mock 制造可中断的一轮：MOCK_DELAY_MS 让子进程先睡再回显，确保 stopRound 能在其完成前触发 abort
  c.agents.a.envWhitelist = ['PATH', 'SYSTEMROOT', 'MOCK_DELAY_MS'];
  c.agents.b.envWhitelist = ['PATH', 'SYSTEMROOT', 'MOCK_DELAY_MS'];
  process.env.MOCK_DELAY_MS = '3000';
  try {
    const p = c.runNextRound();
    setTimeout(() => c.stopRound(), 50);
    await p;
  } finally {
    delete process.env.MOCK_DELAY_MS;
  }
  assert.equal(c.round, 1);
  assert.equal(c.state, 'paused');
  assert.equal(c.history.length, 1);
});

test('savePartial 落盘半成品', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  await c.savePartial();
  const meta = JSON.parse(readFileSync(path.join(c.dir, 'metadata.json'), 'utf8'));
  assert.equal(meta.status, 'partial');
  assert.ok(readdirSync(c.dir).includes('session.md'));
});

test('runAuto 达到 maxRounds 后自动裁决', async () => {
  const { c } = makeCommittee({ maxRounds: 2, mode: 'auto' });
  await c.init();
  await c.runAuto();
  assert.equal(c.round, 2);
  assert.equal(c.state, 'done');
});

test('extractDisagreementBlock 截取分歧段', () => {
  const s = '- 当前共识：x\n- 分歧分类表：\n  事实分歧 | A | B | 查证\n- 已证实事实：y';
  assert.match(extractDisagreementBlock(s), /事实分歧 \| A \| B/);
  assert.doesNotMatch(extractDisagreementBlock(s), /已证实事实/);
});

test('stopRound 后 skipSide 的摘要调用仍可被再次 stopRound 中止', async () => {
  const { c } = makeCommittee();
  await c.init();
  await c.runNextRound();
  c.stopRound();                       // spend 掉当前 controller
  const oldAbort = c.abort;
  await c.skipSide('b');               // 应新建 controller
  assert.notEqual(c.abort, oldAbort);
});

test('retrySide 成功后 session.md 展示重试后的内容（不再是失败时的旧内容）', async () => {
  const { c } = makeCommittee();
  await c.init();
  // 让 b 在第 1 轮真实失败（非 aborted），使规范文件 raw/r1-b.md 落盘失败占位
  const workingCmd = c.agents.b.command;
  c.agents.b.command = [process.execPath, '-e', 'process.exit(1)'];
  await c.runNextRound();
  assert.equal(c.history[0].outputs.b.ok, false);
  const rawBefore = readFileSync(path.join(c.dir, 'raw', 'r1-b.md'), 'utf8');
  assert.match(rawBefore, /exit:1/);
  // 恢复正常 mock，重试成功
  c.agents.b.command = workingCmd;
  await c.retrySide('b');
  assert.equal(c.history[0].outputs.b.ok, true);
  await c.savePartial();
  const rawAfter = readFileSync(path.join(c.dir, 'raw', 'r1-b.md'), 'utf8');
  assert.doesNotMatch(rawAfter, /exit:1/);
  const md = readFileSync(path.join(c.dir, 'session.md'), 'utf8');
  assert.doesNotMatch(md, /exit:1/);
});

test('copyJudgeCardTo：裁决卡额外落盘到指定目录', async () => {
  const extra = mkdtempSync(path.join(tmpdir(), 'rt-decisions-'));
  const { c } = makeCommittee({
    template: { name: 'x', injections: {}, debaterFormat: '', judgeFormat: '', copyJudgeCardTo: extra },
  });
  await c.init();
  await c.runNextRound();
  await c.runJudge();
  const files = readdirSync(extra);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.md$/);
});
