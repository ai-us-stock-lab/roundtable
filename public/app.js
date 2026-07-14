const $ = s => document.querySelector(s);
let cfg, sid = null, sideOf = {}, es = null; // agentId -> 'A' | 'B'；es：当前 EventSource 引用（新会话/重连时需先关闭旧连接）

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
}

function feed(side) { return $(side === 'A' ? '#colA .feed' : '#colB .feed'); }
function badge(side) { return $(side === 'A' ? '#colA .badge' : '#colB .badge'); }
let roundDivs = {};

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
  if (ev.type === 'agent-status' && sideOf[ev.agentId] && isDebaterCall(ev.label)) badge(sideOf[ev.agentId]).textContent = ev.data;
  if (ev.type === 'summary') { $('#summary').textContent = ev.data; }
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
    item.appendChild(title);
    item.appendChild(meta);
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
  showArchiveView(data.topic, data.sessionMd);
}

$('#newSessionBtn').onclick = () => {
  closeEvents();
  sid = null;
  resetSessionUI();
  showSetup();
  refreshSessionList();
};

$('#archiveBack').onclick = () => { sid ? showArena() : showSetup(); };

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
      body: JSON.stringify({ topic: $('#topic').value, materials: $('#materials').value, template: $('#tpl').value, roles, mode: 'manual', maxRounds: Number($('#maxR').value) }),
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
$('#auto').onclick = async () => { await sendNote(); await api('auto'); };
$('#stop').onclick = () => api('stop');
$('#dojudge').onclick = () => api('judge');
$('#partial').onclick = () => api('save-partial');
$('#copycard').onclick = () => navigator.clipboard.writeText($('#judgecard pre').textContent);
for (const [sel, side] of [['#colA', 'A'], ['#colB', 'B']]) {
  $(sel + ' .retry').onclick = () => api('retry', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
  $(sel + ' .skip').onclick = () => api('skip', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
}
boot();
