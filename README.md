# Roundtable 多引擎圆桌

**让你手里的多个 AI CLI 坐到一张桌子上——日常在工作台随手群聊，重决策升格为有规矩的委员会辩论。**

两种房间，一套底盘：

- **工作台**（高频日常）：勾选模型直接群聊，随时追问、点名任意模型接力，还能让模型之间就你的话题**互聊 N 轮**（互相反驳、追问，聊无可聊自动收敛）
- **会议**（低频重决策）：完整委员会流程，见下

Claude Code 说 A，Codex 说 B——听谁的？会议模式不让它们各说各话，而是走完整的委员会流程：

```
独立判断（clean room）→ 交叉质询 → 分歧分类 → 证据仲裁 → 最小下一步
```

- **独立判断**：第一轮双方隔离作答，互相看不见，避免先发言者带偏后发言者
- **交叉质询**：之后每轮，双方针对对方上一轮发言找漏洞、要证据
- **分歧分类**：书记角色每轮把分歧归入五类（事实 / 假设 / 框架 / 风险偏好 / 行动），各有对应处置方式
- **证据仲裁**：独立的仲裁角色（可以是第三个引擎）比较证据强弱与证伪点质量，出结构化裁决卡
- **人在环中**：你是主持人——每轮可暂停、插话、重试、跳过，也可以拉群聊直接跟参会 AI 讨论

零依赖：Node 原生模块 + 原生前端，连 `npm install` 都不用跑。

## 快速开始

**前提**：
- Node.js ≥ 20
- 至少装好并登录 **两个** AI CLI（默认支持 [Claude Code](https://claude.com/claude-code) 与 [Codex](https://github.com/openai/codex)；接任意 CLI 见下文）

```sh
git clone https://github.com/ai-us-stock-lab/roundtable
cd roundtable
npm start        # 打开 http://127.0.0.1:7777
```

填议题 → 选辩手/仲裁/书记 → 开始第 1 轮。没装的引擎会自动标灰，不影响其余引擎使用。

Windows 用户可双击 `open-roundtable.cmd`（自动探活+起服务+开浏览器）；把 `open-roundtable.vbs` 的快捷方式放进启动文件夹即可开机常驻。

## 接入任意 CLI（适配器）

引擎在 `adapters/agents.json` 里声明，不写死任何厂商。一个条目：

```jsonc
{
  "myai": {
    "name": "MyAI",
    "command": ["myai", "chat", "-q", "{PROMPT}"],  // argv 数组，永不拼 shell 字符串
    "input": "arg",            // stdin | file | arg（file 模式用 {PROMPT_FILE} 占位）
    "output": "text",          // text | json | stream-json
    "timeoutMs": 300000,
    "envWhitelist": ["PATH", "USERPROFILE", "SYSTEMROOT"],  // 子进程只见白名单变量
    "cwd": "workdir",
    "roles": ["debater", "judge", "summarizer"]
  }
}
```

实用细节：
- **路径可移植**：`command[0]` 与参数支持 `~/` 前缀（展开为用户主目录）；也可用 `commandEnvVar` 指定环境变量、`commandFallbackGlob` 按版本目录通配取 mtime 最新
- **`{NONCE}`**：每次调用展开为唯一串，给要求"每次全新会话"的有状态 CLI 当 session key
- **`dropLines`**：按正则丢弃输出中的噪音行（如 session id）
- **`workspaceArgs`**：会话挂载了项目目录时改用的参数（如给 Claude 只开 Read/Grep/Glob 只读三件套）
- 验证：`node scripts/smoke.js <id>`
- **Windows 注意**：CLI 解析到 `.cmd/.bat` 时自动包一层 `cmd /c`，无需手工改配置（仅对 stdin/file 输入安全）；**arg 输入**的 prompt 含换行时会拒绝走 `.cmd` 包装（cmd.exe 会截断参数且构成注入面）——这类 CLI 请把 `command[0]` 配为真实 `.exe` 或 node 脚本路径

## 功能

**工作台（多模型群聊）**：
- 不勾收件人 = 自动回复上一个发言的模型（追问零操作）；勾选 = 点名/广播（串行回复控成本）
- **互聊**：「让他们讨论 × N 轮」——模型按顺序接力发言，每位都看到完整讨论（含其他模型的标注发言），被鼓励点名反驳与追问；随时可停，模型回复【无新增】自动收敛终止
- 长历史自动裁剪（整条消息取舍，绝不切半），裁剪时界面明示"该模型仅看到最近 N 条"——禁止静默截断
- **升格为会议**：一键把讨论打包成会议草稿，转入正式委员会流程
- 全程落盘（每条消息、每次调用的完整 prompt 与原始输出），跨重启恢复

**会议（委员会辩论）**：
- **三栏会场**：双辩手流式输出、轮次卡片折叠、`##` 小节折叠、轮次跳转、运行计时
- **书记摘要**：每轮滚动摘要 + 五类分歧分类表
- **裁决卡**：结构化裁决（采纳方案/关键理由/被证伪的论点/风险与对冲/最小下一步），一键复制
- **群聊抽屉**：会议轮次之外，随时基于会议上下文与任意参会 AI 自由讨论（各自立场延续）
- **工作区只读挂载**：建会话时填项目目录，参会 AI 可自行查阅真实代码、发言带文件行号引用——治"纸上谈兵"
- **会话管理**：历史列表、重命名、断线重连回放、跨重启恢复、归档只读、软删除（回收站 `sessions/.trash/`）
- **模板**：通用辩论 / 协作开发（独立设计-交叉评审-融合）/ 项目会诊；`templates/<name>/template.json` 可自定义
- **一句话发起**（可选）：把 `skills/roundtable-meeting/` 装进 Claude Code / Codex 的技能目录（`~/.claude/skills/`、`~/.codex/skills/`），在任何项目对话里说"开个多 agent 会议"，AI 自动写会诊简报、`POST /api/draft` 预填表单并弹出浏览器；会后说"导入会议结论"读回裁决卡

## 安全模型

- 服务只监听 `127.0.0.1`，无远程访问面
- 子进程环境变量白名单制——API key 等敏感变量默认全部隔离（注意：代理 URL 若内嵌凭据会随白名单传递，属已知权衡）
- 所有落盘内容过凭据擦除（redaction）
- 参会 CLI 尽量以只读/禁工具模式运行（Codex `--sandbox read-only --ephemeral`、Claude `--disallowedTools`）
- 模型输出只作为文本展示，永不执行
- prompt 永远走 argv 数组 / stdin / 临时文件，不拼 shell 字符串

## 会话产物（可复盘）

每场会议落盘 `sessions/<日期-议题>/`：`problem.md`、各轮 prompt 与原始输出、`summaries/`（滚动摘要+分歧表）、`judge-card.md`、`session.md`（全程回放）、`chat.jsonl`（群聊）、`outcome.md`（会后采纳追踪，手填）。删除为软删除（移入 `sessions/.trash/`，可手工找回）。

---

# Roundtable — One Table for All Your AI CLIs

**Group-chat your AI CLIs day to day; escalate to a structured debate committee when the decision matters.**

Two rooms on one chassis:

- **Workbench** (everyday): pick models and just chat. Unaddressed messages route to whoever spoke last; address one model or broadcast to all. Hit "let them talk" and the models take turns responding to each other for N rounds — encouraged to push back and question each other by name, auto-stopping when the discussion converges. Long histories are trimmed whole-message with a visible "this model only sees the last N messages" chip — never silently. One click promotes the chat into a formal committee meeting.
- **Committee** (when it counts): when Claude Code says A and Codex says B, Roundtable runs a structured committee instead of letting you coin-flip:

```
independent takes (clean room) → cross-examination → disagreement classification → evidence-based judging → minimal next step
```

Round 1 is isolated so neither side anchors the other; later rounds attack each other's evidence; a scribe classifies every disagreement into 5 types (fact / assumption / framing / risk appetite / action); an independent judge (optionally a third engine) issues a structured verdict card. You are the moderator: pause between rounds, interject, retry, skip, or open a side-chat drawer with any participant.

Zero dependencies — Node built-ins + vanilla frontend. No `npm install` needed.

**Quick start**: Node ≥ 20 plus at least two logged-in AI CLIs (Claude Code and Codex work out of the box; unavailable engines are greyed out automatically).

```sh
git clone https://github.com/ai-us-stock-lab/roundtable
cd roundtable
npm start        # open http://127.0.0.1:7777
```

**Plug in any CLI** via `adapters/agents.json`: declare `command` as an argv array (never a shell string), pick `input` (stdin / file / arg) and `output` (text / json / stream-json), and whitelist env vars per engine. `~/` prefixes expand to the user home; `{NONCE}` expands to a unique string per call for stateful CLIs; `{PROMPT}` / `{PROMPT_FILE}` are the prompt placeholders. Validate an entry with `node scripts/smoke.js <id>`.

**Security**: localhost-only; env-var whitelisting (API keys never reach subprocesses unless whitelisted); credential redaction on all persisted files; participants run in read-only / tool-disabled modes where supported; model output is displayed as text and never executed; on Windows, `.cmd` shims are refused for arg-mode prompts containing newlines (cmd.exe truncation / injection surface).

Every meeting is fully replayable on disk under `sessions/`: problem statement, per-round prompts and raw outputs, rolling summaries with the disagreement table, the verdict card, and a full `session.md` transcript.

Optional: install `skills/roundtable-meeting/` into your Claude Code / Codex skills directory to launch a meeting from any coding conversation with one sentence — the AI writes the briefing, prefills the form via `POST /api/draft`, and opens the browser; afterwards say "import the verdict" to bring the card back into your work.

License: MIT

---

## 路线备忘（维护者）

写模式（AI 改文件的 diff-only 桥接）当前不做。触发重新评估的硬阈值（三条件与门）：
**连续 3-5 场真实会议中 ≥2 场出现「裁决被采纳 且 ≥50% 内容需改文件 且 手工落地 >15 分钟」**——
数据来源为各场 `sessions/<dir>/outcome.md`，满足即重开会议评估写模式。
