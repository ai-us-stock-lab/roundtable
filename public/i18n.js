// ===== 极简零依赖 i18n（最先加载）=====
// 机制：字典 key -> {en, zh}；t(key, vars) 取当前语言；applyI18n() 遍历 data-i18n* 属性替换。
// 切换语言 = 存 localStorage + 刷新页面（最稳，免去动态 DOM 重渲染的复杂度）。

const I18N = {
  // ---- 侧边栏 / 通用 ----
  'sidebar.start': { zh: '+ 开始', en: '+ Start' },
  'sidebar.empty': { zh: '还没有会话记录', en: 'No sessions yet' },
  'sidebar.summaryTip': { zh: '书记的滚动摘要与分歧分类表会出现在这里', en: "The scribe's rolling summary and disagreement table appear here" },
  'sidebar.stale': { zh: '⟳ 服务端代码已更新——重启服务后生效（start-server.cmd）', en: '⟳ Backend code has changed — restart the server (start-server.cmd) to pick it up' },
  'lang.toggle': { zh: 'EN', en: '中文' },
  'lang.toggleTitle': { zh: 'Switch to English', en: '切换到中文' },

  // ---- 引擎状态灯 ----
  'status.engines': { zh: '引擎状态', en: 'Engines' },
  'status.checkAll': { zh: '检查全部', en: 'Check all' },
  'status.unknownTip': { zh: '未检查——点击做一次真实调用检查登录态（消耗一次额度）', en: 'Not checked — click to run one real health call (uses one request)' },
  'status.okTip': { zh: '就绪（{s}s）——点击重新检查', en: 'Ready ({s}s) — click to re-check' },
  'status.stale': { zh: '服务进程是旧版本（无此接口）——重启服务（npm start）后再检查', en: 'Server process is an older build (endpoint missing) — restart it (npm start), then re-check' },

  // ---- 仲裁/书记状态芯片 ----
  'staff.judge': { zh: '仲裁', en: 'Judge' },
  'staff.scribe': { zh: '书记', en: 'Scribe' },
  'staff.idle': { zh: '待命', en: 'standby' },
  'staff.running': { zh: '运行中…', en: 'running…' },
  'staff.done': { zh: '完成 ✓', en: 'done ✓' },
  'staff.retryTip': { zh: '失败——点击重试（仲裁重跑裁决 / 书记重新生成本轮摘要）', en: 'Failed — click to retry (judge re-runs the verdict / scribe regenerates this round\'s summary)' },

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
  'arena.flowbackGo': { zh: '投放', en: 'Send' },
  'dyn.flowbackPickFirst': { zh: '请先在下拉框选择目标工作台，再点「投放」', en: 'Pick a target workbench in the dropdown first, then hit Send' },
  'dyn.flowbackBusy': { zh: '投放中……（归档工作台需先恢复，稍等一两秒）', en: 'Sending… (an archived workbench is being restored first)' },
  'arena.flowbackPick': { zh: '投放/转发裁决卡到工作台…', en: 'Redistribute verdict to a workbench…' },
  'arena.groupChat': { zh: '场边追问', en: 'Sideline Q&A' },
  'arena.groupChatToggle': { zh: '展开/收起场边追问', en: 'Toggle sideline Q&A' },
  'arena.groupChatHint': { zh: '轮间/会后基于本场上下文向参会 AI 追问（不打断辩论）', en: 'Ask participants between rounds, grounded in this meeting (never interrupts the debate)' },
  'arena.chatInputPh': { zh: '和参会 AI 自由讨论……（Ctrl+Enter 发送）', en: 'Chat freely with participants… (Ctrl+Enter to send)' },
  'arena.send': { zh: '发送', en: 'Send' },
  'arena.notePh': { zh: '主持人插话（进入下一轮双方简报）', en: "Moderator note (folded into next round's briefs)" },
  'arena.viewDense': { zh: '☰ 简明视图', en: '☰ Distilled view' },
  'arena.viewFull': { zh: '☰ 全量视图', en: '☰ Full view' },
  'arena.viewToggleTitle': { zh: '简明：书记摘要一到自动折叠该轮辩手原文（点标题可展开）；全量：原文全部展开', en: "Distilled: each round's raw statements auto-collapse once the scribe summary lands (click a round title to expand). Full: everything expanded." },
  'arena.sendNote': { zh: '插话', en: 'Interject' },
  'arena.sendNoteTitle': { zh: '随时可发（自动跑轮间也行）——排队进入下一轮双方简报；Ctrl+Enter 同效', en: "Send anytime (even mid auto-run) — queued into the next round's briefs; Ctrl+Enter works too" },
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
  'wbSetup.advancedMeeting': { zh: '直接开一场独立会议 →', en: 'Start a standalone meeting →' },
  'wbSetup.advancedMeetingTitle': { zh: '不经工作台直接开正式会议（一般建议先聊，聊到分歧再「就此开会」）', en: 'Convene a formal meeting without a workbench (usually: chat first, convene when a real disagreement shows up)' },

  // ---- 工作台 ----
  'wb.promote': { zh: '就此开会', en: 'Convene a meeting' },
  'wb.promoteTitle': { zh: '把这段讨论打包成会议简报、就地开一场正式委员会；裁决卡会自动落回本时间线', en: 'Bundle this discussion into a meeting brief and convene a formal committee; the verdict card lands back in this timeline automatically' },
  'wb.inputPh': { zh: '发消息……（不勾收件人 = 回复上一个发言的模型；Ctrl+Enter 发送）', en: 'Message… (no recipient = reply to whoever spoke last; Ctrl+Enter to send)' },
  'wb.addAgent': { zh: '＋ 添加参与者…', en: '+ Add participant…' },
  'wb.removeTitle': { zh: '移出该参与者（历史保留，可随时加回）', en: 'Remove this participant (history kept, re-add anytime)' },
  'wb.routeHint': { zh: '未勾收件人 → 将发给 {name}', en: 'No recipient → goes to {name}' },
  'wb.relay': { zh: '让他们讨论', en: 'Let them talk' },
  'wb.relayTitle': { zh: '让模型们就当前讨论互相接力发言，可点名反驳与追问；聊无可聊会自动提前结束', en: 'Have the models relay-respond to each other, pushing back and questioning by name; auto-stops when talked out' },
  'wb.build': { zh: '指派修改', en: 'Assign change' },
  'wb.buildWith': { zh: '指派 {name} 修改', en: 'Assign to {name}' },
  'wb.assign': { zh: '指派修改', en: 'Assign change' },
  'wb.changesTitle': { zh: '变更', en: 'Changes' },
  'wb.changeNo': { zh: '变更 #{n}', en: 'Change #{n}' },
  'wb.changeRef': { zh: '↳ 提交了变更 #{n}（{stat}）—— 点击查看', en: '↳ submitted Change #{n} ({stat}) — click to view' },
  'wb.actor': { zh: '执行者', en: 'Executor' },
  'wb.taskPh': { zh: '任务：要改什么、为什么、验收标准……（Ctrl+Enter 指派）', en: 'Task: what to change, why, acceptance criteria… (Ctrl+Enter to assign)' },
  'wb.actionHint': { zh: '在项目的隔离副本中真实改文件；产出 diff 逐文件审批后才落入你的工作区', en: 'Edits real files in an isolated copy of your project; the diff lands only after your per-file approval' },
  'role.talk': { zh: '讨论者', en: 'Discussant' },
  'role.propose': { zh: '提案者', en: 'Proposer' },
  'role.arbiter': { zh: '仲裁', en: 'Arbiter' },
  'wb.roleTip': { zh: '能力：讨论者=只动嘴；提案者=可被指派产出变更', en: 'Capability: Discussant = talk only; Proposer = can be assigned changes' },
  'wb.arbiterTip': { zh: '叠加职责，至多一位（授予即从他人处转移）。可配在任一能力上：冲突时整理各方 pro/con 供你拍板并执行融合。「讨论者+仲裁」=不提自己方案的纯裁判（利益回避最优）', en: 'Stackable duty, at most one holder (granting transfers it). On either capability: on conflicts, digests pro/con for your call and executes the merge. Discussant+Arbiter = a pure judge with no proposals of its own (best for impartiality)' },
  'wb.roleNoWrite': { zh: '该引擎无安全写模式，只能作为纯讨论者（提案与执行融合都需写文件）', en: 'This engine has no safe write mode — pure discussant only (both proposing and merge execution write files)' },
  'wb.decide': { zh: '替我决断', en: 'Decide for me' },
  'wb.decideTip': { zh: '冲突时授权它直接选边并融合（默认只整理 pro/con 交你拍板）；最终应用进工作区仍需你批准', en: 'On conflict, let it pick a side and merge directly (default: it only prepares pro/con for your call); applying to your workspace still needs your approval' },
  'wb.noEligibleActor': { zh: '（无可执行者——先在上方把某位的角色改为提案者/仲裁者）', en: '(no eligible executor — set someone\'s role to Proposer/Arbiter above)' },
  'wb.helpTitle': { zh: '❓ 角色说明', en: '❓ Role guide' },
  'wb.helpTalk': { zh: '讨论者：不自主产出变更——只讨论与评审。角色管的是 agent 的自主行为；你在下方显式指派任何有写能力的引擎（含讨论者）都可以。', en: 'Discussant: never produces changes on its own — discussion and review only. Roles govern autonomous behavior; you can still explicitly assign any write-capable engine (discussants included) below.' },
  'wb.helpPropose': { zh: '提案者：讨论者 + 可被指派修改——在项目的隔离副本里真实改文件，产出变更（diff）；每个文件落进你的工作区前都需你批准。', en: 'Proposer: discussant + can be assigned changes — edits real files in an isolated copy, producing a diff; every file needs your approval before it lands in your workspace.' },
  'wb.helpArbiter': { zh: '仲裁：叠加职责，至多一位（授予即转移）——可配在讨论者或提案者身上，多个变更打架时整理各方 pro/con 供你拍板，你选定后由它执行融合。「讨论者+仲裁」即不提自己方案的纯裁判。', en: 'Arbiter: a stackable duty, at most one holder (granting transfers it) — when changes clash, it digests each side\'s pros/cons for your call, then executes the merge you pick. Discussant+Arbiter = a pure judge with no proposals of its own.' },
  'wb.helpDecide': { zh: '「替我决断」：授权仲裁者在冲突时直接选边并融合（过程留痕）。无论哪档，应用进工作区的批准权永远在你。', en: '"Decide for me": lets the arbiter pick a side and merge directly on conflict (fully logged). Either way, applying to your workspace always needs your approval.' },
  'wb.helpNoWrite': { zh: '为何有的引擎只能当讨论者：写权需要该引擎声明「安全写模式」——隔离副本管住改动不外溢，安全写模式管住过程不越权，缺一层就不给写权。在 adapters/agents.json 为其补上 writeArgs 即可解锁。', en: 'Why some engines are discussant-only: write access requires a vetted safe-write mode. The isolated copy contains change spillover; the safe-write mode contains process overreach — missing either layer means no write. Declare writeArgs for the engine in adapters/agents.json to unlock.' },
  'wb.buildTitle': { zh: '把输入框内容作为任务，交给勾选的那一个模型在隔离副本里真实改文件；产出 diff 由你审批后才落地', en: 'Give the input box to the one checked model as a task; it edits files in an isolated copy, and the diff lands only after you approve' },
  'wb.stop': { zh: '停止', en: 'Stop' },
  'wb.send': { zh: '发送', en: 'Send' },
  'wb.logEmpty': { zh: '开聊吧——不勾收件人时，消息发给上一个发言的模型', en: "Start chatting — with no recipient checked, the message goes to whoever spoke last" },
  'arena.chatEmpty': { zh: '还没有消息——先勾选收件人，再向参会 AI 提问', en: 'No messages yet — check a recipient, then ask the participants' },

  // ---- 归档 ----
  'archive.back': { zh: '← 返回', en: '← Back' },
  'archive.resume': { zh: '恢复此会话', en: 'Resume this session' },

  'dyn.noteQueued': { zh: '插话已排队——将进入下一轮双方简报', en: "Note queued — it will be folded into the next round's briefs" },

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
  'setup.templatePreview': { zh: '模板格式预览', en: 'Template format preview' },
  'setup.debaterFormat': { zh: '辩手输出格式', en: 'Debater output format' },
  'setup.judgeFormat': { zh: '裁决卡格式', en: 'Verdict card format' },
  'setup.defaultJudgeFormat': { zh: '该模板未定制，使用默认裁决卡格式', en: 'This template does not customize it; the default verdict card format will be used.' },
  'wb.conflictsTitle': { zh: '⚠ 冲突待处置', en: '⚠ Conflicts to resolve' },
  'wb.conflictInvolves': { zh: '涉及：', en: 'Involves:' },
  'wb.discussBtn': { zh: '深入讨论', en: 'Discuss deeper' },
  'wb.discussBusy': { zh: '对比生成中…', en: 'Generating comparison…' },
  'wb.mergeBtn': { zh: '仲裁融合', en: 'Arbiter merge' },
  'wb.decideBtn': { zh: '按授权决断', en: 'Decide as authorized' },
  'wb.needArbiterTip': { zh: '先在上方给一位参与者勾选仲裁', en: 'First assign one participant as arbiter above' },
  'wb.needDecideTip': { zh: '该仲裁未勾「替我决断」', en: 'This arbiter does not have "Decide for me" enabled' },
  'wb.conflictBadge': { zh: '⚠ 冲突', en: '⚠ Conflict' },
  'wb.conflictHint': { zh: '重叠的变更不会被拦截或默判——看对比、做决定，或交给仲裁融合；最终应用仍需你逐文件批准', en: 'Overlapping changes are neither blocked nor decided silently. Review the comparison, decide, or ask the arbiter to merge; you still approve each file before it is applied.' },
  'wb.meetingStarted': { zh: '会议已开始', en: 'Meeting started' },
  'wb.meetingVerdict': { zh: '会议裁决', en: 'Meeting verdict' },
  'wb.meetingVerdictExpand': { zh: '展开裁决卡', en: 'Expand verdict card' },
  'wb.openMeeting': { zh: '打开会场', en: 'Open meeting' },
  'wb.meetingGone': { zh: '找不到该会议(可能已删除)', en: 'Meeting not found (it may have been deleted)' },
  'setup.roleBriefs': { zh: '角色分工', en: 'Role assignments' },
  'setup.roleBriefA': { zh: '辩手 A · 视角', en: 'Debater A · Perspective' },
  'setup.roleBriefB': { zh: '辩手 B · 视角', en: 'Debater B · Perspective' },
  'diag.toggleTip': { zh: '展开或收起引擎诊断与修复指引', en: 'Show or hide engine diagnostics and recovery guidance' },
  'diag.notFound': { zh: '未找到可执行文件——确认已安装，或在 adapters/agents.json 配置路径/环境变量，改后重启服务', en: 'Executable not found. Confirm it is installed, or configure its path or environment variable in adapters/agents.json, then restart the service.' },
  'diag.auth': { zh: '登录态失效——在终端运行该 CLI 完成登录，然后点灯复查', en: 'Login expired. Run this CLI in a terminal and complete login, then click its light to re-check.' },
  'diag.timeout': { zh: '响应超时——引擎可能较慢，可点灯重试；持续超时可在 adapters/agents.json 调大 timeoutMs（重启生效）', en: 'Response timed out. The engine may be slow; click its light to retry. If timeouts persist, increase timeoutMs in adapters/agents.json and restart the service.' },
  'diag.failGeneric': { zh: '检查失败（{msg}）——点灯重试；若持续失败，请检查该 CLI 与 adapters/agents.json 配置', en: 'Health check failed ({msg}). Click its light to retry; if it persists, check the CLI and adapters/agents.json.' },
  'diag.ok': { zh: '就绪（{s}s）', en: 'Ready ({s}s)' },
  'diag.unknown': { zh: '尚未检查——点灯执行一次真实调用', en: 'Not checked. Click its light to run one real health call.' },
  'diag.checking': { zh: '检查中…', en: 'Checking…' },
  'diag.advanced': { zh: '高级配置（命令/参数/超时）：adapters/agents.json，修改后重启服务生效', en: 'Advanced configuration (command, arguments, timeout): adapters/agents.json. Restart the service after changes.' },
  'wb.wsEditTip': { zh: '切换或卸载工作区项目目录', en: 'Switch or unmount the workspace project directory' },
  'wb.wsPrompt': { zh: '输入项目目录；留空将卸载当前目录：', en: 'Enter a project directory. Leave it empty to unmount the current directory:' },
  'wb.wsMount': { zh: '＋ 挂载项目目录', en: '+ Mount project directory' },
  'wb.wsSaving': { zh: '切换中…', en: 'Switching…' },
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
  LANG = lang;
  localStorage.setItem('rt-lang', lang);
  // 防御性刷新模板预览：当前实现整页重载后 boot 会重渲染（实测已覆盖语言切换）；
  // 此调用保证未来若改为不重载的切换实现，预览仍随语言即时刷新
  if (typeof renderTemplatePreview === 'function') renderTemplatePreview();
  location.reload(); // 最稳：新语言在 localStorage，刷新后全量按新语言渲染
}

// 本地化字段：{zh,en} 取当前 UI 语言；纯字符串（旧格式）原样返回
function localizeField(v) {
  if (v && typeof v === 'object') return v[LANG] ?? v.zh ?? v.en ?? '';
  return v ?? '';
}
