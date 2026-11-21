import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createLauncher, servicePaths } from '../lib/launcher.mjs';
import { temporary } from './helpers.mjs';
function fixture(t, extra = {}) {
  const base = temporary(t), app = join(base, 'GPT SoVITS'), dir = join(base, 'data'), runner = join(base, 'service-runner.py');
  const python = join(app, process.platform === 'win32' ? 'runtime/python.exe' : 'runtime/bin/python3');
  mkdirSync(join(python, '..'), { recursive: true }); writeFileSync(python, 'fixture'); writeFileSync(join(app, 'api_v2.py'), 'fixture'); writeFileSync(runner, 'fixture');
  const c = { api: 'http://127.0.0.1:9880', serviceDir: app };
  let live = false, killed = 0, spawned = 0;
  const identity = { executable: python, command: `"${python}" -u "${runner}" --app-dir "${app}" --host 127.0.0.1 --port 9880` };
  const launcher = createLauncher({ getConfig: () => c, dir, runner, fetchImpl: async () => { throw new Error('offline'); }, isAlive: pid => pid === 4242 && live, inspectImpl: async () => identity,
    spawnImpl: () => { live = true; spawned++; const child = new EventEmitter(); child.pid = 4242; child.unref = () => {}; return child; },
    killImpl: pid => { assert.equal(pid, 4242); live = false; killed++; }, ...extra });
  return { launcher, c, dir, identity, state: () => JSON.parse(readFileSync(servicePaths(c, dir).state)), live: value => { live = value; }, killed: () => killed, spawned: () => spawned };
}
test('自己的启动中进程可以关闭，关闭后按钮状态允许再次启动', async t => {
  const f = fixture(t);
  const start = await f.launcher.start(); assert.equal(start.phase, 'starting'); assert.equal(start.canStop, true);
  const stop = await f.launcher.stop(); assert.equal(stop.phase, 'stopped'); assert.equal(stop.canStop, false); assert.equal(stop.pid, 0); assert.equal(f.killed(), 1); assert.equal(f.state().pid, 0);
  assert.equal((await f.launcher.stop()).phase, 'stopped'); assert.equal(f.killed(), 1);
  assert.equal((await f.launcher.start()).canStop, true); assert.equal(f.spawned(), 2);
});
test('PID复用或进程标记不一致时保留其它进程', async t => {
  const f = fixture(t, { inspectImpl: async () => ({ executable: 'unrelated', command: 'another program' }) });
  await f.launcher.start(); await assert.rejects(f.launcher.stop(), /不匹配/);
  assert.equal(f.killed(), 0); assert.equal(f.state().pid, 4242);
});
test('同一脚本但端口不匹配也不关闭', async t => {
  const f = fixture(t);
  await f.launcher.start(); f.identity.command = f.identity.command.replace('--port 9880', '--port 9881');
  await assert.rejects(f.launcher.stop(), /不匹配/); assert.equal(f.killed(), 0);
});
test('正在退出的进程显示stopping，不会重复启动，退出后恢复stopped', async t => {
  const f = fixture(t, { killImpl: () => {}, stopWaitMs: 1 });
  await f.launcher.start(); const stop = await f.launcher.stop(); assert.equal(stop.phase, 'stopping'); assert.equal(stop.canStop, false);
  assert.equal((await f.launcher.start()).phase, 'stopping'); assert.equal(f.spawned(), 1);
  f.live(false); assert.equal((await f.launcher.status()).phase, 'stopped');
});
test('外部启动的健康服务只显示运行，不尝试终止', async t => {
  const f = fixture(t, { fetchImpl: async () => new Response(JSON.stringify({ paths: { '/tts': {}, '/set_sovits_weights': {}, '/set_gpt_weights': {} } })) });
  const status = await f.launcher.status(); assert.equal(status.phase, 'running'); assert.equal(status.canStop, false);
  await assert.rejects(f.launcher.stop(), /其他入口/); assert.equal(f.killed(), 0);
});
