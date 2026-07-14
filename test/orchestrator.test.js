import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Committee } from '../src/orchestrator.js';

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
