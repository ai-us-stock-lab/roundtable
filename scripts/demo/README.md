# Roundtable 演示视频生成器

这套脚本把 `docs/demo-storyboard.md` 里的五句旁白原样抽取出来，按四个主镜头录制真实 Roundtable UI，并生成：

- `docs/demo.mp4`：60–90 秒、1920×1080、H.264 + AAC、中文配音与烧录字幕；
- `docs/demo.gif`：约 14 秒、无声、≤8MB 的 README 精简版。

Roundtable 根 `package.json` 不会增加任何依赖。Playwright、ElevenLabs 官方 SDK、Edge TTS 和静态 ffmpeg/ffprobe 都只安装在本目录。

## 一次性安装

在仓库根目录运行：

```powershell
npm.cmd --prefix scripts/demo install
npm.cmd --prefix scripts/demo run install:browser
```

这两步会下载 npm 包、Chromium 和静态媒体工具。它们只进入 `scripts/demo/node_modules` 或 Playwright 自己的浏览器缓存，不改变 Roundtable 主项目的零依赖配置。

## 一条命令重录

先确认：

1. `http://127.0.0.1:7777` 已运行当前仓库的 Roundtable；
2. `claude` 与 `codex` 已安装并登录；
3. 已购买 ElevenLabs 套餐，并在当前终端设置 `ELEVENLABS_API_KEY` 与 `ELEVENLABS_VOICE_ID`；
4. 录制期间不要在演示仓库或 Roundtable 会话里放敏感信息。

然后在仓库根目录运行：

```powershell
npm.cmd --prefix scripts/demo run demo
```

密钥不要写进脚本、`.env` 或仓库。可在 PowerShell 当前会话中安全输入：

```powershell
$secret = Read-Host "ElevenLabs API key" -AsSecureString
$env:ELEVENLABS_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
$env:ELEVENLABS_VOICE_ID = '<从 Voice Library 复制的 voice ID>'
```

在 ElevenLabs 的 Voice Library 中建议筛选 `Chinese`，用途选 `Narration` 或 `Conversational`，试听普通话样音后用菜单里的 **Copy voice ID**。正式脚本使用 `eleven_multilingual_v2`，逐句传递上下文以保持语气连续，并且任何 ElevenLabs 错误都会直接终止，不会再退回 SAPI。

脚本会先分别对 Claude、Codex 做一次短冒烟调用，避免登录过期后录出半截；模型等待全部依赖 DOM 状态，不用固定秒数猜测。等待空档会在合成时按 `timeline.json` 的保留片段剪掉。

## 常用选项

```powershell
# 默认正式配音；也可显式传 voice ID
npm.cmd --prefix scripts/demo run demo -- --tts elevenlabs --voice "<voice-id>"

# 免费 Edge TTS 仅供显式测试；失败会直接报错
npm.cmd --prefix scripts/demo run demo -- --tts edge

# 强制 Windows SAPI；可指定本机已安装的声音
npm.cmd --prefix scripts/demo run demo -- --tts sapi --voice "Microsoft Huihui Desktop"

# 显示浏览器，便于观察真实录制过程
npm.cmd --prefix scripts/demo run demo -- --headed

# WindowsApps 里的 Codex 不能被 Roundtable 子进程启动时：
# 自动选择用户目录里可执行的 Codex，启动隔离的临时真实服务；仍是真实模型调用
npm.cmd --prefix scripts/demo run demo -- --isolated-server

# 只生成 MP4，不生成 GIF
npm.cmd --prefix scripts/demo run demo -- --no-gif

# 保留中间录屏、音轨、字幕和渲染报告
npm.cmd --prefix scripts/demo run demo -- --keep-work
```

## 固定回复兜底

默认永远走真实 Claude + Codex。只有真实调用过慢、网络不稳定，且目标只是验证录制/剪辑链路时，才使用：

```powershell
npm.cmd --prefix scripts/demo run demo -- --mock
```

`--mock` 会在 `127.0.0.1:7788` 启动临时 Roundtable 服务，沿用项目的 CLI adapter 契约提供固定回复。若端口被占用，可追加 `--url http://127.0.0.1:7798`。动手镜头仍会在真实 git worktree 里修改 README、生成真实 diff，再走同一个审批 API；它不是产品能力证明，公开发布前应优先重录真实版本。

`--isolated-server` 不是 mock。它仍调用真实 Claude/Codex，只是把录制会话放到 `scripts/demo/.work/real-sessions`，并为当前 Node 进程临时设置 `CODEX_CLI_PATH`，绕开不可由子进程启动的 WindowsApps 副本。脚本关闭服务时会恢复原进程值，不写 User/Machine 环境变量，也不重启或修改你正在运行的 7777 服务。

## 脚本实际做了什么

1. 创建一次性小 git 仓库，并在 Windows 映射为中性路径 `R:\roundtable-demo`；
2. 隐藏侧边栏历史标题，只勾 Claude 与 Codex；
3. 按分镜发送问题、等待两份回复、运行两轮互聊；
4. 让 Codex 在隔离 worktree 改 README，等待 diff 卡片后展开；
5. 点击单文件“应用”，检查真实 `git status`、`git diff`，并验证 `HEAD` 没变化；
6. 将真实 git 输出放进录屏内的临时终端卡，再切到“+ 会议”收尾；
7. ElevenLabs Multilingual v2 逐句配音，并传入前后文保持连续性；失败时直接中止，绝不自动退回 SAPI；
8. ffmpeg 剪掉模型等待、对齐五段旁白、烧录字幕并校验时长/分辨率/音轨；
9. 软删除本次工作台，将会话移到 `sessions/.trash`，不会清理你的其他会话。

异常退出时脚本会保留 `scripts/demo/.work`。若 Windows 强制终止导致中性盘符未撤销，可手工运行：

```powershell
subst R: /d
```

## 交付前必须人工确认

- 从头到尾完整观看 `docs/demo.mp4`，确认没有 API key、token、真实敏感路径、无关会话标题；
- 中文人名、CLI 名称与“Roundtable”的读音是否自然；
- ElevenLabs 套餐余额、API key、voice ID 与所选普通话声音是否仍然可用；
- Claude/Codex 登录与订阅额度是否可用；
- diff 卡片和“✓ 已应用”是否看清，等待空档是否已剪掉；
- `docs/demo.gif` 是否 ≤15 秒且 ≤8MB；
- 配音属于 AI 生成语音，公开使用时按发布场景保留适当披露。

脚本不会替你 `git commit`、不会 push。它只写 `docs/demo.mp4`、可选 `docs/demo.gif`、被 git 忽略的中间目录与一条可恢复的演示会话记录。
