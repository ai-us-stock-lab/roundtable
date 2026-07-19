import { runAgent } from './runner.js';
import { buildDebaterR1, buildDebaterRN, buildSummarizer, buildJudge } from './prompts.js';
import { resolveInjection, expandHome } from './templates.js';
import { redact } from './redactor.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as store from './store.js';

export class Committee {
  constructor({ topic, materials, agents, roles, template, mode, maxRounds, baseDir, emit, origin = '' }) {
    Object.assign(this, { topic, materials, agents, roles, template, mode, maxRounds, baseDir, origin }); // origin=来源工作台目录名（升格而来时非空，裁决卡可回流）
    this.emit = emit ?? (() => {});
    this.state = 'created';
    this.round = 0;
    this.history = [];
    this.userNote = '';
    this.dir = null;
    this.abort = null;
    this.errors = [];
    this.autoStopRequested = false;
    this.chatLog = [];
    this.chatSeq = 0;
  }

  // 从磁盘状态装配一个可继续辩论的 Committee：不新建目录（复用给定 dir），
  // 直接注入 round/history，state 置为 paused。调用方随后应 saveMeta('paused') 刷新磁盘状态。
  static resume({ topic, materials, agents, roles, template, mode, maxRounds, baseDir, emit, dir, round, history, origin = '' }) {
    const c = new Committee({ topic, materials, agents, roles, template, mode, maxRounds, baseDir, emit, origin });
    c.dir = dir;
    c.round = round;
    c.history = history;
    c.state = 'paused';
    return c;
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
      mode: this.mode, maxRounds: this.maxRounds, rounds: this.round, workspace: this.workspace, origin: this.origin,
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
    // 会诊裁决 2026-07-15：书记调用成功但缺关键结构时不再静默——下游收敛判定与阅读体验会悄悄劣化
    if (r.ok && !entry.summary.includes('分歧分类表'))
      this.emit({ type: 'error', agentId: this.roles.summarizer, label: `r${this.round}summary`, data: '书记输出缺少「分歧分类表」结构，摘要质量可能下降（可点「重新生成本轮摘要」）' });
    await store.saveSummary(this.dir, this.round, entry.summary);
    await store.saveDisagreements(this.dir, entry.summary);
    this.emit({ type: 'summary', round: this.round, data: entry.summary });
  }

  // 会话内群聊：会后/轮间与参会 AI 自由讨论，AI 回答延续其会上立场（若为辩手，引用其最新一轮发言）
  async chat(text, agentIds) {
    if (['running', 'judging'].includes(this.state)) throw new Error('辩论进行中，稍后再聊');
    if (this.state === 'created') throw new Error('尚无会议内容可聊，请先开始第 1 轮');
    const userMsg = { from: 'user', name: '主持人', text, at: new Date().toISOString() };
    this.chatLog.push(userMsg);
    this.emit({ type: 'chat-message', from: 'user', name: '主持人', data: text });
    for (const agentId of agentIds) {
      this.chatSeq += 1;
      const label = 'chat' + this.chatSeq;
      const prompt = this.buildChatPrompt(agentId, text);
      const r = await this.call(agentId, label, prompt);
      if (r.ok) {
        const name = this.agentName(agentId);
        this.chatLog.push({ from: agentId, name, text: r.text, at: new Date().toISOString() });
        this.emit({ type: 'chat-message', from: agentId, name, data: r.text });
      }
      // 失败时 call() 已发出 error 事件，此处无需重复处理
    }
    await this.saveChatLog();
  }

  buildChatPrompt(agentId, text) {
    const name = this.agentName(agentId);
    const summary = this.latestSummary().slice(0, 3000);
    const last = this.history.at(-1);
    const isDebater = this.roles.debaters.includes(agentId);
    const lastOutput = last?.outputs?.[agentId];
    const stance = isDebater && lastOutput?.ok ? lastOutput.text.slice(0, 2000) : '';
    const recent = this.chatLog.slice(-10).map(m => `${m.name}：${m.text}`).join('\n');
    return [
      `你是决策委员会会议的参会者「${name}」，现在是会后/轮间的自由讨论环节。`,
      `# 议题：${this.topic}`,
      `# 会议摘要：${summary}`,
      stance ? `# 你在辩论中的最新立场（保持一致性）：${stance}` : '',
      `# 最近群聊记录：\n${recent}`,
      `# 主持人刚刚说：${text}`,
      '请以对话方式简明回应（几句话到一小段，无需固定结构），延续你的立场与视角，可引用会议内容；被问到超出会议范围的事实请照实说不知道。',
    ].filter(Boolean).join('\n\n');
  }

  async saveChatLog() {
    const lines = this.chatLog.map(m => redact(JSON.stringify(m))).join('\n') + '\n';
    await writeFile(path.join(this.dir, 'chat.jsonl'), lines, 'utf8');
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

  // 摘要失败（如书记 agent 出错）后重跑本轮摘要——换新 AbortController，避免复用已 spent 的信号
  async resummarize() {
    if (!this.history.length) throw new Error('尚无可重新摘要的轮次');
    this.abort = new AbortController();
    await this.summarizeRound();
    await this.saveMeta(this.state);
  }

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
