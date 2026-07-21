import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeFsPath, startServer } from '../src/server.js';

// 用 mock adapter 配置与临时 sessions 目录启动真实服务
const sessionsDir = mkdtempSync(path.join(tmpdir(), 'rt-srv-'));
const srv = await startServer({
  port: 0, // 随机可用端口
  agentsFile: 'test/agents.fixture.json',
  templatesDir: 'templates',
  sessionsDir,
});
const BASE = `http://127.0.0.1:${srv.port}`;
after(() => srv.close());

const agentsFixtureOriginal = readFileSync('test/agents.fixture.json', 'utf8');

test('normalizeFsPath 去除配对引号与首尾空白', () => {
  assert.equal(normalizeFsPath('"C:\\x"'), 'C:\\x');
  assert.equal(normalizeFsPath("'C:\\x'"), 'C:\\x');
  assert.equal(normalizeFsPath('  C:\\x  '), 'C:\\x');
  assert.equal(normalizeFsPath('C:\\x'), 'C:\\x');
  assert.equal(normalizeFsPath(null), '');
  assert.equal(normalizeFsPath(undefined), '');
});

test('GET /api/config 返回 agents/bin 与 templates，且不泄漏 command/envWhitelist', async () => {
  const r = await (await fetch(BASE + '/api/config')).json();
  assert.ok(r.agents.mockA);
  for (const agent of Object.values(r.agents)) {
    assert.equal(typeof agent.bin, 'string');
    assert.ok(agent.bin);
    assert.equal(agent.command, undefined);
    assert.equal(agent.envWhitelist, undefined);
  }
  assert.ok(r.templates.general);
  assert.ok(r.templates.consult.roleBriefs.debaterA.zh);
  assert.equal(r.templates.general.roleBriefs, undefined);
});

test('GET /api/browse 默认浏览 home；文件路径与不存在路径返回 200 error', async () => {
  const home = await (await fetch(BASE + '/api/browse')).json();
  assert.equal(home.ok, true);
  assert.equal(home.path, path.resolve(homedir()));
  assert.equal(home.parent, path.dirname(path.resolve(homedir())));
  assert.ok(Array.isArray(home.dirs));

  const file = await fetch(BASE + '/api/browse?path=' + encodeURIComponent(path.resolve('test/agents.fixture.json')));
  assert.equal(file.status, 200);
  assert.equal(typeof (await file.json()).error, 'string');

  const missing = await fetch(BASE + '/api/browse?path=' + encodeURIComponent(path.join(sessionsDir, 'no-such-folder')));
  assert.equal(missing.status, 200);
  assert.equal(typeof (await missing.json()).error, 'string');
});

test('GET /api/browse 接受带引号的合法目录路径', async () => {
  const result = await (await fetch(BASE + '/api/browse?path=' + encodeURIComponent('"' + sessionsDir + '"'))).json();
  assert.equal(result.ok, true);
  assert.equal(result.path, path.resolve(sessionsDir));
});

test('agents raw：读取原文、拒绝非法配置、保存后热重载公开配置', async () => {
  const rawDir = mkdtempSync(path.join(tmpdir(), 'rt-agents-raw-'));
  const rawAgentsFile = path.join(rawDir, 'agents.json');
  writeFileSync(rawAgentsFile, agentsFixtureOriginal, 'utf8');
  const rawSrv = await startServer({
    port: 0,
    agentsFile: rawAgentsFile,
    templatesDir: 'templates',
    sessionsDir: path.join(rawDir, 'sessions'),
  });
  const rawBase = `http://127.0.0.1:${rawSrv.port}`;
  try {
    const got = await (await fetch(rawBase + '/api/agents/raw')).json();
    assert.equal(got.ok, true);
    assert.match(got.content, /"mockA"/);

    const invalidJson = await fetch(rawBase + '/api/agents/raw', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '{' }),
    });
    assert.equal(invalidJson.status, 400);
    assert.match((await invalidJson.json()).error, /JSON 解析失败/);

    const missingCommand = await fetch(rawBase + '/api/agents/raw', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: JSON.stringify({ bad: { name: 'Bad' } }) }),
    });
    assert.equal(missingCommand.status, 400);
    assert.match((await missingCommand.json()).error, /agent「bad」配置无效/);

    const changed = JSON.parse(agentsFixtureOriginal);
    changed.mockA.name = 'MockA Reloaded';
    const saved = await fetch(rawBase + '/api/agents/raw', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: JSON.stringify(changed, null, 2) + '\n' }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.ok, true);
    assert.equal(savedBody.agents.mockA.name, 'MockA Reloaded');
    assert.equal(savedBody.agents.mockA.command, undefined);
    const config = await (await fetch(rawBase + '/api/config')).json();
    assert.equal(config.agents.mockA.name, 'MockA Reloaded');
  } finally {
    rawSrv.close();
    assert.equal(readFileSync('test/agents.fixture.json', 'utf8'), agentsFixtureOriginal);
  }
});

test('agents smoke: 真实调用返回 ok 并缓存进 /api/config；未知 agent 404', async () => {
  const r = await (await fetch(`${BASE}/api/agents/mockA/smoke`, { method: 'POST' })).json();
  assert.equal(r.ok, true);
  assert.ok(r.durationMs >= 0);
  const cfg = await (await fetch(BASE + '/api/config')).json();
  assert.equal(cfg.agents.mockA.smoke.ok, true); // 灯的状态随 config 下发，刷新页面不丢
  const nf = await fetch(`${BASE}/api/agents/nope/smoke`, { method: 'POST' });
  assert.equal(nf.status, 404);
});

test('创建会话→跑一轮→SSE 收到 round-done', async () => {
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'T', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 3 }),
  })).json();
  assert.ok(create.id);
  await fetch(`${BASE}/api/sessions/${create.id}/round`, { method: 'POST' });
  // 轮询会话状态直到 paused（mock 很快）
  let state = '';
  for (let i = 0; i < 50 && state !== 'paused'; i++) {
    await new Promise(r => setTimeout(r, 100));
    state = (await (await fetch(`${BASE}/api/sessions/${create.id}`)).json()).state;
  }
  assert.equal(state, 'paused');
  // SSE 回放缓冲：新连接也能拿到已发生的 round-done
  const res = await fetch(`${BASE}/api/sessions/${create.id}/events`);
  const reader = res.body.getReader();
  let text = '';
  for (let i = 0; i < 20 && !text.includes('round-done'); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.cancel();
  assert.match(text, /round-done/);
});

test('未知会话返回 404', async () => {
  const r = await fetch(BASE + '/api/sessions/nope');
  assert.equal(r.status, 404);
});

test('SSE 客户端断开后广播不炸（write 异常被吞并移除 client）', async () => {
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'T2', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 2 }),
  })).json();
  // 建立 SSE 连接后立刻粗暴取消（模拟断线）
  const res = await fetch(`${BASE}/api/sessions/${create.id}/events`);
  await res.body.cancel();
  await new Promise(r => setTimeout(r, 50));
  // 断线后触发一轮（会产生大量广播事件）——若无防护，进程在此崩溃、后续断言无法执行
  await fetch(`${BASE}/api/sessions/${create.id}/round`, { method: 'POST' });
  let state = '';
  for (let i = 0; i < 50 && state !== 'paused'; i++) {
    await new Promise(r => setTimeout(r, 100));
    state = (await (await fetch(`${BASE}/api/sessions/${create.id}`)).json()).state;
  }
  assert.equal(state, 'paused'); // 服务仍活着且正常完成一轮
});

test('广播对 write 抛错的 client：吞异常并将其移除', async () => {
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'T3', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 2 }),
  })).json();
  const entry = srv.sessions.get(create.id);
  const evil = { write() { throw new Error('broken pipe'); } };
  entry.clients.add(evil);
  // 触发一轮产生广播——防护存在则异常被吞、evil 被移除、轮次正常完成
  await fetch(`${BASE}/api/sessions/${create.id}/round`, { method: 'POST' });
  let state = '';
  for (let i = 0; i < 50 && state !== 'paused'; i++) {
    await new Promise(r => setTimeout(r, 100));
    state = (await (await fetch(`${BASE}/api/sessions/${create.id}`)).json()).state;
  }
  assert.equal(state, 'paused');
  assert.ok(!entry.clients.has(evil), 'write 抛错的 client 应被移除');
});

test('GET /api/sessions 列表包含已建活动会话且 archived:false，并带 roles/agentNames', async () => {
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'T4', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 2 }),
  })).json();
  const list = await (await fetch(BASE + '/api/sessions')).json();
  assert.ok(Array.isArray(list));
  const item = list.find(s => s.id === create.id);
  assert.ok(item, '活动会话应出现在列表中');
  assert.equal(item.archived, false);
  assert.equal(item.topic, 'T4');

  const detail = await (await fetch(`${BASE}/api/sessions/${create.id}`)).json();
  assert.deepEqual(detail.roles, { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' });
  assert.equal(detail.agentNames.mockA, 'MockA');
  assert.equal(detail.agentNames.mockB, 'MockB');
});

test('磁盘历史会话出现在列表且 archived:true；GET /api/archive/:dirname 返回 sessionMd', async () => {
  const dirname = '2020-01-01-fake-history';
  const dir = path.join(sessionsDir, dirname);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ status: 'done', topic: '历史议题', rounds: 3, updatedAt: '2020-01-01T00:00:00.000Z' }), 'utf8');
  await writeFile(path.join(dir, 'session.md'), '# 历史议题\n\n历史正文内容', 'utf8');

  const list = await (await fetch(BASE + '/api/sessions')).json();
  const item = list.find(s => s.id === dirname);
  assert.ok(item, '磁盘历史会话应出现在列表中');
  assert.equal(item.archived, true);
  assert.equal(item.topic, '历史议题');
  assert.equal(item.state, 'done');
  assert.equal(item.round, 3);

  const archive = await (await fetch(`${BASE}/api/archive/${dirname}`)).json();
  assert.equal(archive.topic, '历史议题');
  assert.match(archive.sessionMd, /历史正文内容/);
});

test('路径穿越防护：archive dirname 必须精确匹配 readdir 条目，否则 404', async () => {
  const r1 = await fetch(`${BASE}/api/archive/${encodeURIComponent('../../etc')}`);
  assert.equal(r1.status, 404);
  const r2 = await fetch(`${BASE}/api/archive/` + encodeURIComponent('..\\..\\x'));
  assert.equal(r2.status, 404);
  const r3 = await fetch(BASE + '/api/archive/..%2F..%2Fetc');
  assert.equal(r3.status, 404);
});

test('DELETE /api/archive/:dirname 删除磁盘归档；穿越路径 404', async () => {
  const { mkdirSync, writeFileSync, existsSync, readdirSync } = await import('node:fs');
  const dir = path.join(sessionsDir, '2026-01-01-delete-me');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ status: 'done', topic: '待删', rounds: 1 }));
  writeFileSync(path.join(dir, 'session.md'), 'x');
  // 穿越尝试 → 404 且目录仍在
  const evil = await fetch(BASE + '/api/archive/..%2F..%2Fetc', { method: 'DELETE' });
  assert.equal(evil.status, 404);
  // 正常删除
  const r = await fetch(BASE + '/api/archive/' + encodeURIComponent('2026-01-01-delete-me'), { method: 'DELETE' });
  assert.equal((await r.json()).ok, true);
  assert.ok(!existsSync(dir), '目录应已从原位置移除');
  const trash = readdirSync(path.join(sessionsDir, '.trash'));
  assert.ok(trash.some(n => n.startsWith('2026-01-01-delete-me')), '应移入回收站');
});

test('DELETE /api/sessions/:id 停止并移除活动会话（连同磁盘目录）', async () => {
  const { existsSync } = await import('node:fs');
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '待删活动会话', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 2 }),
  })).json();
  const detail = await (await fetch(BASE + '/api/sessions/' + create.id)).json();
  const r = await fetch(BASE + '/api/sessions/' + create.id, { method: 'DELETE' });
  assert.equal((await r.json()).ok, true);
  assert.equal((await fetch(BASE + '/api/sessions/' + create.id)).status, 404);
  assert.ok(!existsSync(detail.dir), '会话磁盘目录应已删除');
  const list = await (await fetch(BASE + '/api/sessions')).json();
  assert.ok(!list.some(s => s.id === create.id));
});

test('auto 动作可携带 maxRounds 覆盖（自动跑完至多 N 轮）', async () => {
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '自动轮数覆盖', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual' }),
  })).json();
  await fetch(`${BASE}/api/sessions/${create.id}/auto`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxRounds: 1 }),
  });
  let s = {};
  for (let i = 0; i < 60 && s.state !== 'done'; i++) {
    await new Promise(r => setTimeout(r, 100));
    s = await (await fetch(`${BASE}/api/sessions/${create.id}`)).json();
  }
  assert.equal(s.state, 'done');
  assert.equal(s.round, 1);
});

test('draft 预填：POST 存草稿，GET 取回，未知 404', async () => {
  const r = await (await fetch(BASE + '/api/draft', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '会诊议题X', materials: '项目简报内容……', template: 'consult' }),
  })).json();
  assert.ok(r.id);
  const got = await (await fetch(BASE + '/api/draft/' + r.id)).json();
  assert.equal(got.topic, '会诊议题X');
  assert.match(got.materials, /项目简报/);
  assert.equal(got.template, 'consult');
  assert.equal((await fetch(BASE + '/api/draft/nope')).status, 404);
});

test('deriveSessionAgents：挂载工作区时切换 cwd 与只读工具集', async () => {
  const { deriveSessionAgents } = await import('../src/server.js');
  const base = {
    claude: { name: 'Claude', command: ['claude.cmd', '-p', '--disallowedTools', 'ALL'], workspaceArgs: ['-p', '--disallowedTools', 'Bash,Edit,Write'], cwd: 'workdir', roles: ['debater'] },
    codex: { name: 'Codex', command: ['codex.exe', 'exec', '--sandbox', 'read-only'], cwd: 'workdir', roles: ['debater'] },
  };
  const ws = 'C:/some/project';
  const derived = deriveSessionAgents(base, ['claude', 'codex'], ws);
  assert.equal(derived.claude.cwd, ws);
  assert.equal(derived.codex.cwd, ws);
  assert.deepEqual(derived.claude.command, ['claude.cmd', '-p', '--disallowedTools', 'Bash,Edit,Write']); // 换成只读工具集
  assert.deepEqual(derived.codex.command, base.codex.command); // 无 workspaceArgs 的保持原样（沙箱本就只读）
  const noWs = deriveSessionAgents(base, ['claude'], '');
  assert.equal(noWs.claude.cwd, 'workdir'); // 不挂载则一切照旧
  assert.deepEqual(noWs.claude.command, base.claude.command);
  noWs.claude.cwd = 'mutated';
  assert.equal(base.claude.cwd, 'workdir'); // 派生是深拷贝，不污染全局配置
});

test('POST /api/sessions 接受带引号的合法工作区并存储规范化路径', async () => {
  const response = await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '带引号工作区', materials: '', template: 'general', workspace: '"' + sessionsDir + '"', origin: 'quoted-workspace-test', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' } }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.ok(created.id);
  try {
    const detail = await (await fetch(BASE + '/api/sessions/' + created.id)).json();
    const metadata = JSON.parse(readFileSync(path.join(detail.dir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.workspace, sessionsDir);
  } finally {
    await fetch(BASE + '/api/sessions/' + created.id, { method: 'DELETE' });
  }
});

test('挂载不存在的工作区目录返回 400', async () => {
  const r = await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'ws测试', materials: '', template: 'general', workspace: 'C:/definitely/not/exist/xyz', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' } }),
  });
  assert.equal(r.status, 400);
  const payload = await r.json();
  assert.match(payload.error, /找不到这个路径/);
});

test('挂载文件作为工作区返回 400，并明确要求文件夹', async () => {
  const filePath = path.resolve('test/agents.fixture.json');
  const r = await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic: 'ws 文件校验', materials: '', template: 'general',
      workspace: filePath, lang: 'zh',
      roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' },
    }),
  });
  assert.equal(r.status, 400);
  const payload = await r.json();
  assert.match(payload.error, /文件|file/i);
  assert.equal(payload.suggest, path.dirname(filePath));
});

// ---- 会话跨重启恢复 ----

test('POST /api/archive/:dirname/resume 跨实例恢复：装配 Committee、SSE 缓冲回放、可继续辩论并真实衔接历史', async () => {
  const resumeSessionsDir = mkdtempSync(path.join(tmpdir(), 'rt-resume-'));
  const s1 = await startServer({ port: 0, agentsFile: 'test/agents.fixture.json', templatesDir: 'templates', sessionsDir: resumeSessionsDir });
  const base1 = `http://127.0.0.1:${s1.port}`;
  const create = await (await fetch(base1 + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '恢复测试议题', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 3 }),
  })).json();
  await fetch(`${base1}/api/sessions/${create.id}/round`, { method: 'POST' });
  let detail = {};
  for (let i = 0; i < 50 && detail.state !== 'paused'; i++) {
    await new Promise(r => setTimeout(r, 100));
    detail = await (await fetch(`${base1}/api/sessions/${create.id}`)).json();
  }
  assert.equal(detail.state, 'paused');
  const dirname = path.basename(detail.dir);
  await s1.close(); // 模拟服务重启：第一个实例彻底关闭，进程内 sessions Map 消失

  const s2 = await startServer({ port: 0, agentsFile: 'test/agents.fixture.json', templatesDir: 'templates', sessionsDir: resumeSessionsDir });
  const base2 = `http://127.0.0.1:${s2.port}`;
  try {
    const resumed = await (await fetch(`${base2}/api/archive/${encodeURIComponent(dirname)}/resume`, { method: 'POST' })).json();
    assert.ok(resumed.id, 'resume 应返回新的活动会话 id');

    const got = await (await fetch(`${base2}/api/sessions/${resumed.id}`)).json();
    assert.equal(got.state, 'paused');
    assert.equal(got.round, 1);

    // SSE 缓冲应含 label r1 的 chunk 与 summary 事件
    const sse = await fetch(`${base2}/api/sessions/${resumed.id}/events`);
    const reader = sse.body.getReader();
    let text = '';
    for (let i = 0; i < 20 && !(text.includes('"label":"r1"') && text.includes('"type":"summary"')); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.cancel();
    assert.match(text, /"label":"r1"/);
    assert.match(text, /"type":"summary"/);

    // 继续跑第 2 轮：round 应推进，且第 2 轮简报应真实接上第 1 轮对方（mockA）发言
    await fetch(`${base2}/api/sessions/${resumed.id}/round`, { method: 'POST' });
    let s = {};
    for (let i = 0; i < 50 && s.round !== 2; i++) {
      await new Promise(r => setTimeout(r, 100));
      s = await (await fetch(`${base2}/api/sessions/${resumed.id}`)).json();
    }
    assert.equal(s.round, 2);
    const r1OutputA = readFileSync(path.join(resumeSessionsDir, dirname, 'raw', 'r1-mockA.md'), 'utf8');
    const briefB = readFileSync(path.join(resumeSessionsDir, dirname, 'prompts', 'r2-mockB.md'), 'utf8');
    assert.ok(briefB.includes(r1OutputA.trim()), '第 2 轮 mockB 的简报应包含第 1 轮对手（mockA）发言原文——证明 history 真实接上了');
  } finally {
    await s2.close();
  }
});

test('resume：不存在的归档目录返回 404', async () => {
  const r = await fetch(BASE + '/api/archive/' + encodeURIComponent('no-such-dir') + '/resume', { method: 'POST' });
  assert.equal(r.status, 404);
});

test('resume：metadata 中的模板名在当前 templates 中找不到时返回 400', async () => {
  const dirname = '2020-02-02-bad-template';
  const dir = path.join(sessionsDir, dirname);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
    status: 'paused', topic: '坏模板', rounds: 0, updatedAt: new Date().toISOString(),
    template: '不存在的模板名', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' },
    mode: 'manual', maxRounds: 3, agents: {},
  }), 'utf8');
  const r = await fetch(BASE + '/api/archive/' + encodeURIComponent(dirname) + '/resume', { method: 'POST' });
  assert.equal(r.status, 400);
});

// ---- 会话内群聊 ----

test('POST /api/sessions/:id/chat：SSE 缓冲含用户消息与 agent 回复的 chat-message', async () => {
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '群聊议题', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 3 }),
  })).json();
  await fetch(`${BASE}/api/sessions/${create.id}/round`, { method: 'POST' });
  let state = '';
  for (let i = 0; i < 50 && state !== 'paused'; i++) {
    await new Promise(r => setTimeout(r, 100));
    state = (await (await fetch(`${BASE}/api/sessions/${create.id}`)).json()).state;
  }
  assert.equal(state, 'paused');

  const detail = await (await fetch(`${BASE}/api/sessions/${create.id}`)).json();
  const chatRes = await fetch(`${BASE}/api/sessions/${create.id}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '追问一下你的立场', to: ['mockA'] }),
  });
  assert.equal((await chatRes.json()).ok, true);
  // 先轮询磁盘确认 chat() 已跑完落盘（避免在事件流仍开着、但没有更多数据时永久阻塞在 read()）
  const chatFile = path.join(detail.dir, 'chat.jsonl');
  for (let i = 0; i < 50 && !existsSync(chatFile); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(existsSync(chatFile), 'chat.jsonl 应已落盘');
  // 此时两条 chat-message 均已在缓冲中，单次连接、按条件提前退出读取（不做超出所需的阻塞 read）
  const res = await fetch(`${BASE}/api/sessions/${create.id}/events`);
  const reader = res.body.getReader();
  let text = '';
  for (let i = 0; i < 20 && !((text.match(/"type":"chat-message"/g) ?? []).length >= 2); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.cancel();
  assert.match(text, /"type":"chat-message"[^\n]*"from":"user"/);
  assert.match(text, /追问一下你的立场/);
  assert.match(text, /"type":"chat-message"[^\n]*"from":"mockA"/);
});

test('POST chat：text 为空或 to 为空返回 400，未知 agent 返回 400', async () => {
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '群聊校验', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 3 }),
  })).json();
  await fetch(`${BASE}/api/sessions/${create.id}/round`, { method: 'POST' });
  let state = '';
  for (let i = 0; i < 50 && state !== 'paused'; i++) {
    await new Promise(r => setTimeout(r, 100));
    state = (await (await fetch(`${BASE}/api/sessions/${create.id}`)).json()).state;
  }
  const r1 = await fetch(`${BASE}/api/sessions/${create.id}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '  ', to: ['mockA'] }),
  });
  assert.equal(r1.status, 400);
  const r2 = await fetch(`${BASE}/api/sessions/${create.id}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好', to: [] }),
  });
  assert.equal(r2.status, 400);
  const r3 = await fetch(`${BASE}/api/sessions/${create.id}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好', to: ['nope'] }),
  });
  assert.equal(r3.status, 400);
});

test('resume 后 chat.jsonl 重放为 chat-message 事件', async () => {
  const resumeSessionsDir = mkdtempSync(path.join(tmpdir(), 'rt-resume-chat-'));
  const s1 = await startServer({ port: 0, agentsFile: 'test/agents.fixture.json', templatesDir: 'templates', sessionsDir: resumeSessionsDir });
  const base1 = `http://127.0.0.1:${s1.port}`;
  const create = await (await fetch(base1 + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '恢复群聊议题', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 3 }),
  })).json();
  await fetch(`${base1}/api/sessions/${create.id}/round`, { method: 'POST' });
  let detail = {};
  for (let i = 0; i < 50 && detail.state !== 'paused'; i++) {
    await new Promise(r => setTimeout(r, 100));
    detail = await (await fetch(`${base1}/api/sessions/${create.id}`)).json();
  }
  await fetch(`${base1}/api/sessions/${create.id}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '恢复前问一句', to: ['mockA'] }),
  });
  // 等 chat.jsonl 落盘（轮询磁盘）
  const dirname = path.basename(detail.dir);
  const chatFile = path.join(resumeSessionsDir, dirname, 'chat.jsonl');
  for (let i = 0; i < 50 && !existsSync(chatFile); i++) await new Promise(r => setTimeout(r, 100));
  await s1.close();

  const s2 = await startServer({ port: 0, agentsFile: 'test/agents.fixture.json', templatesDir: 'templates', sessionsDir: resumeSessionsDir });
  const base2 = `http://127.0.0.1:${s2.port}`;
  try {
    const resumed = await (await fetch(`${base2}/api/archive/${encodeURIComponent(dirname)}/resume`, { method: 'POST' })).json();
    assert.ok(resumed.id);
    const sse = await fetch(`${base2}/api/sessions/${resumed.id}/events`);
    const reader = sse.body.getReader();
    let text = '';
    for (let i = 0; i < 20 && !text.includes('恢复前问一句'); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.cancel();
    assert.match(text, /"type":"chat-message"/);
    assert.match(text, /恢复前问一句/);
  } finally {
    await s2.close();
  }
});

test('resume：目标目录已是活动会话时返回 409', async () => {
  const create = await (await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '活动中防重复恢复', materials: '', template: 'general', roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockA' }, mode: 'manual', maxRounds: 2 }),
  })).json();
  const detail = await (await fetch(BASE + '/api/sessions/' + create.id)).json();
  const dirname = path.basename(detail.dir);
  const r = await fetch(BASE + '/api/archive/' + encodeURIComponent(dirname) + '/resume', { method: 'POST' });
  assert.equal(r.status, 409);
});
