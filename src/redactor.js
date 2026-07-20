// 落盘/展示前统一擦除凭据与本机隐私路径。宁可误伤，不可漏放。
import { homedir } from 'node:os';

const BARE_PATTERNS = [
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,                         // OpenAI/Anthropic 风格
  /ghp_[A-Za-z0-9]{20,}/g,                                            // GitHub PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,                                    // Slack
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,                              // Bearer token
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/g,      // JWT
];
const KEYED = /((?:api[_-]?key|token|secret|password|passwd|cookie)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi;

// 主目录前缀 → ~：模型转述 worktree/临时目录等绝对路径时会带出用户名（C:\Users\<name>\...）。
// 同一路径可能以 \、\\（JSON 转义后）、/ 三种分隔符出现，分段拼 [\\/]+ 全部命中；Windows 盘符不区分大小写。
const HOME_RE = (() => {
  const segs = homedir().split(/[\\/]+/).filter(Boolean)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return segs.length ? new RegExp(segs.join('[\\\\/]+'), 'gi') : null;
})();

export function redact(text) {
  let out = String(text);
  for (const p of BARE_PATTERNS) out = out.replace(p, '[REDACTED]');
  out = out.replace(KEYED, '$1[REDACTED]');
  if (HOME_RE) out = out.replace(HOME_RE, '~');
  return out;
}
