// 可控 mock CLI：按 prompt 首行指令行为，供全部测试复用
let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', async () => {
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
  if (first.startsWith('#sleep')) {
    await new Promise(r => setTimeout(r, Number(first.split(/\s+/)[1] ?? 100)));
    process.stdout.write(rest);
    process.exit(0);
  }
  if (first.startsWith('#env')) {
    process.stdout.write(String(process.env[first.split(/\s+/)[1]] ?? '<unset>'));
    process.exit(0);
  }
  if (first === '#echo') { process.stdout.write(rest); process.exit(0); }
  process.stdout.write(input);
  process.exit(0);
});
