// ===== 核心：DOM 助手 + 跨模块全局状态 + 状态条 + 视图切换 =====
// 前端为 classic script 多文件加载（共享同一全局作用域，语义等价单文件）。
// 加载顺序：core → committee → workbench → sidebar → boot。

const $ = s => document.querySelector(s);

// 跨模块共享的全局状态（集中一处声明——这就是前端的全部共享状态）
let cfg;                    // /api/config 返回的引擎与模板
let sid = null;            // 当前活动会议 id
let sideOf = {};          // agentId -> 'A' | 'B'
let es = null;            // 当前会议 EventSource（新会话/重连前需先关闭）
let draftOrigin = null;   // 升格草稿携带的来源工作台目录名（建会时随请求提交）
let sessionOrigin = '';   // 当前会议的来源工作台（非空则裁决卡可回流）
let archiveDirname = null; // 当前只读归档视图对应的磁盘目录名
let wbId = null;          // 当前活动工作台 id
let wbEs = null;          // 当前工作台 EventSource
let wbInfo = null;        // 当前工作台详情（workspace/writeCapable 等）

// 状态提示：会话区可见时写主状态条，否则写建会话页的提示条（修复：创建失败静默无反应）
function setStatebar(msg, isErr) {
  const target = $('#arena').hidden ? $('#setupbar') : $('#statebar');
  target.hidden = false;
  target.textContent = msg;
  target.classList.toggle('err', !!isErr);
}

// ---- 视图切换（五个顶层视图互斥）----
const VIEWS = ['#setup', '#arena', '#archiveView', '#wbSetup', '#workbench'];
function showView(sel) { for (const v of VIEWS) $(v).hidden = v !== sel; }
function showSetup() { showView('#setup'); }
function showArena() { showView('#arena'); }
function showArchiveView(topic, sessionMd) {
  $('#archiveTopic').textContent = topic ?? '';
  $('#archiveContent').textContent = sessionMd ?? '';
  showView('#archiveView');
}
