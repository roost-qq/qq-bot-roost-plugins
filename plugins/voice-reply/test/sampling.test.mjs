import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../lib/client.mjs';

const config = { api: 'http://127.0.0.1:9880', refAudio: 'ref.wav', promptText: '参考', promptLang: 'zh', speed: 1.2 };
const speech = { text: '目标正文。再一句。', lang: 'zh' };
const audio = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/wav' } });
const schema = paths => new Response(JSON.stringify({ paths }), { headers: { 'content-type': 'application/json' } });

test('normal synthesis preserves GET /tts and forwards all configured sampling fields', async () => {
  const calls = [];
  const client = createClient(async (url, opts) => { calls.push({ url: new URL(url), opts }); return audio(); });
  await client.wav({ ...config, textSplitMethod: 'cut2', fragmentInterval: 0, topK: 23, topP: 0.72, temperature: 0.63 }, speech);
  const [{ url, opts }] = calls;
  assert.equal(url.pathname, '/tts');
  assert.equal(opts.method, undefined);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    text: speech.text, text_lang: 'zh', ref_audio_path: 'ref.wav', prompt_text: '参考', prompt_lang: 'zh',
    text_split_method: 'cut2', fragment_interval: '0', top_k: '23', top_p: '0.72', temperature: '0.63',
    batch_size: '1', speed_factor: '1.2', media_type: 'wav', streaming_mode: 'false',
  });
  assert.equal(opts.redirect, 'error');
});

test('sampling defaults are explicit API parameters', async () => {
  let params;
  const client = createClient(async url => { params = new URL(url).searchParams; return audio(); });
  await client.wav(config, speech);
  for (const [key, value] of Object.entries({ text_split_method: 'cut5', fragment_interval: '0.3', top_k: '15', top_p: '1', temperature: '1' })) assert.equal(params.get(key), value);
  assert.equal(params.has('seed'), false);
});

test('freeze calls adapter POST with actual fields and no seed substitution', async () => {
  let call;
  const client = createClient(async (url, opts) => { call = { url, opts }; return audio(); });
  await client.wav({ ...config, freeze: true, textSplitMethod: 'cut1', fragmentInterval: 0.8, topK: 9, topP: 0.8, temperature: 1.1 }, speech);
  assert.equal(call.url, `${config.api}/voice-reply/tts`);
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(call.opts.body), {
    text: speech.text, text_lang: 'zh', ref_audio_path: 'ref.wav', prompt_text: '参考', prompt_lang: 'zh',
    text_split_method: 'cut1', fragment_interval: 0.8, top_k: 9, top_p: 0.8, temperature: 1.1,
    batch_size: 1, speed_factor: 1.2, media_type: 'wav', streaming_mode: false, if_freeze: true,
  });
});

for (const status of [404, 405, 501]) test(`missing adapter HTTP ${status} explains one-click startup and disable reuse`, async () => {
  const client = createClient(async () => new Response('sensitive server text', { status }));
  await assert.rejects(client.wav({ ...config, freeze: true }, speech), error => {
    assert.match(error.message, /一键启动启用复用/);
    assert.match(error.message, /关闭/);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test('probe preserves existing fields and requires the adapter POST operation', async () => {
  for (const [adapter, expected] of [[undefined, false], [{ get: {} }, false], [{ post: {} }, true]]) {
    const paths = { '/tts': {}, '/set_sovits_weights': {}, '/set_gpt_weights': {}, ...(adapter ? { '/voice-reply/tts': adapter } : {}) };
    const client = createClient(async () => schema(paths));
    const result = await client.probe(config);
    assert.equal(result.ok, true);
    assert.deepEqual(result.endpoints, ['/tts', '/set_sovits_weights', '/set_gpt_weights']);
    assert.equal(typeof result.message, 'string');
    assert.deepEqual(result.features, { semanticFreeze: expected });
  }
});

test('network and failed probes keep actionable context without underlying exception secrets', async () => {
  const client = createClient(async () => { throw new TypeError('Bearer PRIVATE_KEY https://secret.invalid'); });
  await assert.rejects(client.wav(config, speech), error => {
    assert.match(error.message, /网络连接失败/);
    assert.match(error.message, /端口/);
    assert.doesNotMatch(error.message, /PRIVATE_KEY|secret.invalid/);
    return true;
  });
  const probe = await client.probe(config);
  assert.equal(probe.ok, false);
  assert.deepEqual(probe.features, { semanticFreeze: false });
  assert.doesNotMatch(probe.message, /PRIVATE_KEY|secret.invalid/);
});

test('abort reason propagates to preserve service timeout handling', async () => {
  const ctrl = new AbortController();
  const reason = new Error('fixture timeout');
  ctrl.abort(reason);
  const client = createClient(async () => { throw reason; });
  await assert.rejects(client.wav(config, speech, ctrl.signal), error => error === reason);
});
