// ===== 启动：填充引擎/模板下拉、刷新会话列表、装配 draft 预填；最后一个加载 =====

async function boot() {
  applyI18n(); // 先按当前语言渲染所有静态文本（data-i18n 属性）
  try {
    cfg = await (await fetch('/api/config')).json();
  } catch (e) {
    return setStatebar(t('dyn.connectFail', { msg: e.message }), true);
  }
  const opts = role => Object.entries(cfg.agents)
    .filter(([, a]) => a.roles.includes(role))
    .map(([id, a]) => `<option value="${id}"${a.unavailable ? ' disabled' : ''}>${a.name}${a.unavailable ? t('dyn.unavailable') : ''}</option>`).join('');
  $('#debA').innerHTML = opts('debater');
  $('#debB').innerHTML = opts('debater');
  if ($('#debB').options.length > 1) $('#debB').selectedIndex = 1;
  $('#judge').innerHTML = opts('judge');
  $('#summ').innerHTML = opts('summarizer');
  $('#tpl').innerHTML = Object.entries(cfg.templates).map(([n, t]) => `<option value="${n}">${localizeField(t.title)}</option>`).join('');
  await refreshSessionList();
  await applyDraftFromHash();
  // 页面已开着时又发起新会议（仅 hash 变化不重载）→ 同样要预填
  window.addEventListener('hashchange', applyDraftFromHash);
}

$('#newSessionBtn').onclick = () => {
  closeEvents();
  closeWbEvents();
  sid = null;
  resetSessionUI();
  showSetup();
  refreshSessionList();
};

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

$('#langToggle').onclick = () => setLang(LANG === 'zh' ? 'en' : 'zh');

boot();
