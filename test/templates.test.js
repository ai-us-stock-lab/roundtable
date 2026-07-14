import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { loadTemplates, resolveInjection, expandHome } from '../src/templates.js';

function makeTplDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-tpl-'));
  mkdirSync(path.join(dir, 'demo'));
  const skillPath = path.join(dir, 'skillA.md').replaceAll('\\', '/');
  writeFileSync(path.join(dir, 'demo', 'template.json'), JSON.stringify({
    name: 'demo', title: '演示', injections: { claude: [skillPath] },
    debaterFormat: 'F', judgeFormat: 'J', copyJudgeCardTo: null,
  }));
  writeFileSync(path.join(dir, 'skillA.md'), 'SKILL_A_CONTENT');
  return dir;
}

test('expandHome 展开 ~', () => {
  assert.equal(expandHome('~/x'), path.join(homedir(), 'x'));
  assert.equal(expandHome('/abs/x'), '/abs/x');
});

test('loadTemplates 扫描目录', async () => {
  const tpls = await loadTemplates(makeTplDir());
  assert.equal(tpls.demo.title, '演示');
});

test('resolveInjection 拼接文件内容；无配置返回空串', async () => {
  const tpls = await loadTemplates(makeTplDir());
  assert.match(await resolveInjection(tpls.demo, 'claude'), /SKILL_A_CONTENT/);
  assert.equal(await resolveInjection(tpls.demo, 'codex'), '');
});

test('注入文件缺失时报带路径的错误', async () => {
  const dir = makeTplDir();
  const tpls = await loadTemplates(dir);
  tpls.demo.injections.claude = [path.join(dir, 'missing.md')];
  await assert.rejects(() => resolveInjection(tpls.demo, 'claude'), /missing\.md/);
});
