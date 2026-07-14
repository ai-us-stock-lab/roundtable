// 可控 mock CLI：按 prompt 首行指令行为，供全部测试复用
const { readFileSync } = require('node:fs');

// 测试可控延迟：存在 MOCK_DELAY_MS 时先睡再回显，默认 0 不影响其他测试
const delay = Number(process.env.MOCK_DELAY_MS ?? 0);

// 文件输入模式：node mock-cli.cjs --from-file <path>
if (process.argv[2] === '--from-file') {
  process.stdout.write(readFileSync(process.argv[3], 'utf8'));
  process.exit(0);
}

let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () => {
  const nl = input.indexOf('\n');
  const first = (nl === -1 ? input : input.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : input.slice(nl + 1);
  if (first.startsWith('#fail')) {
    process.stderr.write('mock failure');
    process.exit(Number(first.split(/\s+/)[1] ?? 1));
  }
  if (first === '#auth') {
    process.stderr.write('please login: session expired');
    process.exit(1);
  }
  if (first === '#json') {
    process.stdout.write(JSON.stringify({ result: rest.trim() }));
    process.exit(0);
  }
  if (first === '#stream') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', result: rest.trim() }) + '\n');
    process.exit(0);
  }
  if (first.startsWith('#sleep')) {
    const ms = Number(first.split(/\s+/)[1] ?? 100);
    setTimeout(() => {
      process.stdout.write(rest);
      process.exit(0);
    }, ms);
    return;
  }
  if (first.startsWith('#env')) {
    process.stdout.write(String(process.env[first.split(/\s+/)[1]] ?? '<unset>'));
    process.exit(0);
  }
  if (first === '#echo') { process.stdout.write(rest); process.exit(0); }
  setTimeout(() => {
    process.stdout.write(input);
    process.exit(0);
  }, delay);
});
