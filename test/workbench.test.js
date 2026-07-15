import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
