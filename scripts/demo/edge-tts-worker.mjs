import { readFile, writeFile } from 'node:fs/promises';
import { EdgeTTS } from '@travisvn/edge-tts';

const [inputPath, outputPath, voice, rate] = process.argv.slice(2);
if (!inputPath || !outputPath || !voice || !rate) throw new Error('edge-tts-worker 参数不完整');
const text = await readFile(inputPath, 'utf8');
const tts = new EdgeTTS(text, voice, { rate, volume: '+0%', pitch: '+0Hz' });
const result = await tts.synthesize();
const audio = Buffer.from(await result.audio.arrayBuffer());
if (audio.length < 1024) throw new Error('未收到有效 Edge TTS 音频');
await writeFile(outputPath, audio);
