import { composeDemo } from './compose.mjs';
import { DEFAULT_URL, HELP_TEXT, parseCliArgs } from './config.mjs';
import { fetchJson, removeWorkDir, resetWorkDir } from './lib.mjs';
import { startMockServer } from './mock-server.mjs';
import { preflight } from './preflight.mjs';
import { startRealDemoServer } from './real-server.mjs';
import { recordDemo } from './record.mjs';
import { synthesizeNarrations } from './tts.mjs';
import { createDemoWorkspace } from './workspace.mjs';

async function main() {
  const options = parseCliArgs();
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  await resetWorkDir();
  let mockServer;
  let realServer;
  let workspace;
  let succeeded = false;
  try {
    if (options.mock) mockServer = await startMockServer(options.url, options.lang);
    if (options.isolatedServer) {
      // 保留原始前提：先确认用户的 7777 服务确实在运行；录制用临时端口，避免重启或污染它。
      await fetchJson(`${DEFAULT_URL}/api/config`);
      realServer = await startRealDemoServer(options.url);
    }
    await preflight({
      ...options,
      mockServerStarted: !!mockServer,
      engineSmoke: options.mock ? false : options.engineSmoke,
    });
    workspace = await createDemoWorkspace(options);
    console.log(`[demo] 演示仓库：${workspace.displayPath}（退出时自动清理）`);
    await recordDemo(options, workspace);
    await synthesizeNarrations(options);
    const report = await composeDemo(options);
    succeeded = true;
    console.log('');
    console.log(`[demo] 完成：${report.outputVideo}`);
    if (report.gif) console.log(`[demo] 完成：${report.gif}`);
    console.log('[demo] 交付前仍须人工完整观看一次，检查配音、节奏和画面中是否含敏感信息。');
  } finally {
    // 各步独立 try/catch：任何一步失败不能吞掉后面的清理（subst 盘符、临时服务端口都要还回去）。
    // 先关服务再删演示仓库：进程内服务/其子进程可能还攥着仓库句柄，反序会 EBUSY。
    try { mockServer?.close(); } catch { /* 已关 */ }
    try { realServer?.close(); } catch { /* 已关 */ }
    try { await workspace?.cleanup(); } catch (error) { console.error('[demo] 工作区清理失败：' + error.message); }
    if (succeeded && !options.keepWork) {
      try { await removeWorkDir(); } catch (error) { console.error('[demo] .work 清理失败：' + error.message); }
    } else if (!succeeded) console.error('[demo] 已保留 scripts/demo/.work，便于定位失败步骤。');
  }
}

// 确定性退出：录制链路牵扯 Playwright、undici 连接池、SSE socket、CLI 子进程 stdio 等外部句柄，
// 任何一个未释放都会让 Node 事件循环悬挂（曾出现生成完毕后进程挂十几分钟直到外层超时）。
// 走到这里时上面的清理都已 await 完成（workspace 的 subst /d 兜底挂在 process 'exit' 钩子上，同步执行，不受影响）。
main().then(
  () => process.exit(process.exitCode ?? 0),
  error => {
    console.error('[demo] ' + error.message);
    process.exit(1);
  },
);
