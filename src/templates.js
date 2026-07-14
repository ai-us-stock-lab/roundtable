import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export function expandHome(p) {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
}

export async function loadTemplates(dir) {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(path.join(dir, entry.name, 'template.json'), 'utf8');
      const t = JSON.parse(raw);
      out[t.name] = { injections: {}, debaterFormat: '', judgeFormat: '', copyJudgeCardTo: null, ...t };
    } catch { /* 无 template.json 的目录跳过 */ }
  }
  return out;
}

export async function resolveInjection(template, agentId) {
  const files = template.injections?.[agentId] ?? [];
  const parts = [];
  for (const f of files) {
    const p = expandHome(f);
    try {
      parts.push(await readFile(p, 'utf8'));
    } catch (e) {
      throw new Error(`模板「${template.name}」的注入文件读取失败: ${p} (${e.code ?? e.message})`);
    }
  }
  return parts.join('\n\n---\n\n');
}
