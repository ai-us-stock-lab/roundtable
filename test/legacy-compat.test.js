import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { Workbench, loadWorkbenchFromDisk } from '../src/workbench.js';

const LEGACY_ROOT = path.resolve('test/fixtures/legacy-sessions');
const LEGACY_WORKBENCH = path.join(LEGACY_ROOT, 'legacy-workbench');

test('旧工作台 fixture：缺少新字段仍可读取 metadata、messages 与 builds', async () => {
  const { meta, messages, builds } = await loadWorkbenchFromDisk(LEGACY_WORKBENCH);
  assert.equal(meta.topic, '[工作台] 旧格式台');
  assert.equal(meta.lang, undefined);
  assert.equal(meta.perms, undefined);
  assert.equal(meta.buildSessions, undefined);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].text, '旧格式回答');
  assert.equal(messages.every(message => message.meeting === undefined && message.build === undefined), true);
  assert.equal(builds.length, 1);
  assert.equal(builds[0].files, undefined);
});

test('Workbench.resume：无 perms 时按写能力给默认角色，permOf 不抛', async () => {
  const { meta, messages, builds } = await loadWorkbenchFromDisk(LEGACY_WORKBENCH);
  const agents = JSON.parse(await readFile('test/agents.fixture.json', 'utf8'));
  const bench = await Workbench.resume({
    name: '旧格式台',
    agents,
    participants: meta.participants,
    baseDir: LEGACY_ROOT,
    dir: LEGACY_WORKBENCH,
    messages,
    builds,
    workspace: meta.workspace,
    writeAgents: { mockA: agents.mockA },
    buildSessions: meta.buildSessions ?? {},
    lang: meta.lang === 'en' ? 'en' : 'zh',
    perms: meta.perms ?? {},
  });

  assert.deepEqual(bench.roleOf('mockA'), { role: 'propose', arbiter: false, decide: false });
  assert.deepEqual(bench.roleOf('mockB'), { role: 'talk', arbiter: false, decide: false });
  assert.deepEqual(bench.permOf('mockA'), { propose: true, apply: false, decide: false });
  assert.deepEqual(bench.permOf('mockB'), { propose: false, apply: false, decide: false });
});

test('旧 build 无 files：公开审批路径触发私有兼容分支并正常补齐', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'rt-legacy-build-'));
  const copiedDir = path.join(tempRoot, 'legacy-workbench');
  await cp(LEGACY_WORKBENCH, copiedDir, { recursive: true });
  const { meta, messages, builds } = await loadWorkbenchFromDisk(copiedDir);
  const agents = JSON.parse(await readFile('test/agents.fixture.json', 'utf8'));
  const bench = await Workbench.resume({
    name: '旧格式台',
    agents,
    participants: meta.participants,
    baseDir: tempRoot,
    dir: copiedDir,
    messages,
    builds,
    writeAgents: { mockA: agents.mockA },
  });

  assert.equal(bench.builds[0].files, undefined);
  await bench.discardBuild('legacy-build-1');
  assert.deepEqual(bench.builds[0].files, [{ path: '(全部)', status: 'discarded' }]);
  assert.equal(bench.builds[0].status, 'discarded');
});

test('旧会议归档：列表可见且归档内容可打开', async () => {
  const server = await startServer({
    port: 0,
    agentsFile: 'test/agents.fixture.json',
    templatesDir: 'templates',
    sessionsDir: LEGACY_ROOT,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const listResponse = await fetch(base + '/api/sessions');
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.ok(list.some(item => item.id === 'legacy-meeting' && item.topic === '旧格式会议' && item.archived));

    const archiveResponse = await fetch(base + '/api/archive/legacy-meeting');
    assert.equal(archiveResponse.status, 200);
    const archive = await archiveResponse.json();
    assert.equal(archive.topic, '旧格式会议');
    assert.match(archive.sessionMd, /手工构造的最小旧会议问题/);
  } finally {
    server.close();
  }
});
