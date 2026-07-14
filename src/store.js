import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { redact } from './redactor.js';

const today = () => new Date().toISOString().slice(0, 10);

export async function createSessionDir(baseDir, slug) {
  const safe = String(slug).replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/^-+|-+$/g, '') || 'session';
  let dir = path.join(baseDir, `${today()}-${safe}`);
  for (let i = 2; existsSync(dir); i++) dir = path.join(baseDir, `${today()}-${safe}-${i}`);
  for (const sub of ['', 'prompts', 'raw', 'summaries']) await mkdir(path.join(dir, sub), { recursive: true });
  return dir;
}

const w = (file, text) => writeFile(file, redact(String(text)), 'utf8');

export async function saveProblem(dir, { topic, materials, templateName, roles, mode, maxRounds }) {
  await w(path.join(dir, 'problem.md'),
    `# 议题\n${topic}\n\n# 背景材料\n${materials || '（无）'}\n\n# 配置\n- 模板：${templateName}\n- 辩手：${roles.debaters.join(', ')}\n- 仲裁：${roles.judge}\n- 书记：${roles.summarizer}\n- 模式：${mode}\n- 最大轮数：${maxRounds}\n`);
}
export const savePrompt = (dir, label, agentId, text) => w(path.join(dir, 'prompts', `${label}-${agentId}.md`), text);
export const saveRaw = (dir, label, agentId, text) => w(path.join(dir, 'raw', `${label}-${agentId}.md`), text);
export const saveSummary = (dir, round, text) => w(path.join(dir, 'summaries', `r${round}.md`), text);
export const saveDisagreements = (dir, text) => w(path.join(dir, 'disagreements.md'), text);
export const saveJudgeCard = (dir, text) => w(path.join(dir, 'judge-card.md'), text);
export const saveMetadata = (dir, obj) => writeFile(path.join(dir, 'metadata.json'), JSON.stringify(obj, null, 2), 'utf8');

export async function assembleSessionMd(dir) {
  const parts = [];
  const tryRead = async f => { try { return await readFile(f, 'utf8'); } catch { return null; } };
  const problem = await tryRead(path.join(dir, 'problem.md'));
  if (problem) parts.push(problem);
  let raws = [];
  try { raws = (await readdir(path.join(dir, 'raw'))).sort(); } catch { /* 目录可能为空 */ }
  let sums = [];
  try { sums = (await readdir(path.join(dir, 'summaries'))).sort(); } catch { /* 同上 */ }
  const rounds = [...new Set(raws.map(f => f.split('-')[0]))].filter(r => /^r\d+$/.test(r)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const r of rounds) {
    parts.push(`\n---\n\n# 第 ${r.slice(1)} 轮`);
    for (const f of raws.filter(x => x.startsWith(r + '-') && !x.includes('summary')))
      parts.push(`## ${f.replace('.md', '').replace(r + '-', '')} 发言\n\n${await tryRead(path.join(dir, 'raw', f))}`);
    const s = sums.find(x => x === `${r}.md`);
    if (s) parts.push(await tryRead(path.join(dir, 'summaries', s)));
  }
  const dis = await tryRead(path.join(dir, 'disagreements.md'));
  if (dis) parts.push(`\n---\n\n# 分歧分类表（全场累计）\n\n${dis}`);
  const judgeRaws = raws.filter(f => f.startsWith('judge-'));
  if (judgeRaws.length > 0) {
    parts.push(`\n---\n\n# 仲裁发言原文`);
    for (const f of judgeRaws)
      parts.push(`\n${await tryRead(path.join(dir, 'raw', f))}`);
  }
  const card = await tryRead(path.join(dir, 'judge-card.md'));
  if (card) parts.push(`\n---\n\n${card}`);
  await writeFile(path.join(dir, 'session.md'), parts.filter(Boolean).join('\n\n'), 'utf8');
}
