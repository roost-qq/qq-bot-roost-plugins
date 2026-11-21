import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createLauncher, findServiceFiles, servicePaths } from '../lib/launcher.mjs';
import { temporary } from './helpers.mjs';

function setup(t) {
  const base = temporary(t), app = join(base, 'GPT SoVITS'), dir = join(base, 'data'), runner = join(base, 'runner.py');
  mkdirSync(join(app, 'runtime'), { recursive: true });
  mkdirSync(join(app, 'GPT_SoVITS/configs'), { recursive: true });
  const python = process.platform === 'win32' ? join(app, 'runtime/python.exe') : join(app, 'runtime/bin/python3');
  mkdirSync(join(python, '..'), { recursive: true });
  for (const file of [python, join(app, 'api_v2.py'), runner, join(app, 'GPT_SoVITS/configs/tts_infer.yaml')]) writeFileSync(file, 'test fixture');
  return { app, dir, runner, c: { api: 'http://127.0.0.1:9880', serviceDir: app } };
}
const noService = async () => { throw new Error('ECONNREFUSED'); };
const schema = adapter => new Response(JSON.stringify({ paths: { '/tts': {}, '/set_gpt_weights': {}, '/set_sovits_weights': {}, ...(adapter ? { '/voice-reply/tts': { post: {} } } : {}) } }), { headers: { 'content-type': 'application/json' } });

test('一键启动明确校验本机API与安装目录，不执行任意shell命令', async t => {
  const s = setup(t); let count = 0;
  const launcher = createLauncher({ ...s, getConfig: () => ({ ...s.c, api: 'http://example.test:9880' }), fetchImpl: noService, spawnImpl: () => { count++; } });
  await assert.rejects(launcher.start(), /仅支持本机/); assert.equal(count, 0);
  assert.equal(findServiceFiles(s.app).app, s.app);
  assert.throws(() => findServiceFiles(join(s.app, 'not-there')), /未找到 api_v2/);
});
test('重复与并发启动只生成一个独立进程，参数与持久日志完整', async t => {
  const s = setup(t), calls = [], children = [];
  const launcher = createLauncher({ ...s, getConfig: () => s.c, fetchImpl: noService, isAlive: pid => pid === 4242, spawnImpl: (...args) => {
    calls.push(args); const child = new EventEmitter(); child.pid = 4242; child.unref = () => { child.detached = true; }; children.push(child); return child;
  } });
  const [a, b] = await Promise.all([launcher.start(), launcher.start()]);
  assert.equal(a.phase, 'starting'); assert.equal(b.phase, 'starting'); assert.equal(calls.length, 1);
  const [python, args, opts] = calls[0];
  assert.ok(python.endsWith(process.platform === 'win32' ? 'python.exe' : 'python3'));
  assert.ok(args.includes('--app-dir')); assert.ok(args.includes(s.app)); assert.ok(args.includes('9880')); assert.ok(args.includes('--config'));
  assert.equal(opts.cwd, s.app); assert.equal(opts.detached, true); assert.equal(opts.shell, false); assert.equal(opts.stdio[0], 'ignore'); assert.equal(opts.stdio[1], opts.stdio[2]);
  assert.equal(children[0].detached, true);
  assert.equal(JSON.parse(readFileSync(servicePaths(s.c, s.dir).state)).pid, 4242);
  assert.equal((await launcher.status()).phase, 'starting');
});
test('已经运行的v2 API不要求本地目录、不重复拉起，正确识别复用能力', async t => {
  const s = setup(t); let count = 0;
  const launcher = createLauncher({ ...s, getConfig: () => ({ ...s.c, serviceDir: '' }), fetchImpl: async () => schema(true), spawnImpl: () => { count++; } });
  assert.equal((await launcher.start()).phase, 'running'); assert.equal(count, 0);
  assert.equal((await launcher.status()).features.semanticFreeze, true);
});
test('已就绪进程在合成繁忙时不误报模型加载超时', async t => {
  const s = setup(t); let ready = false;
  const launcher = createLauncher({ ...s, getConfig: () => s.c, fetchImpl: async () => ready ? schema(true) : noService(), isAlive: pid => pid === 4242, startupMs: -1, spawnImpl: () => { const child = new EventEmitter(); child.pid = 4242; child.unref = () => {}; return child; } });
  await launcher.start(); ready = true;
  assert.equal((await launcher.status()).phase, 'running'); ready = false;
  const busy = await launcher.status(); assert.equal(busy.phase, 'running'); assert.equal(busy.features.semanticFreeze, true); assert.match(busy.message, /任务|响应/);
});
test('spawn异步失败转为明确错误状态，不显示虚假运行PID', async t => {
  const s = setup(t); let child;
  const launcher = createLauncher({ ...s, getConfig: () => s.c, fetchImpl: noService, spawnImpl: () => { child = new EventEmitter(); child.unref = () => {}; return child; } });
  await launcher.start(); child.emit('error', Object.assign(new Error('missing interpreter'), { code: 'ENOENT' }));
  const state = await launcher.status(); assert.equal(state.phase, 'error'); assert.equal(state.pid, 0); assert.match(state.message, /ENOENT/);
});
