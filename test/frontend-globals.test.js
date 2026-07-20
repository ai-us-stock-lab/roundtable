import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 前端是多个 classic <script>，共享同一全局词法作用域：任何两个文件顶层重名的
// let/const/function 会让后加载的整个脚本求值失败（且单文件 node --check 测不出）。
// 实战教训：app-workbench 重复声明 app-core 的 wbInfo，整个工作台模块静默瘫痪。
const FILES = ['i18n.js', 'app-core.js', 'app-committee.js', 'app-workbench.js', 'app-sidebar.js', 'app-boot.js'];

test('前端各脚本顶层声明跨文件不重名', async () => {
  const declaredIn = {}; // name -> file
  for (const f of FILES) {
    const src = await readFile('public/' + f, 'utf8');
    // 只看行首（顶层）声明；函数/类/let/const 均计入。缩进的局部声明不匹配。
    for (const m of src.matchAll(/^(?:let|const|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1];
      assert.ok(!declaredIn[name] || declaredIn[name] === f,
        `顶层声明重名: "${name}" 同时出现在 ${declaredIn[name]} 与 ${f}——后加载脚本会整体求值失败`);
      declaredIn[name] = f;
    }
  }
});
