import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ELEVENLABS_MODEL,
  DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
  DEFAULT_ELEVENLABS_VOICE_SETTINGS,
  DEFAULT_EDGE_RATE,
  DEFAULT_EDGE_VOICE,
  DEMO_DIR,
  WORK_DIR,
  loadNarrations,
  parseCliArgs,
} from './config.mjs';
import { runOrThrow } from './lib.mjs';

async function prepareVoiceDir() {
  const voiceDir = path.join(WORK_DIR, 'voice');
  await rm(voiceDir, { recursive: true, force: true });
  await mkdir(voiceDir, { recursive: true });
  return voiceDir;
}

function requiredElevenLabsConfig(options) {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = options.voice?.trim() || process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!apiKey) {
    throw new Error('缺少 ELEVENLABS_API_KEY；请在当前终端设置环境变量，不要把密钥写进仓库');
  }
  if (!voiceId) {
    throw new Error('缺少 ElevenLabs voice ID；请设置 ELEVENLABS_VOICE_ID 或传入 --voice <voice-id>');
  }
  return { apiKey, voiceId };
}

async function elevenLabsTts(narrations, voiceDir, options) {
  const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
  const { apiKey, voiceId } = requiredElevenLabsConfig(options);
  const model = options.ttsModel || DEFAULT_ELEVENLABS_MODEL;
  const client = new ElevenLabsClient({ apiKey });
  let voiceName = voiceId;
  try {
    const voice = await client.voices.get(voiceId);
    voiceName = voice.name || voiceId;
  } catch (error) {
    throw new Error(`ElevenLabs 声音不可用；请检查付费账户、voice ID 与 API key（${error.message}）`);
  }

  const clips = [];
  for (let index = 0; index < narrations.length; index += 1) {
    const cue = narrations[index];
    const output = path.join(voiceDir, `${cue.id}.mp3`);
    try {
      const audio = await client.textToSpeech.convert(voiceId, {
        text: cue.text,
        modelId: model,
        outputFormat: DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
        voiceSettings: DEFAULT_ELEVENLABS_VOICE_SETTINGS,
        seed: 2_407_2026,
        previousText: index > 0 ? narrations[index - 1].text : undefined,
        nextText: index + 1 < narrations.length ? narrations[index + 1].text : undefined,
      });
      const buffer = Buffer.from(await new Response(audio).arrayBuffer());
      if (buffer.length < 1024) throw new Error('返回的音频为空或不完整');
      await writeFile(output, buffer);
    } catch (error) {
      throw new Error(`ElevenLabs 生成“${cue.title}”失败（${error.message}）`);
    }
    clips.push({ id: cue.id, title: cue.title, text: cue.text, path: output });
    console.log(`[voice] ElevenLabs：${cue.title}`);
  }
  return {
    provider: 'elevenlabs',
    voice: voiceName,
    voiceId,
    model,
    outputFormat: DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
    settings: DEFAULT_ELEVENLABS_VOICE_SETTINGS,
    clips,
  };
}

async function edgeTts(narrations, voiceDir, voice, rate) {
  const clips = [];
  for (const cue of narrations) {
    const textPath = path.join(voiceDir, `${cue.id}.txt`);
    const output = path.join(voiceDir, `${cue.id}.mp3`);
    await writeFile(textPath, cue.text, 'utf8');
    // Edge 服务偶尔会保持 WebSocket 长时间不返回。每句放到独立子进程，60 秒后杀掉，
    // 让 auto 能可靠退回 SAPI，也避免整个录制命令被一个悬挂连接占住。
    await runOrThrow(process.execPath, [
      path.join(DEMO_DIR, 'edge-tts-worker.mjs'), textPath, output, voice, rate,
    ], { timeoutMs: 60_000 });
    clips.push({ id: cue.id, title: cue.title, text: cue.text, path: output });
    console.log(`[voice] Edge TTS：${cue.title}`);
  }
  return { provider: 'edge', voice, rate, clips };
}

async function sapiTts(narrations, voiceDir, requestedVoice) {
  if (process.platform !== 'win32') throw new Error('Windows SAPI 兜底只在 Windows 可用');
  const clips = [];
  let selectedVoice = requestedVoice || '';
  for (const cue of narrations) {
    const textPath = path.join(voiceDir, `${cue.id}.txt`);
    const output = path.join(voiceDir, `${cue.id}.wav`);
    await writeFile(textPath, cue.text, 'utf8');
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(DEMO_DIR, 'sapi-tts.ps1'),
      '-InputPath', textPath,
      '-OutputPath', output,
      '-Rate', '1',
    ];
    if (requestedVoice) args.push('-VoiceName', requestedVoice);
    const result = await runOrThrow('powershell.exe', args, { timeoutMs: 120_000 });
    selectedVoice ||= result.stdout.trim();
    clips.push({ id: cue.id, title: cue.title, text: cue.text, path: output });
    console.log(`[voice] Windows SAPI：${cue.title}`);
  }
  return { provider: 'sapi', voice: selectedVoice, rate: 'SAPI +1', clips };
}

export async function synthesizeNarrations(options = {}) {
  const narrations = await loadNarrations();
  const voiceDir = await prepareVoiceDir();
  const requested = options.tts ?? 'elevenlabs';
  let manifest;

  if (requested === 'elevenlabs') manifest = await elevenLabsTts(narrations, voiceDir, options);
  else if (requested === 'edge') {
    manifest = await edgeTts(
      narrations,
      voiceDir,
      options.voice || DEFAULT_EDGE_VOICE,
      options.rate || DEFAULT_EDGE_RATE,
    );
  } else if (requested === 'sapi') manifest = await sapiTts(narrations, voiceDir, options.voice || '');
  else throw new Error(`不支持的 TTS provider: ${requested}`);

  const manifestPath = path.join(WORK_DIR, 'voice-manifest.json');
  await writeFile(manifestPath, JSON.stringify({ version: 1, ...manifest }, null, 2), 'utf8');
  console.log(`[voice] 旁白生成完成（${manifest.provider} / ${manifest.voice}）`);
  return { manifestPath, manifest };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await synthesizeNarrations(parseCliArgs());
  } catch (error) {
    console.error('[voice] ' + error.message);
    process.exitCode = 1;
  }
}
