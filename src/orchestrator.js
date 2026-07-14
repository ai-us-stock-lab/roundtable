import { runAgent } from './runner.js';
import { buildDebaterR1, buildDebaterRN, buildSummarizer, buildJudge } from './prompts.js';
import { resolveInjection, expandHome } from './templates.js';
import { redact } from './redactor.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as store from './store.js';

export class Committee {
  constructor({ topic, materials, agents, roles, template, mode, maxRounds, baseDir, emit }) {
    Object.assign(this, { topic, materials, agents, roles, template, mode, maxRounds, baseDir });
    this.emit = emit ?? (() => {});
    this.state = 'created';
    this.round = 0;
    this.history = [];
    this.userNote = '';
    this.dir = null;
    this.abort = null;
    this.errors = [];
    this.autoStopRequested = false;
  }

  setState(s) { this.state = s; this.emit({ type: 'state', data: s }); }
  agentName(id) { return this.agents[id].name; }
  latestSummary() { return this.history.at(-1)?.summary ?? ''; }
  interject(text) { this.userNote = text; }

  async init() {
    this.dir = await store.createSessionDir(this.baseDir, this.topic.slice(0, 30));
    await store.saveProblem(this.dir, {
      topic: this.topic, materials: this.materials, templateName: this.template.name,
      roles: this.roles, mode: this.mode, maxRounds: this.maxRounds,
    });
    await this.saveMeta('created');
  }

  async saveMeta(status) {
    await store.saveMetadata(this.dir, {
      status, topic: this.topic, template: this.template.name, roles: this.roles,
      mode: this.mode, maxRounds: this.maxRounds, rounds: this.round,
      agents: this.agents, errors: this.errors, updatedAt: new Date().toISOString(),
    });
  }

  // 从 summary 提取给某辩手的质询行（「问 <辩手名>」）
  questionsFor(agentId) {
    const name = this.agentName(agentId);
    return this.latestSummary().split('\n')
      .filter(l => l.includes(`问 ${name}`) || l.includes(`问${name}`)).join('\n');
  }

  async buildBrief(agentId, opponentId) {
    const injection = await resolveInjection(this.template, agentId);
    if (this.round === 1) {
      // clean room：R1 构建路径上没有任何对手数据可引用
      return buildDebaterR1({
        topic: this.topic, materials: this.materials, injection,
        format: this.template.debaterFormat, userNote: this.userNote,
      });
    }
    const prev = this.history.at(-1);
    return buildDebaterRN({
      topic: this.topic, round: this.round, summary: prev.summary,
      opponentName: this.agentName(opponentId),
      opponentText: prev.outputs[opponentId]?.text || '（对方上一轮缺席）',
      questions: this.questionsFor(agentId), injection,
      format: this.template.debaterFormat, userNote: this.userNote,
    });
  }

  async call(agentId, label, prompt) {
    await store.savePrompt(this.dir, label, agentId, prompt);
    this.emit({ type: 'agent-status', agentId, label, data: 'running' });
    const r = await runAgent(this.agents[agentId], prompt, {
      onChunk: s => this.emit({ type: 'chunk', agentId, label, data: s }),
      signal: this.abort?.signal,
    });
    await store.saveRaw(this.dir, label, agentId,
      r.ok ? r.text : `[${r.error}]\n${r.text}\n--- stderr ---\n${r.stderr}`);
    if (!r.ok) {
      this.errors.push({ label, agentId, error: r.error, at: new Date().toISOString() });
      this.emit({ type: 'error', agentId, label, data: r.error });
    }
    this.emit({ type: 'agent-status', agentId, label, data: r.ok ? 'done' : 'failed:' + r.error });
    return r;
  }

  async runNextRound() {
    if (!['created', 'paused'].includes(this.state)) throw new Error('当前状态不能开始新一轮: ' + this.state);
    this.round += 1;
    this.abort = new AbortController();
    this.setState('running');
    const [a, b] = this.roles.debaters;
    const briefs = { [a]: await this.buildBrief(a, b), [b]: await this.buildBrief(b, a) };
    this.userNote = '';
    const label = 'r' + this.round;
    const [ra, rb] = await Promise.all([this.call(a, label, briefs[a]), this.call(b, label, briefs[b])]);
    if ([ra, rb].some(r => r.error === 'aborted')) return null; // stopRound 已处理状态与轮次回退
    const entry = { briefs, outputs: { [a]: ra, [b]: rb }, summary: '' };
    this.history.push(entry);
    await this.summarizeRound();
    this.setState('paused');
    this.emit({ type: 'round-done', round: this.round });
    await this.saveMeta('paused');
    return entry;
  }

  async summarizeRound() {
    const entry = this.history.at(-1);
    const roundTexts = {};
    for (const d of this.roles.debaters) {
      const o = entry.outputs[d];
      roundTexts[this.agentName(d)] = o?.ok ? o.text : `（本轮缺席：${o?.error ?? 'skipped'}）`;
    }
    const prompt = buildSummarizer({
      topic: this.topic, round: this.round, roundTexts,
      previousSummary: this.history.at(-2)?.summary ?? '',
    });
    const r = await this.call(this.roles.summarizer, `r${this.round}summary`, prompt);
    entry.summary = r.ok ? r.text : '（本轮摘要失败：' + r.error + '）';
    await store.saveSummary(this.dir, this.round, entry.summary);
    await store.saveDisagreements(this.dir, entry.summary);
    this.emit({ type: 'summary', round: this.round, data: entry.summary });
  }

  async retrySide(agentId) {
    const entry = this.history.at(-1);
    if (!entry) throw new Error('尚无可重试的轮次');
    this.abort = new AbortController();
    const r = await this.call(agentId, `r${this.round}retry`, entry.briefs[agentId]);
    entry.outputs[agentId] = r;
    if (r.ok) await store.saveRaw(this.dir, 'r' + this.round, agentId, r.text);
    await this.summarizeRound();
    await this.saveMeta(this.state);
    return r;
  }

  async skipSide(agentId) {
    const entry = this.history.at(-1);
    if (!entry) throw new Error('尚无可跳过的轮次');
    this.abort = new AbortController();
    entry.outputs[agentId] = { ok: false, error: 'skipped', text: '' };
    this.emit({ type: 'agent-status', agentId, label: 'r' + this.round, data: 'skipped' });
    await this.summarizeRound();
  }

  stopRound() {
    this.autoStopRequested = true;
    this.abort?.abort();
    if (this.state === 'running') {
      this.round -= 1; // 本轮作废
      this.setState('paused');
    }
  }

  async savePartial() {
    await store.assembleSessionMd(this.dir);
    await this.saveMeta('partial');
    this.state = 'partial';
  }

  requestAutoStop() { this.autoStopRequested = true; }

  async runAuto() {
    this.autoStopRequested = false;
    while (this.round < this.maxRounds && !this.autoStopRequested) {
      const entry = await this.runNextRound();
      if (!entry) return; // 被 stopRound 中止
      const [s1, s2] = [this.history.at(-2)?.summary, this.history.at(-1)?.summary];
      const b1 = extractDisagreementBlock(s1 ?? ''), b2 = extractDisagreementBlock(s2 ?? '');
      if (b1 && b2 && b1 === b2) break; // 分歧收敛（双方分歧块非空且一致才算收敛，防止双空块假收敛）
    }
    if (!this.autoStopRequested) await this.runJudge();
  }

  async runJudge() {
    this.setState('judging');
    const finalStatements = {};
    const last = this.history.at(-1);
    for (const d of this.roles.debaters) {
      const o = last.outputs[d];
      finalStatements[this.agentName(d)] = o?.ok ? o.text : '（最终轮缺席）';
    }
    const prompt = buildJudge({
      topic: this.topic, summary: this.latestSummary(), finalStatements,
      format: this.template.judgeFormat,
    });
    const r = await this.call(this.roles.judge, 'judge', prompt);
    if (r.ok) {
      await store.saveJudgeCard(this.dir, r.text);
      this.emit({ type: 'judge-card', data: r.text });
      // 若模板设置了 copyJudgeCardTo，则额外落盘一份到该目录
      if (this.template.copyJudgeCardTo) {
        const dest = expandHome(this.template.copyJudgeCardTo);
        await mkdir(dest, { recursive: true });
        const name = path.basename(this.dir) + '.md';
        await writeFile(path.join(dest, name), redact(`# 裁决卡：${this.topic}\n\n来源会话：${this.dir}\n\n${r.text}`), 'utf8');
      }
    }
    await store.assembleSessionMd(this.dir);
    this.setState(r.ok ? 'done' : 'partial');
    await this.saveMeta(this.state);
    return r;
  }
}

// 从 summary 文本中截取「分歧分类表」段落（用于 runAuto 判断分歧是否已收敛）
export function extractDisagreementBlock(summary) {
  const lines = String(summary).split('\n');
  const start = lines.findIndex(l => l.includes('分歧分类表'));
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) break; // 下一个顶层条目
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}
