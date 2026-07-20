// ===== 侧边栏：会话列表（统一容器：工作台为顶层，来源会议缩进挂其下；孤儿会议平级）=====

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function refreshSessionList() {
  let list;
  try { list = await (await fetch('/api/sessions')).json(); } catch { return; }
  const el = $('#sessionList');
  el.innerHTML = '';
  // 统一容器（方案 A 第一期）：会议是工作台讨论流的升格事件——有来源的会议缩进显示在来源工作台之下
  const benchDirname = s => (s.type === 'workbench' ? (s.archived ? s.id : (s.dirname || '')) : null);
  const benchDirs = new Set(list.map(benchDirname).filter(Boolean));
  const childrenOf = {};
  const top = [];
  for (const s of list) {
    if (s.type !== 'workbench' && s.origin && benchDirs.has(s.origin)) (childrenOf[s.origin] ??= []).push(s);
    else top.push(s); // 工作台、孤儿会议（草稿直建/来源已删）
  }
  for (const s of top) {
    el.appendChild(buildSessionItem(s, false));
    const dn = benchDirname(s);
    if (dn) for (const m of childrenOf[dn] ?? []) el.appendChild(buildSessionItem(m, true));
  }
}

function buildSessionItem(s, isChild) {
  const isWb = s.type === 'workbench';
  const item = document.createElement('div');
  item.className = 'session-item' + (s.archived ? ' archived' : '') + (isChild ? ' session-child' : '')
    + (!s.archived && (s.id === sid || s.id === wbId) ? ' active' : '');
  const title = document.createElement('div');
  title.className = 'session-title';
  title.textContent = (isChild ? '⚖ ' : '') + (s.topic || t('dyn.noTopic')).replace(/^\[工作台\] /, '');
  const meta = document.createElement('div');
  meta.className = 'session-meta';
  // 状态点（参考 super.engineering 侧栏行语义）：running/busy=accent 呼吸，done=绿，其余=灰
  const dot = document.createElement('i');
  const st = s.state ?? '';
  dot.className = 'st-dot ' + (['running', 'busy', 'judging'].includes(st) ? 'st-live' : (st === 'done' ? 'st-done' : 'st-idle'));
  title.prepend(dot);
  const when = s.updatedAt ? ' · ' + fmtTime(s.updatedAt) : '';
  const sep = ' · ';
  meta.textContent = (isWb
    ? (t('dyn.wbActive') + sep + (s.archived ? t('dyn.archived') : (s.state === 'busy' ? t('dyn.busy') : t('dyn.online'))) + sep + t('dyn.msgs', { n: s.round ?? 0 }))
    : (s.archived ? (t('dyn.archived') + sep + (s.state ?? '')) : ((s.state ?? '') + sep + t('dyn.roundN', { n: s.round ?? 0 })))) + when;
  meta.title = s.updatedAt ? t('dyn.updatedAt', { t: new Date(s.updatedAt).toLocaleString() }) : '';
  if (s.pending > 0) { // 待批 diff 徽章
    const badge = document.createElement('span');
    badge.className = 'pending-badge';
    badge.textContent = t('dyn.pending', { n: s.pending });
    meta.appendChild(badge);
  }
  const del = document.createElement('button');
  del.className = 'session-del';
  del.textContent = '✕';
  del.title = t('dyn.del');
  del.onclick = async e => {
    e.stopPropagation(); // 不触发条目本身的打开动作
    if (!confirm(t('dyn.delConfirm', { topic: (s.topic || t('dyn.noTopic')).replace(/^\[工作台\] /, '') }))) return;
    const url = s.archived ? '/api/archive/' + encodeURIComponent(s.id)
      : (isWb ? '/api/workbenches/' + s.id : '/api/sessions/' + s.id);
    let r;
    try { r = await (await fetch(url, { method: 'DELETE' })).json(); } catch (err) { return setStatebar(t('dyn.delFail', { msg: err.message }), true); }
    if (r.error) return setStatebar(r.error, true);
    if (!s.archived && s.id === sid) { closeEvents(); sid = null; resetSessionUI(); $('#newBenchBtn').click(); } // 回到默认建台页
    if (!s.archived && s.id === wbId) { closeWbEvents(); $('#newBenchBtn').click(); }
    await refreshSessionList();
  };
  item.appendChild(title);
  item.appendChild(meta);
  const ren = document.createElement('button');
  ren.className = 'session-rename';
  ren.textContent = '✎';
  ren.title = t('dyn.rename');
  // 归档的会议条目右侧还有 ↻ 恢复按钮，改名按钮再往左让一格
  ren.style.right = (s.archived && !isWb) ? '46px' : '26px';
  ren.onclick = async e => {
    e.stopPropagation();
    const current = (s.topic || '').replace(/^\[工作台\] /, '');
    const name = prompt(t('dyn.renamePrompt'), current);
    if (name === null || !name.trim() || name.trim() === current) return;
    const url = s.archived ? '/api/archive/' + encodeURIComponent(s.id) + '/rename'
      : (isWb ? '/api/workbenches/' + s.id + '/rename' : '/api/sessions/' + s.id + '/rename');
    const body = isWb && !s.archived ? { name: name.trim() } : { title: name.trim() };
    let r;
    try { r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }
    catch (err) { return setStatebar(t('dyn.renameFail', { msg: err.message }), true); }
    if (r.error) return setStatebar(r.error, true);
    if (!s.archived && isWb && s.id === wbId) $('#wbTitle').textContent = name.trim(); // 当前工作台标题同步
    await refreshSessionList();
  };
  item.appendChild(ren);
  if (s.archived && !isWb) {
    const resume = document.createElement('button');
    resume.className = 'session-resume';
    resume.textContent = '↻';
    resume.title = t('dyn.resumeTitle');
    resume.onclick = e => { e.stopPropagation(); resumeSession(s.id); };
    item.appendChild(resume);
  }
  item.appendChild(del);
  // 工作台：归档条目点击即恢复（无只读视图——恢复零成本，不产生 CLI 调用）
  item.onclick = () => isWb
    ? (s.archived ? resumeWorkbench(s.id) : attachWorkbench(s.id))
    : (s.archived ? openArchive(s.id) : attach(s.id));
  return item;
}
