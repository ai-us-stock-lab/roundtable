import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCliPath } from '../src/resolve.js';

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
