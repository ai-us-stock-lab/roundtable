// 落盘前统一擦除凭据。宁可误伤，不可漏放。
const BARE_PATTERNS = [
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,                         // OpenAI/Anthropic 风格
  /ghp_[A-Za-z0-9]{20,}/g,                                            // GitHub PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,                                    // Slack
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,                              // Bearer token
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/g,      // JWT
];
const KEYED = /((?:api[_-]?key|token|secret|password|passwd|cookie)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi;

export function redact(text) {
  let out = String(text);
  for (const p of BARE_PATTERNS) out = out.replace(p, '[REDACTED]');
  out = out.replace(KEYED, '$1[REDACTED]');
  return out;
}
