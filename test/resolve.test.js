import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCliPath, collectCandidates, canSpawn } from '../src/resolve.js';

test('优先级1：commandEnvVar 命中', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-res-'));
  const exe = path.join(dir, 'fake.exe');
  writeFileSync(exe, '');
  process.env.RT_TEST_CLI = exe;
  const p = resolveCliPath({ command: ['nonexistent-cli-xyz'], commandEnvVar: 'RT_TEST_CLI' });
  delete process.env.RT_TEST_CLI;
  assert.equal(p, exe);
});

test('优先级2：绝对路径直接用', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-res-'));
  const exe = path.join(dir, 'a.exe');
  writeFileSync(exe, '');
  assert.equal(resolveCliPath({ command: [exe] }), exe);
});

test('优先级4：glob 命中取最新 mtime', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-res-'));
  for (const [name, age] of [['old', 60], ['new', 0]]) {
    mkdirSync(path.join(dir, name));
    const f = path.join(dir, name, 'x.exe');
    writeFileSync(f, '');
    const t = new Date(Date.now() - age * 1000);
    utimesSync(f, t, t);
  }
  const p = resolveCliPath({ command: ['nonexistent-cli-xyz'], commandFallbackGlob: dir.replaceAll('\\', '/') + '/*/x.exe' });
  assert.match(p.replaceAll('\\', '/'), /new\/x\.exe$/);
});

test('全部未命中抛带指引的错误', () => {
  assert.throws(() => resolveCliPath({ command: ['nonexistent-cli-xyz'] }), /未找到/);
});

test('win32 下 PATH 查找跳过无扩展名裸文件、命中 .cmd', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-path-'));
  writeFileSync(path.join(dir, 'mytool'), '#!/bin/sh\necho posix-shim');   // 裸 POSIX shim
  writeFileSync(path.join(dir, 'mytool.cmd'), '@echo off\r\n');
  const oldPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + oldPath;
  try {
    const p = resolveCliPath({ command: ['mytool'] });
    assert.match(p, /mytool\.cmd$/i);
  } finally { process.env.PATH = oldPath; }
});

test('expandHome: ~/ 前缀展开为主目录', async () => {
  const { expandHome } = await import('../src/resolve.js');
  const { homedir } = await import('node:os');
  const path = (await import('node:path')).default;
  assert.equal(expandHome('~/x/y.exe'), path.join(homedir(), 'x/y.exe'));
  assert.equal(expandHome('plain'), 'plain');
});

// ---- WindowsApps 降级 + spawn 探测 ----

test('collectCandidates：PATH 里的 WindowsApps 候选降到 fallback 之后', { skip: process.platform !== 'win32' }, () => {
  // 用唯一 CLI 名避免撞上测试机真实 PATH 里的同名工具；WindowsApps 必须是独立路径段
  const cli = 'rtcodex' + Date.now().toString(36);
  const winAppsDir = path.join(mkdtempSync(path.join(tmpdir(), 'rt-wa-')), 'WindowsApps');
  mkdirSync(winAppsDir);
  writeFileSync(path.join(winAppsDir, cli + '.cmd'), '@echo off\r\n');
  const fbBase = mkdtempSync(path.join(tmpdir(), 'rt-fb-'));
  mkdirSync(path.join(fbBase, 'hash1'));
  const fbExe = path.join(fbBase, 'hash1', cli + '.exe');
  writeFileSync(fbExe, '');
  const oldPath = process.env.PATH;
  process.env.PATH = winAppsDir + path.delimiter + oldPath;
  try {
    const cands = collectCandidates({ command: [cli], commandFallbackGlob: fbBase.replaceAll('\\', '/') + '/*/' + cli + '.exe' });
    const winIdx = cands.findIndex(c => /[\\/]WindowsApps[\\/]/i.test(c));
    const fbIdx = cands.findIndex(c => c === fbExe);
    assert.ok(fbIdx !== -1 && winIdx !== -1, 'both candidates present: ' + JSON.stringify(cands));
    assert.ok(fbIdx < winIdx, 'fallback must rank before WindowsApps: ' + JSON.stringify(cands));
  } finally { process.env.PATH = oldPath; }
});

test('resolveCliPath：首候选不可 spawn（EPERM 类）→ 自动选可用的次候选', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-probe-'));
  const bad = path.join(dir, 'bad.exe');  writeFileSync(bad, '');
  const fbBase = mkdtempSync(path.join(tmpdir(), 'rt-probe-fb-'));
  mkdirSync(path.join(fbBase, 'h'));
  const good = path.join(fbBase, 'h', 'good.exe'); writeFileSync(good, '');
  // command[0]=绝对 bad（候选②），fallback→good（候选④）；注入 probe 模拟 bad 不可 spawn
  const probe = p => p === good;
  const chosen = resolveCliPath({ command: [bad], commandFallbackGlob: fbBase.replaceAll('\\', '/') + '/*/good.exe' }, { probe });
  assert.equal(chosen, good);
});

test('resolveCliPath：所有候选都不可 spawn → 抛错并列出尝试过的路径', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-probe2-'));
  const a = path.join(dir, 'a.exe'); writeFileSync(a, '');
  const fbBase = mkdtempSync(path.join(tmpdir(), 'rt-probe2-fb-'));
  mkdirSync(path.join(fbBase, 'h'));
  const b = path.join(fbBase, 'h', 'b.exe'); writeFileSync(b, '');
  const probe = () => false; // 全部不可 spawn
  try {
    resolveCliPath({ command: [a], commandFallbackGlob: fbBase.replaceAll('\\', '/') + '/*/b.exe' }, { probe });
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /b\.exe/); // 错误信息列出尝试过的候选
    assert.match(e.message, /EPERM|无法被 Node 启动/);
  }
});

test('canSpawn：node 可启动为 true，不存在路径为 false', () => {
  assert.equal(canSpawn(process.execPath), true); // node --version 能起来
  assert.equal(canSpawn(path.join(tmpdir(), 'definitely-not-here-xyz.exe')), false);
});
