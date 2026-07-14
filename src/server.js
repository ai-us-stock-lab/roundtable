import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Committee } from './orchestrator.js';
import { loadTemplates } from './templates.js';

// 静态文件白名单（无通用静态服务，杜绝路径穿越）
const STATIC = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'] };

export async function startServer({ port = 7777, agentsFile = 'adapters/agents.json', templatesDir = 'templates', sessionsDir = 'sessions' } = {}) {
  const agents = JSON.parse(await readFile(agentsFile, 'utf8'));
  const templates = await loadTemplates(templatesDir);
  const sessions = new Map();

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const readBody = req => new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

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
        // 只暴露 name/roles，不泄漏 command/envWhitelist 等 adapter 细节
        const pub = Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, { name: a.name, roles: a.roles }]));
        const tpl = Object.fromEntries(Object.entries(templates).map(([n, t]) => [n, { title: t.title }]));
        return json(res, 200, { agents: pub, templates: tpl });
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const template = templates[body.template];
        if (!template) return json(res, 400, { error: '未知模板: ' + body.template });
        for (const id of [...(body.roles?.debaters ?? []), body.roles?.judge, body.roles?.summarizer])
          if (!agents[id]) return json(res, 400, { error: '未知 agent: ' + id });
        const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
        const entry = { events: [], clients: new Set() };
        const committee = new Committee({
          topic: body.topic, materials: body.materials ?? '',
          agents: Object.fromEntries([...body.roles.debaters, body.roles.judge, body.roles.summarizer].map(x => [x, agents[x]])),
          roles: body.roles, template, mode: body.mode ?? 'manual',
          maxRounds: Math.min(Math.max(Number(body.maxRounds) || 4, 1), 10),
          baseDir: sessionsDir,
          emit: ev => {
            entry.events.push(ev);
            const line = `data: ${JSON.stringify(ev)}\n\n`;
            for (const c of entry.clients) c.write(line);
          },
        });
        entry.committee = committee;
        await committee.init();
        sessions.set(id, entry);
        return json(res, 200, { id });
      }
      const m = url.pathname.match(/^\/api\/sessions\/([a-z0-9]+)(\/([a-z-]+))?$/);
      if (m) {
        const entry = sessions.get(m[1]);
        if (!entry) return json(res, 404, { error: '会话不存在' });
        const c = entry.committee, action = m[3];
        if (!action && req.method === 'GET')
          return json(res, 200, { state: c.state, round: c.round, topic: c.topic, dir: c.dir });
        // events 是 GET 语义（SSE），必须先放行，再统一做 POST 检查
        if (action === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          for (const ev of entry.events) res.write(`data: ${JSON.stringify(ev)}\n\n`); // 回放缓冲
          entry.clients.add(res);
          req.on('close', () => entry.clients.delete(res));
          return;
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readBody(req);
        const fire = fn => { fn().catch(e => c.emit({ type: 'error', data: String(e.message ?? e) })); return json(res, 200, { ok: true }); };
        switch (action) {
          case 'round': return fire(() => c.runNextRound());
          case 'auto': return fire(() => c.runAuto());
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
