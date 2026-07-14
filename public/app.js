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
    const d = document.createElement('div');
    d.className = 'round';
    const h4 = document.createElement('h4');
    h4.textContent = label;
    const pre = document.createElement('pre');
    d.appendChild(h4);
    d.appendChild(pre);
    feed(side).appendChild(d);
    roundDivs[key] = pre;
    // 栏头加该轮的快速跳转按钮（栏头是 sticky 的，按钮始终可见）
    const nav = $(side === 'A' ? '#colA .roundnav' : '#colB .roundnav');
    const btn = document.createElement('button');
    btn.textContent = label.replace(/[第轮\s]/g, ''); // 「第 2 轮」→「2」
    btn.title = '跳转到' + label;
    btn.onclick = () => d.scrollIntoView({ block: 'start' }); // 不用 smooth：部分环境平滑滚动不执行
    nav.appendChild(btn);
  }
  return roundDivs[key];
}

const isDebaterCall = label => /^r\d+(retry)?$/.test(label ?? ''); // r1、r2retry 等辩手轮次调用；r1summary/judge 等不路由进辩手栏
// 从 label（r1 / r2retry 等）解析轮次标题；retry 与初次调用同轮号 → 落入同一个 round div（追加而非新建）
const roundTitleOf = label => { const m = /^r(\d+)/.exec(label ?? ''); return m ? `第 ${m[1]} 轮` : (label ?? ''); };

function onEvent(ev) {
  if (ev.type === 'chunk') {
    const side = sideOf[ev.agentId];
    if (!side || !isDebaterCall(ev.label)) return; // 非辩手轮次（如同一 agent 兼任的 summarizer/judge）的流不进辩手栏
    const pre = ensureRoundDiv(side, roundTitleOf(ev.label));
    pre.textContent += ev.data;             // textContent：天然防 XSS
    pre.scrollIntoView({ block: 'end' });
  }
  if (ev.type === 'agent-status') {
    const name = cfg.agents[ev.agentId]?.name ?? ev.agentId;
    if (sideOf[ev.agentId] && isDebaterCall(ev.label)) {
      // 辩手徽标：running 时带计时器（阶段性反馈——至少让人知道跑了多久、没有卡死）
      const side = sideOf[ev.agentId];
      stopBadgeTimer(side);
      if (ev.data === 'running') startBadgeTimer(side);
      else badge(side).textContent = ev.data;
    } else if (ev.label === 'judge') {
      // 仲裁运行时显示身份（此前只有干巴巴的 judging 状态）
      if (ev.data === 'running') setStatebar('仲裁（' + name + '）正在裁决——比较证据强弱与证伪点质量…');
    } else if (/summary$/.test(ev.label ?? '')) {
      if (ev.data === 'running') setStatebar('书记（' + name + '）正在整理本轮摘要与分歧分类表…');
    }
  }
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

// ---- 视图切换 ----
function showSetup() { $('#arena').hidden = true; $('#archiveView').hidden = true; $('#setup').hidden = false; }
function showArena() { $('#setup').hidden = true; $('#archiveView').hidden = true; $('#arena').hidden = false; }
function showArchiveView(topic, sessionMd) {
  $('#setup').hidden = true; $('#arena').hidden = true;
  $('#archiveTopic').textContent = topic ?? '';
  $('#archiveContent').textContent = sessionMd ?? '';
  $('#archiveView').hidden = false;
}

// ---- 重置会话相关 UI 状态（新会话 / 重连前调用）----
function resetSessionUI() {
  stopBadgeTimer('A'); stopBadgeTimer('B');
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
    const item = document.createElement('div');
    item.className = 'session-item' + (s.archived ? ' archived' : '') + (!s.archived && s.id === sid ? ' active' : '');
    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = s.topic || '（无议题）';
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = s.archived ? ('已归档 · ' + (s.state ?? '')) : ((s.state ?? '') + ' · 第 ' + (s.round ?? 0) + ' 轮');
    const del = document.createElement('button');
    del.className = 'session-del';
    del.textContent = '✕';
    del.title = '删除该会话记录';
    del.onclick = async e => {
      e.stopPropagation(); // 不触发条目本身的打开动作
      if (!confirm('删除「' + (s.topic || '（无议题）') + '」？记录将从磁盘移除，不可恢复。')) return;
      const url = s.archived ? '/api/archive/' + encodeURIComponent(s.id) : '/api/sessions/' + s.id;
      let r;
      try { r = await (await fetch(url, { method: 'DELETE' })).json(); } catch (err) { return setStatebar('删除失败: ' + err.message, true); }
      if (r.error) return setStatebar(r.error, true);
      if (!s.archived && s.id === sid) { closeEvents(); sid = null; resetSessionUI(); showSetup(); } // 删的是当前会话则回到建会话页
      await refreshSessionList();
    };
    item.appendChild(title);
    item.appendChild(meta);
    if (s.archived) {
      const resume = document.createElement('button');
      resume.className = 'session-resume';
      resume.textContent = '↻';
      resume.title = '恢复此会话继续辩论';
      resume.onclick = e => { e.stopPropagation(); resumeSession(s.id); };
      item.appendChild(resume);
    }
    item.appendChild(del);
    item.onclick = () => s.archived ? openArchive(s.id) : attach(s.id);
    el.appendChild(item);
  }
}

// ---- 重连活动会话 ----
async function attach(id) {
  let detail;
  try { detail = await (await fetch(`/api/sessions/${id}`)).json(); } catch (e) { return setStatebar('无法连接服务: ' + e.message, true); }
  if (detail.error) return setStatebar(detail.error, true);
  resetSessionUI();
  sid = id;
  sideOf = { [detail.roles.debaters[0]]: 'A', [detail.roles.debaters[1]]: 'B' };
  $('#colA .name').textContent = detail.agentNames?.[detail.roles.debaters[0]] ?? detail.roles.debaters[0];
  $('#colB .name').textContent = detail.agentNames?.[detail.roles.debaters[1]] ?? detail.roles.debaters[1];
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
  sid = null;
  resetSessionUI();
  showSetup();
  refreshSessionList();
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
  sid = r.id;
  resetSessionUI();
  $('#setup').hidden = true; // setupbar 已在 resetSessionUI 中清空隐藏
  sideOf = { [roles.debaters[0]]: 'A', [roles.debaters[1]]: 'B' };
  $('#colA .name').textContent = cfg.agents[roles.debaters[0]].name;
  $('#colB .name').textContent = cfg.agents[roles.debaters[1]].name;
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
$('#copycard').onclick = () => navigator.clipboard.writeText($('#judgecard pre').textContent);
for (const [sel, side] of [['#colA', 'A'], ['#colB', 'B']]) {
  $(sel + ' .retry').onclick = () => api('retry', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
  $(sel + ' .skip').onclick = () => api('skip', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
}
boot();
