// 仅供 --mock 演示兜底。默认录制不走这里。
// 它遵循 Roundtable 的 CLI adapter 契约：prompt 从 stdin 进入，回复写 stdout；
// “动手”时 cwd 已是 git worktree 隔离副本，因此写 README 仍走真实 diff/审批链路。
const fs = require('node:fs');
const path = require('node:path');

const agentId = process.argv[2] || 'codex';
const lang = process.argv[3] === 'en' ? 'en' : 'zh';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  const isBuild = /隔离副本|在 README 末尾新增一行|Append one line to the README|every file change approved by the user/i.test(input);
  if (isBuild) {
    const readme = path.join(process.cwd(), 'README.md');
    const line = lang === 'en'
      ? 'Roundtable lets multiple AI CLIs collaborate locally, with every file change approved by the user.'
      : 'Roundtable 让多个 AI CLI 在本机协作，并由用户审批每一次文件改动。';
    const existing = fs.readFileSync(readme, 'utf8');
    if (!existing.includes(line)) fs.appendFileSync(readme, `\n${line}\n`, 'utf8');
    process.stdout.write(lang === 'en'
      ? 'Appended the project summary to README.md. The diff is ready for your review.'
      : '已在 README.md 末尾补充项目一句话简介，等待你审批 diff。');
    return;
  }

  const isRelay = /互相接力|点名反驳|上一位发言/.test(input);
  if (lang === 'en') {
    if (isRelay && agentId === 'claude') {
      process.stdout.write('Codex, start with one failing test—but document the acceptance criteria so the target stays clear.');
    } else if (isRelay) {
      process.stdout.write('Agreed. Lock behavior with one failing test, then add the shortest documentation that explains the contract.');
    } else if (agentId === 'claude') {
      process.stdout.write('Add one minimal failing test first, then document the behavior that test locks down.');
    } else {
      process.stdout.write('Write two acceptance criteria first, then turn them into tests that avoid implementation details.');
    }
    return;
  }
  if (isRelay && agentId === 'claude') {
    process.stdout.write('Codex，我同意先补最小测试；但文档也应同步写清验收标准，否则测试目标会漂移。');
  } else if (isRelay) {
    process.stdout.write('Claude 的边界合理。先用一个失败测试锁定行为，再补最短文档，二者不必二选一。');
  } else if (agentId === 'claude') {
    process.stdout.write('先补一个最小失败测试，先锁定行为，再写与实现一致的文档。');
  } else {
    process.stdout.write('先写两句验收标准，再落成测试；这样测试不会只覆盖实现细节。');
  }
});
