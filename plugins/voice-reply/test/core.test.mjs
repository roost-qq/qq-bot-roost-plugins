import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeConfig, missingSetup, currentConfig } from '../lib/config.mjs';
import { parseAsk, langOf, composeSpeech, pickLine } from '../lib/speech.mjs';
import { normalizeWav, encodeVoice } from '../lib/audio.mjs';
import { createService } from '../lib/service.mjs';
import { createHandler } from '../server.mjs';
import { limitedBody } from '../lib/client.mjs';
import { withLock, readJson } from '../lib/store.mjs';
import { temporary, wavFixture, fakeApi } from './helpers.mjs';

const c = normalizeConfig({});
test('已安装扩展重置配置/密钥后不退回启动时的旧env', t => {
  const launcher = temporary(t), root = join(launcher, 'extensions', 'voice-reply');
  mkdirSync(root, { recursive: true }); mkdirSync(join(launcher, 'secrets'));
  const file = join(root, 'config.json'), secretFile = join(launcher, 'secrets', 'voice-reply.config.json');
  writeFileSync(file, JSON.stringify({ refAudio: 'latest.wav' }));
  writeFileSync(secretFile, JSON.stringify({ translateKey: 'fixture-secret-latest' }));
  const env = { ROOST_EXT_CONFIG: JSON.stringify({ refAudio: 'obsolete.wav' }), ROOST_EXT_SECRET_TRANSLATEKEY: 'fixture-secret-obsolete' };
  assert.equal(currentConfig({ root, env }).refAudio, 'latest.wav');
  assert.equal(currentConfig({ root, env }).translateKey, 'fixture-secret-latest');
  rmSync(file); rmSync(secretFile);
  assert.equal(currentConfig({ root, env }).refAudio, '');
  assert.equal(currentConfig({ root, env }).translateKey, '');
});
test('异常退出遗留的空锁可恢复，活进程锁不会被超时抢走', async t => {
  const dir = temporary(t), lock = join(dir, 'synthesis.lock');
  writeFileSync(lock, ''); const old = new Date(Date.now() - 181000); utimesSync(lock, old, old);
  await withLock(dir, AbortSignal.timeout(1000), async () => {});
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'live-fixture' })); utimesSync(lock, old, old);
  await assert.rejects(withLock(dir, AbortSignal.timeout(50), async () => {}), /abort/i);
  assert.equal(JSON.parse(readFileSync(lock)).nonce, 'live-fixture');
});
test('状态工具不回传其他会话正文/目录', async () => {
  const handler = createHandler({ status: () => ({ version: 'fixture', enabled: true, missing: [], lineCount: 24, dataDir: 'private-path', lastJob: { id: 'fixture', status: 'done', text: 'private-text', warning: 'private-warning', at: 123 } }) });
  const out = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'voice_status' } });
  assert.doesNotMatch(JSON.stringify(out), /private-/);
});
test('清空配置真实生效，不继承旧权重；无内置用户路径', () => {
  assert.equal(normalizeConfig({ refAudio: '' }).refAudio, '');
  assert.deepEqual(missingSetup(c), ['参考音频', '参考文本', 'SoVITS 权重', 'GPT 权重']);
  assert.equal(c.translateKey, '');
  for (const api of ['file:///tmp', 'http://name:pass@localhost', 'http://localhost/?token=abc']) assert.throws(() => normalizeConfig({ api }));
  assert.throws(() => normalizeConfig({ speed: NaN }));
});
test('关键词匹配、原文尾句、问句碎片和纯闲聊', () => {
  for (const phrase of ['说话', '发个语音', '念一句', '现在呢，能语音回复吗', '说话试试']) assert.deepEqual(parseAsk(phrase, c.keywords), { asked: true, rest: '' });
  assert.equal(parseAsk('说话，叫我主人', c.keywords).rest, '叫我主人');
  assert.equal(parseAsk('<@!123> 说话 今天好累', c.keywords).rest, '今天好累');
  assert.equal(parseAsk('普通聊天', c.keywords).asked, false);
});
test('正文语言识别与显式日语配置', () => {
  assert.equal(langOf('こんにちは'), 'ja'); assert.equal(langOf('今天好累'), 'zh'); assert.equal(langOf('Hello'), 'en');
  assert.equal(langOf('大丈夫', 'ja'), 'ja');
});
test('中文正文在没配翻译时保留，不退回无关日语台词', async () => {
  const out = await composeSpeech({ text: '今天好累', c });
  assert.equal(out.text, '今天好累'); assert.equal(out.lang, 'zh'); assert.equal(out.source, 'echo');
});
test('翻译失败保留原文，翻译成功使用日语', async () => {
  const cfg = { ...c, translateApi: 'http://fixture' };
  const fail = await composeSpeech({ text: '你好', c: cfg, translate: async () => { throw new Error('not ready'); } });
  assert.equal(fail.text, '你好'); assert.match(fail.warning, /原文/);
  const good = await composeSpeech({ text: '你好', c: cfg, translate: async () => 'こんにちは' });
  assert.equal(good.lang, 'ja'); assert.equal(good.source, 'translated');
});
test('自定义台词优先、去重和显式正文不二次解释关键词', async () => {
  assert.equal(pickLine(['甲', '乙'], ['甲'], () => 0), '乙');
  const out = await composeSpeech({ text: '今天我不想说话了', c });
  assert.equal(out.text, '今天我不想说话了');
  assert.equal((await composeSpeech({ message: '普通聊天', c })).mode, 'text');
});
test('WAV → SILK 编码解码有实际声音，支持32kHz', async () => {
  const out = await encodeVoice(wavFixture());
  assert.ok(out.silk.length > 100); assert.ok(out.outRms > 100); assert.equal(out.sampleRate, 32000);
});
test('立体声浮点 WAV 先规范为单声道16bit，静音与截断被挡住', () => {
  const out = normalizeWav(wavFixture({ channels: 2, float: true }));
  assert.equal(out.wav.readUInt16LE(22), 1); assert.equal(out.wav.readUInt16LE(34), 16);
  assert.throws(() => normalizeWav(wavFixture({ silent: true })), /静音/);
  assert.throws(() => normalizeWav(wavFixture().subarray(0, 50)), /截断/);
  assert.throws(() => normalizeWav(Buffer.from('not a wave')), /有效 WAV/);
});
test('拒绝超大响应（含没有content-length的chunked）', async () => {
  await assert.rejects(limitedBody(new Response('12345'), 4), /上限/);
  await assert.rejects(limitedBody(new Response('1', { headers: { 'content-length': '999' } }), 4), /上限/);
});
test('完整调用链：切权重→正文合成→有效SILK文件→只返回标记不发QQ', async t => {
  const { c, requests } = await fakeApi(t); const dir = temporary(t);
  const service = createService({ dir, getConfig: () => c });
  const out = await service.run({ text: '今天好累', chatId: 'fixture-chat' });
  assert.equal(out.mode, 'voice'); assert.equal(out.generated, true); assert.equal(out.delivered, false);
  assert.match(out.reply, /^<<voice: .*\.silk>>$/); assert.deepEqual(requests.map(x => x.path), ['/set_sovits_weights', '/set_gpt_weights', '/tts']);
  assert.equal(requests[2].query.text, '今天好累'); assert.equal(requests[2].query.text_lang, 'zh'); assert.equal(requests[2].query.streaming_mode, 'false');
  assert.equal(service.job(out.id).status, 'done'); assert.equal(service.job(out.id).silkFile, undefined);
  assert.match(service.audio(out.id).dataUrl, /^data:audio\/wav;base64,/);
  assert.ok(readFileSync(join(dir, 'audio', `${out.id}.silk`)).length > 100);
  assert.throws(() => service.audio('../../secret'), /ID/);
});
test('服务端200静音WAV不被假报为成功语音', async t => {
  const { c } = await fakeApi(t, { audio: wavFixture({ silent: true }) });
  const service = createService({ dir: temporary(t), getConfig: () => c });
  const handler = createHandler(service);
  const out = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'voice_reply', arguments: { text: '你好' } } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /静音/);
  assert.doesNotMatch(out.result.content[0].text, /<<voice:/);
});
test('并发入口共享锁，两个角色的权重与合成保持连续', async t => {
  const { c, requests } = await fakeApi(t, { delay: 15 }); const dir = temporary(t);
  const a = createService({ dir, getConfig: () => ({ ...c, sovitsWeights: 'A.pth', gptWeights: 'A.ckpt' }) });
  const b = createService({ dir, getConfig: () => ({ ...c, sovitsWeights: 'B.pth', gptWeights: 'B.ckpt' }) });
  await Promise.all([a.run({ text: '你好' }), b.run({ text: 'こんにちは' })]);
  assert.deepEqual(requests.map(x => x.path), ['/set_sovits_weights', '/set_gpt_weights', '/tts', '/set_sovits_weights', '/set_gpt_weights', '/tts']);
  for (const r of requests.filter(x => x.path === '/tts')) assert.equal(r.weights.sovits[0], r.weights.gpt[0]);
});
test('每次合成重新确认模型，避免服务重启后沿用过期缓存', async t => {
  const { c, requests } = await fakeApi(t); const service = createService({ dir: temporary(t), getConfig: () => c });
  await service.run({ text: '你好' }); await service.run({ text: '你好' });
  assert.equal(requests.filter(x => x.path === '/set_gpt_weights').length, 2);
});
test('冷却拦住重复调用；服务失败不返回语音标记', async t => {
  const { c } = await fakeApi(t); const dir = temporary(t);
  const service = createService({ dir, getConfig: () => ({ ...c, cooldownSec: 3 }) });
  await service.run({ text: '你好', chatId: 'same' });
  await assert.rejects(service.run({ text: '你好', chatId: 'same' }), /频繁/);
  const bad = await fakeApi(t, { failWeight: true });
  const broken = createService({ dir: temporary(t), getConfig: () => bad.c });
  await assert.rejects(broken.run({ text: '你好' }), /HTTP 400/);
  assert.equal(broken.status().lastJob.status, 'error');
});
test('任务总超时包含排队，错误持久化且锁释放', async t => {
  const { c } = await fakeApi(t, { delay: 50 }); const dir = temporary(t);
  const service = createService({ dir, getConfig: () => ({ ...c, timeoutSec: 0.01 }) });
  await assert.rejects(service.run({ text: '你好' }), /超时/);
  assert.equal(service.status().lastJob.status, 'error');
  await withLock(dir, AbortSignal.timeout(1000), async () => {});
});
test('试听后台任务可轮询完成；停用只阻止聊天合成', async t => {
  const { c } = await fakeApi(t); const service = createService({ dir: temporary(t), getConfig: () => ({ ...c, enabled: false }) });
  await assert.rejects(service.run({ text: '你好' }), /停用/);
  const { jobId } = service.startPreview({ text: 'こんにちは' });
  while (service.job(jobId).status === 'running') await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.job(jobId).status, 'done');
});
test('非法参数与过量MCP请求都不会进入合成', async () => {
  let calls = 0, resolveRun;
  const wait = new Promise(resolve => { resolveRun = resolve; });
  const handler = createHandler({ run: async () => { calls++; await wait; return { mode: 'voice' }; } });
  const make = id => handler({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'voice_reply', arguments: {} } });
  const a = make(1), b = make(2), c = await make(3);
  assert.equal(c.result.isError, true); assert.equal(calls, 2); resolveRun(); await Promise.all([a, b]);
});
test('配置和密钥活引用：面板配置更新/清空下一次动作生效', async t => {
  const { createActions } = await import('../actions-v4.mjs');
  const config = { enabled: true, refAudio: 'sample.wav' }, secrets = {};
  const actions = createActions({ config, secrets, env: { VOICE_REPLY_DATA_DIR: temporary(t) } });
  assert.equal((await actions.status()).data.missing.includes('参考音频'), false);
  config.refAudio = '';
  assert.equal((await actions.status()).data.missing.includes('参考音频'), true);
  config.enabled = false;
  assert.equal((await actions.status()).data.enabled, false);
});
