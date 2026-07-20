# 开发日志(dev-log)

> 用途:会话可能随时中断,新会话靠本文件 + `git log` 接手。每完成一个任务追加一行:内容 / commit / 遗留。
> 阅读顺序:先看本文件末尾的最新总结,再按需回溯 git log 与 docs/design-*.md。

## 2026-07-21(总管自治批次一:方案A检查点 + M1/M2)

- **方案 A 第一期(统一容器检查点)** / `dd6c03f` / 单一「+ 开始」入口、侧栏母子分组、裁决卡自动落回来源时间线、开会留痕、「就此开会/场边追问」命名;遗留:可点击会议卡、孤儿包台、存储归巢(见 docs/design-unified-container.md 第二期)。
- **A2 redact-patch 隐患修复** / `e748691` / 应用 diff 改用原始 `.patch.raw`,脱敏版仅展示;旧记录回退兼容;回归测试覆盖敏感形态内容逐字节落地。
- **A1 changes 层接线** / `6f767a7` / 动手登记 Revision(CAS 快照),applyBuild 过确定性硬门(基线漂移/快照篡改),应用落 applications.jsonl 审计;旧记录走旧行为。
- **B2 demo 管线适配新 UI(Codex 执行,零返工)** / `fffc71f` / record/config/storyboard 选择器与分镜全面适配;未录制:preflight 报 ELEVENLABS_API_KEY 未设置(证据存档)。
- **B1 模板格式预览(Codex 执行,零返工)** / `24e732a` / 选模板预览辩手/裁决格式,/api/config 补两字段(不含 injections),general 显默认提示;验收实测语言切换经整页重载不复现"预览不刷新",仍按指示在 setLang 补防御性 renderTemplatePreview 调用。
- 遗留清理:scratchpad/wt-b1 目录句柄被外部进程占用删不掉(worktree 注册已清,不影响仓库),待句柄释放后手工删。

## 2026-07-21(总管自治批次二:Codex-first,P2→P5)

(进行中,逐任务追加)
- **P2 分歧处置流(后端 P2a + 前端 P2b,均 Codex 执行,零返工)** / 见上两条 commit / 冲突清单+对比卡+仲裁两档全链路 E2E 验证(digest 前缀、两档产卡、decisions.jsonl 留痕、决断未授权时按钮禁用);161/161 全绿。设计决策:对比卡由仲裁单次生成(省调用+职责对齐);融合=特殊指派复用 build 通道(审批权天然归用户);竞争提案靠 A1 漂移硬门自然失效。
- **P3 统一容器第二期(P3a 服务端 + P3b 前端,均 Codex 执行,零返工)** / 见上两条 commit / 孤儿建会自动包台、时间线会议卡(started/verdict)可点击直达会场、手动回流按钮退场;E2E:独立建会→侧栏包裹台+嵌套会议→双卡→打开会场,163/163 全绿。决策:存储不归巢(平铺+origin 引用,零迁移);draft 预填链路保留(外部技能依赖)。
