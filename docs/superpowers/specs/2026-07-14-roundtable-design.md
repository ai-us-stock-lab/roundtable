# Roundtable：多智能体辩论协作室 — 设计规格

日期：2026-07-14
状态：待用户审阅
形态：Node.js 本地服务 + SSE + 零构建网页（方案 A，用户已确认）

## 1. 目标与非目标

**目标**：一个独立浏览器窗口里的**多智能体决策委员会**。核心流水线：

```
独立判断（clean room）→ 交叉质询 → 分歧分类 → 证据仲裁 → 最小下一步
```

不是让两个模型聊天——每个环节都有结构化产出，用户作为主持人全程可控，全程可复盘。首个用例是"南添决策双引擎裁决"，但架构是通用的。

**非目标**：
- 不是代码协作工具（模型输出只展示、绝不执行）
- 不做云部署/多用户（仅 127.0.0.1 本地单用户）
- 不做模型 API 直连（只通过各家 CLI，认证复用 CLI 已有登录态）

## 2. 架构总览

```
browser (单页, 零构建)
   │  SSE (事件流) + fetch (指令)
   ▼
Node.js server (127.0.0.1:7777)
   ├─ orchestrator   轮次状态机（clean room → 互评 → 汇总 → 暂停/继续）
   ├─ adapters/      插拔式 agent 适配层（每个 agent 一份配置）
   ├─ summarizer     每轮 rolling summary 生成
   ├─ judge          独立仲裁角色（可指派任意 adapter 执行）
   ├─ redactor       日志/会话落盘前的敏感信息擦除
   └─ sessions/      会话持久化（markdown + json），git 管理
```

## 3. Adapter 插拔式架构（用户要求 #1）

每个 agent 由一份配置描述，放在 `adapters/agents.json`。**代码不写死任何模型名**，Claude/Codex 只是两份默认配置；未来加 Gemini、OpenClaw、Hermes、本地模型只需新增配置项。

```json
{
  "claude": {
    "name": "Claude",
    "command": ["claude", "-p", "--output-format", "stream-json", "--verbose"],
    "input": "stdin",
    "output": "stream-json",
    "timeoutMs": 300000,
    "envWhitelist": ["PATH", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "COMSPEC", "LANG"],
    "cwd": "~/Documents/Roundtable/workdir",
    "extraArgs": ["--disallowedTools", "*"],
    "roles": ["debater", "judge", "summarizer"]
  },
  "codex": {
    "name": "Codex",
    "command": ["codex", "exec", "--sandbox", "read-only"],
    "input": "stdin",
    "output": "text",
    "timeoutMs": 300000,
    "envWhitelist": ["PATH", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "COMSPEC", "LANG"],
    "cwd": "~/Documents/Roundtable/workdir",
    "roles": ["debater", "judge", "summarizer"]
  }
}
```

配置字段语义：
- `command`：argv 数组（不经 shell 解析，杜绝注入）
- `input`：`stdin` | `file`（file 模式写临时文件、以路径传参，供不吃 stdin 的 CLI 用）
- `output`：`text` | `json` | `stream-json`（决定解析器；stream-json 可逐 token 推给前端）
- `timeoutMs`：单次调用超时
- `envWhitelist`：子进程环境变量白名单，**默认不传任何未列出的变量**（见 §8 安全）
- `cwd`：子进程工作目录，指向一个专用空目录，与用户真实项目隔离
- `roles`：该 adapter 可担任的角色

实现时首先验证两个 CLI 的确切旗标（`--disallowedTools` 的准确语法、codex 是否支持 `--ephemeral`），以实测为准修正默认配置；旗标不存在时按该 CLI 等效的最小权限方式配置，并在 README 记录。

## 4. 角色模型（用户要求 #2）

三个角色，均可指派给任意具备该 role 的 adapter，**在会话创建时选择**：

- **debater ×2+**：辩手。收到简报，按模板输出立场。
- **judge ×1**：独立仲裁者。**不默认是 Claude**，可以是 Codex、未来的 OpenClaw/Hermes，也可以与某辩手同引擎——但 judge 调用是一次全新的洁净调用，prompt 中只有仲裁指令，不含该引擎作为辩手时的立场。judge 的任务定义（写死在 judge prompt 里）：
  1. 比较双方**证据强弱**（事实引用的数量与质量）
  2. 比较**假设多少**（谁的结论依赖更多未证实前提）
  3. 比较**证伪点质量**（谁给出了更可检验、反馈成本更低的 kill condition）
  4. 评估**下一步反馈成本**（验证各方主张分别需要多少时间/金钱）
  5. **按分歧分类表逐条处置**：事实分歧给出裁决与依据；假设分歧标注验证方式；框架分歧比较证伪点质量；风险偏好分歧**不判对错**、明确交还用户选择；行动分歧倾向反馈成本最低者
  6. 裁决卡必须以**最小可验证下一步**收尾（下一个要查证的事实、kill condition、最小行动）
  7. 明确禁止：输出自己对议题的独立观点、替任何一方补充论据
- **summarizer ×1**：每轮生成 rolling summary（可与 judge 同一 adapter，同样是独立洁净调用）。

## 5. 辩论流程状态机（用户要求 #3、#5）

```
创建会话（议题 + 模板 + 角色指派 + 模式）
  → 第 1 轮：CLEAN ROOM —— 各辩手只收到（议题 + 模板注入内容 + 用户补充材料），
              互相绝对不可见；orchestrator 在代码层保证第 1 轮简报不含对方任何输出
  → summarizer 生成 rolling summary v1
  → [暂停点] 用户插话 / 点“下一轮” / 切自动
  → 第 2 轮起：各辩手收到（rolling summary + 对方最新一轮原文 + 用户插话），
              输出：同意点 / 被说服的修正 / 坚持的分歧及理由 / 新证据
  → summarizer 更新 rolling summary
  → [暂停点] ……循环……
  → 终局：judge 收到（rolling summary + 双方最终陈述）→ 输出裁决卡
  → 会话落盘
```

**人工主持（#5）**：默认逐轮暂停。暂停点上用户可以：插话（进入下一轮双方简报的"主持人补充"栏）、追加材料、修改下一轮的问题清单、点"下一轮"、点"直接进入裁决"、或切换"自动跑完"。自动模式必须设**最大轮数**（默认 4，可配 1–10），到达即强制进入裁决；自动模式中途可随时暂停。

**收敛判定**（自动模式提前终局条件）：summarizer 报告"当前分歧"连续两轮无变化。

## 6. Rolling Summary = 分歧分类器（用户要求 #4、#9）

每轮结束由 summarizer 生成结构化摘要，**下一轮只传 rolling summary + 最新一轮原文**，完整历史绝不整体进上下文。

摘要不是普通总结，核心是**分歧分类表**——每条分歧必须归入五类之一，且各类的处置方式不同：

| 分歧类型 | 定义 | 处置 |
|---|---|---|
| **事实分歧** | 对已发生事实的陈述不一致 | 标注"需要查证"+ 查证途径（数据源/逐字稿时间戳），judge 仲裁时优先解决 |
| **假设分歧** | 依赖的未证实前提不同 | 标注双方各自的假设，进入"未证实假设"栏跟踪 |
| **框架分歧** | 同一事实、不同框架判断（如 N0/N1/N2 分类不同） | 呈现双方框架依据，judge 比较证伪点质量 |
| **风险偏好分歧** | 不是谁对谁错，是承受度不同 | **不仲裁对错**，明确标注"由用户按自身偏好选择" |
| **行动分歧** | 下一步做什么不同 | 比较各行动的反馈成本，倾向最小可验证步 |

摘要固定结构：

```markdown
## Rolling Summary（第 N 轮后）
- 当前共识：
- 分歧分类表：（类型 | 分歧内容 | A 方立场 | B 方立场 | 处置）
- 已证实事实：（含出处）
- 未证实假设：（谁的假设、如何验证）
- 证伪点：
- 下一轮待问问题：（含交叉质询问题——各方必须回答对方的质询）
```

第 2 轮起辩手简报中包含对方向己方提出的质询问题，辩手输出必须**先答质询、再陈述**（交叉质询环节的落实）。所有轮次的 summary 与原文都持久化（供复盘），只是不进上下文。

## 7. 错误处理（用户要求 #6）

每个辩手调用独立隔离，单点失败不毁全场：

| 场景 | 检测 | UI 行为 |
|---|---|---|
| CLI 超时 | timeoutMs 到期 kill 进程 | 该栏位标红"超时"，提供【单边重试】 |
| 登录失效 | exit code + stderr 模式匹配（如 auth/login/401 字样） | 明确提示"请在终端重新登录 <cli> 后重试"，提供【单边重试】 |
| 进程崩溃 | 非零退出 | 显示捕获的 stderr 尾部，提供【单边重试】 |
| 输出解析失败 | JSON 解析异常 | 降级为原文本展示并警告 |

全局控制（任意时刻可用）：**停止当前轮**（kill 所有进行中的子进程）、**单边重试**、**跳过某一方**（本轮按缺席处理，summary 记录"X 方本轮缺席"）、**继续下一轮**、**保存半成品**（当前状态完整落盘，会话可日后从落盘状态恢复继续）。

## 8. 安全（用户要求 #7）

1. **子进程 env 白名单**：只传 `envWhitelist` 列出的变量；`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等一律不传（CLI 用自己的登录态文件认证，不需要环境变量）。
2. **Redaction**：prompt、输出、会话文件落盘前经 redactor 过滤——正则匹配常见凭据形态（`sk-`/`ghp_`/`xoxb-` 前缀、`Bearer …`、`api[_-]?key\s*[:=]`、JWT 形态、cookie 串等）替换为 `[REDACTED]`。
3. **Codex 默认**：`codex exec --sandbox read-only`，若实测支持 `--ephemeral` 则加上。
4. **Claude 默认**：`claude -p` 并以实测确认的语法禁用全部工具（目标：纯文本问答，无文件/网络/命令能力）。
5. **输出即文本**：所有模型输出仅作为 HTML 转义后的文本渲染（防 XSS），永不执行、永不写入模板或配置。
6. **网络边界**：服务只绑定 127.0.0.1；无任何外呼（模型调用全部走本地 CLI 子进程）。

## 9. 模板系统（用户要求 #8）

模板 = `templates/<name>/` 目录，含 `template.json`（各角色 prompt 骨架、注入文件列表、输出格式要求）。用户可自建模板。内置两个：

**a. 通用辩论**：无注入，辩手输出自由结构（但必须含"证据/假设/证伪点"三节），judge 按 §4 标准仲裁。

**b. 南添决策辩论（结构化）**：
- 注入（保持洁净房间，各用各的蒸馏版）：
  - Claude 辩手 ← `~/.claude/skills/nantian-decision/SKILL.md`（+ 按议题可选注入 reference.md / podcast-notes.md 相关节选）
  - Codex 辩手 ← `~/.codex/skills/nantian-decision-framework/SKILL.md` + 其 `references/framework.md`
- 辩手输出强制五步结构：①增量事实（区分事实/假设/推断）②N0/N1/N2 分类及依据 ③商业验证要点 ④渗透率/阶段定位 ⑤2% 仓位算法（认知止损点 + 以损定量）+ kill condition + 最小验证下一步
- judge 输出 = **裁决卡**：一致结论（置信度↑）/ 被说服的修正 / 遗留分歧（各自理由）/ 事实性分歧的裁决（可回源 `E112-transcript.txt` 按时间戳查证原文）/ 综合证伪条件 / 建议行动与下注规模
- 裁决卡额外落盘一份到 `~/.claude/skills/nantian-decision/decisions/`（决策日志，与技能联动）

## 10. 前端（单页，零构建）

- 三栏：左右为辩手栏（流式渲染、轮次分节、状态徽标），中间主持席（议题、插话框、轮次控制按钮、模式开关、最大轮数、裁决卡展示）
- 顶栏：模板选择、角色指派（每个角色一个下拉，选项来自 agents.json 里具备该 role 的 adapter）、会话列表
- 会话页支持导出 markdown / 复制裁决卡
- 深浅色跟随系统

## 11. 持久化：每场 session 可复盘（用户要求 #10）

每场会话一个目录 `sessions/<日期>-<slug>/`，内容齐备到**任何人事后能完整还原这场决策是怎么做出来的**：

```
sessions/2026-07-15-nvda-add-position/
├── problem.md            议题原文 + 用户补充材料 + 模板与角色指派
├── prompts/              每次调用发给每个 agent 的完整简报（redaction 后）
│   ├── r1-claude.md  r1-codex.md  r2-claude.md  …  judge.md
├── raw/                  每次调用的原始输出（redaction 后）
│   ├── r1-claude.md  r1-codex.md  …  judge.md
├── summaries/            每轮 rolling summary
│   ├── r1.md  r2.md  …
├── disagreements.md      最终分歧分类表（全场累计，含每条的处置结果）
├── judge-card.md         最终裁决卡
└── metadata.json         时间戳、adapter 配置快照、轮数、模式、错误记录、
                          每次调用的耗时与退出码、会话状态（完成/半成品）
```

- `metadata.json` 里包含 adapter 配置快照——半年后复盘时能知道当时用的是什么模型、什么参数。
- 人读汇总版 `session.md`（全场时间线拼接）自动生成，方便直接阅读或分享。
- 会话目录用 git 管理，历史即审计轨迹。
- "保存半成品"（§7）即把当前已有内容按此结构落盘，`metadata.json` 标记 `status: partial`，可恢复继续。

## 12. 测试

- adapter 层：mock CLI（一个 echo 脚本）测 stdin/file 两种 input、text/json/stream-json 三种 output、超时 kill、非零退出、env 白名单（子进程内 dump env 验证）
- orchestrator：状态机单测（clean room 第 1 轮简报中不含对方输出——用断言硬性验证；暂停/自动/最大轮数/收敛提前终局）
- redactor：凭据样本集过滤单测
- 端到端：用 mock adapter 全流程跑一场 2 轮辩论 + 裁决，校验落盘文件结构
- 真实冒烟：claude + codex 各跑一次单轮问答（实现末期，需 codex CLI 已登录）

## 13. 里程碑

1. **M1 骨架**：server + adapter 层 + mock adapter 全流程可跑（无真实 CLI 也能演示）
2. **M2 真实接入**：claude adapter 实测打通（含旗标验证）；codex adapter 写好待用户装 CLI 后实测
3. **M3 完整体验**：前端三栏 + 流式 + 主持控制 + 错误处理全套
4. **M4 模板与联动**：南添模板 + 裁决卡落盘决策日志 + redactor
