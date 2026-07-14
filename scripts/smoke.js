// 单 agent 冒烟脚本：真实调用一次 CLI，验证 resolveCliPath + runAgent 端到端可用
// 用法: node scripts/smoke.js <agentId>
import { readFile } from 'node:fs/promises';
import { runAgent } from '../src/runner.js';
import { resolveCliPath } from '../src/resolve.js';

const id = process.argv[2];
const agents = JSON.parse(await readFile('adapters/agents.json', 'utf8'));
if (!agents[id]) { console.error('未知 agent:', id, '可选:', Object.keys(agents).join(', ')); process.exit(1); }
const cfg = agents[id];
cfg.command[0] = resolveCliPath(cfg);
console.log(`[smoke] 调用 ${id} -> ${cfg.command[0]}`);
const r = await runAgent(cfg, '请只回答一句话：1+1 等于几？');
console.log(JSON.stringify({ ok: r.ok, error: r.error, exitCode: r.exitCode, durationMs: r.durationMs }, null, 2));
console.log('--- text ---\n' + r.text.slice(0, 500));
process.exit(r.ok ? 0 : 1);
