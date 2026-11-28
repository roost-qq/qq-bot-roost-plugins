import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlugin } from '../index.js';
import { DEFAULTS } from '../settings.js';
import { createBiliLogin } from '../bili-login.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const PNG = 'data:image/png;base64,AA==';
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(testDir, '.login-'));
  const uidPart = ['DedeUser', 'ID=123'].join('');
  const initialCookie = [uidPart, 'SESSDATA=offline-login-test'].join('; ');
  await fs.writeFile(path.join(dir, 'credentials.json'), JSON.stringify({
    bilibili_enhanced: { cookie: initialCookie },
  }, null, 2));
  const calls = { nav: 0, generate: 0, poll: 0 };
  let fakeNow = Date.now();
  const advance = (ms) => { fakeNow += Math.max(0, Math.floor(Number(ms) || 0)); };
  const client = {
    async nav() { calls.nav += 1; return { mid: '425503913', uname: 'test-account' }; },
    async generateQr() { calls.generate += 1; return { url: 'https://qr.invalid/offline', key: 'qr-test-key' }; },
    async pollQr() { calls.poll += 1; return { state: 'waiting' }; },
  };
  const store = {
    ready: Promise.resolve(),
    binding: () => ({ target: 'owner-1', notifyKind: 'c2c', groupTarget: '', version: 1 }),
    read: (fn) => fn({ binding: { target: 'owner-1', notifyKind: 'c2c', groupTarget: '', version: 1 } }),
    async transaction(fn) { return fn({ binding: { target: 'owner-1' } }); },
    async flush() {},
  };
  const delivery = {
    async bind() { return { mask: '***0001' }; },
    async claim() { return { handled: false }; },
    async view() { return { ok: false }; },
    async sendTest() { return { sent: 1 }; },
    async pump() {},
    async pumpNotices() {},
    async configureTarget() {},
    async flush() {},
    deactivate() {},
  };
  const modules = {
    createBiliDmStore: () => store,
    createBiliDmDelivery: () => delivery,
    createBiliDmService: () => ({
      ready: Promise.resolve(),
      status: () => ({
        state: 'disabled', reasonCode: 'DM_DISABLED',
        lastCheckAt: null, lastSuccessAt: null, nextRetryAt: null,
        account: { loggedIn: false, verified: false },
        binding: { bound: true, mask: '***0001', version: 1 },
        discovery: { phase: 'idle', baselineComplete: false, pages: 0, sessionCount: 0, gap: false },
        queue: {
          unfinished: 0, pending: 0, unknown: 0, failed: 0, sent: 0,
          pendingConversations: 0, gapConversations: 0,
        },
        polling: { seconds: 300, requestBudget: 6 },
        noticePending: false,
      }),
      start() {}, pause() {}, async check() {}, deactivate() {}, async flush() {},
      configChanged() {},
    }),
  };
  const routes = new Map();
  const ctx = {
    id: 'media-parser', name: '流媒体聚合解析', version: '0.3.0', prefix: '/',
    dataDir: dir, state: {},
    config: { ...DEFAULTS, biliDmEnabled: false },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    storage: {
      async get(key, fallback) { return this.map?.get(key) ?? fallback; },
      async set(key, value) { (this.map ??= new Map()).set(key, structuredClone(value)); },
      async update(key, fn, fallback) { const value = await fn((this.map ??= new Map()).get(key) ?? fallback); this.map.set(key, value); return value; },
      async delete(key) { this.map?.delete(key); },
      async all() { return Object.fromEntries(this.map ?? new Map()); },
      async flush() {},
    },
    api: { appId: 'login-cache-test' },
    delivery: { get: async () => null, fail: async () => {} },
    gate: { check: () => ({ ok: true, reasons: [] }) },
    async getGroup() { return null; },
    async isGroupAdmin() { return false; },
    async can() { return false; },
    isOwner: async () => true,
    async setConfig(patch) { Object.assign(ctx.config, patch); return ctx.config; },
    command() {}, on() {}, menu() {}, registerPage() {},
    registerRoute(method, url, fn) { routes.set(`${method} ${url}`, fn); },
    setDashboard() {}, onTeardown() {}, schedule() {},
  };
  const plugin = createPlugin({
    engineFactory: () => ({
      status: () => ({ state: 'ready', ready: true }),
      async ensure() { return true; }, async parse() { return { plan: { messages: [] } }; },
      async health() { return { state: 'ready', ready: true }; },
      async stop() { return true; }, async restart() { return true; },
      async clean() { return { removed: 0 }; },
    }),
    delivery: async () => ({ claimed: false }),
    dmModules: modules,
    biliClientFactory: () => client,
    biliLoginFactory: ({ settings, client: loginClient }) => createBiliLogin({
      settings, client: loginClient, qrEncode: () => PNG, now: () => fakeNow, inspectCacheMs: 60_000,
    }),
  });
  let runtime = null;
  t.after(async () => {
    if (runtime?.isActive?.()) await runtime.deactivate('test cleanup').catch(() => {});
    await runtime?.dm?.flush?.().catch?.(() => {});
    await runtime?.dmStore?.flush?.().catch?.(() => {});
    await runtime?.requestPolicy?.flush?.().catch?.(() => {});
    await runtime?.queue?.flush?.().catch?.(() => {});
    await runtime?.settings?.flush?.().catch?.(() => {});
    await runtime?.pageReady?.catch?.(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  plugin.setup(ctx);
  runtime = ctx.state.runtime;
  await runtime.ready;
  await runtime.dmReady;
  const route = async (method, url, { params = {}, query = {}, body = null } = {}) => {
    const fn = routes.get(`${method} ${url}`);
    if (!fn) throw new Error(`missing route ${method} ${url}`);
    const out = await fn({ method, url, params, query, body, json: (code, data) => ({ __response: { code, data } }) });
    return out?.__response ?? { code: 200, data: out };
  };
  return { dir, ctx, runtime, calls, route, advance };
}

test('inspect-valid cache is visible from every local GET until expiry or credential replacement', async (t) => {
  const env = await fixture(t);
  const inspected = await env.runtime.dmLoginInspect();
  assert.equal(inspected.state, 'valid');
  assert.equal(env.calls.nav, 1);

  const providerStatus = await env.runtime.providerStatus('bilibili');
  assert.equal(providerStatus.login.state, 'valid');
  assert.equal((await env.runtime.providerLoginStatus('bilibili')).state, 'valid');
  assert.equal(env.runtime.safeDmStatus().login.state, 'valid');
  assert.equal((await env.route('GET', '/bili/login/status')).data.state, 'valid');
  assert.equal((await env.route('GET', '/dm/providers/:provider/login/status', { params: { provider: 'bilibili' } })).data.state, 'valid');
  assert.equal((await env.route('GET', '/dm/providers/:provider/status', { params: { provider: 'bilibili' } })).data.login.state, 'valid');
  const list = await env.route('GET', '/dm/providers');
  assert.equal(list.data.providers.find((provider) => provider.id === 'bilibili').login.state, 'valid');
  assert.equal(env.calls.nav, 1, 'GET routes must not revalidate upstream');

  env.advance(60_001);
  assert.equal((await env.runtime.providerLoginStatus('bilibili')).state, 'idle');
  assert.equal(env.calls.nav, 1, 'expired cache must not claim valid');
  assert.equal((await env.runtime.dmLoginInspect()).state, 'valid');
  assert.equal(env.calls.nav, 2, 'expired cache revalidates only on explicit inspect');

  await env.runtime.settings.setBiliCookie('DedeUserID=999; SESSDATA=replacement-cookie');
  assert.equal((await env.runtime.providerLoginStatus('bilibili')).state, 'idle');
  assert.equal(env.calls.nav, 2, 'credential replacement must invalidate without network');

  assert.equal((await env.runtime.dmLoginInspect()).state, 'valid');
  assert.equal(env.calls.nav, 3);
  const started = await env.runtime.dmLoginStart();
  assert.equal(['starting', 'waiting'].includes(started.state), true);
  assert.equal((await env.runtime.providerLoginStatus('bilibili')).state, started.state);
  assert.equal(env.calls.nav, 3, 'active QR state must take priority over cached validation');
  await env.runtime.dmLoginCancel();
  await tick();
  assert.equal((await env.runtime.dmLoginLogout()).ok, true);
});
