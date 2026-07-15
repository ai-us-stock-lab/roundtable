import path from 'node:path';
import { appendFile, readFile } from 'node:fs/promises';
import { runAgent } from './runner.js';
import { redact } from './redactor.js';
import { createSessionDir, saveMetadata, savePrompt, saveRaw } from './store.js';

// ---- 上下文装配：整条消息取舍，从最近往前装（O(n)，绝不从字符中间切） ----
// 裁决卡共识：禁止静默截断——truncated 信息随消息回传前端明示
export function fitHistory(messages, { fixedLen, limit }) {
  const total = messages.length;
  if (fixedLen > limit) return { blocked: true, errorCode: 'PREAMBLE_TOO_LONG', start: total, shown: 0, total };
  let sum = fixedLen;
  let start = total;
  for (let i = total - 1; i >= 0; i--) {
    const len = messages[i].rendered.length + 1; // +1 换行
    if (sum + len > limit) break;
    sum += len;
    start = i;
  }
  if (start === total && total > 0) return { blocked: true, errorCode: 'NOTHING_FITS', start, shown: 0, total };
  return { blocked: false, start, shown: total - start, total };
}

// 对话史纯文本位置化渲染（共识：发言者/收件人显式标注，防冒充/防混淆）
export function renderMessage(m) {
  const who = m.from === 'user' ? '用户' : m.name;
  const to = m.from === 'user' && m.to?.length ? ` → ${m.toNames?.join('、') ?? m.to.join('、')}` : '';
  return `[${who}${to}] ${m.text}`;
}

function buildPromptWithTail({ selfName, participantNames, messages, tail, limit }) {
  const preamble = [
    `你是 ${selfName}，正在一个多模型协作工作台中与用户和其他 AI 模型共同讨论。`,
    `参与者：用户、${participantNames.join('、')}（其中「${selfName}」是你本人）。`,
    '规则：',
    '- 下方对话记录每条都标注了发言者；[某模型] 开头的是其他模型的发言——不要冒充他人，不要把他人发言当作你说过的话',
    '- 延续你此前在本对话中的观点与风格；以对话口吻直接回复，简明为主，无需固定结构',
    '- 超出对话内信息的事实，照实说不知道；你的回复会以纯文本展示，不要用 markdown 链接语法',
    '',
  ].join('\n');
  const rendered = messages.map(m => ({ ...m, rendered: renderMessage(m) }));
  const headerLen = 40; // 「=== 对话记录 ... ===」行的预算
  const fit = fitHistory(rendered, { fixedLen: preamble.length + tail.length + headerLen, limit });
  if (fit.blocked) return { ...fit, prompt: '' };
  const shownMsgs = rendered.slice(fit.start);
  const header = fit.shown < fit.total
    ? `=== 对话记录（仅最近 ${fit.shown} 条，共 ${fit.total} 条）===`
    : `=== 对话记录 ===`;
  const body = shownMsgs.length ? `${header}\n${shownMsgs.map(m => m.rendered).join('\n')}\n` : '';
  return { ...fit, prompt: preamble + body + tail };
}

// 互聊轮到某模型发言时的指令：鼓励点名反驳/追问（防多模型假共识），收敛时主动终止（防烧额度）
export const RELAY_CONVERGED = '【无新增】';
export function buildRelayPrompt({ selfName, participantNames, messages, limit }) {
  const tail = `\n=== 现在轮到你发言 ===\n请直接回应上面的讨论，特别是其他参与者最近的发言：同意就在其基础上深化，不同意就点名反驳并给出理由，也可以向某位参与者提出具体问题。不要重复或笼统总结已有内容。若你认为讨论已经收敛、没有可新增的实质内容，只回复：${RELAY_CONVERGED}`;
  return buildPromptWithTail({ selfName, participantNames, messages, tail, limit });
}

export function buildWorkbenchPrompt({ selfName, participantNames, messages, text, limit }) {
  const tail = `\n=== 用户现在的消息（请你回复）===\n${text}\n\n请直接给出回复正文。`;
  return buildPromptWithTail({ selfName, participantNames, messages, tail, limit });
}

// arg 模式（prompt 走命令行参数）受 Windows ~32K 命令行总长限制；runner 在 30000 处硬护栏，
// 这里留出 argv 本身与安全余量。stdin 模式无此限制，给宽预算防失控。
export const promptLimitFor = cfg => (cfg.input === 'arg' ? 26000 : 150000);

// ---- 工作台：多模型群聊会话（与 Committee 平行的顶层会话类型，零共享状态） ----
export class Workbench {
  constructor({ name, agents, participants, baseDir, emit }) {
    Object.assign(this, { name, agents, participants, baseDir });
    this.emit = emit ?? (() => {});
    this.messages = []; // {seq, from:'user'|agentId, name, to?, toNames?, text, ts, ctx?}
    this.state = 'idle';
    this.dir = null;
    this.lastSpeaker = null; // 最近一次发言的模型 id（默认路由目标）
  }

  static async resume({ name, agents, participants, baseDir, emit, dir, messages }) {
    const w = new Workbench({ name, agents, participants, baseDir, emit });
    w.dir = dir;
    w.messages = messages;
    for (const m of messages) if (m.from !== 'user') w.lastSpeaker = m.from;
    return w;
  }

  async init() {
    this.dir = await createSessionDir(this.baseDir, '工作台-' + (this.name || '未命名'));
    await this.saveMeta();
  }

  async saveMeta() {
    await saveMetadata(this.dir, {
      type: 'workbench', topic: '[工作台] ' + (this.name || '未命名'),
      participants: this.participants, status: this.state === 'busy' ? 'busy' : 'idle',
      rounds: this.messages.length, updatedAt: new Date().toISOString(),
    });
  }

  async #persist(m) {
    await appendFile(path.join(this.dir, 'messages.jsonl'), redact(JSON.stringify(m)) + '\n', 'utf8');
  }

  nameOf(id) { return id === 'user' ? '用户' : (this.agents[id]?.name ?? id); }

  // 发一条消息：先落用户消息，再串行调用各收件人（不并发——控成本也控输出交错）
  async message(text, to = []) {
    if (this.state === 'busy') throw new Error('上一条消息还在处理中');
    const targets = (to.length ? to : [this.lastSpeaker ?? this.participants[0]]).filter(id => this.participants.includes(id));
    if (!targets.length) throw new Error('没有有效的收件人');
    this.state = 'busy';
    this.emit({ type: 'state', data: 'busy' });
    try {
      const userMsg = {
        seq: this.messages.length, from: 'user', name: '用户',
        to: targets, toNames: targets.map(id => this.nameOf(id)), text, ts: new Date().toISOString(),
      };
      this.messages.push(userMsg);
      await this.#persist(userMsg);
      this.emit({ type: 'chat-message', from: 'user', name: '用户', to: userMsg.toNames, data: text });
      for (const id of targets) {
        this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'running' });
        // 历史 = 本条用户消息之前的全部（当前消息在 tail 中单独呈现）
        const built = buildWorkbenchPrompt({
          selfName: this.nameOf(id),
          participantNames: this.participants.map(p => this.nameOf(p)),
          messages: this.messages.slice(0, -1),
          text, limit: promptLimitFor(this.agents[id]),
        });
        if (built.blocked) {
          // 双层硬阻断：绝不静默截断成空上下文（PREAMBLE_TOO_LONG / NOTHING_FITS）
          this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'failed:' + built.errorCode });
          this.emit({ type: 'error', agentId: id, data: built.errorCode === 'PREAMBLE_TOO_LONG' ? '消息本身超过该模型的长度上限，请缩短后重发' : '该模型的长度上限连一条历史都装不下——请缩短当前消息' });
          continue;
        }
        const seq = this.messages.length;
        await savePrompt(this.dir, `m${seq}`, id, built.prompt);
        const r = await runAgent(this.agents[id], built.prompt);
        await saveRaw(this.dir, `m${seq}`, id, r.raw || r.text || r.error || '');
        if (!r.ok) {
          this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'failed:' + r.error });
          this.emit({ type: 'error', agentId: id, data: r.error });
          continue;
        }
        const ctx = built.shown < built.total ? { shown: built.shown, total: built.total } : undefined;
        const reply = { seq, from: id, name: this.nameOf(id), text: r.text.trim(), ts: new Date().toISOString(), ...(ctx ? { ctx } : {}) };
        this.messages.push(reply);
        this.lastSpeaker = id;
        await this.#persist(reply);
        this.emit({ type: 'chat-message', from: id, name: reply.name, data: reply.text, ...(ctx ? { ctx } : {}) });
        this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'done' });
      }
    } finally {
      this.state = 'idle';
      this.emit({ type: 'state', data: 'idle' });
      await this.saveMeta();
    }
  }

  // 互聊：模型之间按顺序接力发言 n 轮，每人都看到此前全部讨论（含上一位刚说的话）。
  // 串行 + 可随时停 + 收敛自动终止——三重成本刹车。
  async relay(rounds, order = []) {
    if (this.state === 'busy') throw new Error('上一条消息还在处理中');
    const circle = (order.length ? order : this.participants).filter(id => this.participants.includes(id));
    if (new Set(circle).size < 2) throw new Error('互聊至少需要两个模型');
    const n = Math.min(Math.max(Number(rounds) || 1, 1), 8);
    this.state = 'busy';
    this.stopped = false;
    this.aborter = new AbortController();
    this.emit({ type: 'state', data: 'busy' });
    this.emit({ type: 'sys', data: `互聊开始：${circle.map(id => this.nameOf(id)).join(' → ')}，至多 ${n} 轮` });
    let ended = '完成';
    try {
      outer: for (let r = 0; r < n; r++) {
        for (const id of circle) {
          if (this.stopped) { ended = '已停止'; break outer; }
          this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'running' });
          const built = buildRelayPrompt({
            selfName: this.nameOf(id),
            participantNames: this.participants.map(p => this.nameOf(p)),
            messages: this.messages, limit: promptLimitFor(this.agents[id]),
          });
          if (built.blocked) {
            this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'failed:' + built.errorCode });
            this.emit({ type: 'error', agentId: id, data: '上下文超出该模型长度上限，互聊终止' });
            ended = '因长度上限终止';
            break outer;
          }
          const seq = this.messages.length;
          await savePrompt(this.dir, `m${seq}`, id, built.prompt);
          const res = await runAgent(this.agents[id], built.prompt, { signal: this.aborter.signal });
          await saveRaw(this.dir, `m${seq}`, id, res.raw || res.text || res.error || '');
          if (!res.ok) {
            this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'failed:' + res.error });
            if (res.error === 'aborted') { ended = '已停止'; break outer; }
            this.emit({ type: 'error', agentId: id, data: res.error });
            continue; // 单模型失败不终止整场互聊
          }
          const text = res.text.trim();
          const ctx = built.shown < built.total ? { shown: built.shown, total: built.total } : undefined;
          const reply = { seq, from: id, name: this.nameOf(id), text, ts: new Date().toISOString(), ...(ctx ? { ctx } : {}) };
          this.messages.push(reply);
          this.lastSpeaker = id;
          await this.#persist(reply);
          this.emit({ type: 'chat-message', from: id, name: reply.name, data: text, ...(ctx ? { ctx } : {}) });
          this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'done' });
          if (text.startsWith(RELAY_CONVERGED)) { ended = `${this.nameOf(id)} 判断讨论已收敛`; break outer; }
        }
      }
    } finally {
      this.state = 'idle';
      this.aborter = null;
      this.emit({ type: 'sys', data: '互聊结束（' + ended + '）' });
      this.emit({ type: 'state', data: 'idle' });
      await this.saveMeta();
    }
  }

  stop() { this.stopped = true; this.aborter?.abort(); }

  // 升格材料：把对话史打包成会议简报草稿（用户在建会表单里可编辑）
  promoteMaterials(maxMessages = 60) {
    const tail = this.messages.slice(-maxMessages);
    const lines = tail.map(m => renderMessage(m));
    const omitted = this.messages.length - tail.length;
    return `# 工作台讨论记录（升格为正式会议）\n\n${omitted > 0 ? `（更早的 ${omitted} 条从略）\n\n` : ''}${lines.join('\n\n')}\n\n---\n以上为工作台自由讨论的原始记录。请围绕其中的分歧与未决问题展开正式辩论。`;
  }
}

// 从磁盘恢复工作台会话（跨重启）
export async function loadWorkbenchFromDisk(dir) {
  const meta = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8'));
  if (meta.type !== 'workbench') throw new Error('该目录不是工作台会话');
  let messages = [];
  try {
    messages = (await readFile(path.join(dir, 'messages.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { /* 尚无消息 */ }
  return { meta, messages };
}
