import http from 'node:http';
import { readFile, writeFile, readdir, rm, rename, mkdir, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Committee } from './orchestrator.js';
import { Workbench, loadWorkbenchFromDisk } from './workbench.js';
import { loadTemplates } from './templates.js';
import { resolveCliPath } from './resolve.js';
import { redact } from './redactor.js';
import { runAgent } from './runner.js';

// 静态文件白名单（无通用静态服务，杜绝路径穿越）
const STATIC = {
  '/': ['public/index.html', 'text/html'],
  '/style.css': ['public/style.css', 'text/css'],
  '/i18n.js': ['public/i18n.js', 'text/javascript'],
  '/app-core.js': ['public/app-core.js', 'text/javascript'],
  '/app-committee.js': ['public/app-committee.js', 'text/javascript'],
  '/app-workbench.js': ['public/app-workbench.js', 'text/javascript'],
  '/app-sidebar.js': ['public/app-sidebar.js', 'text/javascript'],
  '/app-boot.js': ['public/app-boot.js', 'text/javascript'],
};

const isDir = p => {
  try { return existsSync(p) && statSync(p).isDirectory(); }
  catch { return false; }
};

const workspacePathError = (workspace, lang = 'zh') => {
  if (!workspace || isDir(workspace)) return '';
  if (!existsSync(workspace)) return (lang === 'en' ? 'Project directory does not exist: ' : '项目目录不存在: ') + workspace;
  return (lang === 'en'
    ? 'Project directory must be a folder (this path is a file): '
    : '项目目录必须是文件夹(该路径是一个文件): ') + workspace;
};

// 按会话派生 agent 配置：挂载工作区（项目目录只读访问）时，cwd 指向项目根，
// 且配置了 workspaceArgs 的 adapter 换用只读工具集参数（如 claude 放开 Read/Grep/Glob）。
// 深拷贝，绝不污染全局 adapter 配置。
export function deriveSessionAgents(agents, ids, workspace) {
  const out = {};
  for (const id of new Set(ids)) {
    const a = structuredClone(agents[id]);
    if (workspace) {
      a.cwd = workspace;
      if (a.workspaceArgs) a.command = [a.command[0], ...a.workspaceArgs];
    }
    out[id] = a;
  }
  return out;
}

// 写模式配置：仅显式声明 writeArgs（安全写参数）的引擎可「动手」；
// cwd 不在此设置——每次动手时由 Workbench 注入隔离副本目录
export function deriveWriteAgents(agents, ids) {
  const out = {};
  for (const id of new Set(ids)) {
    const a = agents[id];
    if (!a || a.unavailable || !a.writeArgs) continue;
    const c = structuredClone(a);
    c.command = [c.command[0], ...c.writeArgs];
    out[id] = c;
  }
  return out;
}

export async function startServer({ port = 7777, agentsFile = 'adapters/agents.json', templatesDir = 'templates', sessionsDir = 'sessions' } = {}) {
  // 「前端新后端旧」错配检测：前端文件按请求现读、后端代码进程启动时定格。
  // src/*.js 磁盘 mtime 晚于进程启动 → 下发 stale 标记，前端亮「重启生效」横幅。
  const serverStartedMs = Date.now();
  const backendStale = async () => {
    try {
      for (const f of await readdir('src')) {
        if (!f.endsWith('.js')) continue;
        const { mtimeMs } = await stat(path.join('src', f));
        if (mtimeMs > serverStartedMs) return true;
      }
    } catch { /* 探测失败按不陈旧处理 */ }
    return false;
  };
  const agents = JSON.parse(await readFile(agentsFile, 'utf8'));
  // 启动与热重载共用同一加载路径：解析失败不阻塞服务，只标记该 agent 不可用。
  const loadAgents = configuredAgents => {
    for (const [id, a] of Object.entries(configuredAgents)) {
      delete a.unavailable;
      try {
        if (a.disabled) throw new Error(a.disabled); // 手工禁用（已知运行时必失败的 agent，修好后删 disabled 字段即恢复）
        a.command[0] = resolveCliPath(a);
        console.log(`[adapter] ${id} -> ${a.command[0]}`);
      } catch (e) {
        a.unavailable = String(e.message);
        console.warn(`[adapter] ${id} 不可用: ${e.message}`);
      }
    }
  };
  loadAgents(agents);
  const templates = await loadTemplates(templatesDir);
  // 就绪检查（状态灯）：启动时的路径解析只能发现「找不到 CLI」，auth 过期等运行时故障
  // 要真调用一次才暴露。结果存内存（重启清零），随 /api/config 下发供前端亮灯。
  const smokeStatus = {}; // agentId -> { ok, error?, durationMs, ts }
  const smokeInflight = new Set();
  const publicAgents = () => Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, {
    name: a.name,
    roles: Array.isArray(a.roles) ? a.roles : [],
    write: !!a.writeArgs,
    bin: a.command?.[0] ?? '',
    ...(a.unavailable ? { unavailable: a.unavailable } : {}),
    ...(smokeStatus[id] ? { smoke: smokeStatus[id] } : {}),
  }]));
  const sessions = new Map();
  const benches = new Map(); // 工作台会话（与委员会平行的顶层类型）：{ bench, events, clients, updatedAt }
  const drafts = new Map(); // 外部 AI（项目对话侧）预填的议题+简报草稿，浏览器 #draft=<id> 打开即填入表单

  // 统一的事件发射器（委员会与工作台共用一套语义，杜绝两套回放代码漂移）：
  // - 纯瞬态流（build-progress）只发给在线客户端，绝不进回放缓冲——否则长命工作台
  //   积累几十次动手的流式碎片会无界增长、重连越来越慢
  // - 其余事件进缓冲供重连回放；缓冲总量硬上限，超限丢最旧（骨架事件由磁盘状态兜底重建）
  const TRANSIENT = new Set(['build-progress']);
  const EVENT_BUFFER_CAP = 4000;
  const attachEmit = entry => {
    entry.emit = rawEv => {
      entry.updatedAt = new Date().toISOString();
      // 展示层统一脱敏：落盘各处已过 redact，但 SSE 直达前端（进而进录屏/截图）这条路此前是裸的。
      // 模型转述的 worktree/临时目录绝对路径（含用户名）、凭据样式字符串都在这里擦掉；
      // redact 对 JSON 串安全（messages.jsonl 同样 redact 后回读解析，已有先例）。
      const ev = JSON.parse(redact(JSON.stringify(rawEv)));
      if (!TRANSIENT.has(ev.type)) {
        entry.events.push(ev);
        if (entry.events.length > EVENT_BUFFER_CAP) entry.events.splice(0, entry.events.length - EVENT_BUFFER_CAP);
      }
      const line = `data: ${JSON.stringify(ev)}\n\n`;
      for (const c of entry.clients) { try { c.write(line); } catch { entry.clients.delete(c); } }
    };
    return entry;
  };
  const newBenchEntry = () => attachEmit({ events: [], clients: new Set(), updatedAt: new Date().toISOString() });

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const MAX_BODY_BYTES = 1024 * 1024; // 1MB 上限，防止无界内存增长
  const readBody = req => new Promise(r => {
    let b = ''; let bytes = 0; let done = false;
    req.on('data', d => {
      if (done) return;
      bytes += d.length;
      if (bytes > MAX_BODY_BYTES) { done = true; req.destroy(); r({}); return; }
      b += d;
    });
    req.on('end', () => { if (done) return; done = true; try { r(JSON.parse(b || '{}')); } catch { r({}); } });
  });

  // 软删除：移入 sessions/.trash/（可手工找回），绝不物理抹除会议记录
  const moveToTrash = async dir => {
    const trashDir = path.join(sessionsDir, '.trash');
    await mkdir(trashDir, { recursive: true });
    await rename(dir, path.join(trashDir, path.basename(dir) + '-' + Date.now().toString(36)));
  };

  // 活动工作台查找 + 从磁盘装配（resume 路由 / 裁决投放 / 自动落卡共用）
  const findActiveBenchId = dirname => {
    for (const [bid, e] of benches.entries()) if (e.bench.dir && path.basename(e.bench.dir) === dirname) return bid;
    return null;
  };
  const resumeBenchFromDisk = async dirname => {
    let entries = [];
    try { entries = (await readdir(sessionsDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { /* 无目录 */ }
    if (!entries.includes(dirname)) throw new Error('归档不存在'); // 白名单精确匹配，杜绝路径穿越
    const dir = path.join(sessionsDir, dirname);
    const { meta, messages, builds } = await loadWorkbenchFromDisk(dir);
    const participants = (meta.participants ?? []).filter(x => agents[x]);
    if (!participants.length) throw new Error('该工作台的参与模型已全部从配置中移除');
    const wbWorkspace = String(meta.workspace ?? '');
    const entry = newBenchEntry();
    const bench = await Workbench.resume({
      name: String(meta.topic ?? '').replace(/^\[工作台\] /, ''), agents: deriveSessionAgents(agents, participants, wbWorkspace),
      participants, baseDir: sessionsDir, emit: ev => entry.emit(ev), dir, messages,
      workspace: wbWorkspace, writeAgents: deriveWriteAgents(agents, participants), builds,
      buildSessions: meta.buildSessions ?? {}, lang: meta.lang === 'en' ? 'en' : 'zh', perms: meta.perms ?? {},
    });
    entry.bench = bench;
    // 合成事件回放：重建聊天记录（含动手 diff 卡片——patch 从会话目录读回）
    for (const msg of messages) {
      let build;
      if (msg.build) {
        const rec = builds.find(x => x.buildId === msg.build);
        if (rec) {
          let patch = '';
          try { patch = (await readFile(bench.patchPathOf(msg.build), 'utf8')).slice(0, 200000); } catch { /* patch 文件缺失则只展示统计 */ }
          build = { buildId: rec.buildId, stat: rec.stat, status: rec.status, ...(rec.files ? { files: rec.files } : {}), patch };
        }
      }
      entry.events.push({ type: 'chat-message', from: msg.from, name: msg.name, ...(msg.from === 'user' && msg.toNames ? { to: msg.toNames } : {}), data: msg.text, ...(msg.ctx ? { ctx: msg.ctx } : {}), ...(msg.meeting ? { meeting: msg.meeting } : {}), ...(build ? { build } : {}) });
    }
    entry.events.push({ type: 'state', data: 'idle' });
    const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    benches.set(id, entry);
    return id;
  };

  // 把裁决卡作为消息贴进目标工作台（活动的直接用，归档的从磁盘恢复）
  const postVerdictToBench = async (c, targetDirname, card) => {
    const benchId = findActiveBenchId(targetDirname) ?? await resumeBenchFromDisk(targetDirname);
    const b = benches.get(benchId).bench;
    await b.note(
      b.lang === 'en'
        ? '[Verdict] From meeting "' + c.topic + '"\n\n' + card.trim()
        : '【会议裁决】来自会议「' + c.topic + '」\n\n' + card.trim(),
      { meeting: { dir: path.basename(c.dir), topic: c.topic, kind: 'verdict' } },
    );
    return benchId;
  };

  // 统一容器（方案 A 第一期）：会议是工作台时间线里的事件——裁决卡产出即自动落回来源工作台，
  // 不再需要手动「回流」。重跑裁决会再次落卡（以最新为准）。恢复回放走 events.push 不经 emit，不会误触。
  const attachAutoVerdictFlow = entry => {
    const orig = entry.emit;
    entry.emit = ev => {
      orig(ev);
      if (ev.type === 'judge-card' && entry.committee?.origin) {
        postVerdictToBench(entry.committee, entry.committee.origin, ev.data)
          .catch(e => orig({ type: 'sys', data: (entry.committee.lang === 'en' ? 'Auto-post of the verdict to the source workbench failed: ' : '裁决卡自动落回来源工作台失败：') + String(e.message ?? e) }));
      }
    };
    return entry;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i;
      // ① 防 DNS rebinding：恶意域名解析到 127.0.0.1 时 Host 头是攻击者域名——只放行回环 Host
      const host = String(req.headers.host ?? '');
      if (!LOOPBACK.test(host)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'forbidden host' }));
      }
      // ② 防 CSRF：直连本地 API 的跨站请求 Host 头合法（=目标），但浏览器强制带上真实 Origin。
      // 拒绝任何非回环 Origin——否则恶意网页可用 text/plain「简单请求」绕过 CORS 预检、
      // 静默触发写文件类操作（同源请求 Origin 缺省或为回环，正常放行）
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let ohost = '';
        try { ohost = new URL(origin).host; } catch { ohost = 'invalid'; }
        if (!LOOPBACK.test(ohost)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: 'forbidden origin' }));
        }
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      // 静态文件（白名单，无路径穿越面）
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        try {
          const data = await readFile(file);
          // no-cache：本地应用不需要浏览器缓存。否则 HTML/JS 可能一新一旧（浏览器启发式缓存），
          // 曾致按钮文案空白等「幽灵 UI」——同一页面上跑着两个版本的前端
          res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-cache' });
          return res.end(data);
        } catch { return json(res, 404, { error: 'not found' }); }
      }
      if (url.pathname === '/api/browse' && req.method === 'GET') {
        const requestedPath = String(url.searchParams.get('path') ?? '').trim();
        const browsePath = path.resolve(requestedPath || homedir());
        if (!isDir(browsePath)) return json(res, 200, { error: '不是有效的文件夹' });
        let names;
        try { names = await readdir(browsePath); }
        catch { return json(res, 200, { error: '不是有效的文件夹' }); }
        const dirs = [];
        for (const name of names) {
          try {
            if (statSync(path.join(browsePath, name)).isDirectory()) dirs.push(name);
          } catch { /* 无权限或条目已消失：跳过 */ }
        }
        dirs.sort((a, b) => a.localeCompare(b));
        return json(res, 200, {
          ok: true,
          path: browsePath,
          parent: path.dirname(browsePath),
          dirs: dirs.slice(0, 500),
        });
      }
      if (url.pathname === '/api/agents/raw' && req.method === 'GET') {
        try { return json(res, 200, { ok: true, content: await readFile(agentsFile, 'utf8') }); }
        catch (e) { return json(res, 200, { error: String(e.message ?? e) }); }
      }
      if (url.pathname === '/api/agents/raw' && req.method === 'POST') {
        const body = await readBody(req);
        const content = typeof body.content === 'string' ? body.content : '';
        let nextAgents;
        try { nextAgents = JSON.parse(content); }
        catch (e) { return json(res, 400, { error: 'JSON 解析失败: ' + String(e.message ?? e) }); }
        if (!nextAgents || typeof nextAgents !== 'object' || Array.isArray(nextAgents)) {
          return json(res, 400, { error: '配置无效：顶层必须是对象' });
        }
        for (const [key, a] of Object.entries(nextAgents)) {
          const valid = a && typeof a === 'object' && !Array.isArray(a)
            && typeof a.name === 'string' && !!a.name.trim()
            && Array.isArray(a.command) && a.command.length > 0
            && a.command.every(part => typeof part === 'string') && !!a.command[0].trim();
          if (!valid) return json(res, 400, { error: `agent「${key}」配置无效：需要 name 与非空 command 数组` });
        }
        await writeFile(agentsFile, content, 'utf8');
        const reloadedAgents = JSON.parse(content);
        for (const key of Object.keys(agents)) delete agents[key];
        Object.assign(agents, reloadedAgents);
        loadAgents(agents);
        for (const key of Object.keys(smokeStatus)) if (!agents[key]) delete smokeStatus[key];
        return json(res, 200, { ok: true, agents: publicAgents() });
      }
      if (url.pathname === '/api/config') {
        // 只额外暴露诊断所需的可执行路径，不泄漏 command 参数、envWhitelist 等 adapter 细节
        const tpl = Object.fromEntries(Object.entries(templates).map(([n, t]) => [n, {
          title: t.title,
          debaterFormat: t.debaterFormat,
          judgeFormat: t.judgeFormat,
          roleBriefs: t.roleBriefs,
        }]));
        return json(res, 200, { agents: publicAgents(), templates: tpl, stale: await backendStale() });
      }
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        const activeDirs = new Set([
          ...[...sessions.values()].map(e => e.committee.dir && path.basename(e.committee.dir)),
          ...[...benches.values()].map(e => e.bench.dir && path.basename(e.bench.dir)),
        ].filter(Boolean));
        const active = [...sessions.entries()].map(([id, entry]) => ({
          id, topic: entry.committee.topic, state: entry.committee.state, round: entry.committee.round,
          archived: false, updatedAt: entry.updatedAt, origin: entry.committee.origin || '', // 母子分组：会议挂在来源工作台下
          dirname: entry.committee.dir ? path.basename(entry.committee.dir) : '',
        }));
        const activeBenches = [...benches.entries()].map(([id, entry]) => ({
          id, topic: '[工作台] ' + (entry.bench.name || (entry.bench.lang === 'en' ? 'unnamed' : '未命名')), state: entry.bench.state,
          round: entry.bench.messages.length, archived: false, updatedAt: entry.updatedAt, type: 'workbench',
          dirname: entry.bench.dir ? path.basename(entry.bench.dir) : '', // 裁决卡投放等按目录名寻址的操作用
          pending: entry.bench.builds.filter(b => b.status === 'pending').length, // 待批 diff 数
        }));
        let archived = [];
        try {
          const dirents = await readdir(sessionsDir, { withFileTypes: true });
          for (const d of dirents) {
            if (!d.isDirectory() || activeDirs.has(d.name)) continue;
            let meta;
            try { meta = JSON.parse(await readFile(path.join(sessionsDir, d.name, 'metadata.json'), 'utf8')); }
            catch { continue; } // 无 metadata.json（非会话目录）跳过
            archived.push({ id: d.name, topic: meta.topic, state: meta.status, round: meta.rounds, archived: true, updatedAt: meta.updatedAt, origin: String(meta.origin ?? ''), ...(meta.type ? { type: meta.type } : {}) });
          }
        } catch { /* sessionsDir 尚不存在 */ }
        archived.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))); // 归档按最近更新在前
        return json(res, 200, [...active, ...activeBenches, ...archived]);
      }
      // 就绪检查：对单个 agent 做一次真实最小调用（验证 CLI 可启动 + 登录态有效）。
      // 由用户在界面上显式触发——每次消耗一次真实额度，绝不自动轮询。
      if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/smoke') && req.method === 'POST') {
        const id = url.pathname.slice('/api/agents/'.length, -'/smoke'.length);
        const a = agents[id];
        if (!a) return json(res, 404, { error: '未知 agent: ' + id });
        if (a.unavailable) {
          smokeStatus[id] = { ok: false, error: a.unavailable, ts: new Date().toISOString() };
          return json(res, 200, smokeStatus[id]);
        }
        if (smokeInflight.has(id)) return json(res, 409, { error: 'smoke already running' });
        smokeInflight.add(id);
        try {
          // 超时沿用该 adapter 自己声明的 timeoutMs：慢引擎（如 OpenClaw 正常要 ~3 分钟）
          // 用统一的短上限会被误判 timeout——健康检查不能比引擎的已知特性更急躁
          const r = await runAgent(structuredClone(a), 'Health check. Reply with the single word: ok');
          smokeStatus[id] = { ok: r.ok, ...(r.ok ? {} : { error: r.error }), durationMs: r.durationMs, ts: new Date().toISOString() };
          return json(res, 200, smokeStatus[id]);
        } finally { smokeInflight.delete(id); }
      }
      if (url.pathname === '/api/draft' && req.method === 'POST') {
        const body = await readBody(req);
        const id = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
        drafts.set(id, { topic: String(body.topic ?? ''), materials: String(body.materials ?? ''), template: String(body.template ?? ''), workspace: String(body.workspace ?? ''), lang: body.lang === 'en' ? 'en' : (body.lang === 'zh' ? 'zh' : '') });
        while (drafts.size > 20) drafts.delete(drafts.keys().next().value); // 只保留最近 20 份
        return json(res, 200, { id });
      }
      if (url.pathname.startsWith('/api/draft/') && req.method === 'GET') {
        const d = drafts.get(url.pathname.slice('/api/draft/'.length));
        return d ? json(res, 200, d) : json(res, 404, { error: '草稿不存在' });
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const template = templates[body.template];
        if (!template) return json(res, 400, { error: '未知模板: ' + body.template });
        for (const id of [...(body.roles?.debaters ?? []), body.roles?.judge, body.roles?.summarizer])
          if (!agents[id]) return json(res, 400, { error: '未知 agent: ' + id });
        // 工作区挂载：参会 AI 以该目录为只读工作目录，可自行查阅项目文件
        const lang = body.lang === 'en' ? 'en' : 'zh'; // 会话语言：建会时定死，存 metadata，提示词链路按此选中英文
        const workspace = String(body.workspace ?? '').trim();
        const workspaceError = workspacePathError(workspace, lang);
        if (workspaceError) return json(res, 400, { error: workspaceError });
        let materials = body.materials ?? '';
        if (workspace) materials += lang === 'en'
          ? "\n\n---\nParticipant note: your working directory is the project root (read-only). Before speaking, check the key files yourself to verify the brief's claims; cite facts as plain-text \"relative/path:line\" (e.g. src/server.js:123) — no absolute paths, no markdown link syntax (your statements render as plain text, links just become screen-filling noise)."
          : '\n\n---\n参会说明：你的工作目录就是该项目的根目录（只读）。发言前请先自行查阅关键文件核实简报中的说法；引用事实时用「相对路径:行号」纯文本格式（如 src/server.js:123），不要写绝对路径，不要用 markdown 链接语法——你的发言按纯文本展示，链接语法只会变成刷屏的长串。';
        const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
        const now = new Date().toISOString();
        const entry = attachEmit({ events: [], clients: new Set(), createdAt: now, updatedAt: now });
        const roleIds = [...body.roles.debaters, body.roles.judge, body.roles.summarizer];
        let sessionOrigin = String(body.origin ?? '');
        if (!body.origin) {
          sessionOrigin = ''; // 包台被跳过或失败时，保持无 origin 的旧行为
          const participantsIds = [...new Set(roleIds)].filter(agentId => agents[agentId] && !agents[agentId].unavailable);
          if (participantsIds.length) {
            try {
              const wrapEntry = newBenchEntry();
              const wrapBench = new Workbench({
                name: String(body.topic ?? '').slice(0, 40),
                agents: deriveSessionAgents(agents, participantsIds, workspace),
                participants: participantsIds,
                baseDir: sessionsDir,
                emit: ev => wrapEntry.emit(ev),
                workspace,
                writeAgents: deriveWriteAgents(agents, participantsIds),
                lang,
              });
              await wrapBench.init();
              wrapEntry.bench = wrapBench;
              const wrapId = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
              benches.set(wrapId, wrapEntry);
              sessionOrigin = path.basename(wrapBench.dir);
            } catch { /* 包台失败不阻塞建会，回退为无 origin 的旧行为 */ }
          }
        }
        const committee = new Committee({
          topic: body.topic, materials,
          agents: deriveSessionAgents(agents, roleIds, workspace),
          roles: body.roles, template, mode: body.mode ?? 'manual', workspace, origin: sessionOrigin,
          maxRounds: Math.min(Math.max(Number(body.maxRounds) || 4, 1), 10),
          baseDir: sessionsDir, lang,
          emit: ev => entry.emit(ev),
        });
        entry.committee = committee;
        attachAutoVerdictFlow(entry); // 裁决卡产出即自动落回来源工作台（统一容器第一期）
        await committee.init();
        sessions.set(id, entry);
        // 时间线事件通知：来源工作台里留一条「会议已开始」记录（仅活动台，便宜路径）
        const srcBenchId = committee.origin ? findActiveBenchId(committee.origin) : null;
        if (srcBenchId) {
          const b = benches.get(srcBenchId).bench;
          b.note(
            b.lang === 'en' ? `[Meeting started] "${committee.topic}" — see the sidebar to watch or join` : `【会议已开始】「${committee.topic}」——侧栏可进入旁听或主持`,
            { meeting: { dir: path.basename(committee.dir), topic: committee.topic, kind: 'started' } },
          ).catch(() => {});
        }
        return json(res, 200, { id });
      }
      if (url.pathname.startsWith('/api/archive/')) {
        const rest = url.pathname.slice('/api/archive/'.length);
        const slashIdx = rest.indexOf('/');
        const rawDirname = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
        const sub = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);
        let dirname;
        try { dirname = decodeURIComponent(rawDirname); } catch { return json(res, 404, { error: 'not found' }); }
        let entries;
        try { entries = await readdir(sessionsDir); } catch { entries = []; }
        const activeDirs = () => new Set([...sessions.values()].map(e => e.committee.dir && path.basename(e.committee.dir)).filter(Boolean));

        if (sub === 'rename' && req.method === 'POST') {
          if (!entries.includes(dirname)) return json(res, 404, { error: '归档不存在' }); // 白名单精确匹配，杜绝路径穿越
          const body = await readBody(req);
          const title = String(body.title ?? '').trim();
          if (!title) return json(res, 400, { error: '名字不能为空' });
          const metaPath = path.join(sessionsDir, dirname, 'metadata.json');
          let meta;
          try { meta = JSON.parse(await readFile(metaPath, 'utf8')); } catch { return json(res, 404, { error: '归档不存在' }); }
          meta.topic = meta.type === 'workbench' ? '[工作台] ' + title : title;
          await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
          return json(res, 200, { ok: true });
        }

        if (sub === 'resume' && req.method === 'POST') {
          if (!entries.includes(dirname)) return json(res, 404, { error: '归档不存在' }); // 白名单精确匹配，杜绝路径穿越
          if (activeDirs().has(dirname)) return json(res, 409, { error: '该会话已在进行中' });
          const dir = path.join(sessionsDir, dirname);
          let meta;
          try { meta = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8')); }
          catch { return json(res, 404, { error: '归档不存在' }); }
          const template = templates[meta.template];
          if (!template) return json(res, 400, { error: '未知模板: ' + meta.template });
          const materials = await readFile(path.join(dir, 'problem.md'), 'utf8').catch(() => '');
          const rounds = meta.rounds || 0;
          const history = [];
          for (let n = 1; n <= rounds; n++) {
            const briefs = {}, outputs = {};
            for (const d of meta.roles.debaters) {
              briefs[d] = await readFile(path.join(dir, 'prompts', `r${n}-${d}.md`), 'utf8').catch(() => '');
              const raw = await readFile(path.join(dir, 'raw', `r${n}-${d}.md`), 'utf8').catch(() => null);
              outputs[d] = raw === null ? { ok: false, error: 'missing', text: '' } : { ok: true, text: raw };
            }
            const summary = await readFile(path.join(dir, 'summaries', `r${n}.md`), 'utf8').catch(() => '');
            history.push({ briefs, outputs, summary });
          }
          const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
          const now = new Date().toISOString();
          const entry = attachEmit({ events: [], clients: new Set(), createdAt: now, updatedAt: now });
          // agent 配置优先用当前全局配置重新派生（让 adapter 修复/升级惠及恢复的会话），
          // 仅当某 agent 已从全局配置中移除时才回退到存档快照
          const roleIds = [...meta.roles.debaters, meta.roles.judge, meta.roles.summarizer];
          const currentIds = roleIds.filter(x => agents[x]);
          const resumedAgents = {
        ...Object.fromEntries(roleIds.filter(x => !agents[x]).map(x => [x, meta.agents[x]])),
        ...deriveSessionAgents(agents, currentIds, String(meta.workspace ?? '')),
          };
          const committee = Committee.resume({
            topic: meta.topic, materials, agents: resumedAgents, roles: meta.roles, template,
            mode: meta.mode, maxRounds: meta.maxRounds, baseDir: sessionsDir,
            dir, round: rounds, history, origin: String(meta.origin ?? ''),
            lang: meta.lang === 'en' ? 'en' : 'zh',
            emit: ev => entry.emit(ev),
          });
          entry.committee = committee;
          attachAutoVerdictFlow(entry); // 恢复后再出的新裁决同样自动落回（回放走 events.push 不经 emit，不误触）
          await committee.saveMeta('paused');
          // 合成事件缓冲：供新连上的前端 SSE 回放重建界面（辩手栏、摘要、裁决卡）
          entry.events.push({ type: 'state', data: 'paused' });
          for (let n = 1; n <= rounds; n++) {
            const h = history[n - 1];
            for (const d of meta.roles.debaters) {
              const o = h.outputs[d];
              entry.events.push({ type: 'chunk', agentId: d, label: `r${n}`, data: o.ok ? o.text : '' });
              entry.events.push({ type: 'agent-status', agentId: d, label: `r${n}`, data: o.ok ? 'done' : 'failed:' + o.error });
            }
            entry.events.push({ type: 'summary', round: n, data: h.summary });
          }
          const judgeCard = await readFile(path.join(dir, 'judge-card.md'), 'utf8').catch(() => null);
          if (judgeCard !== null) entry.events.push({ type: 'judge-card', data: judgeCard });
          // 群聊记录（若存在）：重建 chatLog 并合成事件回放
          const chatRaw = await readFile(path.join(dir, 'chat.jsonl'), 'utf8').catch(() => null);
          if (chatRaw !== null) {
            const chatLog = chatRaw.split('\n').filter(Boolean).map(l => JSON.parse(l));
            committee.chatLog = chatLog;
            committee.chatSeq = chatLog.length;
            for (const m of chatLog) entry.events.push({ type: 'chat-message', from: m.from, name: m.name, data: m.text });
          }
          sessions.set(id, entry);
          return json(res, 200, { id });
        }

        if (sub === '' && (req.method === 'GET' || req.method === 'DELETE')) {
          if (!entries.includes(dirname)) return json(res, 404, { error: '归档不存在' }); // 白名单精确匹配，杜绝路径穿越
          const dir = path.join(sessionsDir, dirname);
          if (req.method === 'DELETE') {
            // 不允许删除仍挂在活动会话名下的目录（先删活动会话）
            if (activeDirs().has(dirname)) return json(res, 409, { error: '该会话仍在进行中，请先删除活动会话' });
            await moveToTrash(dir);
            return json(res, 200, { ok: true });
          }
          let sessionMd;
          try { sessionMd = await readFile(path.join(dir, 'session.md'), 'utf8'); }
          catch {
            try { sessionMd = await readFile(path.join(dir, 'problem.md'), 'utf8'); }
            catch { return json(res, 404, { error: '归档不存在' }); }
          }
          let topic = dirname;
          try { topic = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8')).topic ?? topic; } catch { /* 无 metadata 时退化用目录名 */ }
          return json(res, 200, { topic, sessionMd });
        }
      }
      // ---- 工作台：多模型群聊会话 ----
      if (url.pathname === '/api/workbenches' && req.method === 'POST') {
        const body = await readBody(req);
        const participants = Array.isArray(body.participants) ? body.participants : [];
        if (!participants.length) return json(res, 400, { error: '请至少选择一个参与模型' });
        for (const id of participants) {
          if (!agents[id]) return json(res, 400, { error: '未知 agent: ' + id });
          if (agents[id].unavailable) return json(res, 400, { error: `${agents[id].name} 当前不可用: ${agents[id].unavailable}` });
        }
        const wbLang = body.lang === 'en' ? 'en' : 'zh';
        const wbWorkspace = String(body.workspace ?? '').trim();
        const workspaceError = workspacePathError(wbWorkspace, wbLang);
        if (workspaceError) return json(res, 400, { error: workspaceError });
        const entry = newBenchEntry();
        const bench = new Workbench({
          name: String(body.name ?? '').trim(),
          agents: deriveSessionAgents(agents, participants, wbWorkspace), // 挂了目录则聊天也可只读查阅
          participants, baseDir: sessionsDir, emit: ev => entry.emit(ev),
          workspace: wbWorkspace, writeAgents: deriveWriteAgents(agents, participants),
          lang: wbLang,
        });
        await bench.init();
        // 建台时的角色分配（能力+仲裁叠加）：逐个校验，无效项按默认角色处理不阻塞建台
        for (const [aid, r] of Object.entries(body.roles ?? {})) {
          if (!participants.includes(aid) || typeof r !== 'object') continue;
          try { await bench.setRole(aid, String(r.role ?? ''), !!r.arbiter, !!r.decide); } catch { /* 能力不符→保持默认 */ }
        }
        entry.bench = bench;
        const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
        benches.set(id, entry);
        return json(res, 200, { id });
      }
      if (url.pathname === '/api/workbenches/resume' && req.method === 'POST') {
        const body = await readBody(req);
        const dirname = String(body.dirname ?? '');
        if (findActiveBenchId(dirname)) return json(res, 409, { error: '该工作台已在进行中' });
        try { return json(res, 200, { id: await resumeBenchFromDisk(dirname) }); }
        catch (e) { return json(res, 404, { error: String(e.message ?? e) }); }
      }
      // 动手 diff 的审批（应用/丢弃）——嵌套路径，先于工作台通配匹配
      const wbBuild = url.pathname.match(/^\/api\/workbenches\/([a-z0-9]+)\/builds\/([a-z0-9]+)\/(apply|discard|check)$/);
      if (wbBuild && req.method === 'POST') {
        const entry = benches.get(wbBuild[1]);
        if (!entry) return json(res, 404, { error: '工作台不存在' });
        const bBody = await readBody(req);
        if (wbBuild[3] === 'check') {
          // 长任务：异步执行，结果经 SSE（check-result）回报
          if (entry.bench.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          entry.bench.checkBuild(wbBuild[2], String(bBody.cmd ?? '')).catch(e => entry.emit({ type: 'error', data: String(e.message ?? e) }));
          return json(res, 200, { ok: true });
        }
        const files = Array.isArray(bBody.files) && bBody.files.length ? bBody.files.map(String) : null;
        try {
          if (wbBuild[3] === 'apply') await entry.bench.applyBuild(wbBuild[2], files);
          else await entry.bench.discardBuild(wbBuild[2], files);
          return json(res, 200, { ok: true });
        } catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
      }
      const wb = url.pathname.match(/^\/api\/workbenches\/([a-z0-9]+)(\/([a-z-]+))?$/);
      if (wb) {
        const entry = benches.get(wb[1]);
        if (!entry) return json(res, 404, { error: '工作台不存在' });
        const b = entry.bench, action = wb[3];
        if (!action && req.method === 'GET')
          return json(res, 200, {
            name: b.name, state: b.state, participants: b.participants,
            agentNames: Object.fromEntries(b.participants.map(id => [id, b.nameOf(id)])),
            workspace: b.workspace, writeCapable: Object.keys(b.writeAgents),
            roles: Object.fromEntries(b.participants.map(id => [id, b.roleOf(id)])),
          });
        if (!action && req.method === 'DELETE') {
          for (const client of entry.clients) { try { client.end(); } catch { /* 已断开 */ } }
          benches.delete(wb[1]);
          if (b.dir) await moveToTrash(b.dir);
          return json(res, 200, { ok: true });
        }
        if (action === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.flushHeaders();
          res.on('error', () => entry.clients.delete(res));
          try {
            for (const ev of entry.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          } catch { entry.clients.delete(res); return; }
          entry.clients.add(res);
          req.on('close', () => entry.clients.delete(res));
          return;
        }
        if (action === 'conflicts' && req.method === 'GET')
          return json(res, 200, b.conflictSheet());
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readBody(req);
        if (action === 'message') {
          const text = String(body.text ?? '').trim();
          if (!text) return json(res, 400, { error: '内容不能为空' });
          if (b.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          const to = (Array.isArray(body.to) ? body.to : []).filter(x => b.participants.includes(x));
          b.message(text, to).catch(e => entry.emit({ type: 'error', data: String(e.message ?? e) }));
          return json(res, 200, { ok: true });
        }
        if (action === 'build') {
          const text = String(body.text ?? '').trim();
          const agentId = String(body.agentId ?? '');
          if (!text) return json(res, 400, { error: '任务不能为空' });
          if (b.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          if (!b.writeAgents[agentId]) return json(res, 400, { error: '该模型不支持动手' });
          b.build(text, agentId).catch(e => entry.emit({ type: 'error', data: String(e.message ?? e) }));
          return json(res, 200, { ok: true });
        }
        if (action === 'relay') {
          if (b.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          const order = (Array.isArray(body.order) ? body.order : []).filter(x => b.participants.includes(x));
          b.relay(body.rounds, order).catch(e => entry.emit({ type: 'error', data: String(e.message ?? e) }));
          return json(res, 200, { ok: true });
        }
        if (action === 'conflict-discuss') {
          const conflictPath = String(body.path ?? '');
          if (!conflictPath.trim()) return json(res, 400, { error: '文件路径不能为空' });
          if (b.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          b.discussConflict(conflictPath).catch(e => entry.emit({ type: 'error', data: String(e.message ?? e) }));
          return json(res, 200, { ok: true });
        }
        if (action === 'conflict-merge') {
          const conflictPath = String(body.path ?? '');
          if (!conflictPath.trim()) return json(res, 400, { error: '文件路径不能为空' });
          if (b.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          b.mergeConflict(conflictPath, { decide: !!body.decide, note: String(body.note ?? '') })
            .catch(e => entry.emit({ type: 'error', data: String(e.message ?? e) }));
          return json(res, 200, { ok: true });
        }
        if (action === 'stop') { b.stop(); return json(res, 200, { ok: true }); }
        if (action === 'workspace') {
          const workspacePath = String(body.path ?? '').trim();
          const workspaceError = workspacePathError(workspacePath, b.lang === 'en' ? 'en' : 'zh');
          if (workspaceError) return json(res, 400, { error: workspaceError });
          if (b.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          await b.setWorkspace(
            workspacePath,
            deriveSessionAgents(agents, b.participants, workspacePath),
            workspacePath ? deriveWriteAgents(agents, b.participants) : {},
          );
          return json(res, 200, {
            workspace: b.workspace,
            writeCapable: Object.keys(b.writeAgents),
            roles: Object.fromEntries(b.participants.map(id => [id, b.roleOf(id)])),
          });
        }
        if (action === 'participants') {
          // 中途增删参与者：add 按当前全局配置派生会话/写配置（含工作区只读挂载）
          const agentId = String(body.agentId ?? '');
          try {
            if (body.op === 'add') {
              if (!agents[agentId]) return json(res, 400, { error: '未知 agent: ' + agentId });
              if (agents[agentId].unavailable) return json(res, 400, { error: `${agents[agentId].name} 当前不可用: ${agents[agentId].unavailable}` });
              await b.addParticipant(agentId,
                deriveSessionAgents(agents, [agentId], b.workspace)[agentId],
                deriveWriteAgents(agents, [agentId])[agentId]);
            } else if (body.op === 'remove') {
              await b.removeParticipant(agentId);
            } else return json(res, 400, { error: '未知操作: ' + String(body.op) });
          } catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
          return json(res, 200, {
            participants: b.participants,
            agentNames: Object.fromEntries(b.participants.map(id => [id, b.nameOf(id)])),
            writeCapable: Object.keys(b.writeAgents),
            roles: Object.fromEntries(b.participants.map(id => [id, b.roleOf(id)])),
          });
        }
        if (action === 'role') {
          // 角色设定：能力（讨论者/提案者）+ 仲裁叠加职责 + 决断档
          try { await b.setRole(String(body.agentId ?? ''), String(body.role ?? ''), !!body.arbiter, !!body.decide); }
          catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
          return json(res, 200, { roles: Object.fromEntries(b.participants.map(id => [id, b.roleOf(id)])) });
        }
        if (action === 'rename') {
          const name = String(body.name ?? '').trim();
          if (!name) return json(res, 400, { error: '名字不能为空' });
          b.name = name;
          await b.saveMeta();
          return json(res, 200, { ok: true });
        }
        if (action === 'promote') {
          // 升格：对话史打包成会议草稿，走既有 #draft 预填链路；携带来源目录名供裁决卡回流
          const id = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
          drafts.set(id, { topic: String(body.topic ?? '') || (b.lang === 'en' ? 'Workbench topic: ' + (b.name || 'unnamed') : '工作台议题：' + (b.name || '未命名')), materials: b.promoteMaterials(), template: 'general', workspace: '', originBench: path.basename(b.dir), lang: b.lang });
          while (drafts.size > 20) drafts.delete(drafts.keys().next().value);
          return json(res, 200, { id });
        }
        return json(res, 404, { error: '未知操作: ' + action });
      }
      const m = url.pathname.match(/^\/api\/sessions\/([a-z0-9]+)(\/([a-z-]+))?$/);
      if (m) {
        const entry = sessions.get(m[1]);
        if (!entry) return json(res, 404, { error: '会话不存在' });
        const c = entry.committee, action = m[3];
        if (!action && req.method === 'DELETE') {
          // 删除活动会话：中止子进程、断开 SSE、移出内存，并连同磁盘目录一起删除
          try { c.stopRound(); } catch { /* 未在运行中也无妨 */ }
          for (const client of entry.clients) { try { client.end(); } catch { /* 已断开 */ } }
          sessions.delete(m[1]);
          if (c.dir) await moveToTrash(c.dir);
          return json(res, 200, { ok: true });
        }
        if (!action && req.method === 'GET')
          return json(res, 200, {
            state: c.state, round: c.round, topic: c.topic, dir: c.dir, materials: c.materials, origin: c.origin,
            roles: c.roles, agentNames: Object.fromEntries(Object.entries(c.agents).map(([id, a]) => [id, a.name])),
          });
        // events 是 GET 语义（SSE），必须先放行，再统一做 POST 检查
        if (action === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.flushHeaders(); // 无缓冲事件回放时也要立即放行响应头，否则客户端会一直等待
          res.on('error', () => entry.clients.delete(res)); // 双保险：写入触发的 error 事件也要清理
          try {
            for (const ev of entry.events) res.write(`data: ${JSON.stringify(ev)}\n\n`); // 回放缓冲
          } catch { entry.clients.delete(res); return; }
          entry.clients.add(res);
          req.on('close', () => entry.clients.delete(res));
          return;
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readBody(req);
        const fire = fn => { fn().catch(e => c.emit({ type: 'error', data: String(e.message ?? e) })); return json(res, 200, { ok: true }); };
        switch (action) {
          case 'round': return fire(() => c.runNextRound());
          case 'auto': {
            // 最大轮数只对自动模式有意义：点「自动跑完」时随请求携带、此处生效
            const n = Number(body.maxRounds);
            if (n) c.maxRounds = Math.min(Math.max(n, 1), 10);
            return fire(() => c.runAuto());
          }
          case 'judge': return fire(() => c.runJudge());
          case 'retry': return fire(() => c.retrySide(body.agentId));
          case 'skip': return fire(() => c.skipSide(body.agentId));
          case 'interject': c.interject(String(body.text ?? '')); return json(res, 200, { ok: true });
          case 'stop': c.stopRound(); return json(res, 200, { ok: true });
          case 'save-partial': return fire(() => c.savePartial());
          case 'resummarize': return fire(() => c.resummarize());
          case 'flowback': {
            // 裁决卡投放工作台：默认回升格来源；无来源（草稿直建/手建）可用 body.target 指定任意工作台目录名。
            // target 在 resumeBenchFromDisk 内走白名单精确匹配，无路径穿越面。
            const target = String(body.target ?? '') || c.origin;
            if (!target) return json(res, 400, { error: '该会议无来源工作台——请指定投放目标（target）' });
            let card;
            try { card = await readFile(path.join(c.dir, 'judge-card.md'), 'utf8'); }
            catch { return json(res, 400, { error: '尚无裁决卡——先「进入裁决」' }); }
            try {
              return json(res, 200, { benchId: await postVerdictToBench(c, target, card) });
            } catch (e) { return json(res, 404, { error: '目标工作台不存在或无法恢复: ' + String(e.message ?? e) }); }
          }
          case 'rename': {
            // 只改展示标题（同步进 metadata）；后续轮次 prompt 中的议题随之更新——改名以澄清议题为目的，属预期行为
            const title = String(body.title ?? '').trim();
            if (!title) return json(res, 400, { error: '名字不能为空' });
            c.topic = title;
            await c.saveMeta(c.state);
            return json(res, 200, { ok: true });
          }
          case 'chat': {
            const text = String(body.text ?? '').trim();
            const to = Array.isArray(body.to) ? body.to : [];
            if (!text) return json(res, 400, { error: '内容不能为空' });
            if (!to.length) return json(res, 400, { error: '请至少选择一位收件人' });
            for (const agentId of to) if (!c.agents[agentId]) return json(res, 400, { error: '未知 agent: ' + agentId });
            return fire(() => c.chat(text, to));
          }
          default: return json(res, 404, { error: '未知操作: ' + action });
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e.message ?? e) });
    }
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  // closeAllConnections：连已建立的 SSE/keep-alive socket 一并断开，close 才能真正结束、端口立即释放
  return { port: server.address().port, close: () => { server.closeAllConnections?.(); server.close(); }, sessions, benches };
}

// 直接运行时启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/server.js')) {
  const { port } = await startServer({ port: Number(process.env.PORT) || 7777 });
  console.log(`Roundtable 已启动: http://127.0.0.1:${port}`);
}
