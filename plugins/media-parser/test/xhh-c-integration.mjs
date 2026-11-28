import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlugin } from '../index.js';
import { createXiaoheiheRuntime } from '../xiaoheihe-runtime.js';
import { createXiaoheiheLogin } from '../xiaoheihe-login.js';
import { createSettings, DEFAULTS } from '../settings.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const PNG = 'data:image/png;base64,' + Buffer.from('native-xhh-qr').toString('base64');

function fakeLogin() {
  let state = { state: 'idle' };
  return {
    credentialState() {
      return { cookie: '', heyboxId: '', sessionVersion: 1, accountEpoch: 'test-account' };
    },
    async status() {
      return { ...state };
    },
    async start() {
      state = { state: 'waiting', pngDataUrl: PNG, expiresAt: Date.now() + 180_000 };
      return state;
    },
    async cancel() {
      state = { state: 'cancelled' };
      return state;
    },
    async inspect() {
      return { state: 'valid', heyboxId: '12345678', accountId: '12345678', nickname: '验收账号' };
    },
    async inspectAccount() {
      return { state: 'valid', heyboxId: '12345678', accountId: '12345678', nickname: '验收账号' };
    },
    async manual(cookie) {
      if (!cookie) return { ok: false, state: 'invalid' };
      state = { state: 'valid' };
      return { ok: true, state: 'valid' };
    },
    async logout() {
      state = { state: 'idle' };
      return { ok: true, state: 'idle' };
    },
    deactivate() {},
    async flush() {},
  };
}

function fakeClient() {
  return {
    async requestQr() {
      return {
        qrContent: 'https://api.xiaoheihe.cn/offline-qr',
        qrId: 'OFFLINE_C_TEST_QR',
        expiresAt: Date.now() + 180_000,
      };
    },
    async pollQr() {
      return { state: 'waiting' };
    },
    async checkAuthEndpoint() {
      return { authEndpointAccepted: true, state: 'valid', heyboxId: '12345678' };
    },
    async listConversations() {
      return {
        entries: [],
        shape: { recognized: true },
        precisionSafe: true,
        convertedIntegerCount: 0,
        serverTime: Date.now(),
        page: { hasMore: false, nextOffset: null, nextCursor: null, complete: true },
      };
    },
    async fetchDirectMessages() {
      return {
        messages: [],
        shape: { recognized: true },
        precisionSafe: true,
        convertedIntegerCount: 0,
        serverTime: Date.now(),
        page: { hasMore: false, nextOffset: null, nextCursor: null, complete: true },
      };
    },
  };
}

async function fixture(t, { realLogin = false } = {}) {
  const dir = await fs.mkdtemp(path.join(testDir, '.xhh-c-'));
  const routes = new Map();
  const calls = { network: 0 };
  const ctx = {
    id: 'media-parser', name: '流媒体聚合解析', version: '0.4.2', prefix: '/',
    dataDir: dir, state: {},
    config: { ...DEFAULTS },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    storage: {
      async get(key, fallback) { return this.map?.get(key) ?? fallback; },
      async set(key, value) { (this.map ??= new Map()).set(key, structuredClone(value)); },
      async update(key, fn, fallback) { const value = await fn((this.map ??= new Map()).get(key) ?? fallback); this.map.set(key, value); return value; },
      async delete(key) { this.map?.delete(key); },
      async all() { return Object.fromEntries(this.map ?? new Map()); },
      async flush() {},
    },
    api: { appId: 'test-bot' },
    delivery: { get: async () => null, fail: async () => {} },
    gate: { check: () => ({ ok: true }) },
    reach: { canC2C: async () => 'yes', canGroupPush: async () => 'yes' },
    quotaLeft: async () => 10,
    async getGroup(id) { return { groupId: id, groupOpenid: id, name: '测试群', enabled: true }; },
    async isGroupAdmin() { return false; },
    async can() { return false; },
    async isOwner() { return true; },
    async push() { calls.network += 0; return { id: 'not-sent-in-test' }; },
    async setConfig(patch) { Object.assign(ctx.config, patch); return ctx.config; },
    command() {},
    on() {},
    menu() {},
    registerPage() { return 'media-parser:manage'; },
    registerRoute(method, url, fn) { routes.set(`${method} ${url}`, fn); },
    setDashboard() {},
    onTeardown() {},
    schedule() {},
  };
  const store = {
    ready: Promise.resolve(),
    binding: () => ({ target: 'owner-openid', notifyKind: 'c2c' }),
    reserveSendCall: () => ({ remaining: 1 }),
    rateInfo: () => ({ used: 0, remaining: 2, nextAt: null }),
    flush: async () => {},
  };
  const plugin = createPlugin({
    engineFactory: () => ({
      status: () => ({ state: 'ready', ready: true }),
      async ensure() { return true; },
      async stop() { return true; },
      async restart() { return true; },
      async clean() { return { removed: 0 }; },
    }),
    delivery: async () => ({ claimed: false }),
    dmModules: {
      createBiliDmStore: () => store,
      createBiliDmDelivery: () => ({ bind: async () => ({ mask: '***1234' }), sendTest: async () => ({ sent: 1 }) }),
      createBiliDmService: () => ({
        ready: Promise.resolve(), status: () => ({ state: 'disabled' }),
        start() {}, pause() {}, async check() {}, deactivate() {}, configChanged() {},
      }),
    },
    biliClientFactory: () => ({ request: async () => ({}) }),
    biliLoginFactory: () => ({
      status: () => ({ state: 'valid' }),
      async start() { return { state: 'waiting' }; },
      cancel() { return { state: 'cancelled' }; },
      async inspect() { return { state: 'valid' }; },
      async manual() { return { ok: true, state: 'valid' }; },
      async logout() { return { ok: true, state: 'idle' }; },
      deactivate() {},
    }),
    xhhRuntimeFactory: (options) => createXiaoheiheRuntime({
      ...options,
      clientFactory: async () => fakeClient(),
      loginFactory: realLogin
        ? async (input) => createXiaoheiheLogin({ ...input, qrEncode: () => PNG })
        : async () => fakeLogin(),
      autoSchedule: false,
      now: () => Date.now(),
    }),
  });
  plugin.setup(ctx);
  const runtime = ctx.state.runtime;
  await runtime.ready;
  await runtime.dmReady.catch(() => {});
  await runtime.xhhReady;
  const route = async (method, url, { body = null, params = {}, query = {} } = {}) => {
    const fn = routes.get(`${method} ${url}`);
    if (!fn) throw new Error(`missing route ${method} ${url}`);
    const out = await fn({ body, params, query, method, json: (code, data) => ({ __response: { code, data } }) });
    return out?.__response ?? { code: 200, data: out };
  };
  t.after(async () => {
    try { await runtime.deactivate('test cleanup'); } catch {}
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try { await fs.rm(dir, { recursive: true, force: true }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
  });
  return { runtime, route, calls, ctx };
}

test('real Xiaoheihe runtime is wired through the authenticated provider routes without network', async (t) => {
  const env = await fixture(t);
  assert.ok(env.runtime.xhh, 'native runtime should be created');
  const status = await env.route('GET', '/dm/providers/:provider/status', { params: { provider: 'xiaoheihe' } });
  assert.equal(status.code, 200, JSON.stringify(status.data));
  assert.equal(status.data.provider.capabilities.verified, true);
  assert.equal(status.data.provider.capabilities.experimental, undefined);
  assert.equal(status.data.provider.capabilities.available, true);
  assert.equal(status.data.config.enabled, false);
  assert.equal(status.data.provider.id, 'xiaoheihe');

  const started = await env.route('POST', '/dm/providers/:provider/login/start', { params: { provider: 'xiaoheihe' } });
  assert.equal(started.code, 200, JSON.stringify(started.data));
  assert.equal(started.data.state, 'waiting');
  assert.equal(started.data.pngDataUrl, PNG, JSON.stringify(started.data));

  const loginStatus = await env.route('GET', '/dm/providers/:provider/login/status', { params: { provider: 'xiaoheihe' } });
  assert.equal(loginStatus.code, 200);
  // The dedicated authenticated login GET must keep the current QR available so
  // a refreshed page can reopen it. The ordinary status route strips it below.
  assert.equal(loginStatus.data.pngDataUrl, PNG);
  assert.equal(loginStatus.data.state, 'waiting');

  const ordinaryStatus = await env.route('GET', '/dm/providers/:provider/status', { params: { provider: 'xiaoheihe' } });
  assert.equal(JSON.stringify(ordinaryStatus.data).includes(PNG), false);

  const inspect = await env.route('POST', '/dm/providers/:provider/login/inspect', { params: { provider: 'xiaoheihe' } });
  assert.equal(inspect.code, 200);
  assert.equal(inspect.data.state, 'valid');
  assert.equal(JSON.stringify(inspect.data).includes('12345678'), false);

  const config = await env.route('PUT', '/dm/providers/:provider/config', {
    params: { provider: 'xiaoheihe' }, body: { config: { enabled: true, pollSeconds: 420 } },
  });
  assert.equal(config.code, 200);
  assert.equal(config.data.dm.config.enabled, true);
  assert.equal(config.data.dm.config.pollSeconds, 420);
  assert.equal(env.ctx.config.xiaoheiheDmEnabled, true);
  assert.equal(env.ctx.config.xiaoheiheDmPollSeconds, 420);
  assert.equal(env.runtime.xhh.getStatus().config.enabled, true);
  assert.equal(env.runtime.xhh.getStatus().config.pollSeconds, 420);

  const nestedOff = await env.route('PUT', '/dm/providers/:provider/config', {
    params: { provider: 'xiaoheihe' }, body: { config: { enabled: false, pollSeconds: 360 } },
  });
  assert.equal(nestedOff.code, 200, JSON.stringify(nestedOff.data));
  assert.equal(nestedOff.data.dm.config.enabled, false);
  assert.equal(nestedOff.data.dm.config.pollSeconds, 360);
  assert.equal(env.ctx.config.xiaoheiheDmEnabled, false);
  assert.equal(env.ctx.config.xiaoheiheDmPollSeconds, 360);
  assert.equal(env.runtime.xhh.getStatus().config.enabled, false);
  assert.equal(env.runtime.xhh.getStatus().config.pollSeconds, 360);

  const flatOn = await env.route('PUT', '/dm/providers/:provider/config', {
    params: { provider: 'xiaoheihe' }, body: { enabled: true, pollSeconds: 300 },
  });
  assert.equal(flatOn.code, 200, JSON.stringify(flatOn.data));
  assert.equal(flatOn.data.dm.config.enabled, true);
  assert.equal(env.ctx.config.xiaoheiheDmEnabled, true);

  await env.runtime.xhh.flush();
  const acceptance = await env.route('GET', '/dm/providers/:provider/acceptance', {
    params: { provider: 'xiaoheihe' }, query: { limit: '100' },
  });
  assert.equal(acceptance.code, 200);
  assert.equal(acceptance.data.providerId, 'xiaoheihe');
  assert.ok(Array.isArray(acceptance.data.events));
  assert.ok(acceptance.data.events.some((event) => event.event === 'auth' || event.type === 'auth'),
    JSON.stringify(acceptance.data.events));
  const serialized = JSON.stringify(acceptance.data);
  assert.equal(serialized.includes('12345678'), false);
  assert.equal(serialized.includes('验收账号'), false);

  const logout = await env.route('POST', '/dm/providers/:provider/login/logout', { params: { provider: 'xiaoheihe' } });
  assert.equal(logout.code, 200);
  assert.equal(logout.data.ok, true);
  assert.equal(env.calls.network, 0);
});

test('real A login through C routes keeps numeric Xhh session version and isolates Bili', async (t) => {
  const env = await fixture(t, { realLogin: true });
  assert.ok(env.runtime.xhh, 'native runtime with the real A login must exist');
  const beforeBili = env.runtime.settings?.getBiliSessionVersion?.();

  const started = await env.route('POST', '/dm/providers/:provider/login/start', { params: { provider: 'xiaoheihe' } });
  assert.equal(started.code, 200, JSON.stringify(started.data));
  assert.equal(started.data.state, 'waiting');
  assert.equal(started.data.pngDataUrl, PNG);

  const current = await env.route('GET', '/dm/providers/:provider/login/status', { params: { provider: 'xiaoheihe' } });
  assert.equal(current.code, 200);
  assert.equal(current.data.pngDataUrl, PNG, 'dedicated login GET keeps the real A QR');

  const saved = await env.route('POST', '/dm/providers/:provider/login/manual', {
    params: { provider: 'xiaoheihe' },
    body: { cookie: 'user_pkey=C_TEST_OFFLINE_SECRET; heybox_id=12345678' },
  });
  assert.equal(saved.code, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.ok, true);
  assert.ok(['valid', 'success'].includes(saved.data.state));
  assert.equal(typeof saved.data.sessionVersion, 'number');
  assert.equal(saved.data.sessionVersion, 1);

  const after = await env.route('GET', '/dm/providers/:provider/login/status', { params: { provider: 'xiaoheihe' } });
  assert.equal(after.code, 200, JSON.stringify(after.data));
  assert.ok(['valid', 'success'].includes(after.data.state));
  assert.equal(after.data.sessionVersion, 1);
  assert.equal(JSON.stringify(after.data).includes('C_TEST_OFFLINE_SECRET'), false);
  assert.equal(JSON.stringify(after.data).includes('12345678'), false);

  const ordinary = await env.route('GET', '/dm/providers/:provider/status', { params: { provider: 'xiaoheihe' } });
  assert.equal(JSON.stringify(ordinary.data).includes('data:image/png'), false);
  assert.equal(JSON.stringify(ordinary.data).includes('C_TEST_OFFLINE_SECRET'), false);
  assert.equal(env.runtime.settings?.getBiliSessionVersion?.(), beforeBili);

  const files = await fs.readFile(path.join(env.ctx.dataDir, 'engine-settings.json'), 'utf8').catch(() => '');
  assert.equal(files.includes('C_TEST_OFFLINE_SECRET'), false);

  const logout = await env.route('POST', '/dm/providers/:provider/login/logout', { params: { provider: 'xiaoheihe' } });
  assert.equal(logout.code, 200);
  assert.equal(logout.data.ok, true);
  assert.equal(env.calls.network, 0);
});

test('settings replace erases only the target Xhh secrets and preserves reload metadata', async (t) => {
  const env = await fixture(t, { realLogin: true });
  const settings = env.runtime.settings;
  const secretCookie = 'user_pkey=C_RELOAD_SECRET; heybox_id=12345678; nickname=Reload';
  const arbitrarySecret = 'XHH_ARBITRARY_SECRET';
  const nestedSecret = 'XHH_NESTED_SECRET';
  const otherProviderSecret = 'WEIBO_FAKE_OTHER_PROVIDER_SECRET';
  const biliSecret = 'BILI_RELOAD_COOKIE';

  await settings.setBiliCookie(biliSecret);
  await settings.saveCredentials({ weibo_enhanced: { cookie: otherProviderSecret } });
  const saved = await env.route('POST', '/dm/providers/:provider/login/manual', {
    params: { provider: 'xiaoheihe' },
    body: { cookie: secretCookie },
  });
  assert.equal(saved.code, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.ok, true);
  assert.equal(saved.data.sessionVersion, 1);

  // A normal patch still deep-merges, so the regression can prove that only an
  // explicit replace removes fields this build does not know about.
  await settings.setPrivateMessageProviderCredentials('xiaoheihe', {
    legacyCookie: arbitrarySecret,
    nested: { token: nestedSecret },
  });
  let stored = JSON.parse(await fs.readFile(settings.credentialsFile, 'utf8'));
  let xhh = stored.privateMessageProviders.xiaoheihe;
  assert.equal(xhh.legacyCookie, arbitrarySecret);
  assert.equal(xhh.nested.token, nestedSecret);
  assert.equal(xhh.sessionVersion, 1);
  const priorEpoch = xhh.accountEpoch;
  const otherBefore = stored.weibo_enhanced;

  const logout = await env.route('POST', '/dm/providers/:provider/login/logout', {
    params: { provider: 'xiaoheihe' },
  });
  assert.equal(logout.code, 200, JSON.stringify(logout.data));
  assert.equal(logout.data.ok, true);
  assert.ok(['idle', 'missing'].includes(logout.data.state));
  assert.equal(logout.data.sessionVersion, 2);
  assert.equal(typeof logout.data.accountEpoch, 'string');
  assert.equal(logout.data.accountEpoch.length > 0, true);

  stored = JSON.parse(await fs.readFile(settings.credentialsFile, 'utf8'));
  xhh = stored.privateMessageProviders.xiaoheihe;
  assert.equal(logout.data.accountEpoch, xhh.accountEpoch);
  assert.deepEqual(Object.keys(xhh).sort(), ['accountEpoch', 'cookie', 'heyboxId', 'nickname', 'sessionVersion']);
  assert.equal(xhh.cookie, '');
  assert.equal(xhh.heyboxId, '');
  assert.equal(xhh.nickname, '');
  assert.equal(xhh.sessionVersion, 2);
  assert.notEqual(xhh.accountEpoch, priorEpoch);
  assert.equal('legacyCookie' in xhh, false);
  assert.equal('nested' in xhh, false);
  assert.equal(stored.bilibili_enhanced.cookie, biliSecret);
  assert.deepEqual(stored.weibo_enhanced, otherBefore);
  const rawCredentials = await fs.readFile(settings.credentialsFile, 'utf8');
  assert.equal(rawCredentials.includes('C_RELOAD_SECRET'), false);
  assert.equal(rawCredentials.includes(arbitrarySecret), false);
  assert.equal(rawCredentials.includes(nestedSecret), false);

  // Reload must keep the numeric tombstone version for page ordering, keep the
  // erased partition empty, and leave Bili/other provider rules untouched.
  const reloaded = createSettings(env.ctx, { isActive: () => true });
  await reloaded.ready;
  const afterReload = reloaded.getPrivateMessageProviderCredentials('xiaoheihe');
  assert.equal(afterReload.cookie, '');
  assert.equal(afterReload.heyboxId, '');
  assert.equal(afterReload.sessionVersion, 2);
  assert.equal(afterReload.accountEpoch, xhh.accountEpoch);
  assert.equal('legacyCookie' in afterReload, false);
  assert.equal('nested' in afterReload, false);
  assert.equal(reloaded.getBiliCookie(), biliSecret);
  const reloadedStored = JSON.parse(await fs.readFile(reloaded.credentialsFile, 'utf8'));
  assert.deepEqual(reloadedStored.weibo_enhanced, otherBefore);
  await reloaded.flush();
});
