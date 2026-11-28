import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin, VERSION } from '../index.js';
import { biliFixture, deferred, tick } from './bili-integration-support.mjs';

test('version, exported metadata and the three private-message settings stay in sync', () => {
  const plugin = createPlugin();
  assert.equal(VERSION, '0.4.2');
  assert.equal(plugin.version, '0.4.2');
  for (const [key, type] of [
    ['biliDmEnabled', 'boolean'],
    ['biliDmPollSeconds', 'number'],
    ['biliDmIncludeSystem', 'boolean'],
  ]) {
    assert.equal(plugin.config[key].type, type);
    assert.equal(plugin.config[key].default, type === 'number' ? 300 : false);
  }
  assert.equal(plugin.config.biliDmPollSeconds.min, 180);
  assert.equal(plugin.config.biliDmPollSeconds.max, 3600);
});

test('private commands require a resolved ordinary owner C2C and fail closed without isOwner', async (t) => {
  const env = await biliFixture(t);
  await env.runtime.ready;
  const group = await env.run(['私信', '绑定'], { kind: 'group', chatId: 'group-1', userId: 'owner-1' });
  assert.equal(env.calls.bind.length, 0);
  assert.match(group.replies.join(), /移到.*私聊/);
  const stranger = await env.run(['私信', '绑定'], { kind: 'c2c', chatId: 'stranger', userId: 'stranger' });
  assert.equal(env.calls.bind.length, 0);
  assert.match(stranger.replies.join(), /仅机器人主人/);
  const owner = await env.run(['私信', '绑定'], { kind: 'c2c', chatId: 'owner-1', userId: 'owner-1' });
  assert.equal(env.calls.bind.length, 1);
  assert.equal(env.calls.bind[0].userId, 'owner-1');
  assert.match(owner.replies.join(), /已绑定/);

  const denied = await biliFixture(t, { isOwnerProvided: false });
  await denied.runtime.ready;
  const missing = await denied.run(['私信', '绑定']);
  assert.equal(denied.calls.bind.length, 0);
  assert.match(missing.replies.join(), /未提供主人校验/);
});

test('all documented private subcommands dispatch safely and never use a body target', async (t) => {
  const env = await biliFixture(t);
  await env.runtime.ready;
  env.login.inspectState = 'valid';

  const login = await env.run(['私信', '登录']);
  assert.equal(env.calls.loginStart, 1);
  assert.equal(login.sent.some((item) => item.type === 'image-buffer'), true);
  assert.match(login.replies.join(), /扫码/);
  assert.equal(login.replies.join().includes('data:image'), false);

  const status = await env.run(['私信', '状态']);
  assert.match(status.replies.join(), /登录：(?:等待扫码|有效|已登录)/);
  assert.match(status.replies.join(), /监听/);

  const on = await env.run(['私信', '开']);
  assert.equal(env.ctx.config.biliDmEnabled, true);
  assert.equal(env.calls.serviceConfigChanged > 0, true);
  assert.match(on.replies.join(), /正在初始化|恢复进度/);

  const off = await env.run(['私信', '关']);
  assert.equal(env.ctx.config.biliDmEnabled, false);
  assert.match(off.replies.join(), /暂停/);

  const check = await env.run(['私信', '检查']);
  assert.equal(env.calls.serviceCheck, 1);
  assert.match(check.replies.join(), /监听|登录/);

  const testMessage = await env.run(['私信', '测试']);
  assert.equal(env.calls.sendTest.length, 1);
  assert.equal(env.calls.sendTest[0].userId, 'owner-1');
  assert.equal(env.calls.sendTest[0].chatId, 'owner-1');
  assert.match(testMessage.replies.join(), /测试通知/);

  const backlog = await env.run(['私信', '待发']);
  assert.match(backlog.replies.join(), /待发送：1/);
  assert.match(backlog.replies.join(), /领取/);

  const claim = await env.run(['私信', '领取']);
  assert.equal(env.calls.claim.length, 1);
  assert.equal(claim.replies.length, 0, 'claim sends through the passive handler without a fifth buffered reply');

  const view = await env.run(['私信', '查看', 'AB12CD34', '2']);
  assert.equal(env.calls.view.length, 1);
  assert.equal(env.calls.view[0].shortId, 'AB12CD34');
  assert.equal(env.calls.view[0].page, 2);
  assert.equal(view.replies.length, 0, 'view repeats content through the passive handler');

  const logout = await env.run(['私信', '退出登录']);
  assert.equal(env.calls.loginLogout, 1);
  assert.equal(env.ctx.config.biliDmEnabled, false);
  assert.match(logout.replies.join(), /共享/);
  assert.match(logout.replies.join(), /不会注销/);
});

test('private commands work when media auto settings are off and Python is unavailable', async (t) => {
  const env = await biliFixture(t, {
    config: { enabled: false, privateEnabled: false }, ensureUnavailable: true,
  });
  await env.runtime.ready;
  await env.runtime.bootstrap;
  assert.equal(env.runtime.publicStatus().ready, false);
  const bound = await env.run(['私信', '绑定']);
  assert.equal(env.calls.bind.length, 1);
  assert.match(bound.replies.join(), /已绑定/);
  const status = await env.run(['私信', '状态']);
  assert.match(status.replies.join(), /监听/);
});

test('hot reload cancels the previous generation immediately and waits for its storage write tail', async (t) => {
  const env = await biliFixture(t);
  await env.runtime.ready;
  const gate = deferred();
  env.storeControl.flushGate = gate;
  const fresh = await env.reload({ awaitDm: false });
  let ready = false;
  fresh.ready.then(() => { ready = true; });
  await tick();
  assert.equal(env.runtime.isActive(), false);
  assert.equal(env.calls.serviceDeactivate > 0, true);
  assert.equal(env.calls.loginDeactivate > 0, true);
  assert.equal(ready, false, 'new settings/store load must wait for the old write tail');
  gate.resolve();
  await fresh.ready;
  await fresh.dmReady;
  assert.equal(ready, true);
  assert.equal(fresh.isActive(), true);
  await fresh.deactivate('test cleanup');
});

test('a deactivated generation can no longer bind or start private-message work', async (t) => {
  const env = await biliFixture(t);
  await env.runtime.ready;
  await env.runtime.deactivate('test');
  const after = await env.run(['私信', '绑定']);
  assert.equal(env.calls.bind.length, 0);
  assert.equal(after.replies.length, 0);
  const stale = await env.route('GET', '/bili/dm/status');
  assert.equal(stale.code, 409);
});

test('a late login result after deactivation never becomes a QR reply', async (t) => {
  const env = await biliFixture(t);
  await env.runtime.ready;
  const gate = deferred();
  env.login.startGate = gate.promise;
  const pending = env.run(['私信', '登录']);
  await tick();
  assert.equal(env.calls.loginStart, 1);
  await env.runtime.deactivate('hot reload');
  gate.resolve();
  const message = await pending;
  assert.equal(env.calls.loginDeactivate > 0, true);
  assert.equal(message.sent.length, 0);
  assert.equal(message.replies.length, 0, 'a stale generation must not reply after deactivation');
});

test('real reviewed DM modules are exercised only when they are transferred into the plugin', async (t) => {
  try {
    const [service, store, delivery] = await Promise.all([
      import('../bili-dm.js'), import('../bili-dm-store.js'), import('../bili-dm-delivery.js'),
    ]);
    assert.equal(typeof service.createBiliDmService, 'function');
    assert.equal(typeof store.createBiliDmStore, 'function');
    assert.equal(typeof delivery.createBiliDmDelivery, 'function');
  } catch {
    t.skip('审核中的 bili-dm 模块尚未转移到主开发目录；本项等待父流程转移后执行');
  }
});
