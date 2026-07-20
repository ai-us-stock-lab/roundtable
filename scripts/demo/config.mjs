import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(DEMO_DIR, '..', '..');
export const DOCS_DIR = path.join(ROOT_DIR, 'docs');
export const WORK_DIR = path.join(DEMO_DIR, '.work');
export const STORYBOARD_PATHS = Object.freeze({
  zh: path.join(DOCS_DIR, 'demo-storyboard.md'),
  en: path.join(DOCS_DIR, 'demo-storyboard-en.md'),
});
export const STORYBOARD_PATH = STORYBOARD_PATHS.zh;

export const VIEWPORT = { width: 1920, height: 1080 };
export const DEFAULT_URL = 'http://127.0.0.1:7777';
export const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoxiaoNeural';
export const DEFAULT_EDGE_RATE = '+8%';
export const DEFAULT_ELEVENLABS_MODEL = 'eleven_multilingual_v2';
export const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
export const DEFAULT_ELEVENLABS_VOICE_SETTINGS = Object.freeze({
  stability: 0.42,
  similarityBoost: 0.82,
  style: 0.12,
  useSpeakerBoost: true,
  speed: 0.96,
});

// 四个主镜头 + 镜头 4 尾部的收尾。最短时长合计 62 秒。
const CUE_SPECS_BY_LANG = Object.freeze({
  zh: [
    { id: 'shot-1', title: '开工作台', minDuration: 10 },
    { id: 'shot-2', title: '多模型与互聊', minDuration: 15 },
    { id: 'shot-3', title: '动手改文件', minDuration: 18 },
    { id: 'shot-4', title: '审批与落地证据', minDuration: 13 },
    { id: 'outro', title: '正式会议收尾', minDuration: 6 },
  ],
  en: [
    { id: 'shot-1', title: 'Open a workbench', minDuration: 10 },
    { id: 'shot-2', title: 'Multi-model chat and relay', minDuration: 15 },
    { id: 'shot-3', title: 'Change a file in isolation', minDuration: 18 },
    { id: 'shot-4', title: 'Review and apply the diff', minDuration: 13 },
    { id: 'outro', title: 'Escalate to a committee', minDuration: 6 },
  ],
});
export const CUE_SPECS = CUE_SPECS_BY_LANG.zh;

export const CHAT_PROMPT = '这个项目该先加测试还是先写文档？各说一句，控制在 40 字以内。';
export const BUILD_PROMPT = '在 README 末尾新增一行：Roundtable 让多个 AI CLI 在本机协作，并由用户审批每一次文件改动。';
export const EXPECTED_README_LINE = 'Roundtable 让多个 AI CLI 在本机协作，并由用户审批每一次文件改动。';
export const EN_CHAT_PROMPT = 'Should this project add tests or write docs first? One line each, under 20 words.';
export const EN_BUILD_PROMPT = 'Append one line to the README: Roundtable lets multiple AI CLIs collaborate locally, with every file change approved by the user.';
export const EN_EXPECTED_README_LINE = 'Roundtable lets multiple AI CLIs collaborate locally, with every file change approved by the user.';

export function normalizeLang(lang = 'zh') {
  const normalized = String(lang).trim().toLowerCase();
  if (!['zh', 'en'].includes(normalized)) throw new Error('--lang 只能是 zh 或 en');
  return normalized;
}

export function cueSpecsFor(lang = 'zh') {
  return CUE_SPECS_BY_LANG[normalizeLang(lang)];
}

export function demoCopyFor(lang = 'zh') {
  return normalizeLang(lang) === 'en' ? {
    locale: 'en-US',
    workbenchName: 'README Demo Workbench',
    chatPrompt: EN_CHAT_PROMPT,
    buildPrompt: EN_BUILD_PROMPT,
    expectedReadmeLine: EN_EXPECTED_README_LINE,
    applyLabel: 'Apply',
    terminalHeading: 'Roundtable Demo · Real git output (path hidden)',
  } : {
    locale: 'zh-CN',
    workbenchName: 'README 演示工作台',
    chatPrompt: CHAT_PROMPT,
    buildPrompt: BUILD_PROMPT,
    expectedReadmeLine: EXPECTED_README_LINE,
    applyLabel: '应用',
    terminalHeading: 'Roundtable Demo · 真实 git 输出（路径已省略）',
  };
}

export function outputPathsFor(lang = 'zh') {
  const suffix = normalizeLang(lang) === 'en' ? '-en' : '';
  return {
    video: path.join(DOCS_DIR, `demo${suffix}.mp4`),
    gif: path.join(DOCS_DIR, `demo${suffix}.gif`),
  };
}

export function elevenLabsVoiceIdFor(options = {}, env = process.env) {
  const lang = normalizeLang(options.lang);
  return options.voice?.trim()
    || env[`ELEVENLABS_VOICE_ID_${lang.toUpperCase()}`]?.trim()
    || env.ELEVENLABS_VOICE_ID?.trim()
    || '';
}

export async function loadNarrations(lang = 'zh') {
  const normalized = normalizeLang(lang);
  const cueSpecs = cueSpecsFor(normalized);
  const source = await readFile(STORYBOARD_PATHS[normalized], 'utf8');
  const pattern = normalized === 'en'
    ? /Narration:\s*[“"]([^”"]+)[”"]/g
    : /旁白：「([^」]+)」/g;
  const lines = [...source.matchAll(pattern)].map(match => match[1].trim());
  if (lines.length !== cueSpecs.length) {
    throw new Error(`${normalized} 分镜应包含 ${cueSpecs.length} 句旁白，实际解析到 ${lines.length} 句`);
  }
  return cueSpecs.map((cue, index) => ({ ...cue, text: lines[index] }));
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {
    url: DEFAULT_URL,
    lang: 'zh',
    mock: false,
    isolatedServer: false,
    tts: 'elevenlabs',
    voice: '',
    ttsModel: DEFAULT_ELEVENLABS_MODEL,
    rate: DEFAULT_EDGE_RATE,
    gif: true,
    headed: false,
    engineSmoke: true,
    keepWork: false,
  };
  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mock') options.mock = true;
    else if (arg === '--isolated-server') options.isolatedServer = true;
    else if (arg === '--no-gif') options.gif = false;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--skip-engine-smoke') options.engineSmoke = false;
    else if (arg === '--keep-work') options.keepWork = true;
    else if (arg === '--url') options.url = takeValue(arg, index++);
    else if (arg === '--lang') options.lang = takeValue(arg, index++);
    else if (arg === '--tts') options.tts = takeValue(arg, index++);
    else if (arg === '--voice') options.voice = takeValue(arg, index++);
    else if (arg === '--tts-model') options.ttsModel = takeValue(arg, index++);
    else if (arg === '--rate') options.rate = takeValue(arg, index++);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!['elevenlabs', 'edge', 'sapi'].includes(options.tts)) {
    throw new Error('--tts 只能是 elevenlabs、edge 或 sapi');
  }
  options.lang = normalizeLang(options.lang);
  if (options.mock && options.isolatedServer) throw new Error('--mock 与 --isolated-server 不能同时使用');
  if (options.mock && options.url === DEFAULT_URL) options.url = 'http://127.0.0.1:7788';
  if (options.isolatedServer && options.url === DEFAULT_URL) options.url = 'http://127.0.0.1:7798';
  return options;
}

export const HELP_TEXT = `
Roundtable demo recorder

  npm run demo -- [options]

Options:
  --mock                 使用固定回复演示兜底；默认仍走真实 Claude + Codex
  --isolated-server      用真实引擎启动临时服务；适合 WindowsApps Codex 无法被子进程启动时
  --url <url>            Roundtable 地址（默认 http://127.0.0.1:7777）
  --lang zh|en           录制语言（默认 zh；en 输出 docs/demo-en.*）
  --tts <provider>       elevenlabs（默认）、edge 或 sapi；不会自动降级
  --voice <id|name>      ElevenLabs voice ID，或 Edge/SAPI 声音名
  --tts-model <id>       ElevenLabs 模型（默认 eleven_multilingual_v2）
  --rate <+8%>           Edge TTS 语速
  --headed               显示 Playwright 浏览器，便于人工观察
  --skip-engine-smoke    跳过真实 CLI 登录冒烟检查（不推荐）
  --no-gif               只生成对应语言的 MP4
  --keep-work            保留 scripts/demo/.work 供排错
`;
