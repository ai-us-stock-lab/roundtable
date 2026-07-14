# Roundtable 多智能体决策委员会

独立判断 → 交叉质询 → 分歧分类 → 证据仲裁 → 最小下一步。

## 启动

npm start 后打开 http://127.0.0.1:7777

## 前提

- Node ≥ 20
- claude CLI 已登录（claude -p "hi" 能出结果）
- codex CLI 已登录（npm i -g @openai/codex；未装时可用 Mock 或单边模式）

## 添加新 agent（Gemini / 本地模型 / 任意 CLI）

编辑 adapters/agents.json 增加条目：command 为 argv 数组，input 选 stdin 或 file
（file 模式用 {PROMPT_FILE} 占位符），output 选 text/json/stream-json，
envWhitelist 只列该 CLI 必需的环境变量。跑 node scripts/smoke.js <id> 验证。

## 模板

templates/<name>/template.json。nantian 模板会把两边各自蒸馏的南添 skill 注入
对应辩手，并把裁决卡额外存一份到 ~/.claude/skills/nantian-decision/decisions/。

## 安全

子进程只拿到白名单环境变量；所有落盘经凭据擦除；模型输出只作为文本展示，
永不执行；服务只监听 127.0.0.1。

代理 URL 若内嵌凭据会随白名单传递给子进程，属已知权衡。

## 已知事项

- Windows 下：resolveCliPath 自动解析 CLI 到 .cmd 路径，spawn 在 win32 下自动经 cmd /c 包装执行，
  无需在 agents.json 中手工修改 command。
- 半成品会话完整落盘（status: partial）且可人工查阅 session.md，但服务重启后暂不支持从落盘状态
  恢复继续辩论——属已知未实现项，列为后续增强。
