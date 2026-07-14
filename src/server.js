import http from 'node:http';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Committee } from './orchestrator.js';
import { loadTemplates } from './templates.js';
import { resolveCliPath } from './resolve.js';

// 静态文件白名单（无通用静态服务，杜绝路径穿越）
const STATIC = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'] };

export async function startServer({ port = 7777, agentsFile = 'adapters/agents.json', templatesDir = 'templates', sessionsDir = 'sessions' } = {}) {
  const agents = JSON.parse(await readFile(agentsFile, 'utf8'));
  // 启动时解析每个 agent 的 CLI 路径；解析失败不阻塞服务启动，只标记该 agent 不可用
  for (const [id, a] of Object.entries(agents)) {
    try {
      a.command[0] = resolveCliPath(a);
      console.log(`[adapter] ${id} -> ${a.command[0]}`);
    } catch (e) {
      a.unavailable = String(e.message);
      console.warn(`[adapter] ${id} 不可用: ${e.message}`);
    }
  }
  const templates = await loadTemplates(templatesDir);
  const sessions = new Map();
  const drafts = new Map(); // 外部 AI（项目对话侧）预填的议题+简报草稿，浏览器 #draft=<id> 打开即填入表单

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

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      // 静态文件（白名单，无路径穿越面）
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        try {
          const data = await readFile(file);
          res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
          return res.end(data);
        } catch { return json(res, 404, { error: 'not found' }); }
      }
      if (url.pathname === '/api/config') {
        // 只暴露 name/roles/unavailable，不泄漏 command/envWhitelist 等 adapter 细节
        const pub = Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, { name: a.name, roles: a.roles, ...(a.unavailable ? { unavailable: a.unavailable } : {}) }]));
        const tpl = Object.fromEntries(Object.entries(templates).map(([n, t]) => [n, { title: t.title }]));
        return json(res, 200, { agents: pub, templates: tpl });
      }
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        const activeDirs = new Set([...sessions.values()].map(e => e.committee.dir && path.basename(e.committee.dir)).filter(Boolean));
        const active = [...sessions.entries()].map(([id, entry]) => ({
          id, topic: entry.committee.topic, state: entry.committee.state, round: entry.committee.round,
          archived: false, updatedAt: entry.updatedAt,
        }));
        let archived = [];
        try {
          const dirents = await readdir(sessionsDir, { withFileTypes: true });
          for (const d of dirents) {
            if (!d.isDirectory() || activeDirs.has(d.name)) continue;
            let meta;
            try { meta = JSON.parse(await readFile(path.join(sessionsDir, d.name, 'metadata.json'), 'utf8')); }
            catch { continue; } // 无 metadata.json（非会话目录）跳过
            archived.push({ id: d.name, topic: meta.topic, state: meta.status, round: meta.rounds, archived: true, updatedAt: meta.updatedAt });
          }
        } catch { /* sessionsDir 尚不存在 */ }
        return json(res, 200, [...active, ...archived]);
      }
      if (url.pathname === '/api/draft' && req.method === 'POST') {
        const body = await readBody(req);
        const id = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
        drafts.set(id, { topic: String(body.topic ?? ''), materials: String(body.materials ?? '') });
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
        const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
        const now = new Date().toISOString();
        const entry = { events: [], clients: new Set(), createdAt: now, updatedAt: now };
        const committee = new Committee({
          topic: body.topic, materials: body.materials ?? '',
          agents: Object.fromEntries([...body.roles.debaters, body.roles.judge, body.roles.summarizer].map(x => [x, agents[x]])),
          roles: body.roles, template, mode: body.mode ?? 'manual',
          maxRounds: Math.min(Math.max(Number(body.maxRounds) || 4, 1), 10),
          baseDir: sessionsDir,
          emit: ev => {
            entry.events.push(ev);
            entry.updatedAt = new Date().toISOString();
            const line = `data: ${JSON.stringify(ev)}\n\n`;
            for (const c of entry.clients) {
              try { c.write(line); } catch { entry.clients.delete(c); }
            }
          },
        });
        entry.committee = committee;
        await committee.init();
        sessions.set(id, entry);
        return json(res, 200, { id });
      }
      if (url.pathname.startsWith('/api/archive/') && (req.method === 'GET' || req.method === 'DELETE')) {
        let dirname;
        try { dirname = decodeURIComponent(url.pathname.slice('/api/archive/'.length)); } catch { return json(res, 404, { error: 'not found' }); }
        let entries;
        try { entries = await readdir(sessionsDir); } catch { entries = []; }
        if (!entries.includes(dirname)) return json(res, 404, { error: '归档不存在' }); // 白名单精确匹配，杜绝路径穿越
        const dir = path.join(sessionsDir, dirname);
        if (req.method === 'DELETE') {
          // 不允许删除仍挂在活动会话名下的目录（先删活动会话）
          const activeDirs = new Set([...sessions.values()].map(e => e.committee.dir && path.basename(e.committee.dir)).filter(Boolean));
          if (activeDirs.has(dirname)) return json(res, 409, { error: '该会话仍在进行中，请先删除活动会话' });
          await rm(dir, { recursive: true, force: true });
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
          if (c.dir) await rm(c.dir, { recursive: true, force: true });
          return json(res, 200, { ok: true });
        }
        if (!action && req.method === 'GET')
          return json(res, 200, {
            state: c.state, round: c.round, topic: c.topic, dir: c.dir,
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
          default: return json(res, 404, { error: '未知操作: ' + action });
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e.message ?? e) });
    }
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port: server.address().port, close: () => server.close(), sessions };
}

// 直接运行时启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/server.js')) {
  const { port } = await startServer({ port: Number(process.env.PORT) || 7777 });
  console.log(`Roundtable 已启动: http://127.0.0.1:${port}`);
}
