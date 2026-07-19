import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_URL, ROOT_DIR, parseCliArgs, HELP_TEXT } from './config.mjs';
import { fetchJson, redactLocalPaths, run } from './lib.mjs';

async function checkDependency(name, hint) {
  try {
    return await import(name);
  } catch (error) {
    throw new Error(`缺少 ${name}。${hint}\n${error.message}`);
  }
}

async function verifyEngineLogin(agentId) {
  const result = await run(process.execPath, ['scripts/smoke.js', agentId], {
    cwd: ROOT_DIR,
    timeoutMs: 660_000,
  });
  if (result.code !== 0) {
    const detail = redactLocalPaths(result.stderr || result.stdout).trim().slice(-1000);
    throw new Error(`${agentId} 冒烟调用失败；请先在终端完成登录。${detail ? `\n${detail}` : ''}`);
  }
}

export async function preflight(options = {}) {
  const url = options.url ?? DEFAULT_URL;
  const mock = !!options.mock;
  const engineSmoke = options.engineSmoke !== false;
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 20) throw new Error(`Node.js 需要 >=20，当前是 ${process.version}`);

  await checkDependency('ffmpeg-static', '先在 scripts/demo 运行 npm install');
  await checkDependency('@ffprobe-installer/ffprobe', '先在 scripts/demo 运行 npm install');
  if ((options.tts ?? 'elevenlabs') === 'elevenlabs') {
    await checkDependency('@elevenlabs/elevenlabs-js', '先在 scripts/demo 运行 npm install');
    if (!process.env.ELEVENLABS_API_KEY?.trim()) {
      throw new Error('缺少 ELEVENLABS_API_KEY；请在当前终端设置，不要把密钥写入仓库');
    }
    if (!options.voice?.trim() && !process.env.ELEVENLABS_VOICE_ID?.trim()) {
      throw new Error('缺少 ElevenLabs voice ID；请设置 ELEVENLABS_VOICE_ID 或传入 --voice <voice-id>');
    }
  }
  if (options.tts === 'edge') {
    await checkDependency('@travisvn/edge-tts', '先在 scripts/demo 运行 npm install');
  }
  const { chromium } = await checkDependency('playwright', '先在 scripts/demo 运行 npm install');
  try {
    await access(chromium.executablePath());
  } catch {
    throw new Error('Playwright Chromium 尚未安装。请在 scripts/demo 运行 npm run install:browser');
  }

  const rootPackage = JSON.parse(await readFile(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  if (rootPackage.dependencies || rootPackage.devDependencies) {
    throw new Error('项目根 package.json 出现依赖；录制器要求 Roundtable 主项目继续保持零依赖');
  }

  let config = null;
  if (!mock || options.mockServerStarted) {
    config = await fetchJson(`${url}/api/config`);
    for (const id of ['claude', 'codex']) {
      const agent = config.agents?.[id];
      if (!agent) throw new Error(`服务未配置 ${id}`);
      if (agent.unavailable) throw new Error(`${id} 不可用: ${redactLocalPaths(agent.unavailable)}`);
    }
  }

  if (!mock && engineSmoke) {
    console.log('[preflight] 验证 Claude 登录状态…');
    await verifyEngineLogin('claude');
    console.log('[preflight] 验证 Codex 登录状态…');
    await verifyEngineLogin('codex');
  }

  console.log(`[preflight] 通过：Node ${process.version}、隔离依赖、Chromium${mock ? '、mock 引擎' : '、Claude/Codex'}`);
  return { config };
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = parseCliArgs();
    if (options.help) console.log(HELP_TEXT);
    else await preflight(options);
  } catch (error) {
    console.error('[preflight] ' + error.message);
    process.exitCode = 1;
  }
}
