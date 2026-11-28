import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { previewOutcome, PANEL_AUTH_BOUNDARY, detectHostBoundaries } from '../panel.js';
import { fixture, deferred, tick } from './plugin-support.mjs';

test('management template parses, uses JSON and scoped page token, and renders user content as text', async () => {
  const html = await fs.readFile(new URL('../page.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new Function(script));
  assert.equal(Buffer.byteLength(html) < 512 * 1024, true);
  assert.match(script, /\/api\/plugins\/media-parser\/r/);
  assert.match(script, /Content-Type.*application\/json/);
  assert.match(script, /params\.set\('pt', token\)/);
  assert.equal(script.includes('innerHTML'), false);
  // A fixed provider ID preference is allowed; authentication stays in requests.
  assert.match(script, /media-parser\.dmProvider\./);
  assert.doesNotMatch(script, /\.setItem\([^,\n]*,\s*(?:token|cookie|pngDataUrl)\s*\)/);
  assert.match(html, /不会向真实聊天发消息/);
});

test('routes register on the real ctx contract without request body identity checks', async (t) => {
  const env = await fixture(t);
  await env.runtime.bootstrap; await env.runtime.pageReady;
  assert.equal(env.pages.has('manage'), true);
  assert.equal(env.routes.has('POST /operations'), true);
  const response = await env.route('POST', '/operations', { body: { action: 'clean', owner: false, role: 'ordinary-user' } });
  assert.equal(response.code, 200);
  assert.equal(typeof response.data.taskId, 'string');
  await tick();
  const task = await env.route('GET', '/operations/:id', { params: { id: response.data.taskId } });
  assert.equal(task.data.task.state, 'completed');
  assert.equal(env.calls.clean, 1);
  assert.match(PANEL_AUTH_BOUNDARY, /请求体自报 owner 不参与授权/);
  // Authentication belongs to Roost's dispatcher, which is outside this
  // handler contract; fake req.body.owner must never substitute for it.
});

test('config, advanced settings, tasks and credentials remain sanitized and credentials are separate', async (t) => {
  const env = await fixture(t);
  await env.runtime.bootstrap;
  const put = await env.route('PUT', '/credentials', { body: { credentials: { bilibili_enhanced: { cookie: 'very-private-cookie-value' }, translation: { llm: { custom_provider: { api_key: '{{SECRET_brj9rj50}}' } } } } } });
  assert.equal(put.code, 200);
  assert.equal(JSON.stringify(put.data).includes('very-private-cookie-value'), false);
  const config = await env.route('GET', '/config');
  assert.equal(JSON.stringify(config.data).includes('private-api-key-value'), false);
  assert.equal(config.data.credentials['bilibili_enhanced.cookie'].set, true);
  const advanced = await fs.readFile(path.join(env.dir, 'engine-settings.json'), 'utf8');
  assert.equal(advanced.includes('very-private-cookie-value'), false);
  const status = await env.route('GET', '/status');
  assert.equal(JSON.stringify(status.data).includes('private-api-key-value'), false);
  const patch = await env.route('PUT', '/config', { body: { config: { maxFileMiB: 50 } } });
  assert.equal(patch.data.restartRequired, true);
  assert.equal(env.ctx.config.maxFileMiB, 50);
});

test('platform routes expose all 31 engine modes, reject invalid modes and mark restart explicitly', async (t) => {
  const env = await fixture(t);
  await env.runtime.bootstrap;
  const platforms = await env.route('GET', '/platforms');
  assert.equal(platforms.data.platforms.length, 31);
  assert.deepEqual(platforms.data.modes, ['全部发送', '仅文本', '仅富媒体', '关闭']);
  const invalid = await env.route('PUT', '/platforms', { body: { parsers: { bilibili: 'only-video' } } });
  assert.equal(invalid.code, 400);
  const valid = await env.route('PUT', '/platforms', { body: { parsers: { bilibili: '关闭' } } });
  assert.equal(valid.code, 200);
  assert.equal(valid.data.restartRequired, true);
  assert.equal(valid.data.platforms.find((x) => x.id === 'bilibili').enabled, false);
});

test('preview performs a real parse with a task ID and never invokes delivery or a real chat', async (t) => {
  const parsed = deferred();
  const env = await fixture(t, {
    parse: async () => parsed.promise,
    delivery: async () => { throw new Error('preview must not deliver'); },
  });
  await env.runtime.bootstrap;
  const response = await env.route('POST', '/preview', { body: { text: 'https://b23.tv/AbCdE' } });
  assert.equal(response.code, 200);
  assert.equal(typeof response.data.taskId, 'string');
  await tick();
  assert.equal(env.calls.parse.length, 1);
  parsed.resolve({
    links: ['https://b23.tv/AbCdE'], items: [],
    plan: { messages: [
      { kind: 'segments', segments: [{ type: 'text', data: { text: '预览正文' } }] },
      { kind: 'forward', nodes: [{ type: 'node', data: { content: [{ type: 'video', data: { file: 'C:\\cache\\preview.mp4' } }] } }] },
    ] },
  });
  await tick(); await tick();
  const task = await env.route('GET', '/tasks/:id', { params: { id: response.data.taskId } });
  assert.equal(task.data.task.state, 'completed');
  assert.deepEqual(task.data.preview.messages, [{ type: 'text', text: '预览正文' }, { type: 'video', name: 'preview.mp4' }]);
  assert.equal(env.calls.delivery, 0);
  assert.match(task.data.preview.note, /没有向聊天发送/);
});

test('idle restart rejects active work, stop aborts work, old generation routes reject and external processes stay external', async (t) => {
  const hold = deferred();
  const env = await fixture(t, { parse: async () => hold.promise });
  await env.runtime.bootstrap;
  const work = env.listeners.get('message')[0](env.makeMessage().msg);
  await tick();
  const restart = await env.route('POST', '/operations', { body: { action: 'restart', owner: true } });
  assert.equal(restart.code, 400);
  assert.equal(env.calls.restart, 0);
  const stop = await env.route('POST', '/operations', { body: { action: 'stop' } });
  assert.equal(stop.code, 200);
  await work; hold.resolve({ plan: { messages: [] } }); await tick(); await tick();
  assert.equal(env.calls.stop, 1);
  env.ctx.config.engineMode = 'external';
  const external = await env.route('POST', '/operations', { body: { action: 'stop' } });
  assert.equal(external.code, 400);
  assert.match(external.data.error, /外部模式/);
  env.runtime.deactivate('disabled');
  const stale = await env.route('GET', '/status');
  assert.equal(stale.code, 409);
});

test('boundary diagnostics read reply-judge configuration without editing another plugin', async (t) => {
  const env = await fixture(t);
  const botData = path.join(env.dir, 'data', 'bots', 'example');
  const dataDir = path.join(botData, 'plugins', 'media-parser');
  const configDir = path.join(env.dir, 'config', 'bots', 'example', 'plugins');
  await fs.mkdir(configDir, { recursive: true }); await fs.mkdir(botData, { recursive: true });
  const file = path.join(configDir, 'reply-judge.json');
  const original = JSON.stringify({ enabled: true, bypassRegex: '^骰子$' });
  await fs.writeFile(file, original);
  const result = await detectHostBoundaries({ dataDir });
  assert.equal(result.replyJudge.installed, true);
  assert.equal(result.replyJudge.bypassConfigured, true);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(result.warnings.some((text) => text.includes('DSH')), true);
  assert.match(result.groupSwitch, /未提供群插件开关写接口/);
});

test('preview bounds unknown or excessive nesting without exposing local directory paths', () => {
  const outcome = previewOutcome({ plan: { messages: [
    { type: 'text', data: { text: '⚠️ 链接中包含超过100MB的视频时将单独发送所有媒体' } },
    { type: 'file', data: { file: 'C:\\private\\cache\\file.mp3' } },
    { type: 'unknown', data: { cookie: 'private' } },
  ] } });
  assert.deepEqual(outcome.messages, [{ type: 'file', name: 'file.mp3' }]);
  assert.equal(JSON.stringify(outcome).includes('C:\\'), false);
});
