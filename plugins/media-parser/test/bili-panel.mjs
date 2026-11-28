import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { biliFixture } from './bili-integration-support.mjs';

const PRIVATE_COOKIE = 'SESSDATA=synthetic-cookie; PRIVATE-CSRF-TOKEN';
const PRIVATE_BODY = 'PRIVATE-BODY-MARKER';
const PRIVATE_SENDER = 'PRIVATE-SENDER-MARKER';
const PRIVATE_UID = '9007199254740993';

test('private routes exist only under the authenticated prefix and never include binding/query/view/body routes', async (t) => {
  const env = await biliFixture(t);
  for (const key of [
    'GET /bili/login/status', 'POST /bili/login/start', 'POST /bili/login/cancel',
    'GET /bili/login/inspect', 'POST /bili/login/manual', 'POST /bili/login/logout',
    'GET /bili/dm/status', 'GET /bili/dm/groups', 'PUT /bili/dm/target',
    'PUT /bili/dm/config', 'POST /bili/dm/check', 'POST /bili/dm/test',
  ]) assert.equal(env.routes.has(key), true, key);
  for (const forbidden of ['/bind', '/claim', '/view', '/query', '/body']) {
    const hit = [...env.routes.keys()].filter((key) => key.includes('/bili') && key.includes(forbidden));
    assert.deepEqual(hit, [], forbidden);
  }
  const targetRoutes = [...env.routes.keys()].filter((key) => key.includes('/bili') && key.includes('/target'));
  assert.deepEqual(targetRoutes, ['PUT /bili/dm/target']);
});

test('login routes ignore body identity, return QR only from the dedicated response and never echo a manual cookie', async (t) => {
  const env = await biliFixture(t);
  const started = await env.route('POST', '/bili/login/start', {
    body: { owner: true, chatId: 'evil-target', userId: 'evil-target' },
  });
  assert.equal(started.code, 200);
  assert.equal(env.calls.loginStart, 1);
  assert.match(started.data.pngDataUrl, /^data:image\/png;base64,/);

  const loginStatus = await env.route('GET', '/bili/login/status');
  assert.equal(loginStatus.data.state, 'waiting');
  assert.match(loginStatus.data.pngDataUrl, /^data:image\/png;base64,/);

  const dmStatus = await env.route('GET', '/bili/dm/status');
  assert.equal(JSON.stringify(dmStatus.data).includes('data:image'), false);

  const manual = await env.route('POST', '/bili/login/manual', {
    body: { cookie: PRIVATE_COOKIE, owner: true, chatId: 'evil-target', userId: 'evil-target' },
  });
  assert.equal(manual.code, 200);
  assert.equal(env.calls.loginManual[0], PRIVATE_COOKIE);
  assert.equal(JSON.stringify(manual.data).includes('synthetic-cookie'), false);
  assert.equal(JSON.stringify(manual.data).includes(PRIVATE_COOKIE), false);

  const inspect = await env.route('GET', '/bili/login/inspect');
  assert.equal(inspect.data.state, 'valid');

  const cancelled = await env.route('POST', '/bili/login/cancel', { body: { owner: true } });
  assert.equal(cancelled.data.state, 'cancelled');
  assert.equal(env.calls.loginCancel, 1);

  const logout = await env.route('POST', '/bili/login/logout', { body: { owner: true, chatId: 'evil' } });
  assert.equal(logout.code, 200);
  assert.equal(env.calls.loginLogout, 1);
  assert.match(logout.data.warning, /共享/);
  assert.match(logout.data.warning, /不会注销/);
});

test('DM config and test endpoints reject or ignore request-body targets and keep the server binding', async (t) => {
  const env = await biliFixture(t);
  env.login.inspectState = 'valid';
  const spoof = { owner: true, chatId: 'evil-target', userId: 'evil-target', target: 'evil-target' };
  const saved = await env.route('PUT', '/bili/dm/config', {
    body: { ...spoof, biliDmEnabled: true, biliDmPollSeconds: 240, biliDmIncludeSystem: true },
  });
  assert.equal(saved.code, 200);
  assert.equal(env.ctx.config.biliDmEnabled, true);
  assert.equal(env.ctx.config.biliDmPollSeconds, 240);
  assert.equal(env.store.binding().target, 'owner-1');
  assert.equal(JSON.stringify(saved.data).includes('evil-target'), false);
  assert.equal(saved.data.dm.binding.mask.includes('owner'), false);

  const invalid = await env.route('PUT', '/bili/dm/config', { body: { biliDmPollSeconds: 5 } });
  assert.equal(invalid.code, 400);

  const tested = await env.route('POST', '/bili/dm/test', { body: { ...spoof, text: PRIVATE_BODY } });
  assert.equal(tested.code, 200);
  assert.equal(env.calls.sendTest.length, 1);
  assert.deepEqual(env.calls.sendTest[0], { mode: 'stored-binding' });
  assert.equal(JSON.stringify(tested.data).includes('evil-target'), false);

  const checked = await env.route('POST', '/bili/dm/check', { body: { ...spoof } });
  assert.equal(checked.code, 200);
  assert.equal(env.calls.serviceCheck, 1);
});

test('DM status is an exact whitelist without UID, target id, sender, body or QR image', async (t) => {
  const env = await biliFixture(t);
  env.setServiceStatus({
    state: 'watching',
    reasonCode: 'DM_NETWORK',
    binding: { bound: true, mask: '***0001', target: 'owner-1', uid: PRIVATE_UID },
    account: { loggedIn: true, verified: true, uid: PRIVATE_UID, uname: 'private-uname' },
    queue: {
      unfinished: 1, pending: 2, unknown: 3, failed: 4, sent: 5,
      lastBody: PRIVATE_BODY, sender: PRIVATE_SENDER,
    },
    sender: PRIVATE_SENDER,
    text: PRIVATE_BODY,
    pngDataUrl: 'data:image/png;base64,cHJpdmF0ZQ==',
  });
  env.login.pngDataUrl = 'data:image/png;base64,cHJpdmF0ZQ==';
  const status = await env.route('GET', '/bili/dm/status');
  const text = JSON.stringify(status.data);
  assert.equal(status.data.state, 'watching');
  assert.equal(status.data.reasonCode, 'DM_NETWORK');
  assert.match(status.data.reasonText, /B 站/);
  assert.equal(status.data.binding.bound, true);
  assert.equal(status.data.binding.mask, '***0001');
  assert.equal(status.data.queue.unfinished, 1);
  assert.equal(status.data.queue.pending, 2);
  assert.equal(text.includes('owner-1'), false);
  assert.equal(text.includes(PRIVATE_UID), false);
  assert.equal(text.includes('private-uname'), false);
  assert.equal(text.includes(PRIVATE_BODY), false);
  assert.equal(text.includes(PRIVATE_SENDER), false);
  assert.equal(text.includes('data:image'), false);
  assert.equal(text.includes('target'), false);
});

test('public aggregate responses and the page template never leak private objects or content', async (t) => {
  const env = await biliFixture(t);
  env.setServiceStatus({
    binding: { bound: true, mask: '***0001', target: 'owner-1' },
    queue: { unfinished: 1, pending: 0, unknown: 0, failed: 0, sent: 0, lastBody: PRIVATE_BODY },
    text: PRIVATE_BODY,
    sender: PRIVATE_SENDER,
  });
  const responses = [];
  for (const [method, url] of [
    ['GET', '/status'], ['GET', '/config'], ['GET', '/platforms'],
    ['GET', '/boundaries'], ['GET', '/bili/dm/status'], ['GET', '/bili/login/status'],
  ]) {
    responses.push((await env.route(method, url)).data);
  }
  const serialized = JSON.stringify(responses);
  for (const secret of ['owner-1', PRIVATE_UID, PRIVATE_BODY, PRIVATE_SENDER, 'private-uname', 'data:image']) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  const html = await fs.readFile(new URL('../page.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /v0\.4\.2/);
  assert.match(html, /B站私信提醒/);
  assert.match(html, /dm-login-start/);
  assert.match(html, /\/bili\/dm\/status/);
  assert.match(html, /\/bili\/login\/start/);
  assert.equal(script.includes('innerHTML'), false);
  // v0.3 permits a bot-scoped, nonsecret provider preference.
  assert.match(script, /media-parser\.dmProvider\./);
  assert.doesNotMatch(script, /\.setItem\([^,\n]*,\s*(?:token|cookie|pngDataUrl)\s*\)/);
  assert.equal(script.includes('cdn'), false);
  assert.equal(script.includes("dm-login-start').click()"), false);
  assert.match(script, /pagehide/);
  assert.match(script, /loadLoginStatus/);
});

test('group picker exposes only host-validated groups and saves one explicit destination', async (t) => {
  const env = await biliFixture(t, {
    groups: {
      'group-known': { name: '测试群', note: 'note' },
      'group-disabled': { name: '停用群', enabled: false },
    },
    ledgerStats: {
      byChat: {
        'group-known': { kind: 'group' },
        'group-disabled': { kind: 'group' },
        'owner-1': { kind: 'c2c' },
        'group-unknown': { kind: 'group' },
      },
      file: 'PRIVATE-LEDGER-FILE',
      content: PRIVATE_BODY,
    },
  });
  await env.runtime.dmReady;
  const listed = await env.route('GET', '/bili/dm/groups');
  assert.equal(listed.code, 200);
  assert.deepEqual(listed.data.groups, [{ id: 'group-known', name: '测试群' }]);
  assert.deepEqual(listed.data.selected, { sendToGroup: false, groupId: '' });
  assert.equal(JSON.stringify(listed.data).includes('PRIVATE'), false);

  const saved = await env.route('PUT', '/bili/dm/target', {
    body: { sendToGroup: true, groupId: 'group-known', owner: true, chatId: 'evil', userId: 'evil', target: 'group-unknown' },
  });
  assert.equal(saved.code, 200);
  assert.deepEqual(saved.data.selected, { sendToGroup: true, groupId: 'group-known' });
  assert.deepEqual(env.calls.configureTarget, [{ kind: 'group', target: 'group-known' }]);
  assert.equal(env.store.binding().target, 'owner-1');
  assert.equal(env.store.binding().notifyKind, 'group');
  assert.equal(env.store.binding().groupTarget, 'group-known');

  const status = await env.route('GET', '/bili/dm/status');
  assert.deepEqual(status.data.destination, { kind: 'group', label: '群 ***nown' });
  assert.equal(JSON.stringify(status.data).includes('group-known'), false);

  const disabled = await env.route('PUT', '/bili/dm/target', { body: { sendToGroup: true, groupId: 'group-disabled' } });
  assert.equal(disabled.code, 400);
  const unknown = await env.route('PUT', '/bili/dm/target', { body: { sendToGroup: true, groupId: 'group-unknown' } });
  assert.equal(unknown.code, 400);
  assert.equal(env.calls.configureTarget.length, 1);

  const cleared = await env.route('PUT', '/bili/dm/target', { body: { sendToGroup: false, groupId: 'group-known' } });
  assert.equal(cleared.code, 200);
  assert.deepEqual(cleared.data.selected, { sendToGroup: false, groupId: '' });
  assert.deepEqual(env.calls.configureTarget[1], { kind: 'c2c', target: '' });
  assert.equal(env.store.binding().notifyKind, 'c2c');
  assert.equal(env.store.binding().groupTarget, '');
});

test('group destination fails safely when the delivery worker has no group API', async (t) => {
  const env = await biliFixture(t, {
    groups: { 'group-known': { name: '测试群' } },
  });
  await env.runtime.dmReady;
  delete env.dmDelivery.configureTarget;
  const result = await env.route('PUT', '/bili/dm/target', { body: { sendToGroup: true, groupId: 'group-known' } });
  assert.equal(result.code, 400);
  assert.match(result.data.error, /尚不支持群目标/);
  assert.equal(JSON.stringify(result.data).includes('group-known'), false);
  assert.equal(env.store.binding().notifyKind, 'c2c');
});
