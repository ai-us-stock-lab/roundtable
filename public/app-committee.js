// ===== 委员会（会议）：辩手栏渲染 / 群聊 / 事件路由 / 会话生命周期 / 会议按钮 =====

// ---- 会议模块内部状态 ----
let roundDivs = {};
const badgeTimers = {}; // 运行计时器：running 徽标每秒更新耗时
let typingEls = {};     // agentId -> "正在输入…" 提示元素（群聊）

const api = (action, body) => fetch(`/api/sessions/${sid}/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).catch(e => setStatebar(t('dyn.netErr', { msg: e.message }), true));

// 项目对话侧的 AI 通过 POST /api/draft 预存议题+简报，并打开 /#draft=<id>——这里取回填入表单
async function applyDraftFromHash() {
  const m = /[#&]draft=([a-z0-9]+)/.exec(location.hash);
  if (!m) return;
  try {
    const d = await (await fetch('/api/draft/' + m[1])).json();
    if (d.error) return setStatebar(t('dyn.draftExpired'), true);
    $('#topic').value = d.topic ?? '';
    $('#materials').value = d.materials ?? '';
    // 发起方建议的模板也一并选好（例如项目会诊）——模板选错会导致顾问输出结构完全不对题
    if (d.template && [...$('#tpl').options].some(o => o.value === d.template)) $('#tpl').value = d.template;
    if (d.workspace) $('#workspace').value = d.workspace;
    draftOrigin = d.originBench ?? null;
    draftLang = d.lang === 'en' || d.lang === 'zh' ? d.lang : null; // 升格草稿带来源工作台的会话语言，建会时优先于 UI 语言
    setStatebar(t('dyn.draftFilled'));
  } catch { /* 服务波动时静默，用户可手动填 */ }
  history.replaceState(null, '', location.pathname); // 用后清掉 hash，防刷新重复提示
}

function feed(side) { return $(side === 'A' ? '#colA .feed' : '#colB .feed'); }
function badge(side) { return $(side === 'A' ? '#colA .badge' : '#colB .badge'); }

function startBadgeTimer(side) {
  const t0 = Date.now();
  badge(side).textContent = t('dyn.running', { t: '0s' });
  badgeTimers[side] = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    badge(side).textContent = t('dyn.running', { t: (s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's') });
  }, 1000);
}
function stopBadgeTimer(side) { if (badgeTimers[side]) { clearInterval(badgeTimers[side]); delete badgeTimers[side]; } }

function ensureRoundDiv(side, label) {
  const key = side + label;
  if (!roundDivs[key]) {
    // 整轮用 <details> 包裹：可整体折叠
    const d = document.createElement('details');
    d.className = 'round';
    d.open = true;
    const sum = document.createElement('summary');
    sum.textContent = label;
    const pre = document.createElement('pre');
    d.appendChild(sum);
    d.appendChild(pre);
    feed(side).appendChild(d);
    roundDivs[key] = pre;
    // 栏头加该轮的快速跳转按钮（栏头是 sticky 的，按钮始终可见）
    const nav = $(side === 'A' ? '#colA .roundnav' : '#colB .roundnav');
    const btn = document.createElement('button');
    btn.textContent = label.replace(/\D/g, '') || label; // 「第 2 轮」/「Round 2」→「2」
    btn.title = t('dyn.jumpTo', { label });
    btn.onclick = () => { d.open = true; d.scrollIntoView({ block: 'start' }); }; // 不用 smooth：部分环境平滑滚动不执行
    nav.appendChild(btn);
  }
  return roundDivs[key];
}

// 发言完成后按「## 小节标题」拆成可折叠小节；流式期间保持纯文本追加。
// 全部经 createElement + textContent 构建——模型输出绝不进 innerHTML。
function sectionizeRound(side, label) {
  const pre = roundDivs[side + label];
  if (!pre || !pre.parentElement) return;
  const raw = pre.dataset.raw ?? pre.textContent;
  const lines = raw.split('\n');
  const sections = [];
  let cur = { title: '', body: [] };
  for (const line of lines) {
    const m = /^##\s+(.+)/.exec(line);
    if (m) { if (cur.title || cur.body.join('').trim()) sections.push(cur); cur = { title: m[1].trim(), body: [] }; }
    else cur.body.push(line);
  }
  if (cur.title || cur.body.join('').trim()) sections.push(cur);
  if (sections.length < 2) return; // 无结构或只有一段——保持原样
  const wrap = document.createElement('div');
  wrap.className = 'sections';
  wrap.dataset.raw = raw; // 保留原文：retry 等再来 chunk 时可还原为纯文本继续追加
  for (const s of sections) {
    if (!s.title) { // 首个无标题小节（导语）直接平铺
      const p = document.createElement('pre');
      p.textContent = s.body.join('\n').trim();
      if (p.textContent) wrap.appendChild(p);
      continue;
    }
    const det = document.createElement('details');
    det.className = 'section';
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = s.title;
    const body = document.createElement('pre');
    body.textContent = s.body.join('\n').trim();
    det.appendChild(sum);
    det.appendChild(body);
    wrap.appendChild(det);
  }
  pre.replaceWith(wrap);
  roundDivs[side + label] = wrap; // 后续 chunk 到来时由 chunk 处理路径检测并还原
}

const isDebaterCall = label => /^r\d+(retry)?$/.test(label ?? ''); // r1、r2retry 等辩手轮次调用；r1summary/judge 等不路由进辩手栏
// 从 label（r1 / r2retry 等）解析轮次标题；retry 与初次调用同轮号 → 落入同一个 round div（追加而非新建）
const roundTitleOf = label => { const m = /^r(\d+)/.exec(label ?? ''); return m ? t('dyn.roundTitle', { n: m[1] }) : (label ?? ''); };

// ---- 会话内群聊 ----
const isChatCall = label => /^chat\d+$/.test(label ?? '');

function showTyping(agentId) {
  hideTyping(agentId);
  const name = cfg.agents[agentId]?.name ?? agentId;
  const div = document.createElement('div');
  div.className = 'chat-msg chat-agent chat-typing';
  div.textContent = t('dyn.typing', { name });
  $('#chatLog').appendChild(div);
  typingEls[agentId] = div;
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}
function hideTyping(agentId) {
  const el = typingEls[agentId];
  if (el) { el.remove(); delete typingEls[agentId]; }
}

// from: 'user' | agentId；全部经 textContent 渲染，杜绝模型/用户输出触发 XSS
function appendChatMessage(from, name, text) {
  hideTyping(from);
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (from === 'user' ? 'chat-user' : 'chat-agent');
  const nameEl = document.createElement('div');
  nameEl.className = 'chat-name';
  nameEl.textContent = name;
  const bodyEl = document.createElement('div');
  bodyEl.className = 'chat-body';
  bodyEl.textContent = text;
  div.appendChild(nameEl);
  div.appendChild(bodyEl);
  $('#chatLog').appendChild(div);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  $('#chatPanel').open = true; // 有新消息时自动展开
}

// 重建收件人多选：该会话全部参会 agent（辩手+仲裁+书记去重），默认勾选第一个辩手
function renderChatRecipients(roles, agentNames) {
  const ids = [...new Set([roles.debaters[0], roles.debaters[1], roles.judge, roles.summarizer])];
  const el = $('#chatRecipients');
  el.innerHTML = '';
  for (const id of ids) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = id;
    cb.checked = id === roles.debaters[0];
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + (agentNames[id] ?? id)));
    el.appendChild(label);
  }
}

function onEvent(ev) {
  if (ev.type === 'chunk') {
    const side = sideOf[ev.agentId];
    if (!side || !isDebaterCall(ev.label)) return; // 非辩手轮次（如同一 agent 兼任的 summarizer/judge）的流不进辩手栏
    const title = roundTitleOf(ev.label);
    let node = ensureRoundDiv(side, title);
    if (node.classList?.contains('sections')) {
      // 该轮已分节展示（如 retry 再次来流）——还原为纯文本继续追加
      const pre = document.createElement('pre');
      pre.textContent = node.dataset.raw ?? '';
      node.replaceWith(pre);
      roundDivs[side + title] = pre;
      node = pre;
    }
    node.textContent += ev.data;            // textContent：天然防 XSS
    node.scrollIntoView({ block: 'end' });
  }
  if (ev.type === 'agent-status') {
    const name = cfg.agents[ev.agentId]?.name ?? ev.agentId;
    if (sideOf[ev.agentId] && isDebaterCall(ev.label)) {
      // 辩手徽标：running 时带计时器（阶段性反馈——至少让人知道跑了多久、没有卡死）
      const side = sideOf[ev.agentId];
      stopBadgeTimer(side);
      if (ev.data === 'running') startBadgeTimer(side);
      else {
        badge(side).textContent = ev.data;
        if (ev.data === 'done') sectionizeRound(side, roundTitleOf(ev.label)); // 发言完成→按小节折叠展示
      }
    } else if (ev.label === 'judge') {
      // 仲裁运行时显示身份（此前只有干巴巴的 judging 状态）
      if (ev.data === 'running') setStatebar(t('dyn.judgeRunning', { name }));
    } else if (/summary$/.test(ev.label ?? '')) {
      if (ev.data === 'running') setStatebar(t('dyn.scribeRunning', { name }));
    } else if (isChatCall(ev.label)) {
      if (ev.data === 'running') showTyping(ev.agentId); else hideTyping(ev.agentId); // 消息本身由 chat-message 事件追加，失败则由 error 事件提示
    }
  }
  if (ev.type === 'chat-message') appendChatMessage(ev.from, ev.name, ev.data);
  if (ev.type === 'summary') { $('#summary').textContent = ev.data; $('#resummarize').hidden = !/摘要失败/.test(ev.data); }
  if (ev.type === 'round-done') { setStatebar(t('dyn.roundDone', { round: ev.round })); refreshSessionList(); }
  if (ev.type === 'state') setStatebar(t('dyn.state', { data: ev.data }));
  if (ev.type === 'error') {
    const hint = ev.data === 'auth' ? t('dyn.authHint') : '';
    const nm = ev.agentId ? (cfg.agents[ev.agentId]?.name ?? ev.agentId) : '';
    setStatebar((ev.agentId ? t('dyn.errWith', { name: nm, msg: ev.data }) : t('dyn.errPlain', { msg: ev.data })) + hint, true);
  }
  if (ev.type === 'judge-card') {
    $('#judgecard').hidden = false;
    $('#judgecard pre').textContent = ev.data;
    $('#flowback').hidden = !sessionOrigin; // 升格而来的会议才有回流通道
    refreshSessionList();
  }
}

async function sendNote() {
  const t = $('#note').value.trim();
  if (t) { await api('interject', { text: t }); $('#note').value = ''; }
}

// 会场常驻显示"在讨论什么、前提是什么"——会一开跑建会表单就没了，这里是唯一入口
function setBrief(topic, materials) {
  $('#brief').hidden = false;
  $('#briefTopic').textContent = topic ?? '';
  $('#briefMaterials').textContent = (materials ?? '').trim() || t('arena.noMaterials');
  $('#briefDetails').open = false;
}

// ---- 重置会话相关 UI 状态（新会话 / 重连前调用）----
function resetSessionUI() {
  stopBadgeTimer('A'); stopBadgeTimer('B');
  $('#brief').hidden = true; $('#briefTopic').textContent = ''; $('#briefMaterials').textContent = '';
  $('#colA .roundnav').innerHTML = ''; $('#colB .roundnav').innerHTML = '';
  $('#colA .feed').innerHTML = ''; $('#colB .feed').innerHTML = '';
  $('#colA .badge').textContent = ''; $('#colB .badge').textContent = '';
  $('#colA .name').textContent = ''; $('#colB .name').textContent = '';
  $('#summary').textContent = '';
  $('#judgecard').hidden = true; $('#judgecard pre').textContent = '';
  $('#flowback').hidden = true; sessionOrigin = '';
  const statebar = $('#statebar'); statebar.textContent = ''; statebar.hidden = true; statebar.classList.remove('err');
  const setupbar = $('#setupbar'); setupbar.textContent = ''; setupbar.hidden = true; setupbar.classList.remove('err');
  roundDivs = {};
  sideOf = {};
  $('#chatLog').innerHTML = '';
  $('#chatRecipients').innerHTML = '';
  $('#chatInput').value = '';
  $('#chatPanel').open = false;
  typingEls = {};
}

function closeEvents() { if (es) { es.close(); es = null; } }
function connectEvents() {
  closeEvents();
  es = new EventSource(`/api/sessions/${sid}/events`);
  es.onmessage = e => onEvent(JSON.parse(e.data));
  es.onerror = () => setStatebar(t('dyn.streamBrokenShort'), true);
}

// ---- 重连活动会话 ----
async function attach(id) {
  let detail;
  try { detail = await (await fetch(`/api/sessions/${id}`)).json(); } catch (e) { return setStatebar(t('dyn.noServer', { msg: e.message }), true); }
  if (detail.error) return setStatebar(detail.error, true);
  closeWbEvents();
  resetSessionUI();
  sid = id;
  sideOf = { [detail.roles.debaters[0]]: 'A', [detail.roles.debaters[1]]: 'B' };
  sessionOrigin = detail.origin ?? '';
  setBrief(detail.topic, detail.materials);
  $('#colA .name').textContent = detail.agentNames?.[detail.roles.debaters[0]] ?? detail.roles.debaters[0];
  $('#colB .name').textContent = detail.agentNames?.[detail.roles.debaters[1]] ?? detail.roles.debaters[1];
  renderChatRecipients(detail.roles, detail.agentNames ?? {});
  showArena();
  connectEvents(); // 回放缓冲事件重建全部内容
  await refreshSessionList();
}

// ---- 历史会话只读查看 ----
async function openArchive(dirname) {
  let data;
  try { data = await (await fetch(`/api/archive/${encodeURIComponent(dirname)}`)).json(); } catch (e) { return setStatebar(t('dyn.readArchiveFail', { msg: e.message }), true); }
  if (data.error) return setStatebar(data.error, true);
  archiveDirname = dirname;
  showArchiveView(data.topic, data.sessionMd);
}

// ---- 恢复归档会话继续辩论：从磁盘状态重新装配 Committee，attach 到重建的活动会话 ----
async function resumeSession(dirname) {
  let r;
  try { r = await (await fetch(`/api/archive/${encodeURIComponent(dirname)}/resume`, { method: 'POST' })).json(); }
  catch (e) { return setStatebar(t('dyn.resumeFail', { msg: e.message }), true); }
  if (r.error) return setStatebar(r.error, true);
  await attach(r.id);
  await refreshSessionList();
}

// ---- 会议按钮绑定 ----
$('#archiveBack').onclick = () => { sid ? showArena() : showSetup(); };
$('#archiveResume').onclick = () => { if (archiveDirname) resumeSession(archiveDirname); };

$('#start').onclick = async () => {
  const roles = { debaters: [$('#debA').value, $('#debB').value], judge: $('#judge').value, summarizer: $('#summ').value };
  if (roles.debaters[0] === roles.debaters[1]) return setStatebar(t('dyn.sameDebater'), true);
  if (!$('#topic').value.trim()) return setStatebar(t('dyn.needTopic'), true);
  const btn = $('#start');
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = t('dyn.creatingBtn');
  setStatebar(t('dyn.creating'));
  let r;
  try {
    r = await (await fetch('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: $('#topic').value, materials: $('#materials').value, template: $('#tpl').value, workspace: $('#workspace').value.trim(), roles, mode: 'manual', origin: draftOrigin ?? '', lang: draftLang ?? LANG }),
    })).json();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = oldLabel;
    return setStatebar(t('dyn.createFail', { msg: e.message }), true);
  }
  btn.disabled = false;
  btn.textContent = oldLabel;
  if (r.error) {
    return setStatebar(r.error, true);
  }
  closeWbEvents();
  sid = r.id;
  resetSessionUI();
  sessionOrigin = draftOrigin ?? '';
  draftOrigin = null; // 已随建会提交，防止串到下一场手建会议
  draftLang = null;
  setBrief($('#topic').value, $('#materials').value);
  $('#setup').hidden = true; // setupbar 已在 resetSessionUI 中清空隐藏
  sideOf = { [roles.debaters[0]]: 'A', [roles.debaters[1]]: 'B' };
  $('#colA .name').textContent = cfg.agents[roles.debaters[0]].name;
  $('#colB .name').textContent = cfg.agents[roles.debaters[1]].name;
  const agentNames = Object.fromEntries(Object.entries(cfg.agents).map(([id, a]) => [id, a.name]));
  renderChatRecipients(roles, agentNames);
  $('#arena').hidden = false;
  connectEvents();
  await refreshSessionList();
  await api('round');
};
$('#next').onclick = async () => { await sendNote(); await api('round'); };
$('#auto').onclick = async () => { await sendNote(); await api('auto', { maxRounds: Number($('#maxR').value) }); };
$('#stop').onclick = () => api('stop');
$('#dojudge').onclick = () => api('judge');
$('#partial').onclick = () => api('save-partial');
$('#resummarize').onclick = () => { $('#resummarize').hidden = true; api('resummarize'); };
$('#chatSend').onclick = async () => {
  const text = $('#chatInput').value.trim();
  if (!text) return;
  const to = [...$('#chatRecipients').querySelectorAll('input:checked')].map(cb => cb.value);
  if (!to.length) return setStatebar(t('dyn.needRecipient'), true);
  $('#chatInput').value = '';
  await api('chat', { text, to });
};
$('#chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#chatSend').onclick(); }
});
$('#copycard').onclick = () => navigator.clipboard.writeText($('#judgecard pre').textContent);
$('#flowback').onclick = async () => {
  let r;
  try { r = await (await fetch(`/api/sessions/${sid}/flowback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json(); }
  catch (e) { return setStatebar(t('dyn.flowbackFail', { msg: e.message }), true); }
  if (r.error) return setStatebar(r.error, true);
  await attachWorkbench(r.benchId); // 裁决卡已贴回，切到工作台接着聊
};
for (const [sel, side] of [['#colA', 'A'], ['#colB', 'B']]) {
  $(sel + ' .retry').onclick = () => api('retry', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
  $(sel + ' .skip').onclick = () => api('skip', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
}
