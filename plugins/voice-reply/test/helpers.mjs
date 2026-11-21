import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeConfig } from '../lib/config.mjs';

export function temporary(t) { const dir = mkdtempSync(join(tmpdir(), 'roost-voice-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
export function wavFixture({ rate = 32000, seconds = 0.6, silent = false, channels = 1, float = false } = {}) {
  const samples = Math.round(rate * seconds), bits = float ? 32 : 16;
  const step = bits / 8;
  const buf = Buffer.alloc(44 + samples * channels * step);
  buf.write('RIFF'); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(float ? 3 : 1, 20); buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * step, 28); buf.writeUInt16LE(channels * step, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(buf.length - 44, 40);
  for (let i = 0; i < samples; i++) for (let ch = 0; ch < channels; ch++) {
    const v = silent ? 0 : Math.sin(2 * Math.PI * 440 * i / rate) * 0.2;
    const at = 44 + (i * channels + ch) * step;
    if (float) buf.writeFloatLE(v, at); else buf.writeInt16LE(Math.round(v * 32767), at);
  }
  return buf;
}
export async function fakeApi(t, { audio = wavFixture(), failWeight = false, delay = 0 } = {}) {
  const requests = [];
  let current = { sovits: '', gpt: '' };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), weights: { ...current } });
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (url.pathname.startsWith('/set_')) {
      const type = url.pathname.includes('sovits') ? 'sovits' : 'gpt';
      current[type] = url.searchParams.get('weights_path');
      res.writeHead(failWeight ? 400 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: failWeight ? 'bad file' : 'success' }));
    } else if (url.pathname === '/tts') { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(audio); }
    else if (url.pathname === '/openapi.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ paths: { '/tts': {}, '/set_sovits_weights': {}, '/set_gpt_weights': {} } })); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const c = normalizeConfig({ api: `http://127.0.0.1:${server.address().port}`, refAudio: 'sample.wav', promptText: 'テストです。', sovitsWeights: 'speaker.pth', gptWeights: 'speaker.ckpt', cooldownSec: 0 });
  return { c, requests, server };
}
