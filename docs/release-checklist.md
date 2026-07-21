# Roundtable 发布清单

1. 运行 `node --test`，确认全部测试通过。
2. 从干净目录重新 clone 仓库，直接运行 `npm start`，完整走一遍新建工作台、发消息、开会和打开归档的主流程，证明新用户无需额外安装即可运行。
3. 准备一份由旧版本生成、已脱敏的 `sessions` 测试目录，用当前版本打开至少一个旧工作台或旧会议，确认老数据不报错。
4. 确认零依赖承诺未破坏：`package.json` 的 `dependencies` 与 `devDependencies` 均为空或不存在，不执行 `npm install`。
5. 更新 `package.json` 版本与 `CHANGELOG.md`，打带注释的 tag（`git tag -a vX.Y.Z -m "Roundtable vX.Y.Z"`），再创建对应 GitHub Release。
6. 同步 README 中所有与版本、安装、更新和升级须知相关的文案。
