// ===== 启动：填充引擎/模板下拉、刷新会话列表、装配 draft 预填；最后一个加载 =====

let agentDiagnosticsOpen = { agentStatus: false, wbAgentStatus: false };

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

function bindMeetingWorkspaceErrorHighlight() {
  const input = $('#workspace');
  const start = $('#start');
  if (!input || !start || start.dataset.workspaceErrorBound) return;
  start.dataset.workspaceErrorBound = 'true';
  input.addEventListener('input', () => input.classList.remove('input-error'));
  const originalHandler = start.onclick;
  start.onclick = async function (...args) {
    const result = await originalHandler.apply(this, args);
    const message = $('#setupbar')?.textContent ?? '';
    if (/项目目录不存在|directory does not exist/i.test(message)) {
      input.classList.add('input-error');
      input.focus();
    }
    return result;
  };
}

bindMeetingWorkspaceErrorHighlight();
boot();
