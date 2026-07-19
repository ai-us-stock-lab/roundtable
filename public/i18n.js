// ===== 极简零依赖 i18n（最先加载）=====
// 机制：字典 key -> {en, zh}；t(key, vars) 取当前语言；applyI18n() 遍历 data-i18n* 属性替换。
// 切换语言 = 存 localStorage + 刷新页面（最稳，免去动态 DOM 重渲染的复杂度）。

const I18N = {
  // ---- 侧边栏 / 通用 ----
  'sidebar.newMeeting': { zh: '+ 会议', en: '+ Meeting' },
  'sidebar.newWorkbench': { zh: '+ 工作台', en: '+ Workbench' },
  'sidebar.empty': { zh: '还没有会话记录', en: 'No sessions yet' },
  'sidebar.summaryTip': { zh: '书记的滚动摘要与分歧分类表会出现在这里', en: "The scribe's rolling summary and disagreement table appear here" },
  'lang.toggle': { zh: 'EN', en: '中文' },
  'lang.toggleTitle': { zh: 'Switch to English', en: '切换到中文' },

  // ---- 建会议页 ----
  'setup.title': { zh: '发起一场会议', en: 'Start a meeting' },
  'setup.topicPh': { zh: '议题：要决策什么？', en: 'Topic: what are we deciding?' },
  'setup.materialsPh': { zh: '背景材料（可选）', en: 'Background material (optional)' },
  'setup.workspacePh': { zh: '项目目录（可选，绝对路径——参会 AI 将可只读查阅该目录下的文件）', en: 'Project directory (optional, absolute path — participants get read-only access to its files)' },
  'setup.template': { zh: '模板', en: 'Template' },
  'setup.debaterA': { zh: '辩手 A', en: 'Debater A' },
  'setup.debaterB': { zh: '辩手 B', en: 'Debater B' },
  'setup.judge': { zh: '仲裁', en: 'Judge' },
  'setup.scribe': { zh: '书记（摘要）', en: 'Scribe (summary)' },
  'setup.scribeTitle': { zh: '每轮把双方发言整理成滚动摘要与分歧分类表的角色', en: 'Condenses each round into a rolling summary + disagreement table' },
  'setup.start': { zh: '开始第 1 轮（clean room）', en: 'Start round 1 (clean room)' },

  // ---- 会场 ----
  'arena.retry': { zh: '重试', en: 'Retry' },
  'arena.skip': { zh: '跳过', en: 'Skip' },
  'arena.brief': { zh: '议题与背景材料', en: 'Topic & background' },
  'arena.noMaterials': { zh: '（无背景材料）', en: '(no background material)' },
  'arena.resummarize': { zh: '重新生成本轮摘要', en: "Regenerate this round's summary" },
  'arena.verdict': { zh: '裁决卡', en: 'Verdict card' },
  'arena.copy': { zh: '复制', en: 'Copy' },
  'arena.flowback': { zh: '回流到来源工作台', en: 'Send back to workbench' },
  'arena.flowbackTitle': { zh: '把裁决卡作为一条消息贴回升格前的工作台，接着聊', en: 'Post the verdict card back to the workbench it was promoted from' },
  'arena.groupChat': { zh: '群聊', en: 'Group chat' },
  'arena.groupChatToggle': { zh: '展开/收起群聊', en: 'Toggle group chat' },
  'arena.groupChatHint': { zh: '基于本场会议上下文，与参会 AI 讨论', en: 'Discuss with participants, grounded in this meeting' },
  'arena.chatInputPh': { zh: '和参会 AI 自由讨论……（Ctrl+Enter 发送）', en: 'Chat freely with participants… (Ctrl+Enter to send)' },
  'arena.send': { zh: '发送', en: 'Send' },
  'arena.notePh': { zh: '主持人插话（进入下一轮双方简报）', en: "Moderator note (folded into next round's briefs)" },
  'arena.nextRound': { zh: '下一轮', en: 'Next round' },
  'arena.auto': { zh: '自动跑完', en: 'Auto-run' },
  'arena.upTo': { zh: '至多', en: 'up to' },
  'arena.rounds': { zh: '轮', en: 'rounds' },
  'arena.stopRound': { zh: '停止当前轮', en: 'Stop round' },
  'arena.goVerdict': { zh: '进入裁决', en: 'Go to verdict' },
  'arena.savePartial': { zh: '保存半成品', en: 'Save partial' },

  // ---- 工作台建立 ----
  'wbSetup.title': { zh: '开一个工作台', en: 'Open a workbench' },
  'wbSetup.hint': { zh: '多模型群聊：随时提问、点名任意模型接力讨论；聊到需要正式对撞时，一键升格为委员会会议。', en: 'Multi-model group chat: ask anytime, address any model, relay them; promote to a formal committee meeting in one click when you need a real showdown.' },
  'wbSetup.namePh': { zh: '给这个工作台起个名（可选）', en: 'Name this workbench (optional)' },
  'wbSetup.workspacePh': { zh: '项目目录（可选，绝对路径——聊天时模型可只读查阅；是 git 仓库则可让模型「动手」改文件）', en: 'Project directory (optional, absolute path — models read it while chatting; if a git repo, they can "build" — edit files)' },
  'wbSetup.create': { zh: '开聊', en: 'Start chatting' },

  // ---- 工作台 ----
  'wb.promote': { zh: '升格为会议', en: 'Promote to meeting' },
  'wb.promoteTitle': { zh: '把这段讨论打包成会议草稿，开一场正式委员会', en: 'Package this chat into a meeting draft and open a formal committee' },
  'wb.inputPh': { zh: '发消息……（不勾收件人 = 回复上一个发言的模型；Ctrl+Enter 发送）', en: 'Message… (no recipient = reply to whoever spoke last; Ctrl+Enter to send)' },
  'wb.relay': { zh: '让他们讨论', en: 'Let them talk' },
  'wb.relayTitle': { zh: '让模型们就当前讨论互相接力发言，可点名反驳与追问；聊无可聊会自动提前结束', en: 'Have the models relay-respond to each other, pushing back and questioning by name; auto-stops when talked out' },
  'wb.build': { zh: '动手', en: 'Build' },
  'wb.buildTitle': { zh: '把输入框内容作为任务，交给勾选的那一个模型在隔离副本里真实改文件；产出 diff 由你审批后才落地', en: 'Give the input box to the one checked model as a task; it edits files in an isolated copy, and the diff lands only after you approve' },
  'wb.stop': { zh: '停止', en: 'Stop' },
  'wb.send': { zh: '发送', en: 'Send' },
  'wb.logEmpty': { zh: '开聊吧——不勾收件人时，消息发给上一个发言的模型', en: "Start chatting — with no recipient checked, the message goes to whoever spoke last" },
  'arena.chatEmpty': { zh: '还没有消息——先勾选收件人，再向参会 AI 提问', en: 'No messages yet — check a recipient, then ask the participants' },

  // ---- 归档 ----
  'archive.back': { zh: '← 返回', en: '← Back' },
  'archive.resume': { zh: '恢复此会话', en: 'Resume this session' },

  // ---- JS 动态：状态 / 错误 / 确认 ----
  'dyn.noTopic': { zh: '（无议题）', en: '(no topic)' },
  'dyn.wbPrefix': { zh: '[工作台] ', en: '[Workbench] ' },
  'dyn.connectFail': { zh: '无法连接服务（{msg}）——请在 Roundtable 目录运行 npm start 后刷新本页', en: 'Cannot reach the server ({msg}) — run npm start in the Roundtable dir, then refresh' },
  'dyn.draftExpired': { zh: '预填草稿已过期，请手动填写议题', en: 'Prefill draft expired — please fill in the topic manually' },
  'dyn.draftFilled': { zh: '议题、背景材料与模板已由项目对话预填——选好阵容后点「开始第 1 轮」', en: 'Topic, materials and template were prefilled — pick the lineup and hit "Start round 1"' },
  'dyn.running': { zh: 'running · {t}', en: 'running · {t}' },
  'dyn.judgeRunning': { zh: '仲裁（{name}）正在裁决——比较证据强弱与证伪点质量…', en: 'Judge ({name}) is deliberating — weighing evidence and refutations…' },
  'dyn.scribeRunning': { zh: '书记（{name}）正在整理本轮摘要与分歧分类表…', en: 'Scribe ({name}) is compiling this round\'s summary and disagreement table…' },
  'dyn.typing': { zh: '{name} 正在输入…', en: '{name} is typing…' },
  'dyn.roundDone': { zh: '第 {round} 轮结束——可插话后继续', en: 'Round {round} done — interject then continue' },
  'dyn.state': { zh: '状态: {data}', en: 'State: {data}' },
  'dyn.errPrefix': { zh: '错误', en: 'Error' },
  'dyn.errWith': { zh: '错误（{name}）: {msg}', en: 'Error ({name}): {msg}' },
  'dyn.errPlain': { zh: '错误: {msg}', en: 'Error: {msg}' },
  'dyn.authHint': { zh: '（请在终端重新登录该 CLI 后点「重试」）', en: '(re-login that CLI in your terminal, then hit Retry)' },
  'dyn.netErr': { zh: '网络错误: {msg}', en: 'Network error: {msg}' },
  'dyn.roundTitle': { zh: '第 {n} 轮', en: 'Round {n}' },
  'dyn.jumpTo': { zh: '跳转到 {label}', en: 'Jump to {label}' },

  'dyn.creating': { zh: '正在创建会话…', en: 'Creating session…' },
  'dyn.creatingBtn': { zh: '正在创建会话…', en: 'Creating…' },
  'dyn.sameDebater': { zh: '两个辩手不能是同一个 agent', en: 'The two debaters cannot be the same agent' },
  'dyn.needTopic': { zh: '请先填写议题', en: 'Please enter a topic first' },
  'dyn.createFail': { zh: '无法连接服务（{msg}）——请在 Roundtable 目录运行 npm start，然后刷新本页重试', en: 'Cannot reach the server ({msg}) — run npm start in the Roundtable dir and refresh' },
  'dyn.needRecipient': { zh: '请至少勾选一位收件人', en: 'Check at least one recipient' },
  'dyn.flowbackFail': { zh: '回流失败: {msg}', en: 'Send-back failed: {msg}' },
  'dyn.readArchiveFail': { zh: '无法读取归档: {msg}', en: 'Cannot read archive: {msg}' },
  'dyn.resumeFail': { zh: '恢复失败: {msg}', en: 'Resume failed: {msg}' },
  'dyn.noServer': { zh: '无法连接服务: {msg}', en: 'Cannot reach the server: {msg}' },

  // 侧边栏条目
  'dyn.wbActive': { zh: '工作台', en: 'Workbench' },
  'dyn.archived': { zh: '已归档', en: 'archived' },
  'dyn.busy': { zh: '回复中', en: 'replying' },
  'dyn.online': { zh: '在线', en: 'online' },
  'dyn.msgs': { zh: '{n} 条', en: '{n} msgs' },
  'dyn.roundN': { zh: '第 {n} 轮', en: 'round {n}' },
  'dyn.pending': { zh: '待批 {n}', en: '{n} pending' },
  'dyn.del': { zh: '删除该会话记录', en: 'Delete this session' },
  'dyn.delConfirm': { zh: '删除「{topic}」？记录将移入回收站（sessions/.trash/），需要时可手工找回。', en: 'Delete "{topic}"? It moves to the recycle bin (sessions/.trash/) and can be recovered manually.' },
  'dyn.delFail': { zh: '删除失败: {msg}', en: 'Delete failed: {msg}' },
  'dyn.rename': { zh: '重命名', en: 'Rename' },
  'dyn.renamePrompt': { zh: '新名字：', en: 'New name:' },
  'dyn.renameFail': { zh: '重命名失败: {msg}', en: 'Rename failed: {msg}' },
  'dyn.resumeTitle': { zh: '恢复此会话继续辩论', en: 'Resume this session to keep debating' },
  'dyn.updatedAt': { zh: '最后更新：{t}', en: 'Last updated: {t}' },

  // 工作台动态
  'dyn.replying': { zh: '回复中…', en: 'Replying…' },
  'dyn.unnamedWb': { zh: '未命名工作台', en: 'Untitled workbench' },
  'dyn.mounted': { zh: '挂载: {path}', en: 'Mounted: {path}' },
  'dyn.canBuild': { zh: '（可动手）', en: ' (can build)' },
  'dyn.canBuildTitle': { zh: '该模型可「动手」：在隔离副本内真实改文件，diff 由你审批', en: 'This model can "build": edits files in an isolated copy, diff subject to your approval' },
  'dyn.unavailable': { zh: '（不可用）', en: ' (unavailable)' },
  'dyn.streamBroken': { zh: '事件流连接中断——刷新页面或从侧边栏重新进入', en: 'Event stream dropped — refresh or re-open from the sidebar' },
  'dyn.streamBrokenShort': { zh: '事件流连接中断', en: 'Event stream dropped' },
  'dyn.pickParticipant': { zh: '请至少勾选一个参与模型', en: 'Check at least one participating model' },
  'dyn.buildNeedText': { zh: '把任务写在输入框里，再点「动手」', en: 'Write the task in the input box, then click Build' },
  'dyn.buildNeedOne': { zh: '动手需要恰好勾选一位模型（标注「可动手」的）', en: 'Build needs exactly one checked model (one marked "can build")' },
  'dyn.buildNotCapable': { zh: '勾选的模型不支持动手——请选标注「可动手」的模型', en: 'The checked model cannot build — pick one marked "can build"' },
  'dyn.promoteFail': { zh: '升格失败: {msg}', en: 'Promote failed: {msg}' },

  // diff / 检查
  'dyn.ctxChip': { zh: '该模型仅看到最近 {shown} 条（共 {total} 条）', en: 'this model saw only the last {shown} of {total} messages' },
  'dyn.buildLive': { zh: '{name} 动手中——实时输出', en: '{name} building — live output' },
  'dyn.patchMissing': { zh: '（patch 内容缺失，仅存统计）', en: '(patch content missing, stats only)' },
  'dyn.applyAll': { zh: '全部应用', en: 'Apply all' },
  'dyn.discardAll': { zh: '全部丢弃', en: 'Discard all' },
  'dyn.check': { zh: '跑检查', en: 'Run check' },
  'dyn.checkTitle': { zh: '在「主工作区状态+此改动」的临时副本里运行构建/测试命令，通过了再应用', en: 'Run a build/test command on a temp copy (main worktree + this change); apply only if it passes' },
  'dyn.checkPrompt': { zh: '检查命令（在应用前于临时副本中运行）：', en: 'Check command (runs on a temp copy before applying):' },
  'dyn.applyOne': { zh: '应用', en: 'Apply' },
  'dyn.applyOneTitle': { zh: '只应用这个文件的改动', en: 'Apply only this file' },
  'dyn.discardOne': { zh: '丢弃', en: 'Discard' },
  'dyn.stPending': { zh: '待审批', en: 'pending' },
  'dyn.stApplied': { zh: '✓ 已全部应用', en: '✓ all applied' },
  'dyn.stPartial': { zh: '部分处理', en: 'partial' },
  'dyn.stDiscarded': { zh: '已丢弃', en: 'discarded' },
  'dyn.fApplied': { zh: '✓ 已应用', en: '✓ applied' },
  'dyn.fDiscarded': { zh: '已丢弃', en: 'discarded' },
  'dyn.applyFail': { zh: '应用失败: ', en: 'Apply failed: ' },
  'dyn.applyConflictHint': { zh: '（若与本地改动冲突，可手工应用会话目录 builds/ 下的 patch）', en: ' (if it conflicts with local changes, apply the patch in the session builds/ dir manually)' },
  'dyn.checkTimeout': { zh: '⏱ 检查超时', en: '⏱ check timed out' },
  'dyn.checkPass': { zh: '✓ 检查通过', en: '✓ check passed' },
  'dyn.checkFail': { zh: '✗ 检查未通过（exit {code}）', en: '✗ check failed (exit {code})' },
  'dyn.viewOutput': { zh: '查看输出', en: 'View output' },
  'dyn.noOutput': { zh: '（无输出）', en: '(no output)' },
};

let LANG = localStorage.getItem('rt-lang') || (String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');

function t(key, vars) {
  let s = I18N[key]?.[LANG] ?? I18N[key]?.en ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(v);
  return s;
}

// 遍历 data-i18n / data-i18n-ph / data-i18n-title 属性，替换文本/占位符/提示
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  const tgl = document.querySelector('#langToggle');
  if (tgl) { tgl.textContent = t('lang.toggle'); tgl.title = t('lang.toggleTitle'); }
  // CSS :empty::before 占位文本够不到 i18n——经 CSS 变量注入（JSON.stringify 给出带引号且转义安全的字符串）
  const rs = document.documentElement.style;
  rs.setProperty('--i18n-empty-sessions', JSON.stringify(t('sidebar.empty')));
  rs.setProperty('--i18n-empty-summary', JSON.stringify(t('sidebar.summaryTip')));
  rs.setProperty('--i18n-empty-chat', JSON.stringify(t('arena.chatEmpty')));
  rs.setProperty('--i18n-empty-wblog', JSON.stringify(t('wb.logEmpty')));
}

function setLang(lang) {
  localStorage.setItem('rt-lang', lang);
  location.reload(); // 最稳：新语言在 localStorage，刷新后全量按新语言渲染
}
