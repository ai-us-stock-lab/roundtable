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
    if (options.mock) mockServer = await startMockServer(options.url);
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
    workspace = await createDemoWorkspace();
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
    await workspace?.cleanup();
    mockServer?.close();
    realServer?.close();
    if (succeeded && !options.keepWork) await removeWorkDir();
    else if (!succeeded) console.error('[demo] 已保留 scripts/demo/.work，便于定位失败步骤。');
  }
}

main().catch(error => {
  console.error('[demo] ' + error.message);
  process.exitCode = 1;
});
