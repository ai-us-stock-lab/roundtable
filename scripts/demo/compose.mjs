import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CUE_SPECS, DOCS_DIR, VIEWPORT, WORK_DIR, parseCliArgs } from './config.mjs';
import { formatBytes, runOrThrow } from './lib.mjs';

function numeric(value, digits = 3) {
  return Number(value).toFixed(digits);
}

async function loadMediaTools() {
  const ffmpegModule = await import('ffmpeg-static');
  const probeModule = await import('@ffprobe-installer/ffprobe');
  const ffmpeg = ffmpegModule.default || ffmpegModule;
  const ffprobe = probeModule.path || probeModule.default?.path;
  if (!ffmpeg || !ffprobe) throw new Error('无法定位 scripts/demo 内的 ffmpeg/ffprobe');
  return { ffmpeg, ffprobe };
}

async function probeMedia(ffprobe, file) {
  const result = await runOrThrow(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
    '-of', 'json',
    file,
  ], { timeoutMs: 120_000 });
  return JSON.parse(result.stdout);
}

function assTime(totalSeconds) {
  const centiseconds = Math.max(0, Math.round(totalSeconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function subtitleText(text) {
  const chars = Array.from(text.replace(/[{}]/g, ''));
  if (chars.length <= 30) return chars.join('');
  let split = Math.ceil(chars.length / 2);
  for (let offset = 0; offset < 8; offset += 1) {
    for (const candidate of [split - offset, split + offset]) {
      if ('，。？！；——'.includes(chars[candidate] || '')) {
        split = candidate + 1;
        offset = 99;
        break;
      }
    }
  }
  return `${chars.slice(0, split).join('')}\\N${chars.slice(split).join('')}`;
}

function buildAss(scenes) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${VIEWPORT.width}
PlayResY: ${VIEWPORT.height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,48,&H00FFFFFF,&H000000FF,&HCC111418,&H99000000,0,0,0,0,100,100,0,0,1,3,1,2,120,120,58,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = scenes.map(scene => {
    const start = scene.start + 0.55;
    const end = Math.min(scene.start + scene.duration - 0.3, start + scene.audioDuration + 0.5);
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${subtitleText(scene.text)}`;
  });
  return header + lines.join('\n') + '\n';
}

async function makeScene({ ffmpeg, source, rawDuration, cue, segments, audio, audioDuration, index, sceneDir }) {
  const usable = segments.map(item => ({
    ...item,
    start: Math.max(0, item.startMs / 1000),
    end: Math.min(rawDuration - 0.03, item.endMs / 1000),
  })).filter(item => item.end - item.start >= 0.15);
  if (!usable.length) throw new Error(`${cue.id} 没有可用画面片段`);
  const visualDuration = usable.reduce((sum, item) => sum + item.end - item.start, 0);
  const duration = Math.max(cue.minDuration, visualDuration, audioDuration + 1.4);
  const filters = usable.map((item, clipIndex) => (
    `[0:v]trim=start=${numeric(item.start)}:end=${numeric(item.end)},setpts=PTS-STARTPTS,` +
    `scale=${VIEWPORT.width}:${VIEWPORT.height}:force_original_aspect_ratio=decrease,` +
    `pad=${VIEWPORT.width}:${VIEWPORT.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${clipIndex}]`
  ));
  const labels = usable.map((_, clipIndex) => `[v${clipIndex}]`).join('');
  filters.push(`${labels}concat=n=${usable.length}:v=1:a=0[joined]`);
  const padDuration = Math.max(0, duration - visualDuration);
  filters.push(`[joined]tpad=stop_mode=clone:stop_duration=${numeric(padDuration)}[video]`);
  filters.push(`[1:a]adelay=500:all=1,apad,atrim=duration=${numeric(duration)}[audio]`);

  const output = path.join(sceneDir, `${String(index + 1).padStart(2, '0')}-${cue.id}.mp4`);
  await runOrThrow(ffmpeg, [
    '-y', '-i', source, '-i', audio,
    '-filter_complex', filters.join(';'),
    '-map', '[video]', '-map', '[audio]',
    '-t', numeric(duration),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart', output,
  ], { timeoutMs: 600_000, cwd: WORK_DIR });
  return { ...cue, output, duration, audioDuration, visualDuration };
}

async function makeGif({ ffmpeg, outputVideo, scenes }) {
  const byId = Object.fromEntries(scenes.map(scene => [scene.id, scene]));
  const windows = [
    [byId['shot-1'].start + byId['shot-1'].duration - 2.5, byId['shot-1'].start + byId['shot-1'].duration],
    [byId['shot-2'].start + byId['shot-2'].duration - 3.0, byId['shot-2'].start + byId['shot-2'].duration],
    [byId['shot-3'].start + byId['shot-3'].duration - 3.5, byId['shot-3'].start + byId['shot-3'].duration],
    [byId['shot-4'].start, byId['shot-4'].start + 2.5],
    [byId['shot-4'].start + byId['shot-4'].duration - 2.5, byId['shot-4'].start + byId['shot-4'].duration],
  ];
  const candidates = [
    { width: 960, fps: 10, colors: 128 },
    { width: 840, fps: 10, colors: 112 },
    { width: 720, fps: 8, colors: 96 },
  ];
  const output = path.join(DOCS_DIR, 'demo.gif');
  for (const candidate of candidates) {
    const parts = windows.map(([start, end], index) => (
      `[0:v]trim=start=${numeric(start)}:end=${numeric(end)},setpts=PTS-STARTPTS[g${index}]`
    ));
    const labels = windows.map((_, index) => `[g${index}]`).join('');
    parts.push(`${labels}concat=n=${windows.length}:v=1:a=0,fps=${candidate.fps},` +
      `scale=${candidate.width}:-2:flags=lanczos,split[p0][p1]`);
    parts.push(`[p0]palettegen=max_colors=${candidate.colors}:stats_mode=diff[palette]`);
    parts.push('[p1][palette]paletteuse=dither=bayer:bayer_scale=4[gif]');
    await runOrThrow(ffmpeg, [
      '-y', '-i', outputVideo,
      '-filter_complex', parts.join(';'),
      '-map', '[gif]', '-loop', '0', output,
    ], { timeoutMs: 600_000, cwd: WORK_DIR });
    const size = (await stat(output)).size;
    if (size <= 8 * 1024 * 1024) {
      console.log(`[compose] README GIF：${formatBytes(size)} / ${candidate.width}px / ${candidate.fps}fps`);
      return output;
    }
  }
  throw new Error('docs/demo.gif 经过三档压缩仍超过 8MB；已停止交付，避免生成不合约束的 GIF');
}

export async function composeDemo(options = {}) {
  const { ffmpeg, ffprobe } = await loadMediaTools();
  const timeline = JSON.parse(await readFile(path.join(WORK_DIR, 'timeline.json'), 'utf8'));
  const voice = JSON.parse(await readFile(path.join(WORK_DIR, 'voice-manifest.json'), 'utf8'));
  const voiceById = Object.fromEntries(voice.clips.map(clip => [clip.id, clip]));
  const rawInfo = await probeMedia(ffprobe, timeline.source);
  const rawDuration = Number(rawInfo.format.duration);
  const sceneDir = path.join(WORK_DIR, 'scenes');
  await mkdir(sceneDir, { recursive: true });

  const scenes = [];
  for (let index = 0; index < CUE_SPECS.length; index += 1) {
    const cue = CUE_SPECS[index];
    const audio = voiceById[cue.id];
    if (!audio) throw new Error(`缺少 ${cue.id} 的旁白音轨`);
    const audioInfo = await probeMedia(ffprobe, audio.path);
    const matchingSegments = timeline.segments.filter(item => item.cueId === cue.id);
    scenes.push(await makeScene({
      ffmpeg,
      source: timeline.source,
      rawDuration,
      cue: { ...cue, text: audio.text },
      segments: matchingSegments,
      audio: audio.path,
      audioDuration: Number(audioInfo.format.duration),
      index,
      sceneDir,
    }));
  }

  let cursor = 0;
  for (const scene of scenes) {
    scene.start = cursor;
    cursor += scene.duration;
  }
  const concatList = path.join(WORK_DIR, 'concat.txt');
  await writeFile(concatList, scenes.map(scene => {
    const normalized = scene.output.replaceAll('\\', '/').replaceAll("'", "'\\''");
    return `file '${normalized}'`;
  }).join('\n') + '\n', 'utf8');
  const joined = path.join(WORK_DIR, 'joined.mp4');
  await runOrThrow(ffmpeg, [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c', 'copy', '-movflags', '+faststart', joined,
  ], { timeoutMs: 300_000, cwd: WORK_DIR });

  const assPath = path.join(WORK_DIR, 'subtitles.ass');
  await writeFile(assPath, buildAss(scenes), 'utf8');
  await mkdir(DOCS_DIR, { recursive: true });
  const outputVideo = path.join(DOCS_DIR, 'demo.mp4');
  await runOrThrow(ffmpeg, [
    '-y', '-i', joined,
    '-vf', `ass=${path.basename(assPath)}`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', outputVideo,
  ], { timeoutMs: 600_000, cwd: WORK_DIR });

  const finalInfo = await probeMedia(ffprobe, outputVideo);
  const duration = Number(finalInfo.format.duration);
  const videoStream = finalInfo.streams.find(stream => stream.codec_type === 'video');
  const audioStream = finalInfo.streams.find(stream => stream.codec_type === 'audio');
  if (duration < 60 || duration > 90) throw new Error(`成片时长 ${numeric(duration, 1)} 秒，不在 60–90 秒内`);
  if (videoStream?.width !== VIEWPORT.width || videoStream?.height !== VIEWPORT.height) {
    throw new Error(`成片分辨率不是 ${VIEWPORT.width}×${VIEWPORT.height}`);
  }
  if (!audioStream) throw new Error('成片缺少中文旁白音轨');
  const size = (await stat(outputVideo)).size;
  console.log(`[compose] MP4 完成：${numeric(duration, 1)} 秒，${videoStream.width}×${videoStream.height}，${formatBytes(size)}`);

  let gif = null;
  if (options.gif !== false) gif = await makeGif({ ffmpeg, outputVideo, scenes });
  const report = {
    version: 1,
    outputVideo,
    gif,
    duration,
    size,
    resolution: `${videoStream.width}x${videoStream.height}`,
    audioCodec: audioStream.codec_name,
    videoCodec: videoStream.codec_name,
    narrationProvider: voice.provider,
    narrationVoice: voice.voice,
    scenes: scenes.map(scene => ({
      id: scene.id,
      title: scene.title,
      start: scene.start,
      duration: scene.duration,
      audioDuration: scene.audioDuration,
      segments: timeline.segments.filter(item => item.cueId === scene.id).length,
    })),
  };
  await writeFile(path.join(WORK_DIR, 'render-report.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await composeDemo(parseCliArgs());
  } catch (error) {
    console.error('[compose] ' + error.message);
    process.exitCode = 1;
  }
}
