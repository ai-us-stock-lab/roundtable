import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fitHistory, buildWorkbenchPrompt, promptLimitFor, Workbench, loadWorkbenchFromDisk } from '../src/workbench.js';

const msg = (from, name, text) => ({ from, name, text, rendered: `[${name}] ${text}` });

test('fitHistory: 全部装得下', () => {
  const msgs = [msg('user', '用户', 'a'), msg('m1', 'M1', 'b')];
  const r = fitHistory(msgs, { fixedLen: 100, limit: 1000 });
  assert.deepEqual([r.blocked, r.start, r.shown, r.total], [false, 0, 2, 2]);
});

test('fitHistory: 装不下时保最近整条，绝不切半', () => {
  const msgs = [msg('user', '用户', 'x'.repeat(500)), msg('m1', 'M1', 'y'.repeat(100)), msg('user', '用户', 'z'.repeat(100))];
  const r = fitHistory(msgs, { fixedLen: 50, limit: 300 });
  assert.equal(r.blocked, false);
  assert.equal(r.start, 1); // 第一条 500 字装不下，后两条保留
  assert.equal(r.shown, 2);
});

test('fitHistory: 双层硬阻断错误码', () => {
  const a = fitHistory([msg('user', '用户', 'x')], { fixedLen: 400, limit: 300 });
  assert.deepEqual([a.blocked, a.errorCode], [true, 'PREAMBLE_TOO_LONG']);
  const b = fitHistory([msg('user', '用户', 'x'.repeat(500))], { fixedLen: 100, limit: 300 });
  assert.deepEqual([b.blocked, b.errorCode], [true, 'NOTHING_FITS']);
});

test('buildWorkbenchPrompt: 位置化标注 + 截断明示 + 防冒充', () => {
  const messages = [
    { from: 'user', name: '用户', to: ['m1'], toNames: ['M1'], text: '很长的旧消息' + 'x'.repeat(400) },
    { from: 'm1', name: 'M1', text: '旧回复' },
    { from: 'user', name: '用户', to: ['m2'], toNames: ['M2'], text: '近问' },
    { from: 'm2', name: 'M2', text: '近答' },
  ];
  const r = buildWorkbenchPrompt({ selfName: 'M1', participantNames: ['M1', 'M2'], messages, text: '现在的问题', limit: 700 });
  assert.equal(r.blocked, false);
  assert.ok(r.shown < r.total); // 发生截断
  assert.match(r.prompt, /仅最近 \d+ 条，共 4 条/); // 截断明示写进 prompt
  assert.match(r.prompt, /\[M2\] 近答/); // 他人发言位置化标注
  assert.match(r.prompt, /不要冒充他人/);
  assert.match(r.prompt, /你是 M1/);
  assert.match(r.prompt, /现在的问题/);
});

test('promptLimitFor: arg 模式受限，stdin 宽预算', () => {
  assert.equal(promptLimitFor({ input: 'arg' }), 26000);
  assert.equal(promptLimitFor({ input: 'stdin' }), 150000);
});

const MOCK_AGENTS = fixed => ({
  m1: { name: 'M1', command: [process.execPath, 'test/mock-cli.cjs'], input: 'stdin', output: 'text', timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT', 'MOCK_FIXED_OUTPUT'], cwd: process.cwd() },
  m2: { name: 'M2', command: [process.execPath, 'test/mock-cli.cjs'], input: 'stdin', output: 'text', timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT', 'MOCK_FIXED_OUTPUT'], cwd: process.cwd() },
});

test('Workbench: 消息流转、默认路由=上一个发言模型、落盘可恢复', async () => {
  process.env.MOCK_FIXED_OUTPUT = '模拟回复';
  try {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-'));
    const events = [];
    const w = new Workbench({ name: '测试台', agents: MOCK_AGENTS(), participants: ['m1', 'm2'], baseDir, emit: e => events.push(e) });
    await w.init();

    await w.message('你好', ['m2']); // 显式点名 m2
    assert.equal(w.messages.length, 2);
    assert.equal(w.messages[1].from, 'm2');
    assert.equal(w.messages[1].text, '模拟回复');
    assert.equal(w.lastSpeaker, 'm2');

    await w.message('继续'); // 不点名 → 默认路由到上一个发言者 m2
    assert.equal(w.messages[3].from, 'm2');

    await w.message('都说说', ['m1', 'm2']); // 广播：两个都回，串行
    assert.equal(w.messages.length, 7);
    assert.deepEqual([w.messages[5].from, w.messages[6].from], ['m1', 'm2']);

    // 事件流包含用户与模型的 chat-message
    const chats = events.filter(e => e.type === 'chat-message');
    assert.equal(chats.length, 7);
    assert.ok(events.some(e => e.type === 'agent-status' && e.data === 'running'));

    // 落盘 jsonl 可恢复
    const { meta, messages } = await loadWorkbenchFromDisk(w.dir);
    assert.equal(meta.type, 'workbench');
    assert.equal(messages.length, 7);
    const w2 = await Workbench.resume({ name: '测试台', agents: MOCK_AGENTS(), participants: ['m1', 'm2'], baseDir, dir: w.dir, messages });
    assert.equal(w2.lastSpeaker, 'm2');
    assert.equal(w2.messages.length, 7);

    // 升格材料包含对话原文
    assert.match(w.promoteMaterials(), /\[用户 → M2\] 你好/);
    assert.match(w.promoteMaterials(), /\[M2\] 模拟回复/);
  } finally {
    delete process.env.MOCK_FIXED_OUTPUT;
  }
});

test('Workbench: busy 状态拒绝并发消息', async () => {
  process.env.MOCK_FIXED_OUTPUT = 'ok';
  try {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-'));
    const w = new Workbench({ name: 'b', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: () => {} });
    await w.init();
    const p = w.message('一', ['m1']);
    await assert.rejects(() => w.message('二', ['m1']), /还在处理中/);
    await p;
  } finally {
    delete process.env.MOCK_FIXED_OUTPUT;
  }
});

// ---- 服务端路由集成测试 ----
test('server: 工作台创建/发消息/列表/升格/删除/恢复 全链路', async () => {
  process.env.MOCK_FIXED_OUTPUT = '路由回复';
  const { startServer } = await import('../src/server.js');
  const { mkdtempSync: mkd } = await import('node:fs');
  const sessionsDir = mkd(path.join(tmpdir(), 'wb-srv-'));
  const srv = await startServer({ port: 0, agentsFile: 'test/agents.fixture.json', sessionsDir });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(r => r.json());
  try {
    // 创建
    const { id } = await post('/api/workbenches', { name: '联调台', participants: ['mockA', 'mockB'] });
    assert.ok(id);
    // 发消息（异步 fire）→ 轮询等 idle
    await post(`/api/workbenches/${id}/message`, { text: '你好', to: ['mockA'] });
    let info;
    for (let i = 0; i < 50; i++) {
      info = await fetch(`${base}/api/workbenches/${id}`).then(r => r.json());
      if (info.state === 'idle') break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(info.state, 'idle');
    // 事件缓冲里有两条 chat-message（用户+mockA）
    const entry = srv.benches.get(id);
    const chats = entry.events.filter(e => e.type === 'chat-message');
    assert.equal(chats.length, 2);
    // fixture mock 回显 stdin：回复即完整 prompt——顺带验证 prompt 构造正确
    assert.match(chats[1].data, /你是 MockA/);
    assert.match(chats[1].data, /你好/);
    // 列表包含 type=workbench 的活动条目
    const list = await fetch(base + '/api/sessions').then(r => r.json());
    assert.ok(list.some(s => s.type === 'workbench' && !s.archived));
    // 升格 → 草稿可取回且含对话原文
    const { id: draftId } = await post(`/api/workbenches/${id}/promote`, {});
    const draft = await fetch(`${base}/api/draft/${draftId}`).then(r => r.json());
    assert.match(draft.materials, /\[用户 → MockA\] 你好/);
    // 参与者校验
    const bad = await post('/api/workbenches', { name: 'x', participants: ['不存在'] });
    assert.match(bad.error, /未知 agent/);
    // 恢复：先删内存条目（模拟重启），从磁盘 resume
    const dirname = path.basename(entry.bench.dir);
    srv.benches.delete(id);
    const { id: rid } = await post('/api/workbenches/resume', { dirname });
    assert.ok(rid);
    const rEntry = srv.benches.get(rid);
    assert.equal(rEntry.events.filter(e => e.type === 'chat-message').length, 2); // 回放重建
    assert.equal(rEntry.bench.lastSpeaker, 'mockA');
    // 软删除
    const del = await fetch(`${base}/api/workbenches/${rid}`, { method: 'DELETE' }).then(r => r.json());
    assert.equal(del.ok, true);
  } finally {
    delete process.env.MOCK_FIXED_OUTPUT;
    srv.close();
  }
});

// ---- 互聊（模型间接力讨论）----
test('relay: 按圈子顺序接力 n 轮，后发者能看到前一位刚说的话', async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-relay-'));
  const agents = MOCK_AGENTS();
  const w = new Workbench({ name: 'r', agents, participants: ['m1', 'm2'], baseDir, emit: () => {} });
  await w.init();
  await w.relay(2); // 2 轮 × 2 人 = 4 条模型发言（echo mock 不会说【无新增】）
  assert.equal(w.messages.length, 4);
  assert.deepEqual(w.messages.map(m => m.from), ['m1', 'm2', 'm1', 'm2']);
  // m2 的第一条回复（echo=完整 prompt）里能看到 m1 的发言标注 → 互相可见成立
  assert.match(w.messages[1].text, /\[M1\]/);
  // 互聊指令带反驳鼓励与收敛出口
  assert.match(w.messages[0].text, /点名反驳/);
  assert.match(w.messages[0].text, /【无新增】/);
});

test('relay: 模型回复【无新增】时提前收敛终止', async () => {
  process.env.MOCK_FIXED_OUTPUT = '【无新增】';
  try {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-conv-'));
    const events = [];
    const w = new Workbench({ name: 'c', agents: MOCK_AGENTS(), participants: ['m1', 'm2'], baseDir, emit: e => events.push(e) });
    await w.init();
    await w.relay(5);
    assert.equal(w.messages.length, 1); // 第一个人就收敛，后面全部不再调用
    assert.ok(events.some(e => e.type === 'sys' && /收敛/.test(e.data)));
  } finally { delete process.env.MOCK_FIXED_OUTPUT; }
});

test('relay: en 会话用英文收敛标记，同样提前终止', async () => {
  process.env.MOCK_FIXED_OUTPUT = '[NOTHING NEW]';
  try {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-conv-en-'));
    const events = [];
    const w = new Workbench({ name: 'ce', agents: MOCK_AGENTS(), participants: ['m1', 'm2'], baseDir, emit: e => events.push(e), lang: 'en' });
    await w.init();
    await w.relay(5);
    assert.equal(w.messages.length, 1);
    assert.ok(events.some(e => e.type === 'sys' && /converged/.test(e.data)));
    // en 会话的互聊指令与收敛标记都是英文
    assert.match(w.messages[0].text, /\[NOTHING NEW\]/);
    assert.doesNotMatch(w.messages[0].text, /【无新增】/);
  } finally { delete process.env.MOCK_FIXED_OUTPUT; }
});

test('角色叠加制：能力×仲裁四组合、讨论者拦指派、能力上限、决断档、旧格式兼容', async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-perm-'));
  const agents = MOCK_AGENTS();
  const w = new Workbench({ name: 'pp', agents, participants: ['m1', 'm2'], baseDir, emit: () => {}, workspace: baseDir, writeAgents: { m1: agents.m1 } });
  await w.init();
  assert.deepEqual(w.roleOf('m1'), { role: 'propose', arbiter: false, decide: false }); // 有写能力默认提案者
  assert.deepEqual(w.roleOf('m2'), { role: 'talk', arbiter: false, decide: false });    // 无写能力恒纯讨论者
  // 纯裁判：讨论者 + 仲裁 —— 自主提案位为 false（将来聊天产 diff 的门禁），
  // 但用户显式指派不受角色拦（build 不因角色拒绝；此处工作区非 git 仓库，报的是 git 仓库错误而非角色错误）
  await w.setRole('m1', 'talk', true);
  assert.deepEqual(w.permOf('m1'), { propose: false, apply: true, decide: false });
  await assert.rejects(() => w.build('改点东西', 'm1'), /git 仓库|git repo/);
  // 提案者 + 仲裁 + 决断档（两 agent 小场子配置）
  await w.setRole('m1', 'propose', true, true);
  assert.deepEqual(w.roleOf('m1'), { role: 'propose', arbiter: true, decide: true });
  await assert.rejects(() => w.setRole('m2', 'propose'), /无安全写模式/);       // 能力是上限
  await assert.rejects(() => w.setRole('m2', 'talk', true), /无安全写模式/);    // 仲裁也需写能力（融合要写文件）
  // 仲裁至多一位：转移式——授予 m3 即从 m1 摘除（连同决断档）
  w.participants.push('m3');
  w.writeAgents.m3 = agents.m1;
  await w.setRole('m3', 'talk', true);
  assert.deepEqual(w.roleOf('m3'), { role: 'talk', arbiter: true, decide: false });
  assert.deepEqual(w.roleOf('m1').arbiter, false); // m1 的仲裁与决断被转移摘除
  assert.equal(w.roleOf('m1').role, 'propose');    // 能力保留
  // 旧格式兼容：阶梯制 arbiter → 提案者+仲裁；两位制 apply → 同
  w.perms.m1 = { role: 'arbiter', decide: true };
  assert.deepEqual(w.roleOf('m1'), { role: 'propose', arbiter: true, decide: true });
  w.perms.m1 = { apply: true };
  assert.deepEqual(w.roleOf('m1'), { role: 'propose', arbiter: true, decide: false });
  w.perms.m1 = { propose: false };
  assert.equal(w.roleOf('m1').role, 'talk');
});

test('中途增删参与者：移除清 buildSessions 与 lastSpeaker，至少留一人，可再加回', async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-part-'));
  const agents = MOCK_AGENTS();
  const w = new Workbench({ name: 'p', agents, participants: ['m1', 'm2'], baseDir, emit: () => {} });
  await w.init();
  w.lastSpeaker = 'm2';
  w.buildSessions.m2 = { sessionId: 'x', lastSeq: 1 };
  await w.removeParticipant('m2');
  assert.deepEqual(w.participants, ['m1']);
  assert.equal(w.lastSpeaker, null);           // 隐式路由回退
  assert.equal(w.buildSessions.m2, undefined); // CLI 会话续接缓存作废
  await assert.rejects(() => w.removeParticipant('m1'), /至少保留一个参与者/);
  await assert.rejects(() => w.addParticipant('m1', agents.m1), /已在参与者中/);
  await w.addParticipant('m2', agents.m2);
  assert.deepEqual(w.participants, ['m1', 'm2']);
});

test('relay: 少于两个模型拒绝；busy 时拒绝', async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-guard-'));
  const w = new Workbench({ name: 'g', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: () => {} });
  await w.init();
  await assert.rejects(() => w.relay(2), /至少需要两个模型/);
});

test('relay: stop() 中止后续调用并回到 idle', async () => {
  process.env.MOCK_DELAY_MS = '400';
  try {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-stop-'));
    const agents = MOCK_AGENTS();
    for (const a of Object.values(agents)) a.envWhitelist.push('MOCK_DELAY_MS');
    const events = [];
    const w = new Workbench({ name: 's', agents, participants: ['m1', 'm2'], baseDir, emit: e => events.push(e) });
    await w.init();
    const p = w.relay(4);
    await new Promise(r => setTimeout(r, 150));
    w.stop(); // 第一个还在跑 → abort
    await p;
    assert.equal(w.state, 'idle');
    assert.ok(w.messages.length <= 1); // 最多第一条，绝无 8 条
    assert.ok(events.some(e => e.type === 'sys' && /已停止/.test(e.data)));
  } finally { delete process.env.MOCK_DELAY_MS; }
});

test('server: 重命名——活动工作台 / 归档目录（含工作台前缀规则）', async () => {
  const { startServer } = await import('../src/server.js');
  const { mkdtempSync: mkd } = await import('node:fs');
  const sessionsDir = mkd(path.join(tmpdir(), 'wb-ren-'));
  const srv = await startServer({ port: 0, agentsFile: 'test/agents.fixture.json', sessionsDir });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(r => r.json());
  try {
    const { id } = await post('/api/workbenches', { name: '旧名', participants: ['mockA', 'mockB'] });
    // 活动工作台重命名
    const r1 = await post(`/api/workbenches/${id}/rename`, { name: '新名字' });
    assert.equal(r1.ok, true);
    let list = await fetch(base + '/api/sessions').then(r => r.json());
    assert.ok(list.some(s => s.topic === '[工作台] 新名字' && !s.archived));
    // 空名拒绝
    const r2 = await post(`/api/workbenches/${id}/rename`, { name: '  ' });
    assert.match(r2.error, /不能为空/);
    // 归档重命名：删内存条目后目录变归档，改 metadata.topic
    const dirname = path.basename(srv.benches.get(id).bench.dir);
    srv.benches.delete(id);
    const r3 = await post(`/api/archive/${encodeURIComponent(dirname)}/rename`, { title: '归档新名' });
    assert.equal(r3.ok, true);
    list = await fetch(base + '/api/sessions').then(r => r.json());
    const item = list.find(s => s.id === dirname);
    assert.equal(item.topic, '[工作台] 归档新名'); // 工作台前缀自动保留
    assert.equal(item.type, 'workbench');
  } finally { srv.close(); }
});

// ---- 动手（写模式）----
const { execFileSync } = await import('node:child_process');
function makeWorkspaceRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-ws-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { windowsHide: true });
  g('init'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'readme.md'), 'hello\n');
  g('add', '-A'); g('commit', '-m', 'init');
  return dir;
}
// 假写手：在 cwd（隔离副本）里真实创建文件并输出说明
const WRITE_AGENT = {
  name: 'Builder',
  command: [process.execPath, '-e', "require('fs').writeFileSync('from-agent.txt','built by agent'); console.log('added from-agent.txt')"],
  input: 'stdin', output: 'text', timeoutMs: 10000,
  envWhitelist: ['PATH', 'SYSTEMROOT'], cwd: process.cwd(),
};

test('build: 副本动手 → diff 卡片 → 主工作区零接触 → 应用生效', async () => {
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-build-'));
  const events = [];
  const w = new Workbench({
    name: '动手台', agents: MOCK_AGENTS(), participants: ['m1'], baseDir,
    emit: e => events.push(e), workspace, writeAgents: { m1: WRITE_AGENT },
  });
  await w.init();
  await w.build('把 from-agent.txt 加进去', 'm1');

  // 消息：用户指令 + 模型说明（带 build 标记）
  assert.equal(w.messages.length, 2);
  assert.equal(w.messages[1].text, 'added from-agent.txt');
  assert.ok(w.messages[1].build);
  // build 记录与 patch 落盘
  assert.equal(w.builds.length, 1);
  assert.equal(w.builds[0].status, 'pending');
  assert.match(w.builds[0].stat, /from-agent\.txt/);
  assert.ok(existsSync(w.patchPathOf(w.builds[0].buildId)));
  // 事件带 diff 卡片数据
  const card = events.find(e => e.type === 'chat-message' && e.build);
  assert.match(card.build.patch, /built by agent/);
  // 主工作区此刻零接触
  assert.ok(!existsSync(path.join(workspace, 'from-agent.txt')));

  // 应用 → 文件出现在主工作区
  await w.applyBuild(w.builds[0].buildId);
  assert.equal(w.builds[0].status, 'applied');
  assert.match(readFileSync(path.join(workspace, 'from-agent.txt'), 'utf8'), /built by agent/);
  // 重复应用被拒
  await assert.rejects(() => w.applyBuild(w.builds[0].buildId), /已应用/);
});

test('build: 丢弃只标记状态，主工作区不变；守卫齐全', async () => {
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-build2-'));
  const w = new Workbench({
    name: 'g', agents: MOCK_AGENTS(), participants: ['m1', 'm2'], baseDir,
    emit: () => {}, workspace, writeAgents: { m1: WRITE_AGENT },
  });
  await w.init();
  await w.build('动手', 'm1');
  await w.discardBuild(w.builds[0].buildId);
  assert.equal(w.builds[0].status, 'discarded');
  assert.ok(!existsSync(path.join(workspace, 'from-agent.txt')));
  // 无写能力模型被拒
  await assert.rejects(() => w.build('x', 'm2'), /不支持动手/);
  // 非 git 目录被拒
  const w2 = new Workbench({ name: 'x', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: () => {}, workspace: mkdtempSync(path.join(tmpdir(), 'wb-plain-')), writeAgents: { m1: WRITE_AGENT } });
  await w2.init();
  await assert.rejects(() => w2.build('x', 'm1'), /不是 git 仓库/);
  // 恢复时 builds 读回
  const { builds } = await loadWorkbenchFromDisk(w.dir);
  assert.equal(builds[0].status, 'discarded');
});

// ---- 按文件审批 + 实时可视 ----
const TWO_FILE_AGENT = {
  name: 'Builder2',
  command: [process.execPath, '-e', "const f=require('fs');f.writeFileSync('one.txt','1');f.writeFileSync('two.txt','2');console.log('two files')"],
  input: 'stdin', output: 'text', timeoutMs: 10000,
  envWhitelist: ['PATH', 'SYSTEMROOT'], cwd: process.cwd(),
};

test('splitPatchByFile: 按 diff --git 头切文件段', async () => {
  const { splitPatchByFile } = await import('../src/workbench.js');
  const patch = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@\n+1\ndiff --git a/y.md b/y.md\n--- a/y.md\n+++ b/y.md\n@@\n+2\n';
  const segs = splitPatchByFile(patch);
  assert.deepEqual(segs.map(s => s.path), ['x.js', 'y.md']);
  assert.match(segs[0].patch, /\+1/);
  assert.match(segs[1].patch, /\+2/);
});

test('build: 按文件逐个应用（partial → applied），事件带 files', async () => {
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-pf-'));
  const events = [];
  const w = new Workbench({
    name: 'pf', agents: MOCK_AGENTS(), participants: ['m1'], baseDir,
    emit: e => events.push(e), workspace, writeAgents: { m1: TWO_FILE_AGENT },
  });
  await w.init();
  await w.build('写两个文件', 'm1');
  assert.equal(w.builds[0].files.length, 2);
  // 只应用 one.txt
  await w.applyBuild(w.builds[0].buildId, ['one.txt']);
  assert.equal(w.builds[0].status, 'partial');
  assert.ok(existsSync(path.join(workspace, 'one.txt')));
  assert.ok(!existsSync(path.join(workspace, 'two.txt'))); // 另一个仍未落地
  // 剩余全部应用
  await w.applyBuild(w.builds[0].buildId);
  assert.equal(w.builds[0].status, 'applied');
  assert.ok(existsSync(path.join(workspace, 'two.txt')));
  // build-status 事件携带 files 状态
  const st = events.filter(e => e.type === 'build-status').at(-1);
  assert.ok(st.files.every(f => f.status === 'applied'));
});

test('extractChunkText: toolMarkers 输出工具活动行', async () => {
  const { extractChunkText } = await import('../src/runner.js');
  const line = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: '我来改' },
    { type: 'tool_use', name: 'Edit', input: { file_path: 'C:/proj/src/app.js' } },
  ] } });
  assert.equal(extractChunkText(line), '我来改'); // 默认不含工具标记（辩手栏行为不变）
  const withTools = extractChunkText(line, { toolMarkers: true });
  assert.match(withTools, /▸ Edit src\/app\.js/);
});

// ---- 裁决卡回流：工作台 → 升格 → 会议 → 裁决 → 回流 ----
test('flowback: 升格携带来源，裁决卡回流贴回原工作台（含从磁盘恢复路径）', async () => {
  const { startServer } = await import('../src/server.js');
  const { writeFileSync: wf } = await import('node:fs');
  const sessionsDir = mkdtempSync(path.join(tmpdir(), 'wb-fb-'));
  const srv = await startServer({ port: 0, agentsFile: 'test/agents.fixture.json', sessionsDir });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(r => r.json());
  try {
    // 工作台 + 一条消息
    const { id: wbid } = await post('/api/workbenches', { name: '回流源', participants: ['mockA', 'mockB'] });
    await post(`/api/workbenches/${wbid}/message`, { text: '讨论中', to: ['mockA'] });
    for (let i = 0; i < 50; i++) { const s = await fetch(`${base}/api/workbenches/${wbid}`).then(r => r.json()); if (s.state === 'idle') break; await new Promise(r => setTimeout(r, 100)); }
    const benchDirname = path.basename(srv.benches.get(wbid).bench.dir);
    // 升格草稿带来源
    const { id: draftId } = await post(`/api/workbenches/${wbid}/promote`, {});
    const draft = await fetch(`${base}/api/draft/${draftId}`).then(r => r.json());
    assert.equal(draft.originBench, benchDirname);
    // 建会（带 origin）
    const sess = await post('/api/sessions', {
      topic: '回流测试会', materials: draft.materials, template: 'general',
      roles: { debaters: ['mockA', 'mockB'], judge: 'mockA', summarizer: 'mockB' }, mode: 'manual',
      origin: draft.originBench,
    });
    assert.ok(sess.id);
    const detail = await fetch(`${base}/api/sessions/${sess.id}`).then(r => r.json());
    assert.equal(detail.origin, benchDirname);
    // 统一容器：开会即在来源工作台时间线留痕
    assert.match(srv.benches.get(wbid).bench.messages.at(-1).text, /会议已开始/);
    // 无裁决卡时手动投放被拒
    const noCard = await post(`/api/sessions/${sess.id}/flowback`, {});
    assert.match(noCard.error, /尚无裁决卡/);
    // 手工放一张裁决卡（跳过真实裁决流程），并模拟裁决产出事件 → 自动落回来源时间线
    wf(path.join(detail.dir, 'judge-card.md'), '# 裁决\n采纳方案 X');
    srv.sessions.get(sess.id).emit({ type: 'judge-card', data: '# 裁决\n采纳方案 X' });
    for (let i = 0; i < 50; i++) { if (/会议裁决/.test(srv.benches.get(wbid).bench.messages.at(-1)?.text ?? '')) break; await new Promise(r => setTimeout(r, 50)); }
    const auto = srv.benches.get(wbid).bench.messages.at(-1);
    assert.match(auto.text, /会议裁决/);
    assert.match(auto.text, /采纳方案 X/);
    // 手动投放路径仍可用（显式再分发）
    const fb = await post(`/api/sessions/${sess.id}/flowback`, {});
    assert.equal(fb.benchId, wbid);
    assert.equal(srv.benches.get(wbid).bench.messages.filter(m => /会议裁决/.test(m.text)).length, 2);
    // 从内存删掉工作台（模拟重启）→ 投放走磁盘恢复路径
    srv.benches.delete(wbid);
    const fb2 = await post(`/api/sessions/${sess.id}/flowback`, {});
    assert.ok(fb2.benchId);
    const resumed = srv.benches.get(fb2.benchId).bench;
    assert.equal(resumed.messages.filter(m => /会议裁决/.test(m.text)).length, 3); // 前两条也从磁盘读回
  } finally { srv.close(); }
});

test('diff 一等公民接线：动手登记 Revision（CAS 快照可重建），应用留审计', async () => {
  const { loadRevisions, readBlob, verifyBlob } = await import('../src/changes.js');
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-rev-'));
  const w = new Workbench({ name: 'rev', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: () => {}, workspace, writeAgents: { m1: WRITE_AGENT } });
  await w.init();
  await w.build('加个文件', 'm1');
  const buildId = w.builds[0].buildId;
  const rev = (await loadRevisions(w.dir)).find(r => r.revisionId === buildId);
  assert.ok(rev, '动手应同步登记 Revision');
  const f = rev.files.find(x => x.path === 'from-agent.txt');
  assert.equal(f.baseSha, null);                    // 新文件无基线
  assert.ok(await verifyBlob(w.dir, f.resultSha));  // 改后快照完整
  assert.equal((await readBlob(w.dir, f.resultSha)).toString(), 'built by agent'); // 可逐字节重建
  await w.applyBuild(buildId, ['from-agent.txt']);  // 干净路径硬门放行
  const log = readFileSync(path.join(w.dir, 'changes', 'applications.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log[0].buildId, buildId);
  assert.deepEqual(log[0].files, ['from-agent.txt']);
});

test('确定性硬门：提案后基线漂移 → applyBuild 拦截，主工作区不被触碰', async () => {
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-drift-'));
  const editAgent = {
    name: 'E',
    command: [process.execPath, '-e', "require('fs').appendFileSync('readme.md', 'agent line\\n'); console.log('edited readme')"],
    input: 'stdin', output: 'text', timeoutMs: 15000, envWhitelist: ['PATH', 'SYSTEMROOT'], cwd: '.',
  };
  const w = new Workbench({ name: 'drift', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: () => {}, workspace, writeAgents: { m1: editAgent } });
  await w.init();
  await w.build('改 readme', 'm1');
  const buildId = w.builds[0].buildId;
  // 提案与审批之间，用户/他人改动了同一文件 → 基线漂移
  writeFileSync(path.join(workspace, 'readme.md'), 'drifted by someone else\n');
  await assert.rejects(() => w.applyBuild(buildId, ['readme.md']), /基线漂移|base drift/);
  assert.equal(readFileSync(path.join(workspace, 'readme.md'), 'utf8'), 'drifted by someone else\n'); // 分毫未动
  assert.equal(w.builds[0].files.find(f => f.path === 'readme.md').status, 'pending'); // 状态未被误置
});

test('redact 只影响展示：应用 diff 走原始 patch，敏感形态内容原样落地', async () => {
  const os = await import('node:os');
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-raw-'));
  // 模型写入的文件内容包含本机主目录路径（redactor 的脱敏目标形态）
  const sensitive = os.homedir() + path.sep + 'secret-config.json';
  const agent = {
    name: 'W',
    command: [process.execPath, '-e', `require('fs').writeFileSync('cfg.txt', ${JSON.stringify(JSON.stringify(sensitive))}); console.log('wrote cfg')`],
    input: 'stdin', output: 'text', timeoutMs: 15000, envWhitelist: ['PATH', 'SYSTEMROOT'], cwd: '.',
  };
  const w = new Workbench({ name: 'raw', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: () => {}, workspace, writeAgents: { m1: agent } });
  await w.init();
  await w.build('写入含主目录路径的配置', 'm1');
  const buildId = w.builds[0].buildId;
  // 展示版 patch 已脱敏（不含真实主目录）；raw 版保留原始字节
  const shown = readFileSync(w.patchPathOf(buildId), 'utf8');
  assert.ok(!shown.includes(os.homedir()), '展示版应已脱敏');
  assert.ok(readFileSync(w.rawPatchPathOf(buildId), 'utf8').includes('secret-config'), 'raw 版应存在');
  // 应用后主工作区文件内容 = 原始内容（不是脱敏占位符）
  await w.applyBuild(buildId, ['cfg.txt']);
  const landed = readFileSync(path.join(workspace, 'cfg.txt'), 'utf8');
  assert.equal(landed, JSON.stringify(sensitive));
});

test('build: 二次动手的提示词附上待批的上次 diff（修正语境）', async () => {
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-iter-'));
  const w = new Workbench({
    name: 'iter', agents: MOCK_AGENTS(), participants: ['m1'], baseDir,
    emit: () => {}, workspace, writeAgents: { m1: WRITE_AGENT },
  });
  await w.init();
  await w.build('第一次', 'm1');
  assert.equal(w.builds[0].status, 'pending');
  await w.build('修正一下', 'm1'); // 上一个还待批 → 提示词应含上次 diff
  const promptFile = (await import('node:fs')).readdirSync(path.join(w.dir, 'prompts')).filter(f => f.startsWith('build-')).sort().at(-1);
  const prompt2 = readFileSync(path.join(w.dir, 'prompts', promptFile), 'utf8');
  assert.match(prompt2, /上一次动手产出的 diff/);
  assert.match(prompt2, /from-agent\.txt/); // 上次 patch 内容在场
  assert.match(prompt2, /用户尚未应用/);
});

// ---- 会话续接（动手复用 CLI 原生会话） ----
// 假 stream-json 写手：输出 session_id + result，并把自己的 argv 写进副本（可经 patch 观察）
const SJ_SCRIPT = path.join(mkdtempSync(path.join(tmpdir(), 'sj-agent-')), 'sj.cjs');
writeFileSync(SJ_SCRIPT, "const fs=require('fs');fs.writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:'system',subtype:'init',session_id:'sid-fake-1'}));console.log(JSON.stringify({type:'result',result:'done'}));");
const SJ_AGENT = {
  name: 'SJ',
  command: [process.execPath, SJ_SCRIPT],
  input: 'stdin', output: 'stream-json', timeoutMs: 10000,
  envWhitelist: ['PATH', 'SYSTEMROOT'], cwd: process.cwd(),
  resumeArgs: ['--resume', '{SESSION_ID}'],
};

test('build 会话续接：首次记录 session id，二次带 --resume 且上下文只带新增', async () => {
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-resume-'));
  const w = new Workbench({
    name: 'rs', agents: MOCK_AGENTS(), participants: ['m1'], baseDir,
    emit: () => {}, workspace, writeAgents: { m1: SJ_AGENT },
  });
  await w.init();
  await w.build('第一次任务', 'm1');
  assert.equal(w.buildSessions.m1?.sessionId, 'sid-fake-1'); // 会话 id 已记录
  assert.equal(w.buildSessions.m1.lastSeq, 2);
  // 首次 argv 不含 --resume
  const patch1 = readFileSync(w.patchPathOf(w.builds[0].buildId), 'utf8');
  assert.ok(!patch1.includes('--resume'));

  await w.discardBuild(w.builds[0].buildId); // 让二次动手走"修正"语境
  await w.build('第二次任务', 'm1');
  const patch2 = readFileSync(w.patchPathOf(w.builds[1].buildId), 'utf8');
  assert.match(patch2, /--resume/); // 二次 argv 带续接参数
  assert.match(patch2, /sid-fake-1/);
  // 二次提示词：历史被裁到上次会话之后（不含首次任务的对话行），但含上次被丢弃的 diff 语境
  const pf = readdirSync(path.join(w.dir, 'prompts')).sort().filter(f => f.startsWith('build-')).at(-1);
  const prompt2 = readFileSync(path.join(w.dir, 'prompts', pf), 'utf8');
  assert.ok(!prompt2.includes('[用户 → SJ·动手] 第一次任务'), '续接时不应重发旧对话');
  assert.match(prompt2, /已被用户丢弃/);
  // 元数据持久化 → 恢复后 buildSessions 还在
  const { meta } = await loadWorkbenchFromDisk(w.dir);
  assert.equal(meta.buildSessions.m1.sessionId, 'sid-fake-1');
});

// ---- 应用前检查（临时副本跑命令） ----
test('checkBuild: 副本=主工作区+待批 diff，命令通过/失败/主工作区零接触', async () => {
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-check-'));
  const events = [];
  const w = new Workbench({
    name: 'chk', agents: MOCK_AGENTS(), participants: ['m1'], baseDir,
    emit: e => events.push(e), workspace, writeAgents: { m1: WRITE_AGENT },
  });
  await w.init();
  await w.build('动手', 'm1'); // 产出 from-agent.txt 待批
  const bid = w.builds[0].buildId;
  // 命令验证 patch 已在副本中生效（文件存在 → exit 0）
  await w.checkBuild(bid, 'node -e "process.exit(require(\'fs\').existsSync(\'from-agent.txt\') ? 0 : 1)"');
  let cr = events.filter(e => e.type === 'check-result').at(-1);
  assert.equal(cr.ok, true);
  assert.equal(w.builds[0].check.ok, true);
  // 失败命令
  await w.checkBuild(bid, 'node -e "console.error(\'boom\'); process.exit(3)"');
  cr = events.filter(e => e.type === 'check-result').at(-1);
  assert.equal(cr.ok, false);
  assert.equal(cr.code, 3);
  assert.match(cr.output, /boom/);
  // 主工作区始终零接触
  assert.ok(!existsSync(path.join(workspace, 'from-agent.txt')));
  // 空命令/已处理完的 diff 被拒
  await assert.rejects(() => w.checkBuild(bid, '  '), /不能为空/);
  await w.discardBuild(bid);
  await assert.rejects(() => w.checkBuild(bid, 'node -v'), /已无待批文件/);
});

test('server: build-progress 不进回放缓冲（防长命工作台无界增长）', async () => {
  const { startServer } = await import('../src/server.js');
  const { mkdtempSync: mkd } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const sessionsDir = mkd(path.join(tmpdir(), 'wb-buf-'));
  // 真 git 仓库 + 会流式输出的写手
  const wsRepo = mkd(path.join(tmpdir(), 'wb-buf-ws-'));
  const g = (...a) => execFileSync('git', ['-C', wsRepo, ...a], { windowsHide: true });
  g('init'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(path.join(wsRepo, 'seed.txt'), 'x\n'); g('add', '-A'); g('commit', '-m', 'i');
  // fixture 增加一个 stream-json 写手 mockW
  const fix = JSON.parse(readFileSync('test/agents.fixture.json', 'utf8'));
  const srv = await startServer({ port: 0, agentsFile: 'test/agents.fixture.json', sessionsDir });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then(r => r.json());
  try {
    const { id } = await post('/api/workbenches', { name: 'buf', participants: ['mockA', 'mockB'], workspace: wsRepo });
    const entry = srv.benches.get(id);
    // 直接向 emit 灌大量 build-progress + 少量 chat-message
    for (let i = 0; i < 500; i++) entry.emit({ type: 'build-progress', agentId: 'mockA', data: 'x'.repeat(100) });
    entry.emit({ type: 'chat-message', from: 'mockA', name: 'MockA', data: 'done' });
    const progressBuffered = entry.events.filter(e => e.type === 'build-progress').length;
    const chatBuffered = entry.events.filter(e => e.type === 'chat-message').length;
    assert.equal(progressBuffered, 0, 'build-progress 不应进缓冲');
    assert.equal(chatBuffered, 1, 'chat-message 应进缓冲');
  } finally { srv.close(); }
});

// ---- 分歧处置流：冲突清单 / 深入讨论 / 仲裁融合两档 ----
function seedPendingConflict(w, filePath = 'from-agent.txt') {
  const records = [
    { buildId: 'b-old', agentId: 'm1', instruction: '采用方案一', ts: '2026-07-21T01:00:00.000Z', value: 'shown-one' },
    { buildId: 'b-new', agentId: 'm2', instruction: '采用方案二', ts: '2026-07-21T02:00:00.000Z', value: 'shown-two' },
  ];
  mkdirSync(path.join(w.dir, 'builds'), { recursive: true });
  for (const record of records) {
    w.builds.push({
      buildId: record.buildId, agentId: record.agentId, instruction: record.instruction,
      stat: filePath, status: 'pending', files: [{ path: filePath, status: 'pending' }], ts: record.ts,
    });
    const patch = [
      `diff --git a/${filePath} b/${filePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${filePath}`,
      '@@ -0,0 +1 @@',
      `+${record.value}`,
      '',
    ].join('\n');
    writeFileSync(w.patchPathOf(record.buildId), patch);
    writeFileSync(w.rawPatchPathOf(record.buildId), patch.replace(record.value, 'RAW_SECRET_MUST_NOT_APPEAR'));
  }
}

test('conflictSheet: 只列两个不同待批 build 的共同路径，按时间排序，处理后消失', () => {
  const w = new Workbench({
    name: 'conflicts', agents: MOCK_AGENTS(), participants: ['m1', 'm2'],
    baseDir: '.', emit: () => {},
  });
  w.builds.push(
    {
      buildId: 'b2', agentId: 'm2', instruction: 'later', status: 'pending', ts: '2026-07-21T02:00:00.000Z',
      files: [{ path: 'shared.js', status: 'pending' }, { path: 'only-m2.js', status: 'pending' }],
    },
    {
      buildId: 'b1', agentId: 'm1', instruction: 'earlier', status: 'pending', ts: '2026-07-21T01:00:00.000Z',
      files: [{ path: 'shared.js', status: 'pending' }, { path: '(全部)', status: 'pending' }],
    },
  );

  assert.deepEqual(w.conflictSheet(), {
    conflicts: [{
      path: 'shared.js',
      builds: [
        { buildId: 'b1', actorId: 'm1', actorName: 'M1', instruction: 'earlier' },
        { buildId: 'b2', actorId: 'm2', actorName: 'M2', instruction: 'later' },
      ],
    }],
  });
  w.builds[1].files[0].status = 'applied';
  assert.deepEqual(w.conflictSheet(), { conflicts: [] });
});

test('discussConflict: 仲裁生成结构化对比并落入消息，非冲突路径拒绝', async () => {
  process.env.MOCK_FIXED_OUTPUT = '## 方案 1\n收益：稳妥';
  try {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-conflict-discuss-'));
    const events = [];
    const w = new Workbench({
      name: 'discuss', agents: MOCK_AGENTS(), participants: ['m1', 'm2'], baseDir,
      emit: event => events.push(event), writeAgents: { m1: WRITE_AGENT, m2: WRITE_AGENT },
    });
    await w.init();
    seedPendingConflict(w);
    await w.setRole('m2', 'talk', true, false);

    const result = await w.discussConflict('from-agent.txt');
    assert.equal(result.ok, true);
    assert.equal(w.messages.length, 1);
    assert.equal(w.messages[0].from, 'm2');
    assert.match(w.messages[0].text, /^【冲突对比 · from-agent\.txt】/);
    assert.ok(events.some(event => event.type === 'agent-status' && event.agentId === 'm2' && event.data === 'done'));
    const saved = readFileSync(path.join(w.dir, 'prompts', 'conflict-0-m2.md'), 'utf8');
    assert.match(saved, /不要选边，不要给裁决/);
    assert.match(saved, /shown-one/);
    assert.ok(!saved.includes('RAW_SECRET_MUST_NOT_APPEAR'), '模型上下文只能读取脱敏版 patch');
    const persisted = (await loadWorkbenchFromDisk(w.dir)).messages;
    assert.equal(persisted.at(-1).text, w.messages[0].text);
    await assert.rejects(() => w.discussConflict('only-one.txt'), /没有冲突的待批变更/);
  } finally {
    delete process.env.MOCK_FIXED_OUTPUT;
  }
});

test('mergeConflict: 仲裁与决断授权守卫；两档均产普通待批卡并写 decisions.jsonl', async () => {
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-conflict-merge-'));
  const w = new Workbench({
    name: 'merge', agents: MOCK_AGENTS(), participants: ['m1', 'm2'], baseDir,
    emit: () => {}, workspace, writeAgents: { m1: WRITE_AGENT, m2: WRITE_AGENT },
  });
  await w.init();
  seedPendingConflict(w);

  await assert.rejects(() => w.mergeConflict('from-agent.txt'), /需要一位仲裁/);
  await w.setRole('m2', 'talk', true, false);
  await assert.rejects(() => w.mergeConflict('from-agent.txt', { decide: true }), /替我决断/);

  const facilitated = await w.mergeConflict('from-agent.txt', { note: '保留兼容路径' });
  assert.equal(facilitated.buildId, w.builds.at(-1).buildId);
  assert.equal(w.builds.at(-1).status, 'pending');
  assert.match(w.builds.at(-1).instruction, /^【仲裁融合 · from-agent\.txt】/);
  assert.ok(!existsSync(path.join(workspace, 'from-agent.txt')), '融合卡不得绕过用户审批直接应用');

  await w.setRole('m2', 'talk', true, true);
  const decided = await w.mergeConflict('from-agent.txt', { decide: true, note: '由仲裁选择' });
  assert.equal(decided.buildId, w.builds.at(-1).buildId);
  assert.equal(w.builds.at(-1).status, 'pending');
  assert.ok(!existsSync(path.join(workspace, 'from-agent.txt')), '决断档也不得绕过用户审批');

  const decisions = readFileSync(path.join(w.dir, 'changes', 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(decisions.map(item => item.tier), ['facilitate', 'decide']);
  assert.deepEqual(decisions.map(item => item.buildId), [facilitated.buildId, decided.buildId]);
  assert.deepEqual(decisions.map(item => item.note), ['保留兼容路径', '由仲裁选择']);
});

test('build: 有文件改动返回 buildId，无文件改动返回 null', async () => {
  const workspace = makeWorkspaceRepo();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-build-return-'));
  const noChangeAgent = {
    name: 'NoChange', command: [process.execPath, '-e', `console.log('no file changes')`],
    input: 'stdin', output: 'text', timeoutMs: 10000,
    envWhitelist: ['PATH', 'SYSTEMROOT'], cwd: process.cwd(),
  };
  const w = new Workbench({
    name: 'return', agents: MOCK_AGENTS(), participants: ['m1', 'm2'], baseDir,
    emit: () => {}, workspace, writeAgents: { m1: WRITE_AGENT, m2: noChangeAgent },
  });
  await w.init();
  const buildId = await w.build('产生文件', 'm1');
  assert.equal(buildId, w.builds[0].buildId);
  assert.equal(await w.build('只检查不修改', 'm2'), null);
});
