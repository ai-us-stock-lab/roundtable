import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WORK_DIR } from './config.mjs';

export function run(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 0,
    input,
    quiet = true,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${path.basename(command)} 超过 ${Math.round(timeoutMs / 1000)} 秒未完成`));
      }, timeoutMs);
    }
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (!quiet) process.stdout.write(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      if (!quiet) process.stderr.write(chunk);
    });
    child.on('error', error => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function runOrThrow(command, args = [], options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-1200);
    throw new Error(`${path.basename(command)} 失败（exit ${result.code}）${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export async function resetWorkDir() {
  const resolved = path.resolve(WORK_DIR);
  const expectedParent = path.resolve(path.dirname(WORK_DIR));
  if (path.dirname(resolved) !== expectedParent || path.basename(resolved) !== '.work') {
    throw new Error(`拒绝清理非预期目录: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  await mkdir(resolved, { recursive: true });
}

export async function removeWorkDir() {
  const resolved = path.resolve(WORK_DIR);
  const expectedParent = path.resolve(path.dirname(WORK_DIR));
  if (path.dirname(resolved) !== expectedParent || path.basename(resolved) !== '.work') {
    throw new Error(`拒绝清理非预期目录: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

export function redactLocalPaths(text) {
  let clean = String(text ?? '');
  const home = os.homedir();
  if (home) clean = clean.split(home).join('%USERPROFILE%');
  clean = clean.replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '%USERPROFILE%');
  return clean;
}

export function seconds(ms) {
  return Math.max(0, ms / 1000).toFixed(3);
}

export function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export async function fetchJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(`无法连接 ${url}: ${error.message}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}
