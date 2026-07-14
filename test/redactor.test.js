import { test } from 'node:test';
import assert from 'node:assert/strict';
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
