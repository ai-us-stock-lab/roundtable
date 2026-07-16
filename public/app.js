const $ = s => document.querySelector(s);
let cfg, sid = null, sideOf = {}, es = null; // agentId -> 'A' | 'B'；es：当前 EventSource 引用（新会话/重连时需先关闭旧连接）
let archiveDirname = null; // 当前只读归档视图对应的磁盘目录名（供「恢复此会话」按钮使用）

async function boot() {
  try {
    cfg = await (await fetch('/api/config')).json();
  } catch (e) {
    return setStatebar('无法连接服务（' + e.message + '）——请在 Roundtable 目录运行 npm start 后刷新本页', true);
  }
  const opts = role => Object.entries(cfg.agents)
    .filter(([, a]) => a.roles.includes(role))
    .map(([id, a]) => `<option value="${id}"${a.unavailable ? ' disabled' : ''}>${a.name}${a.unavailable ? '（不可用）' : ''}</option>`).join('');
  $('#debA').innerHTML = opts('debater');
  $('#debB').innerHTML = opts('debater');
  if ($('#debB').options.length > 1) $('#debB').selectedIndex = 1;
  $('#judge').innerHTML = opts('judge');
  $('#summ').innerHTML = opts('summarizer');
  $('#tpl').innerHTML = Object.entries(cfg.templates).map(([n, t]) => `<option value="${n}">${t.title}</option>`).join('');
  await refreshSessionList();
  await applyDraftFromHash();
  // 页面已开着时又发起新会议（仅 hash 变化不重载）→ 同样要预填
  window.addEventListener('hashchange', applyDraftFromHash);
}

// 项目对话侧的 AI 通过 POST /api/draft 预存议题+简报，并打开 /#draft=<id>——这里取回填入表单
async function applyDraftFromHash() {
  const m = /[#&]draft=([a-z0-9]+)/.exec(location.hash);
  if (!m) return;
  try {
    const d = await (await fetch('/api/draft/' + m[1])).json();
    if (d.error) return setStatebar('预填草稿已过期，请手动填写议题', true);
    $('#topic').value = d.topic ?? '';
    $('#materials').value = d.materials ?? '';
    // 发起方建议的模板也一并选好（例如项目会诊）——模板选错会导致顾问输出结构完全不对题
    if (d.template && [...$('#tpl').options].some(o => o.value === d.template)) $('#tpl').value = d.template;
    if (d.workspace) $('#workspace').value = d.workspace;
    setStatebar('议题、背景材料与模板已由项目对话预填——选好阵容后点「开始第 1 轮」');
  } catch { /* 服务波动时静默，用户可手动填 */ }
  history.replaceState(null, '', location.pathname); // 用后清掉 hash，防刷新重复提示
}

function feed(side) { return $(side === 'A' ? '#colA .feed' : '#colB .feed'); }
function badge(side) { return $(side === 'A' ? '#colA .badge' : '#colB .badge'); }
let roundDivs = {};

// 运行计时器：running 徽标每秒更新耗时，让人看到"确实在跑、跑了多久"
const badgeTimers = {};
function startBadgeTimer(side) {
  const t0 = Date.now();
  badge(side).textContent = 'running · 0s';
  badgeTimers[side] = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    badge(side).textContent = 'running · ' + (s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's');
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
    btn.textContent = label.replace(/[第轮\s]/g, ''); // 「第 2 轮」→「2」
    btn.title = '跳转到' + label;
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
const roundTitleOf = label => { const m = /^r(\d+)/.exec(label ?? ''); return m ? `第 ${m[1]} 轮` : (label ?? ''); };

// ---- 会话内群聊 ----
const isChatCall = label => /^chat\d+$/.test(label ?? '');
let typingEls = {}; // agentId -> "正在输入…" 提示元素

function showTyping(agentId) {
  hideTyping(agentId);
  const name = cfg.agents[agentId]?.name ?? agentId;
  const div = document.createElement('div');
  div.className = 'chat-msg chat-agent chat-typing';
  div.textContent = name + ' 正在输入…';
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
      if (ev.data === 'running') setStatebar('仲裁（' + name + '）正在裁决——比较证据强弱与证伪点质量…');
    } else if (/summary$/.test(ev.label ?? '')) {
      if (ev.data === 'running') setStatebar('书记（' + name + '）正在整理本轮摘要与分歧分类表…');
    } else if (isChatCall(ev.label)) {
      if (ev.data === 'running') showTyping(ev.agentId); else hideTyping(ev.agentId); // 消息本身由 chat-message 事件追加，失败则由 error 事件提示
    }
  }
  if (ev.type === 'chat-message') appendChatMessage(ev.from, ev.name, ev.data);
  if (ev.type === 'summary') { $('#summary').textContent = ev.data; $('#resummarize').hidden = !/摘要失败/.test(ev.data); }
  if (ev.type === 'round-done') { setStatebar('第 ' + ev.round + ' 轮结束——可插话后继续'); refreshSessionList(); }
  if (ev.type === 'state') setStatebar('状态: ' + ev.data);
  if (ev.type === 'error') {
    const hint = ev.data === 'auth' ? '（请在终端重新登录该 CLI 后点「重试」）' : '';
    setStatebar('错误' + (ev.agentId ? '（' + (cfg.agents[ev.agentId]?.name ?? ev.agentId) + '）' : '') + ': ' + ev.data + hint, true);
  }
  if (ev.type === 'judge-card') { $('#judgecard').hidden = false; $('#judgecard pre').textContent = ev.data; refreshSessionList(); }
}
// 状态提示：会话区可见时写主状态条，否则写建会话页的提示条（修复：创建失败静默无反应）
function setStatebar(msg, isErr) {
  const target = $('#arena').hidden ? $('#setupbar') : $('#statebar');
  target.hidden = false;
  target.textContent = msg;
  target.classList.toggle('err', !!isErr);
}

const api = (action, body) => fetch(`/api/sessions/${sid}/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).catch(e => setStatebar('网络错误: ' + e.message, true));

async function sendNote() {
  const t = $('#note').value.trim();
  if (t) { await api('interject', { text: t }); $('#note').value = ''; }
}

// 会场常驻显示"在讨论什么、前提是什么"——会一开跑建会表单就没了，这里是唯一入口
function setBrief(topic, materials) {
  $('#brief').hidden = false;
  $('#briefTopic').textContent = topic ?? '';
  $('#briefMaterials').textContent = (materials ?? '').trim() || '（无背景材料）';
  $('#briefDetails').open = false;
}

// ---- 视图切换（五个顶层视图互斥） ----
const VIEWS = ['#setup', '#arena', '#archiveView', '#wbSetup', '#workbench'];
function showView(sel) { for (const v of VIEWS) $(v).hidden = v !== sel; }
function showSetup() { showView('#setup'); }
function showArena() { showView('#arena'); }
function showArchiveView(topic, sessionMd) {
  $('#archiveTopic').textContent = topic ?? '';
  $('#archiveContent').textContent = sessionMd ?? '';
  showView('#archiveView');
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
  es.onerror = () => setStatebar('事件流连接中断', true);
}

// ---- 侧边栏：会话列表 ----
async function refreshSessionList() {
  let list;
  try { list = await (await fetch('/api/sessions')).json(); } catch { return; }
  const el = $('#sessionList');
  el.innerHTML = '';
  for (const s of list) {
    const fmtTime = iso => {
      if (!iso) return '';
      const d = new Date(iso);
      return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const isWb = s.type === 'workbench';
    const item = document.createElement('div');
    item.className = 'session-item' + (s.archived ? ' archived' : '') + (!s.archived && (s.id === sid || s.id === wbId) ? ' active' : '');
    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = (s.topic || '（无议题）').replace(/^\[工作台\] /, '');
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    const when = s.updatedAt ? ' · ' + fmtTime(s.updatedAt) : '';
    meta.textContent = (isWb
      ? ('工作台 · ' + (s.archived ? '已归档' : (s.state === 'busy' ? '回复中' : '在线')) + ' · ' + (s.round ?? 0) + ' 条')
      : (s.archived ? ('已归档 · ' + (s.state ?? '')) : ((s.state ?? '') + ' · 第 ' + (s.round ?? 0) + ' 轮'))) + when;
    meta.title = s.updatedAt ? '最后更新：' + new Date(s.updatedAt).toLocaleString() : '';
    const del = document.createElement('button');
    del.className = 'session-del';
    del.textContent = '✕';
    del.title = '删除该会话记录';
    del.onclick = async e => {
      e.stopPropagation(); // 不触发条目本身的打开动作
      if (!confirm('删除「' + (s.topic || '（无议题）') + '」？记录将移入回收站（sessions/.trash/），需要时可手工找回。')) return;
      const url = s.archived ? '/api/archive/' + encodeURIComponent(s.id)
        : (isWb ? '/api/workbenches/' + s.id : '/api/sessions/' + s.id);
      let r;
      try { r = await (await fetch(url, { method: 'DELETE' })).json(); } catch (err) { return setStatebar('删除失败: ' + err.message, true); }
      if (r.error) return setStatebar(r.error, true);
      if (!s.archived && s.id === sid) { closeEvents(); sid = null; resetSessionUI(); showSetup(); } // 删的是当前会话则回到建会话页
      if (!s.archived && s.id === wbId) { closeWbEvents(); showSetup(); }
      await refreshSessionList();
    };
    item.appendChild(title);
    item.appendChild(meta);
    const ren = document.createElement('button');
    ren.className = 'session-rename';
    ren.textContent = '✎';
    ren.title = '重命名';
    // 归档的会议条目右侧还有 ↻ 恢复按钮，改名按钮再往左让一格
    ren.style.right = (s.archived && !isWb) ? '46px' : '26px';
    ren.onclick = async e => {
      e.stopPropagation();
      const current = (s.topic || '').replace(/^\[工作台\] /, '');
      const name = prompt('新名字：', current);
      if (name === null || !name.trim() || name.trim() === current) return;
      const url = s.archived ? '/api/archive/' + encodeURIComponent(s.id) + '/rename'
        : (isWb ? '/api/workbenches/' + s.id + '/rename' : '/api/sessions/' + s.id + '/rename');
      const body = isWb && !s.archived ? { name: name.trim() } : { title: name.trim() };
      let r;
      try { r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }
      catch (err) { return setStatebar('重命名失败: ' + err.message, true); }
      if (r.error) return setStatebar(r.error, true);
      if (!s.archived && isWb && s.id === wbId) $('#wbTitle').textContent = name.trim(); // 当前工作台标题同步
      await refreshSessionList();
    };
    item.appendChild(ren);
    if (s.archived && !isWb) {
      const resume = document.createElement('button');
      resume.className = 'session-resume';
      resume.textContent = '↻';
      resume.title = '恢复此会话继续辩论';
      resume.onclick = e => { e.stopPropagation(); resumeSession(s.id); };
      item.appendChild(resume);
    }
    item.appendChild(del);
    // 工作台：归档条目点击即恢复（无只读视图——恢复零成本，不产生 CLI 调用）
    item.onclick = () => isWb
      ? (s.archived ? resumeWorkbench(s.id) : attachWorkbench(s.id))
      : (s.archived ? openArchive(s.id) : attach(s.id));
    el.appendChild(item);
  }
}

// ---- 重连活动会话 ----
async function attach(id) {
  let detail;
  try { detail = await (await fetch(`/api/sessions/${id}`)).json(); } catch (e) { return setStatebar('无法连接服务: ' + e.message, true); }
  if (detail.error) return setStatebar(detail.error, true);
  closeWbEvents();
  resetSessionUI();
  sid = id;
  sideOf = { [detail.roles.debaters[0]]: 'A', [detail.roles.debaters[1]]: 'B' };
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
  try { data = await (await fetch(`/api/archive/${encodeURIComponent(dirname)}`)).json(); } catch (e) { return setStatebar('无法读取归档: ' + e.message, true); }
  if (data.error) return setStatebar(data.error, true);
  archiveDirname = dirname;
  showArchiveView(data.topic, data.sessionMd);
}

// ---- 恢复归档会话继续辩论：从磁盘状态重新装配 Committee，attach 到重建的活动会话 ----
async function resumeSession(dirname) {
  let r;
  try { r = await (await fetch(`/api/archive/${encodeURIComponent(dirname)}/resume`, { method: 'POST' })).json(); }
  catch (e) { return setStatebar('恢复失败: ' + e.message, true); }
  if (r.error) return setStatebar(r.error, true);
  await attach(r.id);
  await refreshSessionList();
}

$('#newSessionBtn').onclick = () => {
  closeEvents();
  closeWbEvents();
  sid = null;
  resetSessionUI();
  showSetup();
  refreshSessionList();
};

// ---- 工作台：多模型群聊 ----
let wbId = null, wbEs = null;
const wbTyping = {}; // agentId -> "正在输入…" 元素

function closeWbEvents() { if (wbEs) { wbEs.close(); wbEs = null; } wbId = null; }

function renderWbParticipantPicker() {
  const el = $('#wbParticipants');
  el.innerHTML = '';
  for (const [id, a] of Object.entries(cfg.agents)) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = id;
    cb.disabled = !!a.unavailable;
    cb.checked = !a.unavailable && ['claude', 'codex'].includes(id);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + a.name + (a.unavailable ? '（不可用）' : '')));
    el.appendChild(label);
  }
}

function setWbBusy(busy) {
  $('#wbSend').disabled = busy;
  $('#wbSend').textContent = busy ? '回复中…' : '发送';
  $('#wbRelay').disabled = busy;
  $('#wbStop').hidden = !busy;
}

function appendWbMessage(from, name, to, text, ctx) {
  const el = wbTyping[from]; if (el) { el.remove(); delete wbTyping[from]; }
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (from === 'user' ? 'chat-user' : 'chat-agent');
  const nameEl = document.createElement('div');
  nameEl.className = 'chat-name';
  nameEl.textContent = name + (to?.length ? ' → ' + to.join('、') : '');
  const bodyEl = document.createElement('div');
  bodyEl.className = 'chat-body';
  bodyEl.textContent = text;
  div.appendChild(nameEl);
  div.appendChild(bodyEl);
  if (ctx) { // 截断明示（裁决卡：禁止静默截断）
    const chip = document.createElement('div');
    chip.className = 'ctx-chip';
    chip.textContent = `该模型仅看到最近 ${ctx.shown} 条（共 ${ctx.total} 条）`;
    div.appendChild(chip);
  }
  $('#wbLog').appendChild(div);
  $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
}

function appendWbError(text) {
  const div = document.createElement('div');
  div.className = 'wb-error';
  div.textContent = text;
  $('#wbLog').appendChild(div);
  $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
}

function onWbEvent(ev) {
  if (ev.type === 'chat-message') appendWbMessage(ev.from, ev.name, ev.to, ev.data, ev.ctx);
  if (ev.type === 'state') setWbBusy(ev.data === 'busy');
  if (ev.type === 'agent-status') {
    const name = cfg.agents[ev.agentId]?.name ?? ev.agentId;
    if (ev.data === 'running') {
      const div = document.createElement('div');
      div.className = 'chat-msg chat-agent chat-typing';
      div.textContent = name + ' 正在输入…';
      $('#wbLog').appendChild(div);
      $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
      wbTyping[ev.agentId] = div;
    } else {
      const el = wbTyping[ev.agentId]; if (el) { el.remove(); delete wbTyping[ev.agentId]; }
    }
  }
  if (ev.type === 'error') appendWbError('错误' + (ev.agentId ? '（' + (cfg.agents[ev.agentId]?.name ?? ev.agentId) + '）' : '') + ': ' + ev.data);
  if (ev.type === 'sys') {
    const div = document.createElement('div');
    div.className = 'wb-sys';
    div.textContent = ev.data;
    $('#wbLog').appendChild(div);
    $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
  }
}

async function attachWorkbench(id) {
  let info;
  try { info = await (await fetch('/api/workbenches/' + id)).json(); } catch (e) { return setStatebar('无法连接服务: ' + e.message, true); }
  if (info.error) return setStatebar(info.error, true);
  closeEvents();
  closeWbEvents();
  sid = null;
  wbId = id;
  $('#wbTitle').textContent = info.name || '未命名工作台';
  $('#wbMembers').textContent = info.participants.map(p => info.agentNames[p] ?? p).join(' · ');
  $('#wbLog').innerHTML = '';
  const rc = $('#wbRecipients');
  rc.innerHTML = '';
  for (const p of info.participants) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + (info.agentNames[p] ?? p)));
    rc.appendChild(label);
  }
  showView('#workbench');
  wbEs = new EventSource(`/api/workbenches/${id}/events`);
  wbEs.onmessage = e => onWbEvent(JSON.parse(e.data));
  wbEs.onerror = () => appendWbError('事件流连接中断——刷新页面或从侧边栏重新进入');
  await refreshSessionList();
}

async function resumeWorkbench(dirname) {
  let r;
  try { r = await (await fetch('/api/workbenches/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dirname }) })).json(); }
  catch (e) { return setStatebar('恢复失败: ' + e.message, true); }
  if (r.error) return setStatebar(r.error, true);
  await attachWorkbench(r.id);
}

async function sendWbMessage() {
  const text = $('#wbInput').value.trim();
  if (!text || !wbId) return;
  const to = [...$('#wbRecipients').querySelectorAll('input:checked')].map(cb => cb.value);
  $('#wbInput').value = '';
  let r;
  try { r = await (await fetch(`/api/workbenches/${wbId}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, to }) })).json(); }
  catch (e) { return appendWbError('网络错误: ' + e.message); }
  if (r.error) appendWbError(r.error);
}

$('#newBenchBtn').onclick = () => {
  closeEvents();
  closeWbEvents();
  sid = null;
  resetSessionUI();
  renderWbParticipantPicker();
  $('#wbName').value = '';
  showView('#wbSetup');
  refreshSessionList();
};
$('#wbCreate').onclick = async () => {
  const participants = [...$('#wbParticipants').querySelectorAll('input:checked')].map(cb => cb.value);
  const bar = $('#wbSetupBar');
  const err = msg => { bar.hidden = false; bar.textContent = msg; bar.classList.add('err'); };
  if (!participants.length) return err('请至少勾选一个参与模型');
  let r;
  try { r = await (await fetch('/api/workbenches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#wbName').value.trim(), participants }) })).json(); }
  catch (e) { return err('无法连接服务（' + e.message + '）——请确认服务在运行'); }
  if (r.error) return err(r.error);
  await attachWorkbench(r.id);
};
$('#wbSend').onclick = sendWbMessage;
$('#wbRelay').onclick = async () => {
  if (!wbId) return;
  const checked = [...$('#wbRecipients').querySelectorAll('input:checked')].map(cb => cb.value);
  const order = checked.length >= 2 ? checked : []; // 勾了 ≥2 个就按勾选圈子聊，否则全体参与
  let r;
  try { r = await (await fetch(`/api/workbenches/${wbId}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rounds: Number($('#wbRounds').value) || 2, order }) })).json(); }
  catch (e) { return appendWbError('网络错误: ' + e.message); }
  if (r.error) appendWbError(r.error);
};
$('#wbStop').onclick = () => { if (wbId) fetch(`/api/workbenches/${wbId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); };
$('#wbInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendWbMessage(); }
});
$('#wbPromote').onclick = async () => {
  if (!wbId) return;
  let r;
  try { r = await (await fetch(`/api/workbenches/${wbId}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json(); }
  catch (e) { return appendWbError('升格失败: ' + e.message); }
  if (r.error) return appendWbError(r.error);
  showSetup();
  location.hash = '#draft=' + r.id; // 触发 hashchange → 预填建会表单
};

$('#archiveBack').onclick = () => { sid ? showArena() : showSetup(); };
$('#archiveResume').onclick = () => { if (archiveDirname) resumeSession(archiveDirname); };

$('#start').onclick = async () => {
  const roles = { debaters: [$('#debA').value, $('#debB').value], judge: $('#judge').value, summarizer: $('#summ').value };
  if (roles.debaters[0] === roles.debaters[1]) return setStatebar('两个辩手不能是同一个 agent', true);
  if (!$('#topic').value.trim()) return setStatebar('请先填写议题', true);
  const btn = $('#start');
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = '正在创建会话…';
  setStatebar('正在创建会话…');
  let r;
  try {
    r = await (await fetch('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: $('#topic').value, materials: $('#materials').value, template: $('#tpl').value, workspace: $('#workspace').value.trim(), roles, mode: 'manual' }),
    })).json();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = oldLabel;
    return setStatebar('无法连接服务（' + e.message + '）——请在 Roundtable 目录运行 npm start，然后刷新本页重试', true);
  }
  btn.disabled = false;
  btn.textContent = oldLabel;
  if (r.error) {
    return setStatebar(r.error, true);
  }
  closeWbEvents();
  sid = r.id;
  resetSessionUI();
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
  if (!to.length) return setStatebar('请至少勾选一位收件人', true);
  $('#chatInput').value = '';
  await api('chat', { text, to });
};
$('#chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#chatSend').onclick(); }
});
$('#copycard').onclick = () => navigator.clipboard.writeText($('#judgecard pre').textContent);
for (const [sel, side] of [['#colA', 'A'], ['#colB', 'B']]) {
  $(sel + ' .retry').onclick = () => api('retry', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
  $(sel + ' .skip').onclick = () => api('skip', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
}
boot();
