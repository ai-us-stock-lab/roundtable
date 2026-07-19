// ===== 工作台（多模型群聊 + 互聊 + 动手/diff 审批 + 升格）=====

// ---- 工作台模块内部状态 ----
const wbTyping = {};      // agentId -> "正在输入…" 元素
let wbLiveBox = null;     // 动手实时输出盒（完成后移除，正式消息+diff 卡随 chat-message 到来）

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

// markdown-lite：标题/列表/代码块/**粗体**/`行内码`。逐行 createElement + textContent 构建，
// 模型输出绝不进 innerHTML（与全站同一条防 XSS 底线）；表格等其余语法保持原文
function renderRichText(container, text) {
  const inline = (parent, s) => {
    for (const tok of s.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
      if (!tok) continue;
      if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
        const b = document.createElement('strong');
        b.textContent = tok.slice(2, -2);
        parent.appendChild(b);
      } else if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
        const c = document.createElement('code');
        c.textContent = tok.slice(1, -1);
        parent.appendChild(c);
      } else parent.appendChild(document.createTextNode(tok));
    }
  };
  let codeBlock = null;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) {
      if (codeBlock) { codeBlock = null; } // 结束围栏
      else { codeBlock = document.createElement('pre'); codeBlock.className = 'md-code'; container.appendChild(codeBlock); }
      continue;
    }
    if (codeBlock) { codeBlock.appendChild(document.createTextNode(line + '\n')); continue; }
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    const li = /^([-*]|\d+[.、])\s+(.*)/.exec(line);
    const row = document.createElement('div');
    if (h) { row.className = 'md-h'; inline(row, h[2]); }
    else if (li) {
      row.className = 'md-li';
      const marker = document.createElement('span');
      marker.className = 'md-marker';
      marker.textContent = /^[-*]$/.test(li[1]) ? '•' : li[1];
      row.appendChild(marker);
      const rest = document.createElement('span');
      inline(rest, li[2]);
      row.appendChild(rest);
    } else if (line.trim() === '') { row.className = 'md-gap'; }
    else { row.className = 'md-p'; inline(row, line); }
    container.appendChild(row);
  }
}

function appendWbMessage(from, name, to, text, ctx, build) {
  const el = wbTyping[from]; if (el) { el.remove(); delete wbTyping[from]; }
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (from === 'user' ? 'chat-user' : 'chat-agent');
  const nameEl = document.createElement('div');
  nameEl.className = 'chat-name';
  nameEl.textContent = name + (to?.length ? ' → ' + to.join('、') : '');
  const bodyEl = document.createElement('div');
  bodyEl.className = 'chat-body';
  if (from === 'user') bodyEl.textContent = text;
  else renderRichText(bodyEl, text); // 模型回复常带 markdown——富渲染提升可读性
  div.appendChild(nameEl);
  div.appendChild(bodyEl);
  if (ctx) { // 截断明示（裁决卡：禁止静默截断）
    const chip = document.createElement('div');
    chip.className = 'ctx-chip';
    chip.textContent = `该模型仅看到最近 ${ctx.shown} 条（共 ${ctx.total} 条）`;
    div.appendChild(chip);
  }
  if (build) div.appendChild(renderBuildCard(build));
  $('#wbLog').appendChild(div);
  $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
}

// 与后端 splitPatchByFile 同逻辑：按 diff --git 头切文件段
function splitPatchClient(patch) {
  return (patch || '').split(/(?=^diff --git )/m).filter(s => s.trim()).map(seg => {
    const m = /^diff --git "?a\/(.+?)"? "?b\//.exec(seg);
    return { path: m ? m[1] : '(unknown)', patch: seg };
  });
}

function coloredPatchPre(text) {
  const pre = document.createElement('pre');
  pre.className = 'build-patch';
  for (const line of (text || '（patch 内容缺失，仅存统计）').split('\n')) {
    const span = document.createElement('span');
    span.textContent = line + '\n';
    if (/^\+(?!\+\+)/.test(line)) span.className = 'dl-add';
    else if (/^-(?!--)/.test(line)) span.className = 'dl-del';
    else if (/^(diff |@@)/.test(line)) span.className = 'dl-meta';
    pre.appendChild(span);
  }
  return pre;
}

const buildAction = (buildId, action, files) =>
  fetch(`/api/workbenches/${wbId}/builds/${buildId}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(files ? { files } : {}),
  }).then(r => r.json())
    .then(r => { if (r.error) appendWbError((action === 'apply' ? '应用失败: ' : '') + r.error + (action === 'apply' ? '（若与本地改动冲突，可手工应用会话目录 builds/ 下的 patch）' : '')); })
    .catch(e => appendWbError('网络错误: ' + e.message));

// 动手 diff 卡片：按文件分节（每个文件独立 折叠diff+应用/丢弃）+ 顶部整体操作
function renderBuildCard(build) {
  const card = document.createElement('div');
  card.className = 'build-card';
  card.dataset.buildId = build.buildId;
  const statEl = document.createElement('pre');
  statEl.className = 'build-stat';
  statEl.textContent = build.stat;
  card.appendChild(statEl);

  const segs = splitPatchClient(build.patch);
  const files = build.files?.length ? build.files : [{ path: '(全部)', status: build.status }];
  const fileRows = new Map();
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'build-file';
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'bf-path';
    nameSpan.textContent = f.path;
    const stSpan = document.createElement('span');
    stSpan.className = 'bf-st';
    const applyBtn = document.createElement('button');
    applyBtn.textContent = '应用';
    applyBtn.title = '只应用这个文件的改动';
    applyBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); buildAction(build.buildId, 'apply', f.path === '(全部)' ? null : [f.path]); };
    const discardBtn = document.createElement('button');
    discardBtn.textContent = '丢弃';
    discardBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); buildAction(build.buildId, 'discard', f.path === '(全部)' ? null : [f.path]); };
    sum.appendChild(nameSpan);
    sum.appendChild(stSpan);
    sum.appendChild(applyBtn);
    sum.appendChild(discardBtn);
    det.appendChild(sum);
    const seg = segs.find(s => s.path === f.path);
    det.appendChild(coloredPatchPre(seg ? seg.patch : build.patch));
    row.appendChild(det);
    card.appendChild(row);
    fileRows.set(f.path, { stSpan, applyBtn, discardBtn });
  }

  const bar = document.createElement('div');
  bar.className = 'build-bar';
  const status = document.createElement('span');
  status.className = 'build-status';
  const applyAll = document.createElement('button');
  applyAll.className = 'primary';
  applyAll.textContent = '全部应用';
  applyAll.onclick = () => buildAction(build.buildId, 'apply', null);
  const discardAll = document.createElement('button');
  discardAll.textContent = '全部丢弃';
  discardAll.onclick = () => buildAction(build.buildId, 'discard', null);
  const checkBtn = document.createElement('button');
  checkBtn.textContent = '跑检查';
  checkBtn.title = '在「主工作区状态+此改动」的临时副本里运行构建/测试命令，通过了再应用';
  checkBtn.onclick = async () => {
    const cmd = prompt('检查命令（在应用前于临时副本中运行）：', localStorage.getItem('rt-check-cmd') || 'npm test');
    if (cmd === null || !cmd.trim()) return;
    localStorage.setItem('rt-check-cmd', cmd.trim());
    let r;
    try { r = await (await fetch(`/api/workbenches/${wbId}/builds/${build.buildId}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: cmd.trim() }) })).json(); }
    catch (e) { return appendWbError('网络错误: ' + e.message); }
    if (r.error) appendWbError(r.error);
  };
  bar.appendChild(applyAll);
  bar.appendChild(discardAll);
  bar.appendChild(checkBtn);
  bar.appendChild(status);
  card.appendChild(bar);

  const setStatus = (st, fileStates) => {
    status.textContent = st === 'pending' ? '待审批' : (st === 'applied' ? '✓ 已全部应用' : (st === 'partial' ? '部分处理' : '已丢弃'));
    status.dataset.st = st;
    const done = st === 'applied' || st === 'discarded';
    applyAll.hidden = done;
    discardAll.hidden = done;
    checkBtn.hidden = done;
    for (const f of (fileStates ?? files)) {
      const row = fileRows.get(f.path);
      if (!row) continue;
      row.stSpan.textContent = f.status === 'pending' ? '' : (f.status === 'applied' ? '✓ 已应用' : '已丢弃');
      row.stSpan.dataset.st = f.status;
      row.applyBtn.hidden = f.status !== 'pending';
      row.discardBtn.hidden = f.status !== 'pending';
    }
  };
  card.updateStatus = setStatus;
  setStatus(build.status, files);
  return card;
}

function appendWbError(text) {
  const div = document.createElement('div');
  div.className = 'wb-error';
  div.textContent = text;
  $('#wbLog').appendChild(div);
  $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
}

function ensureLiveBox(agentName) {
  if (wbLiveBox) return wbLiveBox.querySelector('pre');
  wbLiveBox = document.createElement('div');
  wbLiveBox.className = 'build-live';
  const head = document.createElement('div');
  head.className = 'build-live-head';
  head.textContent = agentName + ' 动手中——实时输出';
  const pre = document.createElement('pre');
  wbLiveBox.appendChild(head);
  wbLiveBox.appendChild(pre);
  $('#wbLog').appendChild(wbLiveBox);
  return pre;
}
function removeLiveBox() { if (wbLiveBox) { wbLiveBox.remove(); wbLiveBox = null; } }

function onWbEvent(ev) {
  if (ev.type === 'chat-message') { removeLiveBox(); appendWbMessage(ev.from, ev.name, ev.to, ev.data, ev.ctx, ev.build); }
  if (ev.type === 'build-progress') {
    const pre = ensureLiveBox(cfg.agents[ev.agentId]?.name ?? ev.agentId);
    pre.appendChild(document.createTextNode(ev.data));
    // 只留末尾 ~12KB，防长任务把 DOM 撑爆
    while (pre.textContent.length > 12000 && pre.firstChild) pre.removeChild(pre.firstChild);
    wbLiveBox.scrollTop = wbLiveBox.scrollHeight;
    $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
  }
  if (ev.type === 'check-result') {
    const card = document.createElement('div');
    card.className = 'check-card ' + (ev.ok ? 'check-ok' : 'check-fail');
    const head = document.createElement('div');
    head.className = 'check-head';
    head.textContent = (ev.timedOut ? '⏱ 检查超时' : (ev.ok ? '✓ 检查通过' : `✗ 检查未通过（exit ${ev.code}）`)) + ' · ' + ev.cmd;
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = '查看输出';
    const pre = document.createElement('pre');
    pre.textContent = ev.output || '（无输出）';
    det.appendChild(sum);
    det.appendChild(pre);
    card.appendChild(head);
    card.appendChild(det);
    $('#wbLog').appendChild(card);
    $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
  }
  if (ev.type === 'build-status') {
    const card = $('#wbLog').querySelector(`.build-card[data-build-id="${ev.buildId}"]`);
    if (card?.updateStatus) card.updateStatus(ev.status, ev.files);
  }
  if (ev.type === 'state') { setWbBusy(ev.data === 'busy'); if (ev.data === 'idle') removeLiveBox(); }
  if (ev.type === 'agent-status') {
    const name = cfg.agents[ev.agentId]?.name ?? ev.agentId;
    const chipDot = $('#wbMembers')?.querySelector(`.member-chip[data-agent="${ev.agentId}"] .st-dot`);
    if (chipDot) chipDot.className = 'st-dot ' + (ev.data === 'running' ? 'st-live' : 'st-idle');
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
  wbInfo = info;
  $('#wbTitle').textContent = info.name || '未命名工作台';
  // 成员状态条（参考 agent 标签语义）：每人一枚芯片，发言中亮点
  const members = $('#wbMembers');
  members.innerHTML = '';
  for (const p of info.participants) {
    const chip = document.createElement('span');
    chip.className = 'member-chip';
    chip.dataset.agent = p;
    const d = document.createElement('i');
    d.className = 'st-dot st-idle';
    chip.appendChild(d);
    chip.appendChild(document.createTextNode(info.agentNames[p] ?? p));
    members.appendChild(chip);
  }
  if (info.workspace) {
    const ws = document.createElement('span');
    ws.className = 'wb-ws';
    ws.textContent = info.workspace.split(/[\\/]/).pop();
    ws.title = '挂载: ' + info.workspace;
    members.appendChild(ws);
  }
  // 动手按钮：挂了工作区且有可写模型才出现
  $('#wbBuild').hidden = !(info.workspace && (info.writeCapable ?? []).length);
  $('#wbLog').innerHTML = '';
  const rc = $('#wbRecipients');
  rc.innerHTML = '';
  for (const p of info.participants) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p;
    label.appendChild(cb);
    const canBuild = (info.writeCapable ?? []).includes(p) && info.workspace;
    label.appendChild(document.createTextNode(' ' + (info.agentNames[p] ?? p) + (canBuild ? '（可动手）' : '')));
    if (canBuild) label.title = '该模型可「动手」：在隔离副本内真实改文件，diff 由你审批';
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

// ---- 工作台按钮绑定 ----
$('#wbCreate').onclick = async () => {
  const participants = [...$('#wbParticipants').querySelectorAll('input:checked')].map(cb => cb.value);
  const bar = $('#wbSetupBar');
  const err = msg => { bar.hidden = false; bar.textContent = msg; bar.classList.add('err'); };
  if (!participants.length) return err('请至少勾选一个参与模型');
  let r;
  try { r = await (await fetch('/api/workbenches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#wbName').value.trim(), workspace: $('#wbWorkspace').value.trim(), participants }) })).json(); }
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
$('#wbBuild').onclick = async () => {
  if (!wbId) return;
  const text = $('#wbInput').value.trim();
  if (!text) return appendWbError('把任务写在输入框里，再点「动手」');
  const checked = [...$('#wbRecipients').querySelectorAll('input:checked')].map(cb => cb.value);
  const capable = (wbInfo?.writeCapable ?? []);
  if (checked.length !== 1) return appendWbError('动手需要恰好勾选一位模型（标注「可动手」的）');
  if (!capable.includes(checked[0])) return appendWbError('勾选的模型不支持动手——请选标注「可动手」的模型');
  $('#wbInput').value = '';
  let r;
  try { r = await (await fetch(`/api/workbenches/${wbId}/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, agentId: checked[0] }) })).json(); }
  catch (e) { return appendWbError('网络错误: ' + e.message); }
  if (r.error) appendWbError(r.error);
};
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
