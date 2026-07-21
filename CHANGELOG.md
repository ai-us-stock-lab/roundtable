# Changelog / 更新日志

This file is for Roundtable users. For the detailed internal development stream, see [`docs/dev-log.md`](docs/dev-log.md). / 本文件面向 Roundtable 使用者；详细开发流水见 [`docs/dev-log.md`](docs/dev-log.md)。

Before 1.0, `0.x.y` uses `y` for bug-fix-only releases, while `x` releases may include breaking changes. / 1.0 之前，`0.x.y` 中的 `y` 只修 bug，`x` 版本可能包含破坏性变更。

## Unreleased

## v0.3.0 - 2026-07-21

### Added / 新增

- Unified Workbench and Committee: promote a discussion into a meeting, open meeting cards from the timeline, and automatically return verdicts to the source Workbench. / 工作台与委员会统一串联：讨论可升格开会，时间线会议卡可直接打开，裁决会自动回到来源工作台。
- Added a per-file change workflow with isolated proposals, conflict comparison, optional arbiter-assisted merging, deterministic safety gates, and an application audit trail. / 新增逐文件变更流程：隔离提案、冲突对比、可选仲裁融合、确定性安全门与应用审计记录。
- Added in-app Agent configuration and diagnostics, on-demand readiness checks, editable workspace paths, and participant controls. / 新增界面内 Agent 配置与诊断、按需就绪检查、可修改工作区路径和会话成员管理。
- Added template-specific role briefs and an in-form preview so different meeting templates produce meaningfully different debates. / 新增模板专属角色简报与表单预览，让不同会议模板产生实质差异。

### Improved / 改进

- Folder selection now prefers the native system dialog, with a browser fallback, cancellation escape hatch, and clearer recovery for quoted, missing, or file paths. / 目录选择优先使用系统原生对话框，并提供浏览兜底、取消逃生口，以及对带引号、不存在或误选文件路径的明确恢复指引。
- Workbench roles now separate discussion, proposal, arbitration, and delegated decision duties while keeping final file application under user control. / 工作台角色现在区分讨论、提案、仲裁与代决职责，同时文件最终应用权仍归用户。
- Frontend/backend version mismatch detection and no-cache delivery make upgrades and restarts easier to understand. / 新增前后端版本错配提醒与 no-cache 下发，升级后何时需要重启更加清楚。

### Fixed / 修复

- Applying or checking a diff now uses the original patch; redaction remains display-only, preventing placeholders from entering real files. / 应用或检查 diff 改用原始 patch，脱敏版只用于展示，避免占位符写入真实文件。
- Fixed native folder dialogs getting stuck behind the browser by adding foreground ownership and an explicit cancel path. / 修复原生目录对话框藏在浏览器后导致卡死的问题，并补充显式取消路径。

### Upgrade notes / 升级须知

- **Restart required? Yes.** This release changes the backend; stop the running Roundtable process and start it again after updating. / **是否需要重启？需要。** 本版本包含后端变更，更新后请停止现有 Roundtable 进程并重新启动。
- **Configuration changes?** `adapters/agents.json` is now user-owned. A fresh install creates it from `adapters/agents.example.json` on first start; an existing `agents.json` is left in place. / **配置是否要动？** `adapters/agents.json` 现在归用户所有；全新安装首次启动会从 `adapters/agents.example.json` 生成，已有用户的现有文件不受影响。
- **Can old sessions still open? Yes.** Legacy Workbench and Committee archives remain supported and are covered by compatibility tests. / **老会话是否还能打开？能。** 旧工作台与旧会议归档继续兼容，并已有兼容测试覆盖。
