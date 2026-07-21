// ===== 启动：填充引擎/模板下拉、刷新会话列表、装配 draft 预填；最后一个加载 =====

let agentDiagnosticsOpen = { agentStatus: false, wbAgentStatus: false };
let appBootActiveModalClose = null;

async function boot() {
  applyI18n(); // 先按当前语言渲染所有静态文本（data-i18n 属性）
  bindFolderBrowseButtons();
  bindWorkspacePathInputs();
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
  $('#tpl').addEventListener('change', renderTemplatePreview);
  renderTemplatePreview();
  $('#staleBanner').hidden = !cfg.stale; // 前端新后端旧 → 常驻横幅提醒重启
  renderAgentStatus();
  renderWbParticipantPicker(); // 统一容器：落地默认视图是建台页，选人器开机即就绪
  await refreshSessionList();
  await applyDraftFromHash();
  renderTemplatePreview();
  // 页面已开着时又发起新会议（仅 hash 变化不重载）→ 同样要预填
  window.addEventListener('hashchange', applyDraftFromHash);
}

function renderTemplatePreview() {
  const template = cfg?.templates?.[$('#tpl').value];
  if (!template) return;
  $('#tplDebaterFormat').textContent = localizeField(template.debaterFormat);
  $('#tplJudgeFormat').textContent = localizeField(template.judgeFormat) || t('setup.defaultJudgeFormat');
  const roleSection = $('#tplRoleBriefs');
  roleSection.hidden = !template.roleBriefs;
  if (!template.roleBriefs) {
    $('#tplRoleBriefA').textContent = '';
    $('#tplRoleBriefB').textContent = '';
    return;
  }
  $('#tplRoleBriefA').textContent = localizeField(template.roleBriefs.debaterA);
  $('#tplRoleBriefB').textContent = localizeField(template.roleBriefs.debaterB);
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

// ===== 引擎状态灯：灰=未检查 绿=就绪 红=故障。检查=一次真实 CLI 最小调用（消耗额度），
// 只由用户显式触发（点单灯或「检查全部」），绝不自动轮询。=====
function agentDiagnosticText(agent) {
  if (agent.unavailable) return t('diag.notFound');
  if (!agent.smoke) return t('diag.unknown');
  if (agent.smoke.ok) return t('diag.ok', { s: Math.max(1, Math.round((agent.smoke.durationMs ?? 0) / 1000)) });
  if (agent.smoke.error === 'auth') return t('diag.auth');
  if (agent.smoke.error === 'timeout') return t('diag.timeout');
  return t('diag.failGeneric', { msg: agent.smoke.error ?? '' });
}

function renderAgentDiagnostics(container) {
  const panel = document.createElement('div');
  panel.className = 'agent-diagnostics';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', t('diag.toggleTip'));
  for (const [, agent] of Object.entries(cfg.agents)) {
    const row = document.createElement('div');
    row.className = 'agent-diagnostic-row';
    const head = document.createElement('div');
    head.className = 'agent-diagnostic-head';
    const name = document.createElement('strong');
    name.className = 'agent-diagnostic-name';
    name.textContent = agent.name;
    const bin = document.createElement('code');
    bin.className = 'agent-diagnostic-bin';
    bin.textContent = agent.bin;
    bin.title = agent.bin;
    head.append(name, bin);
    const status = document.createElement('div');
    const state = agent.unavailable || (agent.smoke && !agent.smoke.ok) ? 'bad' : (agent.smoke?.ok ? 'ok' : 'unknown');
    status.className = 'agent-diagnostic-status diag-' + state;
    status.textContent = agentDiagnosticText(agent);
    row.append(head, status);
    panel.appendChild(row);
  }
  const advanced = document.createElement('div');
  advanced.className = 'agent-diagnostic-advanced';
  advanced.textContent = t('diag.advanced');
  panel.appendChild(advanced);
  container.appendChild(panel);
}

function renderAgentStatus() {
  for (const el of [$('#agentStatus'), $('#wbAgentStatus')]) {
    if (!el) continue;
    el.replaceChildren();
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'as-label';
    label.textContent = t('status.engines');
    label.title = t('diag.toggleTip');
    label.setAttribute('aria-expanded', String(!!agentDiagnosticsOpen[el.id]));
    label.onclick = () => {
      agentDiagnosticsOpen[el.id] = !agentDiagnosticsOpen[el.id];
      renderAgentStatus();
    };
    el.appendChild(label);
    for (const [id, a] of Object.entries(cfg.agents)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'as-chip';
      chip.dataset.agent = id;
      const st = a.unavailable ? 'bad' : (a.smoke ? (a.smoke.ok ? 'ok' : 'bad') : 'unknown');
      const dot = document.createElement('span');
      dot.className = 'as-dot as-' + st;
      chip.title = a.unavailable ? a.unavailable
        : a.smoke ? (a.smoke.ok ? t('status.okTip', { s: Math.max(1, Math.round((a.smoke.durationMs ?? 0) / 1000)) }) : (a.smoke.error ?? ''))
        : t('status.unknownTip');
      chip.append(dot, document.createTextNode(a.name));
      if (!a.unavailable) chip.onclick = () => smokeAgent(id);
      el.appendChild(chip);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'as-checkall';
    btn.textContent = t('status.checkAll');
    btn.onclick = smokeAllAgents;
    el.appendChild(btn);
    const configure = document.createElement('button');
    configure.type = 'button';
    configure.className = 'as-configure';
    configure.textContent = t('agentcfg.open');
    configure.onclick = openAgentConfig;
    el.appendChild(configure);
    if (agentDiagnosticsOpen[el.id]) renderAgentDiagnostics(el);
  }
}

async function smokeAgent(id) {
  document.querySelectorAll(`.as-chip[data-agent="${CSS.escape(id)}"] .as-dot`)
    .forEach(d => { d.className = 'as-dot as-checking'; });
  let r;
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(id)}/smoke`, { method: 'POST' });
    // 404 = 正在运行的服务还没有这个接口（前端文件是现读的、服务进程是旧的）——
    // 这是「服务需重启」，不是引擎故障，别亮误导性的红灯
    r = resp.status === 404 ? { ok: false, error: t('status.stale') } : await resp.json();
  } catch (e) { r = { ok: false, error: e.message }; }
  if (r.error && r.ok === undefined) r = { ok: false, error: r.error }; // 409 等错误响应归一
  cfg.agents[id].smoke = r;
  renderAgentStatus();
  return r;
}

async function smokeAllAgents() {
  // 串行：控成本，也避免多个 CLI 同时抢登录态刷新
  for (const [id, a] of Object.entries(cfg.agents)) if (!a.unavailable) await smokeAgent(id);
}

function bindFolderBrowseButtons() {
  document.querySelectorAll('.browse-btn[data-target]').forEach(button => {
    if (button.dataset.folderPickerBound) return;
    button.dataset.folderPickerBound = 'true';
    button.onclick = async () => {
      const input = document.getElementById(button.dataset.target);
      if (input) await pickFolderFor(input);
    };
  });
}

function normalizePathInput(v) {
  let s = String(v ?? '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) s = s.slice(1, -1).trim();
  return s;
}

function bindWorkspacePathInputs() {
  for (const input of [$('#wbWorkspace'), $('#workspace')]) {
    if (!input || input.dataset.workspacePathBound) continue;
    input.dataset.workspacePathBound = 'true';
    input.addEventListener('change', () => { input.value = normalizePathInput(input.value); });
    input.addEventListener('input', () => input.classList.remove('input-error'));
  }
}

function showWorkspaceError(barEl, inputEl, payload) {
  if (!barEl) return;
  const data = payload && typeof payload === 'object' ? payload : { error: payload };
  const message = String(data.error ?? '');
  const pathRelated = !!data.suggest || /找不到这个路径|这是一个文件，不是文件夹|Path not found|This is a file, not a folder|项目目录(?:不存在|必须是文件夹)|Project directory (?:does not exist|must be a folder)/i.test(message);
  barEl.dataset.workspacePathError = pathRelated ? 'true' : 'false';
  barEl.replaceChildren();
  barEl.hidden = false;
  barEl.classList.add('err');
  const text = document.createElement('span');
  text.textContent = message;
  barEl.appendChild(text);
  if (data.suggest && inputEl) {
    const useParentButton = document.createElement('button');
    useParentButton.type = 'button';
    useParentButton.className = 'workspace-use-parent';
    useParentButton.textContent = t('workspace.useParent');
    useParentButton.onclick = () => {
      inputEl.value = normalizePathInput(data.suggest);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.classList.remove('input-error');
      barEl.replaceChildren();
      barEl.classList.remove('err');
      barEl.hidden = true;
      delete barEl.dataset.workspacePathError;
      inputEl.focus();
    };
    barEl.appendChild(useParentButton);
  }
  if (pathRelated && inputEl) {
    inputEl.classList.add('input-error');
    inputEl.focus();
  }
}

async function pickFolderFor(inputEl) {
  if (!inputEl) return;
  const button = [...document.querySelectorAll('.browse-btn[data-target]')]
    .find(candidate => candidate.dataset.target === inputEl.id);
  const errorBar = inputEl.id === 'wbWorkspace' ? $('#wbSetupBar') : $('#setupbar');
  const clearPathError = () => {
    inputEl.classList.remove('input-error');
    if (errorBar?.dataset.workspacePathError !== 'true') return;
    errorBar.replaceChildren();
    errorBar.classList.remove('err');
    errorBar.hidden = true;
    delete errorBar.dataset.workspacePathError;
  };
  const oldLabel = button?.textContent ?? '';
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = t('folder.opening');
  }
  // 逃生口：系统对话框偶尔拿不到前台焦点（藏在浏览器窗口后面），用户会以为卡死。
  // 等 6 秒仍未返回就给一枚「取消，改用内置选择器」，点它终结子进程并降级。
  let escapeBtn = null;
  const escapeTimer = setTimeout(() => {
    if (!button || escapeBtn) return;
    escapeBtn = document.createElement('button');
    escapeBtn.type = 'button';
    escapeBtn.className = 'browse-escape';
    escapeBtn.textContent = t('folder.escape');
    escapeBtn.title = t('folder.escapeTip');
    escapeBtn.onclick = async () => {
      escapeBtn.disabled = true;
      try { await fetch('/api/pick-folder/cancel', { method: 'POST' }); } catch { /* 服务不可达也照样降级 */ }
      escapeBtn.remove();
      escapeBtn = null;
      await openFolderPicker(inputEl, true);
    };
    button.insertAdjacentElement('afterend', escapeBtn);
  }, 6000);
  const clearEscape = () => { clearTimeout(escapeTimer); escapeBtn?.remove(); escapeBtn = null; };
  try {
    let response;
    let result;
    try {
      response = await fetch('/api/pick-folder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ start: normalizePathInput(inputEl.value) || '', lang: LANG }),
      });
      result = await response.json();
    } catch {
      await openFolderPicker(inputEl, true);
      return;
    }
    if (response.status === 409) {
      showWorkspaceError(errorBar, inputEl, { error: result.error || t('folder.busy') });
      return;
    }
    if (result.ok) {
      inputEl.value = normalizePathInput(result.path);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      clearPathError();
      return;
    }
    if (result.canceled) return;
    if (result.unsupported || response.status === 404) {
      await openFolderPicker(inputEl, true);
      return;
    }
    showWorkspaceError(errorBar, inputEl, result.error || t('browse.notDir'));
  } finally {
    clearEscape();
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = oldLabel;
    }
  }
}

async function openFolderPicker(targetInputEl, showFallbackNote = false) {
  if (!targetInputEl) return;
  if (appBootActiveModalClose) appBootActiveModalClose();
  const previousFocus = document.activeElement;
  const browseTrigger = [...document.querySelectorAll('.browse-btn[data-target]')]
    .find(candidate => candidate.dataset.target === targetInputEl.id);
  const overlay = document.createElement('div');
  overlay.className = 'folder-picker-overlay';
  const dialog = document.createElement('section');
  dialog.className = 'folder-picker';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'folderPickerTitle');

  const title = document.createElement('h2');
  title.id = 'folderPickerTitle';
  title.textContent = t('folder.title');
  const fallbackNote = document.createElement('p');
  fallbackNote.className = 'folder-picker-fallback-note';
  fallbackNote.textContent = t('folder.fallbackNote');
  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'folder-picker-path';
  pathInput.placeholder = t('folder.pathHint');
  pathInput.setAttribute('aria-label', t('folder.pathHint'));
  pathInput.value = normalizePathInput(targetInputEl.value);
  const upButton = document.createElement('button');
  upButton.type = 'button';
  upButton.className = 'folder-picker-up';
  upButton.textContent = t('folder.up');
  const list = document.createElement('div');
  list.className = 'folder-picker-list';
  const status = document.createElement('div');
  status.className = 'folder-picker-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const error = document.createElement('div');
  error.className = 'folder-picker-error';
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'folder-picker-actions';
  const pickButton = document.createElement('button');
  pickButton.type = 'button';
  pickButton.className = 'primary';
  pickButton.textContent = t('folder.pick');
  pickButton.disabled = true;
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = t('folder.cancel');
  actions.append(pickButton, cancelButton);
  dialog.appendChild(title);
  if (showFallbackNote) dialog.appendChild(fallbackNote);
  dialog.append(pathInput, upButton, list, status, error, actions);
  overlay.appendChild(dialog);

  let currentPath = '';
  let parentPath = '';
  const closePicker = () => {
    window.removeEventListener('keydown', onPickerKeydown);
    overlay.remove();
    if (appBootActiveModalClose === closePicker) appBootActiveModalClose = null;
    const focusTarget = previousFocus?.isConnected && previousFocus !== document.body ? previousFocus : browseTrigger;
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
  };
  const onPickerKeydown = event => {
    if (event.key === 'Escape') return closePicker();
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  appBootActiveModalClose = closePicker;
  window.addEventListener('keydown', onPickerKeydown);
  overlay.onclick = event => { if (event.target === overlay) closePicker(); };
  cancelButton.onclick = closePicker;
  document.body.appendChild(overlay);
  cancelButton.focus();

  const renderPickerError = problem => {
    error.replaceChildren();
    const message = typeof problem === 'string' ? problem : String(problem?.error ?? '');
    if (!message) return;
    const text = document.createElement('span');
    text.textContent = message;
    error.appendChild(text);
    if (problem && typeof problem === 'object' && problem.suggest) {
      const useParentButton = document.createElement('button');
      useParentButton.type = 'button';
      useParentButton.className = 'workspace-use-parent';
      useParentButton.textContent = t('workspace.useParent');
      useParentButton.onclick = () => loadFolder(problem.suggest);
      error.appendChild(useParentButton);
    }
  };

  const loadFolder = async requestedPath => {
    status.textContent = t('folder.loading');
    renderPickerError(null);
    list.setAttribute('aria-busy', 'true');
    pathInput.disabled = true;
    upButton.disabled = true;
    pickButton.disabled = true;
    let result;
    try {
      const response = await fetch('/api/browse?path=' + encodeURIComponent(requestedPath || '') + '&lang=' + encodeURIComponent(LANG));
      result = await response.json();
    } catch (e) {
      result = { error: e.message };
    }
    if (!result.ok) {
      const message = result.error || t('browse.notDir');
      const problem = { error: message, ...(result.suggest ? { suggest: result.suggest } : {}) };
      status.textContent = '';
      renderPickerError(problem);
      list.setAttribute('aria-busy', 'false');
      pathInput.disabled = false;
      pathInput.value = normalizePathInput(requestedPath);
      upButton.disabled = !currentPath;
      pickButton.disabled = true;
      return;
    }
    currentPath = result.path;
    parentPath = result.parent;
    pathInput.value = currentPath;
    list.replaceChildren();
    if (!result.dirs.length) {
      const empty = document.createElement('div');
      empty.className = 'folder-picker-empty';
      empty.textContent = t('folder.empty');
      list.appendChild(empty);
    } else {
      for (const name of result.dirs) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'folder-picker-item';
        item.textContent = name;
        item.onclick = () => {
          if (!currentPath) return loadFolder(name);
          const separator = currentPath.includes('\\') ? '\\' : '/';
          const childPath = currentPath.endsWith(separator) ? currentPath + name : currentPath + separator + name;
          loadFolder(childPath);
        };
        list.appendChild(item);
      }
    }
    status.textContent = '';
    renderPickerError(null);
    list.setAttribute('aria-busy', 'false');
    pathInput.disabled = false;
    upButton.disabled = !currentPath;
    pickButton.disabled = !currentPath;
  };

  pathInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    loadFolder(normalizePathInput(pathInput.value));
  });
  upButton.onclick = () => {
    const atWindowsDriveRoot = /^[A-Za-z]:[\\/]$/.test(currentPath) && parentPath === currentPath;
    loadFolder(atWindowsDriveRoot ? ':drives:' : parentPath);
  };
  pickButton.onclick = () => {
    if (!currentPath) return;
    targetInputEl.value = currentPath;
    targetInputEl.dispatchEvent(new Event('input', { bubbles: true }));
    targetInputEl.classList.remove('input-error');
    const errorBar = targetInputEl.id === 'wbWorkspace' ? $('#wbSetupBar') : $('#setupbar');
    if (errorBar?.dataset.workspacePathError === 'true') {
      errorBar.replaceChildren();
      errorBar.classList.remove('err');
      errorBar.hidden = true;
      delete errorBar.dataset.workspacePathError;
    }
    closePicker();
  };
  const initialPath = normalizePathInput(targetInputEl.value);
  await loadFolder('');
  if (initialPath) await loadFolder(initialPath);
}

async function openAgentConfig() {
  if (appBootActiveModalClose) appBootActiveModalClose();
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'agent-config-overlay';
  const dialog = document.createElement('section');
  dialog.className = 'agent-config';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'agentConfigTitle');
  const title = document.createElement('h2');
  title.id = 'agentConfigTitle';
  title.textContent = t('agentcfg.title');
  const hint = document.createElement('p');
  hint.className = 'agent-config-hint';
  hint.textContent = t('agentcfg.hint');
  const textarea = document.createElement('textarea');
  textarea.className = 'agent-config-editor';
  textarea.setAttribute('aria-label', t('agentcfg.title'));
  textarea.spellcheck = false;
  textarea.disabled = true;
  const message = document.createElement('div');
  message.className = 'agent-config-message';
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.textContent = t('agentcfg.loading');
  const actions = document.createElement('div');
  actions.className = 'agent-config-actions';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'primary';
  saveButton.textContent = t('agentcfg.save');
  saveButton.disabled = true;
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = t('agentcfg.cancel');
  actions.append(saveButton, cancelButton);
  dialog.append(title, hint, textarea, message, actions);
  overlay.appendChild(dialog);

  const closeConfig = () => {
    window.removeEventListener('keydown', onConfigKeydown);
    overlay.remove();
    if (appBootActiveModalClose === closeConfig) appBootActiveModalClose = null;
    const focusTarget = previousFocus?.isConnected ? previousFocus : document.querySelector('.as-configure');
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
  };
  const onConfigKeydown = event => {
    if (event.key === 'Escape') return closeConfig();
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  appBootActiveModalClose = closeConfig;
  window.addEventListener('keydown', onConfigKeydown);
  overlay.onclick = event => { if (event.target === overlay) closeConfig(); };
  cancelButton.onclick = closeConfig;
  document.body.appendChild(overlay);
  cancelButton.focus();

  let raw;
  try {
    raw = await (await fetch('/api/agents/raw')).json();
  } catch (e) {
    raw = { error: e.message };
  }
  if (!raw.ok) {
    message.classList.add('is-error');
    message.setAttribute('role', 'alert');
    message.textContent = raw.error || t('agentcfg.invalid');
    return;
  }
  textarea.value = raw.content;
  textarea.disabled = false;
  saveButton.disabled = false;
  message.textContent = '';
  textarea.focus();

  saveButton.onclick = async () => {
    saveButton.disabled = true;
    saveButton.setAttribute('aria-busy', 'true');
    saveButton.textContent = t('agentcfg.saving');
    message.classList.remove('is-error');
    message.setAttribute('role', 'status');
    message.textContent = t('agentcfg.saving');
    let result;
    try {
      const response = await fetch('/api/agents/raw', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: textarea.value }),
      });
      result = await response.json();
    } catch (e) {
      result = { error: e.message };
    }
    if (!result.ok) {
      message.classList.add('is-error');
      message.setAttribute('role', 'alert');
      message.textContent = t('agentcfg.invalid') + ': ' + (result.error || t('agentcfg.invalid'));
      saveButton.disabled = false;
      saveButton.removeAttribute('aria-busy');
      saveButton.textContent = t('agentcfg.save');
      textarea.focus();
      return;
    }
    cfg.agents = result.agents;
    renderAgentStatus();
    if (typeof renderWbParticipantPicker === 'function') renderWbParticipantPicker();
    for (const bar of [$('#setupbar'), $('#wbSetupBar')]) {
      if (!bar) continue;
      bar.hidden = false;
      bar.classList.remove('err');
      bar.textContent = t('agentcfg.saved');
    }
    closeConfig();
  };
}

boot();
