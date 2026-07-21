#!/usr/bin/env node
// 跨平台测试启动器（零依赖）。存在的理由是两条 Node 行为差异：
//
// 1. `node --test "test/*.test.js"`：把 glob 当参数传给 test runner 是 Node 22+ 才支持的能力。
//    Node 20 会把它当字面路径 → CI 上 Node 20 两个任务都在测试开始前报
//    `Could not find '.../test/*.test.js'`。（Windows 上即使去掉引号也没救：
//    npm 用 cmd.exe，shell 不做 glob 展开。）
// 2. 裸 `node --test`：默认发现规则里有一条「test 目录下的所有 .js/.cjs/.mjs 都算测试文件」，
//    于是 test/mock-cli.cjs（测试用的假 CLI，挂在 process.stdin 上等 EOF）也被当测试跑，
//    进程永不退出——实测整条命令挂死。
//
// 因此这里自己枚举 *.test.js，再以显式文件路径交给 test runner：
// 显式路径是所有 Node 版本都支持的形式，Windows/Ubuntu 行为一致。
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 递归收集：今天 test/ 下没有子目录测试，但递归可防止将来新增子目录后测试被静默漏跑。
// 只认 *.test.js，所以 mock-cli.cjs、fixtures/ 等非测试文件天然排除在外。
function collect(relDir) {
  const found = [];
  for (const entry of readdirSync(path.join(root, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...collect(rel));
    else if (entry.name.endsWith('.test.js')) found.push(rel);
  }
  return found;
}

const files = collect('test').sort();
if (!files.length) {
  console.error('未找到任何 test/**/*.test.js —— 测试命令不应静默通过');
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1)); // 退出码透传，CI 才能正确判定
