import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { redact } from '../src/redactor.js';

test('擦除常见凭据形态', () => {
  const cases = [
    ['key sk-abc123def456ghi789jkl end', /\[REDACTED\]/],
    ['ghp_ABCDEFGHIJKLMNOPQRSTUV123456', /\[REDACTED\]/],
    ['xoxb-1234567890-abcdefghij', /\[REDACTED\]/],
    ['Authorization: Bearer abcdef123456789012345678', /\[REDACTED\]/],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P', /\[REDACTED\]/],
  ];
  for (const [input, want] of cases) assert.match(redact(input), want, input);
});

test('键值型凭据保留键名', () => {
  const out = redact('api_key: super-secret-value-123');
  assert.match(out, /api_key/);
  assert.doesNotMatch(out, /super-secret-value-123/);
});

test('普通文本不受影响', () => {
  const s = '南添认为规模效应是北极星，N1 阶段增速 >18%。';
  assert.equal(redact(s), s);
});

test('普通连字符词不被 sk- 模式误伤', () => {
  const s = 'our risk-management-framework and task-management-system stay intact';
  assert.equal(redact(s), s);
});

test('主目录绝对路径脱敏为 ~：反斜杠 / 正斜杠 / JSON 双反斜杠三种形态', () => {
  const home = homedir();
  const tail = 'AppData\\Local\\Temp\\roundtable-wt-abc\\README.md';
  const variants = [
    `${home}\\${tail}`,
    `${home.replaceAll('\\', '/')}/${tail.replaceAll('\\', '/')}`,
    JSON.stringify({ text: `edited ${home}\\${tail}` }), // SSE 层对 JSON 串脱敏时的形态
  ];
  for (const input of variants) {
    const out = redact(input);
    assert.doesNotMatch(out, /Users[\\/]+[^\\/]+[\\/]+AppData/i, input); // 用户名段必须消失
    assert.match(out, /~/, input);
  }
  // JSON 形态脱敏后必须仍可解析（emit 层依赖）
  assert.doesNotThrow(() => JSON.parse(redact(JSON.stringify({ text: `${home}\\x.md`, n: 1 }))));
});

test('非本机的 Users 路径不误伤', () => {
  const s = 'see C:\\Users\\someoneelse\\project\\a.md';
  assert.equal(redact(s), s);
});
