const $ = s => document.querySelector(s);
let cfg, sid, sideOf = {}; // agentId -> 'A' | 'B'

async function boot() {
  cfg = await (await fetch('/api/config')).json();
  const opts = role => Object.entries(cfg.agents)
    .filter(([, a]) => a.roles.includes(role))
    .map(([id, a]) => `<option value="${id}">${a.name}</option>`).join('');
  $('#debA').innerHTML = opts('debater');
  $('#debB').innerHTML = opts('debater');
  if ($('#debB').options.length > 1) $('#debB').selectedIndex = 1;
  $('#judge').innerHTML = opts('judge');
  $('#summ').innerHTML = opts('summarizer');
  $('#tpl').innerHTML = Object.entries(cfg.templates).map(([n, t]) => `<option value="${n}">${t.title}</option>`).join('');
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

let currentRound = 1;
function onEvent(ev) {
  if (ev.type === 'chunk') {
    const side = sideOf[ev.agentId];
    if (!side) return; // summarizer/judge 的流不进辩手栏
    const pre = ensureRoundDiv(side, '第 ' + currentRound + ' 轮');
    pre.textContent += ev.data;             // textContent：天然防 XSS
    pre.scrollIntoView({ block: 'end' });
  }
  if (ev.type === 'agent-status' && sideOf[ev.agentId]) badge(sideOf[ev.agentId]).textContent = ev.data;
  if (ev.type === 'summary') { $('#summary').textContent = ev.data; }
  if (ev.type === 'round-done') { currentRound = ev.round + 1; setStatebar('第 ' + ev.round + ' 轮结束——可插话后继续'); }
  if (ev.type === 'state') setStatebar('状态: ' + ev.data);
  if (ev.type === 'error') {
    const hint = ev.data === 'auth' ? '（请在终端重新登录该 CLI 后点「重试」）' : '';
    setStatebar('错误' + (ev.agentId ? '（' + (cfg.agents[ev.agentId]?.name ?? ev.agentId) + '）' : '') + ': ' + ev.data + hint, true);
  }
  if (ev.type === 'judge-card') { $('#judgecard').hidden = false; $('#judgecard pre').textContent = ev.data; }
}
function setStatebar(msg, isErr) { const b = $('#statebar'); b.textContent = msg; b.classList.toggle('err', !!isErr); }

const api = (action, body) => fetch(`/api/sessions/${sid}/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).catch(e => setStatebar('网络错误: ' + e.message, true));

async function sendNote() {
  const t = $('#note').value.trim();
  if (t) { await api('interject', { text: t }); $('#note').value = ''; }
}

$('#start').onclick = async () => {
  const roles = { debaters: [$('#debA').value, $('#debB').value], judge: $('#judge').value, summarizer: $('#summ').value };
  if (roles.debaters[0] === roles.debaters[1]) return setStatebar('两个辩手不能是同一个 agent', true);
  if (!$('#topic').value.trim()) return setStatebar('请先填写议题', true);
  const r = await (await fetch('/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: $('#topic').value, materials: $('#materials').value, template: $('#tpl').value, roles, mode: 'manual', maxRounds: Number($('#maxR').value) }),
  })).json();
  if (r.error) return setStatebar(r.error, true);
  sid = r.id;
  sideOf = { [roles.debaters[0]]: 'A', [roles.debaters[1]]: 'B' };
  $('#colA .name').textContent = cfg.agents[roles.debaters[0]].name;
  $('#colB .name').textContent = cfg.agents[roles.debaters[1]].name;
  $('#setup').hidden = true; $('#arena').hidden = false;
  const es = new EventSource(`/api/sessions/${sid}/events`);
  es.onmessage = e => onEvent(JSON.parse(e.data));
  es.onerror = () => setStatebar('事件流连接中断', true);
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
