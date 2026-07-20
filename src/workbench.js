import path from 'node:path';
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { runAgent } from './runner.js';
import { redact } from './redactor.js';
import { createSessionDir, saveMetadata, savePrompt, saveRaw } from './store.js';
import { isGitRepo, createWorktree, captureDiff, removeWorktree, applyPatch, syncWorktreeWithMain, runCommand } from './worktree.js';

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

// 会话语言相关的固定串（发给模型的 / 进对话历史的，按会话语言）
export const userLabel = lang => (lang === 'en' ? 'User' : '用户');
export const RELAY_CONVERGED = { zh: '【无新增】', en: '[NOTHING NEW]' };
export const relayConvergedFor = lang => (lang === 'en' ? RELAY_CONVERGED.en : RELAY_CONVERGED.zh);

const WB_L = {
  zh: {
    preamble: (self, names) => [
      `你是 ${self}，正在一个多模型协作工作台中与用户和其他 AI 模型共同讨论。`,
      `参与者：用户、${names.join('、')}（其中「${self}」是你本人）。`,
      '规则：',
      '- 下方对话记录每条都标注了发言者；[某模型] 开头的是其他模型的发言——不要冒充他人，不要把他人发言当作你说过的话',
      '- 延续你此前在本对话中的观点与风格；以对话口吻直接回复，简明为主，无需固定结构',
      '- 超出对话内信息的事实，照实说不知道；你的回复会以纯文本展示，不要用 markdown 链接语法',
      '- 全程用中文回复（即使你的个人/全局 CLI 配置默认了其他语言）',
      '',
    ].join('\n'),
    header: (shown, total) => (shown < total ? `=== 对话记录（仅最近 ${shown} 条，共 ${total} 条）===` : `=== 对话记录 ===`),
    relayTail: lang => `\n=== 现在轮到你发言 ===\n请直接回应上面的讨论，特别是其他参与者最近的发言：同意就在其基础上深化，不同意就点名反驳并给出理由，也可以向某位参与者提出具体问题。不要重复或笼统总结已有内容。若你认为讨论已经收敛、没有可新增的实质内容，只回复：${relayConvergedFor(lang)}`,
    msgTail: text => `\n=== 用户现在的消息（请你回复）===\n${text}\n\n请直接给出回复正文。`,
    prevPatchNote: (status, patch, truncated) => `\n\n=== 你（或同伴）上一次动手产出的 diff（${status === 'pending' ? '用户尚未应用' : '已被用户丢弃'}，当前文件里没有这些改动）===\n${patch}${truncated ? '\n（diff 过长已截断）' : ''}\n=== 上一次 diff 结束——若本次任务是修正它，请在其基础上改进 ===`,
    buildTail: (instruction, prevPatchNote) => [
      '\n=== 动手任务（你现在拥有写权限）===',
      '你的当前工作目录是该项目的一个隔离副本（已同步主工作区最新状态），你拥有完整读写权限；你的修改不会直接影响主项目——完成后会生成 diff 交由用户审阅决定是否应用。',
      '要求：',
      '- 只做任务要求的事，不顺手重构无关代码',
      '- 不要执行任何 git 提交/推送类操作',
      '- 完成后用几句话说明：改了哪些文件、为什么这么改、用户应重点检查什么（说明用中文写）',
      `任务：${instruction}`,
      prevPatchNote,
    ].join('\n'),
  },
  en: {
    preamble: (self, names) => [
      `You are ${self}, discussing with the user and other AI models in a multi-model collaboration workbench.`,
      `Participants: User, ${names.join(', ')} (of whom "${self}" is you).`,
      'Rules:',
      '- Each line below is labeled with its speaker; lines starting with [SomeModel] are other models — do not impersonate anyone, do not treat their words as your own.',
      '- Continue your own view and style from earlier in this conversation; reply conversationally, concise, no fixed structure.',
      "- For facts beyond this conversation, say you don't know; your reply is shown as plain text, so don't use markdown link syntax.",
      '- Reply in English throughout, even if your personal/global CLI configuration defaults to another language.',
      '',
    ].join('\n'),
    header: (shown, total) => (shown < total ? `=== Conversation (last ${shown} of ${total} messages) ===` : `=== Conversation ===`),
    relayTail: lang => `\n=== Now it's your turn ===\nRespond directly to the discussion above, especially the most recent messages: if you agree, build on them; if you disagree, rebut by name with reasons; you may ask a participant a specific question. Don't repeat or vaguely summarize. If you think the discussion has converged with nothing substantive to add, reply only: ${relayConvergedFor(lang)}`,
    msgTail: text => `\n=== The user's message now (please reply) ===\n${text}\n\nGive your reply directly.`,
    prevPatchNote: (status, patch, truncated) => `\n\n=== The diff from the previous build by you (or a peer) (${status === 'pending' ? 'not yet applied by the user' : 'discarded by the user'} — the current files do NOT contain these changes) ===\n${patch}${truncated ? '\n(diff truncated — too long)' : ''}\n=== End of previous diff — if this task is a fix to it, improve on that basis ===`,
    buildTail: (instruction, prevPatchNote) => [
      '\n=== Build task (you now have write access) ===',
      "Your current working directory is an isolated copy of the project (synced to the main workspace's latest state) with full read-write access; your changes never touch the main project directly — a diff is produced for the user to review and apply.",
      'Requirements:',
      '- Do only what the task asks; no drive-by refactoring of unrelated code',
      '- Do not run any git commit/push operations',
      '- When done, explain in a few sentences: which files you changed, why, and what the user should double-check (write the explanation in English, even if your personal/global CLI configuration defaults to another language)',
      `Task: ${instruction}`,
      prevPatchNote,
    ].join('\n'),
  },
};
const wbL = lang => WB_L[lang] ?? WB_L.zh;

// 对话史纯文本位置化渲染（共识：发言者/收件人显式标注，防冒充/防混淆）
export function renderMessage(m, lang = 'zh') {
  const who = m.from === 'user' ? userLabel(lang) : m.name;
  const sep = lang === 'en' ? ', ' : '、';
  const to = m.from === 'user' && m.to?.length ? ` → ${m.toNames?.join(sep) ?? m.to.join(sep)}` : '';
  return `[${who}${to}] ${m.text}`;
}

function buildPromptWithTail({ selfName, participantNames, messages, tail, limit, lang = 'zh' }) {
  const s = wbL(lang);
  const preamble = s.preamble(selfName, participantNames);
  const rendered = messages.map(m => ({ ...m, rendered: renderMessage(m, lang) }));
  const headerLen = 40; // 对话记录标题行的预算
  const fit = fitHistory(rendered, { fixedLen: preamble.length + tail.length + headerLen, limit });
  if (fit.blocked) return { ...fit, prompt: '' };
  const shownMsgs = rendered.slice(fit.start);
  const header = s.header(fit.shown, fit.total);
  const body = shownMsgs.length ? `${header}\n${shownMsgs.map(m => m.rendered).join('\n')}\n` : '';
  return { ...fit, prompt: preamble + body + tail };
}

// 互聊轮到某模型发言时的指令：鼓励点名反驳/追问（防多模型假共识），收敛时主动终止（防烧额度）
export function buildRelayPrompt({ selfName, participantNames, messages, limit, lang = 'zh' }) {
  return buildPromptWithTail({ selfName, participantNames, messages, tail: wbL(lang).relayTail(lang), limit, lang });
}

export function buildWorkbenchPrompt({ selfName, participantNames, messages, text, limit, lang = 'zh' }) {
  return buildPromptWithTail({ selfName, participantNames, messages, tail: wbL(lang).msgTail(text), limit, lang });
}

// arg 模式（prompt 走命令行参数）受 Windows ~32K 命令行总长限制；runner 在 30000 处硬护栏，
// 这里留出 argv 本身与安全余量。stdin 模式无此限制，给宽预算防失控。
export const promptLimitFor = cfg => (cfg.input === 'arg' ? 26000 : 150000);

// 把整体 patch 按文件切分（git 的 diff --git 头是文件段落边界，二进制段同样适用）。
// 路径解析兼容带引号形式（"a/中文.md"）作为 core.quotepath 之外的兜底
export function splitPatchByFile(patch) {
  return patch.split(/(?=^diff --git )/m).filter(s => s.trim()).map(seg => {
    const m = /^diff --git "?a\/(.+?)"? "?b\//.exec(seg);
    return { path: m ? m[1] : '(unknown)', patch: seg };
  });
}

// ---- 工作台：多模型群聊会话（与 Committee 平行的顶层会话类型，零共享状态） ----
export class Workbench {
  constructor({ name, agents, participants, baseDir, emit, workspace = '', writeAgents = {}, lang = 'zh' }) {
    Object.assign(this, { name, agents, participants, baseDir, workspace, writeAgents, lang });
    this.emit = emit ?? (() => {});
    this.messages = []; // {seq, from:'user'|agentId, name, to?, toNames?, text, ts, ctx?, build?}
    this.builds = []; // {buildId, agentId, instruction, stat, status: pending|applied|discarded, ts}
    this.buildSessions = {}; // agentId -> {sessionId, lastSeq}：动手会话续接（CLI 原生记忆），持久化于 metadata
    this.state = 'idle';
    this.dir = null;
    this.lastSpeaker = null; // 最近一次发言的模型 id（默认路由目标）
  }

  static async resume({ name, agents, participants, baseDir, emit, dir, messages, workspace = '', writeAgents = {}, builds = [], buildSessions = {}, lang = 'zh' }) {
    const w = new Workbench({ name, agents, participants, baseDir, emit, workspace, writeAgents, lang });
    w.dir = dir;
    w.messages = messages;
    w.builds = builds;
    w.buildSessions = buildSessions;
    for (const m of messages) if (m.from !== 'user') w.lastSpeaker = m.from;
    return w;
  }

  async init() {
    this.dir = await createSessionDir(this.baseDir, this.tr('工作台-', 'workbench-') + (this.name || this.tr('未命名', 'unnamed')));
    await this.saveMeta();
  }

  async saveMeta() {
    await saveMetadata(this.dir, {
      type: 'workbench', topic: '[工作台] ' + (this.name || this.tr('未命名', 'unnamed')), // 前缀是规范内部标记（resume/侧栏 strip 依赖），不本地化
      participants: this.participants, status: this.state === 'busy' ? 'busy' : 'idle',
      workspace: this.workspace, buildSessions: this.buildSessions, lang: this.lang,
      rounds: this.messages.length, updatedAt: new Date().toISOString(),
    });
  }

  async #saveBuilds() {
    await writeFile(path.join(this.dir, 'builds.jsonl'), this.builds.map(b => JSON.stringify(b)).join('\n') + (this.builds.length ? '\n' : ''), 'utf8');
  }

  patchPathOf(buildId) { return path.join(this.dir, 'builds', buildId + '.patch'); }

  async #persist(m) {
    await appendFile(path.join(this.dir, 'messages.jsonl'), redact(JSON.stringify(m)) + '\n', 'utf8');
  }

  nameOf(id) { return id === 'user' ? userLabel(this.lang) : (this.agents[id]?.name ?? id); }
  get en() { return this.lang === 'en'; }
  tr(zh, en) { return this.en ? en : zh; }
  // 会话语言的运行时 error（含后端信息，后端按会话语言渲染）
  #blockedMsg(code) {
    if (this.en) return code === 'PREAMBLE_TOO_LONG' ? "Your message alone exceeds this model's length limit — shorten and resend." : "This model's length limit can't fit even one history message — shorten the current message.";
    return code === 'PREAMBLE_TOO_LONG' ? '消息本身超过该模型的长度上限，请缩短后重发' : '该模型的长度上限连一条历史都装不下——请缩短当前消息';
  }

  // 发一条消息：先落用户消息，再串行调用各收件人（不并发——控成本也控输出交错）
  async message(text, to = []) {
    if (this.state === 'busy') throw new Error(this.en ? 'The previous message is still processing' : '上一条消息还在处理中');
    const targets = (to.length ? to : [this.lastSpeaker ?? this.participants[0]]).filter(id => this.participants.includes(id));
    if (!targets.length) throw new Error(this.en ? 'No valid recipient' : '没有有效的收件人');
    this.state = 'busy';
    this.emit({ type: 'state', data: 'busy' });
    try {
      const uname = userLabel(this.lang);
      const userMsg = {
        seq: this.messages.length, from: 'user', name: uname,
        to: targets, toNames: targets.map(id => this.nameOf(id)), text, ts: new Date().toISOString(),
      };
      this.messages.push(userMsg);
      await this.#persist(userMsg);
      this.emit({ type: 'chat-message', from: 'user', name: uname, to: userMsg.toNames, data: text });
      for (const id of targets) {
        this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'running' });
        // 历史 = 本条用户消息之前的全部（当前消息在 tail 中单独呈现）
        const built = buildWorkbenchPrompt({
          selfName: this.nameOf(id),
          participantNames: this.participants.map(p => this.nameOf(p)),
          messages: this.messages.slice(0, -1),
          text, limit: promptLimitFor(this.agents[id]), lang: this.lang,
        });
        if (built.blocked) {
          // 双层硬阻断：绝不静默截断成空上下文（PREAMBLE_TOO_LONG / NOTHING_FITS）
          this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'failed:' + built.errorCode });
          this.emit({ type: 'error', agentId: id, data: this.#blockedMsg(built.errorCode) });
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
    if (this.state === 'busy') throw new Error(this.tr('上一条消息还在处理中', 'The previous message is still processing'));
    const circle = (order.length ? order : this.participants).filter(id => this.participants.includes(id));
    if (new Set(circle).size < 2) throw new Error(this.tr('互聊至少需要两个模型', 'Relay needs at least two models'));
    const n = Math.min(Math.max(Number(rounds) || 1, 1), 8);
    this.state = 'busy';
    this.stopped = false;
    this.aborter = new AbortController();
    this.emit({ type: 'state', data: 'busy' });
    this.emit({ type: 'sys', data: this.tr(`互聊开始：${circle.map(id => this.nameOf(id)).join(' → ')}，至多 ${n} 轮`, `Relay started: ${circle.map(id => this.nameOf(id)).join(' → ')}, up to ${n} rounds`) });
    let ended = this.tr('完成', 'finished');
    try {
      outer: for (let r = 0; r < n; r++) {
        for (const id of circle) {
          if (this.stopped) { ended = this.tr('已停止', 'stopped'); break outer; }
          this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'running' });
          const built = buildRelayPrompt({
            selfName: this.nameOf(id),
            participantNames: this.participants.map(p => this.nameOf(p)),
            messages: this.messages, limit: promptLimitFor(this.agents[id]), lang: this.lang,
          });
          if (built.blocked) {
            this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'failed:' + built.errorCode });
            this.emit({ type: 'error', agentId: id, data: this.tr('上下文超出该模型长度上限，互聊终止', "Context exceeds this model's length limit — relay stopped") });
            ended = this.tr('因长度上限终止', 'stopped: length limit');
            break outer;
          }
          const seq = this.messages.length;
          await savePrompt(this.dir, `m${seq}`, id, built.prompt);
          const res = await runAgent(this.agents[id], built.prompt, { signal: this.aborter.signal });
          await saveRaw(this.dir, `m${seq}`, id, res.raw || res.text || res.error || '');
          if (!res.ok) {
            this.emit({ type: 'agent-status', agentId: id, label: 'wb', data: 'failed:' + res.error });
            if (res.error === 'aborted') { ended = this.tr('已停止', 'stopped'); break outer; }
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
          // 收敛标记两种语言都认：模型偶尔会无视会话语言用另一种标记回复
          if (text.startsWith(RELAY_CONVERGED.zh) || text.startsWith(RELAY_CONVERGED.en)) { ended = this.tr(`${this.nameOf(id)} 判断讨论已收敛`, `${this.nameOf(id)} judged the discussion converged`); break outer; }
        }
      }
    } finally {
      this.state = 'idle';
      this.aborter = null;
      this.emit({ type: 'sys', data: this.tr('互聊结束（' + ended + '）', 'Relay ended (' + ended + ')') });
      this.emit({ type: 'state', data: 'idle' });
      await this.saveMeta();
    }
  }

  stop() { this.stopped = true; this.aborter?.abort(); }

  // 动手：指定模型在 git worktree 隔离副本里真实改文件 → 捕获 diff → 立即销毁副本。
  // 主工作区零接触；一切写入等用户对 patch 逐次批准（applyBuild）。
  async build(instruction, agentId) {
    if (this.state === 'busy') throw new Error(this.tr('上一条消息还在处理中', 'The previous message is still processing'));
    const wcfg = this.writeAgents[agentId];
    if (!wcfg) throw new Error(this.tr('该模型不支持动手（无安全写模式）', 'This model cannot build (no safe write mode)'));
    if (!this.workspace) throw new Error(this.tr('该工作台未挂载项目目录——动手需要在建台时填写项目目录', 'No project directory mounted — building requires one set at workbench creation'));
    if (!(await isGitRepo(this.workspace))) throw new Error(this.tr('项目目录不是 git 仓库——动手依赖 git worktree 隔离副本', 'The project directory is not a git repo — building relies on a git worktree isolated copy'));
    this.state = 'busy';
    this.aborter = new AbortController();
    this.emit({ type: 'state', data: 'busy' });
    const name = this.nameOf(agentId);
    let wt = null;
    try {
      const uname = userLabel(this.lang);
      const userMsg = {
        seq: this.messages.length, from: 'user', name: uname,
        to: [agentId], toNames: [name + this.tr('·动手', ' · build')], text: instruction, ts: new Date().toISOString(),
      };
      this.messages.push(userMsg);
      await this.#persist(userMsg);
      this.emit({ type: 'chat-message', from: 'user', name: uname, to: userMsg.toNames, data: instruction });
      this.emit({ type: 'agent-status', agentId, label: 'wb', data: 'running' });
      this.emit({ type: 'sys', data: this.tr(`${name} 开始动手（隔离副本，主工作区零接触）…`, `${name} started building (isolated copy — main workspace untouched)…`) });

      // 二次修改上下文：上一个 build 还在待批/被丢弃时，把那份 diff 附上——新任务很可能是对它的修正
      let prevPatchNote = '';
      const lastBuild = this.builds.at(-1);
      if (lastBuild && ['pending', 'discarded'].includes(lastBuild.status)) {
        try {
          const prev = await readFile(this.patchPathOf(lastBuild.buildId), 'utf8');
          prevPatchNote = wbL(this.lang).prevPatchNote(lastBuild.status, prev.slice(0, 6000), prev.length > 6000);
        } catch { /* patch 文件缺失则不附 */ }
      }
      const tail = wbL(this.lang).buildTail(instruction, prevPatchNote);
      // 会话续接：该模型此前动手过且适配器支持续接 → 复用 CLI 原生会话
      //（模型记得它翻过的文件与项目结构），上下文只需带上次动手之后的新消息
      const sess = wcfg.resumeArgs ? this.buildSessions[agentId] : null;
      const useResume = !!sess?.sessionId;
      const promptOpts = msgs => ({
        selfName: name,
        participantNames: this.participants.map(p => this.nameOf(p)),
        messages: msgs, tail, limit: promptLimitFor(wcfg), lang: this.lang,
      });
      const built = buildPromptWithTail(promptOpts(useResume ? this.messages.slice(sess.lastSeq, -1) : this.messages.slice(0, -1)));
      if (built.blocked) throw new Error(this.tr('上下文超出该模型长度上限，无法动手', "Context exceeds this model's length limit — cannot build"));

      wt = await createWorktree(this.workspace);
      // 副本继承主工作区未提交状态（你「应用了但没 commit」的上次成果，这次动手才看得见）
      try { await syncWorktreeWithMain(this.workspace, wt); }
      catch (e) { this.emit({ type: 'sys', data: this.tr('副本未能带上主工作区未提交的改动（' + String(e.message ?? e).slice(0, 80) + '）——本次动手基于最近一次提交', "The copy couldn't carry the main workspace's uncommitted changes (" + String(e.message ?? e).slice(0, 80) + ') — this build starts from the latest commit') }); }
      const seq = this.messages.length;
      const buildId = 'b' + seq + Date.now().toString(36).slice(-4);
      await savePrompt(this.dir, `build-${buildId}`, agentId, built.prompt);
      const runOpts = {
        signal: this.aborter.signal,
        toolMarkers: true, // 实时可视：工具活动（正在改哪个文件）推给前端
        onChunk: t => this.emit({ type: 'build-progress', agentId, data: t }),
      };
      const cfgRun = { ...wcfg, cwd: wt };
      if (useResume) cfgRun.command = [...cfgRun.command, ...wcfg.resumeArgs.map(a => a.replaceAll('{SESSION_ID}', sess.sessionId))];
      let res = await runAgent(cfgRun, built.prompt, runOpts);
      if (!res.ok && useResume && res.error !== 'aborted') {
        // 续接失败（会话过期/CLI 升级等）→ 明示并用全新会话+全量上下文重试一次
        this.emit({ type: 'sys', data: this.tr(`会话续接失败（${res.error}），改用全新会话重试…`, `Session resume failed (${res.error}) — retrying with a fresh session…`) });
        delete this.buildSessions[agentId];
        const full = buildPromptWithTail(promptOpts(this.messages.slice(0, -1)));
        if (!full.blocked) {
          await savePrompt(this.dir, `build-${buildId}retry`, agentId, full.prompt);
          res = await runAgent({ ...wcfg, cwd: wt }, full.prompt, runOpts);
        }
      }
      await saveRaw(this.dir, `build-${buildId}`, agentId, res.raw || res.text || res.error || '');
      if (!res.ok) {
        this.emit({ type: 'agent-status', agentId, label: 'wb', data: 'failed:' + res.error });
        this.emit({ type: 'error', agentId, data: this.tr('动手失败: ', 'Build failed: ') + res.error });
        return;
      }
      const { stat, patch } = await captureDiff(wt);
      const summary = res.text.trim() || this.tr('（模型未输出说明）', '(the model gave no explanation)');
      if (!patch.trim()) {
        const reply = { seq, from: agentId, name, text: summary, ts: new Date().toISOString() };
        this.messages.push(reply);
        this.lastSpeaker = agentId;
        if (res.sessionId) this.buildSessions[agentId] = { sessionId: res.sessionId, lastSeq: this.messages.length };
        await this.#persist(reply);
        this.emit({ type: 'chat-message', from: agentId, name, data: summary });
        this.emit({ type: 'sys', data: this.tr('动手完成，但没有产生任何文件改动', 'Build finished, but no file changes were produced') });
        this.emit({ type: 'agent-status', agentId, label: 'wb', data: 'done' });
        return;
      }
      await mkdir(path.join(this.dir, 'builds'), { recursive: true });
      await writeFile(this.patchPathOf(buildId), redact(patch), 'utf8');
      const files = splitPatchByFile(patch).map(f => ({ path: f.path, status: 'pending' }));
      const record = { buildId, agentId, instruction: instruction.slice(0, 200), stat, status: 'pending', files, ts: new Date().toISOString() };
      this.builds.push(record);
      await this.#saveBuilds();
      const reply = { seq, from: agentId, name, text: summary, ts: new Date().toISOString(), build: buildId };
      this.messages.push(reply);
      this.lastSpeaker = agentId;
      if (res.sessionId) this.buildSessions[agentId] = { sessionId: res.sessionId, lastSeq: this.messages.length };
      await this.#persist(reply);
      this.emit({ type: 'chat-message', from: agentId, name, data: summary, build: { buildId, stat, status: 'pending', files, patch: patch.slice(0, 200000) } });
      this.emit({ type: 'agent-status', agentId, label: 'wb', data: 'done' });
    } finally {
      if (wt) await removeWorktree(this.workspace, wt).catch(() => {}); // 用完即毁：patch 是唯一事实源
      this.state = 'idle';
      this.aborter = null;
      this.emit({ type: 'state', data: 'idle' });
      await this.saveMeta();
    }
  }

  #buildRecordOf(buildId) {
    const b = this.builds.find(x => x.buildId === buildId);
    if (!b) throw new Error(this.tr('该 diff 不存在', 'No such diff'));
    if (!b.files) b.files = [{ path: '(全部)', status: b.status }]; // 旧记录兼容
    return b;
  }

  // 整体状态由文件状态推导：全应用=applied，全丢弃=discarded，有过动作但还有剩=partial
  #recalcBuildStatus(b) {
    if (b.files.every(f => f.status === 'applied')) b.status = 'applied';
    else if (b.files.every(f => f.status === 'discarded')) b.status = 'discarded';
    else if (b.files.some(f => f.status !== 'pending')) b.status = 'partial';
    else b.status = 'pending';
  }

  // 应用（可按文件）：filePaths 省略 = 应用全部待批文件；选中的文件子集作为一个原子 patch 应用
  async applyBuild(buildId, filePaths = null) {
    const b = this.#buildRecordOf(buildId);
    const targets = b.files.filter(f => f.status === 'pending' && (!filePaths || filePaths.includes(f.path)));
    if (!targets.length) throw new Error(this.tr('没有可应用的文件（已应用或已丢弃）', 'No files left to apply (already applied or discarded)'));
    const patch = await readFile(this.patchPathOf(buildId), 'utf8');
    const segs = splitPatchByFile(patch);
    const sub = b.files.length === 1 && b.files[0].path === '(全部)'
      ? patch
      : segs.filter(s => targets.some(t => t.path === s.path)).map(s => s.patch).join('');
    if (!sub.trim()) throw new Error(this.tr('patch 内容缺失', 'Patch content missing'));
    await applyPatch(this.workspace, sub); // 冲突则该子集整体失败抛错，绝不半套用
    for (const f of targets) f.status = 'applied';
    this.#recalcBuildStatus(b);
    await this.#saveBuilds();
    this.emit({ type: 'build-status', buildId, status: b.status, files: b.files });
    this.emit({ type: 'sys', data: this.tr(`已应用 ${targets.length} 个文件到主工作区（未提交——commit 权在你自己的 git 流程里）`, `Applied ${targets.length} file(s) to the main workspace (uncommitted — committing stays in your own git flow)`) });
  }

  // 应用前检查：临时副本 = 主工作区状态 + 该 build 的待批改动，在其中运行用户提供的命令
  //（构建/测试），结果回报聊天流。副本随查随毁，主工作区零接触。
  async checkBuild(buildId, cmd) {
    if (this.state === 'busy') throw new Error(this.tr('上一条消息还在处理中', 'The previous message is still processing'));
    if (!String(cmd ?? '').trim()) throw new Error(this.tr('检查命令不能为空', 'Check command cannot be empty'));
    const b = this.#buildRecordOf(buildId);
    const pending = b.files.filter(f => f.status === 'pending');
    if (!pending.length) throw new Error(this.tr('该 diff 已无待批文件可检查', 'No pending files left in this diff to check'));
    this.state = 'busy';
    this.aborter = new AbortController();
    this.emit({ type: 'state', data: 'busy' });
    this.emit({ type: 'sys', data: this.tr(`正在临时副本中运行检查：${cmd}`, `Running check in a temporary copy: ${cmd}`) });
    let wt = null;
    try {
      wt = await createWorktree(this.workspace);
      try { await syncWorktreeWithMain(this.workspace, wt); } catch { /* 干净 HEAD 兜底 */ }
      const patch = await readFile(this.patchPathOf(buildId), 'utf8');
      const segs = splitPatchByFile(patch);
      const sub = b.files.length === 1 && b.files[0].path === '(全部)'
        ? patch
        : segs.filter(s => pending.some(t => t.path === s.path)).map(s => s.patch).join('');
      await applyPatch(wt, sub);
      const r = await runCommand(wt, cmd, { signal: this.aborter.signal });
      const ok = r.code === 0;
      b.check = { cmd: String(cmd).slice(0, 200), ok, ts: new Date().toISOString() };
      await this.#saveBuilds();
      this.emit({ type: 'check-result', buildId, ok, code: r.code, cmd, output: r.output.slice(-8000), ...(r.timedOut ? { timedOut: true } : {}) });
      this.emit({ type: 'sys', data: r.timedOut ? this.tr('检查超时（5 分钟）已中止', 'Check timed out (5 min) — aborted') : (ok ? this.tr('检查通过 ✓', 'Check passed ✓') : this.tr(`检查未通过 ✗（exit ${r.code}）`, `Check failed ✗ (exit ${r.code})`)) });
    } finally {
      if (wt) await removeWorktree(this.workspace, wt).catch(() => {});
      this.state = 'idle';
      this.aborter = null;
      this.emit({ type: 'state', data: 'idle' });
    }
  }

  async discardBuild(buildId, filePaths = null) {
    const b = this.#buildRecordOf(buildId);
    const targets = b.files.filter(f => f.status === 'pending' && (!filePaths || filePaths.includes(f.path)));
    if (!targets.length) throw new Error(this.tr('没有可丢弃的文件', 'No files left to discard'));
    for (const f of targets) f.status = 'discarded';
    this.#recalcBuildStatus(b);
    await this.#saveBuilds(); // patch 文件保留作审计，仅标记状态
    this.emit({ type: 'build-status', buildId, status: b.status, files: b.files });
    this.emit({ type: 'sys', data: this.tr(`已丢弃 ${targets.length} 个文件的改动（patch 保留在会话目录可手工找回）`, `Discarded changes to ${targets.length} file(s) (the patch stays in the session dir for manual recovery)`) });
  }

  // 静默注入一条用户侧消息（落盘+广播，不触发任何模型调用）——裁决卡回流等场景用
  async note(text) {
    const uname = userLabel(this.lang);
    const m = { seq: this.messages.length, from: 'user', name: uname, text, ts: new Date().toISOString() };
    this.messages.push(m);
    await this.#persist(m);
    this.emit({ type: 'chat-message', from: 'user', name: uname, data: text });
    await this.saveMeta();
  }

  // 升格材料：把对话史打包成会议简报草稿（用户在建会表单里可编辑）
  promoteMaterials(maxMessages = 60) {
    const tail = this.messages.slice(-maxMessages);
    const lines = tail.map(m => renderMessage(m, this.lang));
    const omitted = this.messages.length - tail.length;
    if (this.en) return `# Workbench discussion log (promoted to a formal meeting)\n\n${omitted > 0 ? `(${omitted} earlier messages omitted)\n\n` : ''}${lines.join('\n\n')}\n\n---\nThe above is the raw record of the workbench free discussion. Debate formally around its disagreements and open questions.`;
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
  let builds = [];
  try {
    builds = (await readFile(path.join(dir, 'builds.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { /* 尚无动手记录 */ }
  return { meta, messages, builds };
}
