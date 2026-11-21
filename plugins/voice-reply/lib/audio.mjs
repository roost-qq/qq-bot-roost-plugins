const RATES = new Set([8000, 12000, 16000, 24000, 32000, 44100, 48000]);
export function inspectWav(input) {
  const b = Buffer.from(input);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('服务返回内容不是有效 WAV');
  let fmt, data;
  for (let off = 12; off + 8 <= b.length;) {
    const size = b.readUInt32LE(off + 4);
    const end = off + 8 + size;
    if (end > b.length) throw new Error('WAV 数据截断；请关闭服务端流式输出');
    const id = b.toString('ascii', off, off + 4);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV 格式头过短');
      fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), align: b.readUInt16LE(off + 20), bits: b.readUInt16LE(off + 22) };
    }
    if (id === 'data') data = b.subarray(off + 8, end);
    off = end + size % 2;
  }
  if (!fmt || !data?.length || !RATES.has(fmt.rate) || ![1, 2].includes(fmt.channels)) throw new Error('WAV 缺少有效音轨，或采样率/声道不受支持');
  if (!(fmt.format === 1 && [8, 16, 24, 32].includes(fmt.bits)) && !(fmt.format === 3 && [32, 64].includes(fmt.bits))) throw new Error('WAV 需要 PCM 或浮点音频');
  if (fmt.align !== fmt.channels * fmt.bits / 8 || data.length % fmt.align) throw new Error('WAV 音轨长度与采样格式不一致');
  const samples = data.length / fmt.align;
  const durationSec = samples / fmt.rate;
  if (durationSec < 0.1 || durationSec > 55) throw new Error('语音时长需要在 0.1–55 秒之间，请缩短正文');
  return { b, fmt, data, samples, durationSec };
}
/** 只做声道/位深规范化，保留原始采样率和增益，再交 SILK 编码器。 */
export function normalizeWav(input) {
  const info = inspectWav(input);
  const { fmt, data, samples, durationSec } = info;
  const pcm = Buffer.alloc(samples * 2);
  let sum = 0;
  const step = fmt.bits / 8;
  function sample(off) {
    if (fmt.format === 3) return fmt.bits === 32 ? data.readFloatLE(off) : data.readDoubleLE(off);
    if (fmt.bits === 8) return (data[off] - 128) / 128;
    if (fmt.bits === 16) return data.readInt16LE(off) / 32768;
    if (fmt.bits === 24) return data.readIntLE(off, 3) / 8388608;
    return data.readInt32LE(off) / 2147483648;
  }
  for (let i = 0; i < samples; i++) {
    let v = 0;
    for (let ch = 0; ch < fmt.channels; ch++) v += sample(i * fmt.align + ch * step) / fmt.channels;
    if (!Number.isFinite(v)) throw new Error('WAV 包含无效采样值');
    const s = Math.round(Math.max(-1, Math.min(32767 / 32768, v)) * 32768);
    sum += s * s;
    pcm.writeInt16LE(s, i * 2);
  }
  const rms = Math.sqrt(sum / samples);
  if (rms < 1) throw new Error('语音服务返回了静音音轨，请检查模型与参考音频');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(fmt.rate, 24); header.writeUInt32LE(fmt.rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return { wav: Buffer.concat([header, pcm]), durationSec, rms, sampleRate: fmt.rate };
}
export async function encodeVoice(input, codec) {
  const { wav, durationSec, rms, sampleRate } = normalizeWav(input);
  const silk = codec || await import('../vendor/silk-wasm/index.mjs');
  const encoded = await silk.encode(wav, 0);
  const bytes = Buffer.from(encoded.data || []);
  if (!bytes.length || !silk.isSilk(bytes) || silk.getDuration(bytes) <= 0) throw new Error('SILK 编码结果无效');
  const decoded = await silk.decode(bytes, 24000);
  const pcm = Buffer.from(decoded.data || []);
  let sum = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) { const n = pcm.readInt16LE(i); sum += n * n; }
  const outRms = Math.sqrt(sum / Math.max(1, pcm.length / 2));
  if (!pcm.length || outRms < 1) throw new Error('SILK 编码后音轨为静音，未生成发送标记');
  return { wav, silk: bytes, durationSec, rms, outRms, sampleRate };
}
