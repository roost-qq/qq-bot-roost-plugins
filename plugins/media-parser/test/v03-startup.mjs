import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createPlugin } from '../index.js';
import { DEFAULTS } from '../settings.js';
import { createBiliDmStore } from '../bili-dm-store.js';
import { createBiliDmService, REQUEST_BUDGET } from '../bili-dm.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function withTimeout(promise, ms = 2500) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref?.()),
  ]);
}

function botKeyFor(dir) {
  return createHash('sha256').update(String(dir)).digest('hex').slice(0, 16);
}

async function seedPersistedState(dir) {
  const store = createBiliDmStore({ dataDir: dir, robotKey: botKeyFor(dir) });
  await store.ready;
  const now = Date.now();
  await store.transaction((draft) => {
    draft.currentUid = '123';
    draft.binding = {
      target: 'owner-1', version: 1, updatedAt: now,
      notifyKind: 'c2c', groupTarget: '', groupName: '',
    };
    draft.accounts['123'] = {
      uid: '123', createdAt: now - 10_000, updatedAt: now,
      discovery: {
        phase: 'rescan', baselineComplete: true,
        baselineStartedAt: now - 10_000, monitorStartTs: now - 10_000,
        endTs: String(now), scanActive: false, pages: 10, sessionCount: 1052,
        scannedAt: now, lastServerTime: now, gap: null,
      },
      conversations: {}, messages: {}, segments: {},
    };
  });
  return store;
}

async function startupFixture(t, { enabled, config = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(testDir, '.startup-'));
  await fs.writeFile(path.join(dir, 'credentials.json'), JSON.stringify({
    bilibili_enhanced: { cookie: 'DedeUserID=123; SESSDATA=offline-startup-test' },
  }, null, 2));
  const seeded = await seedPersistedState(dir);
  const navStarted = deferred();
  const calls = { nav: 0, parse: 0, ensure: 0, deliveryPump: 0 };
  const engine = {
    status: () => ({ state: 'ready', ready: true }),
    async ensure() { calls.ensure += 1; return true; },
    async parse() { calls.parse += 1; return { links: [], items: [], plan: { messages: [] } }; },
    async health() { return { state: 'ready', ready: true }; },
    async stop() { return true; },
    async restart() { return true; },
    async clean() { return { removed: 0 }; },
  };
  const dmDelivery = {
    async pump() { calls.deliveryPump += 1; },
    async pumpNotices() {},
    async reconcile() {},
    async flush() {},
    deactivate() {},
    async configureTarget() {},
  };
  const modules = {
    createBiliDmStore,
    createBiliDmService,
    createBiliDmDelivery: () => dmDelivery,
  };
  const client = {
    async nav(cookie, options = {}) {
      calls.nav += 1;
      navStarted.resolve();
      return new Promise((_, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal?.addEventListener?.('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  const login = {
    status: () => ({ state: 'missing' }),
    async start() { return { state: 'waiting' }; },
    cancel() { return { state: 'cancelled' }; },
    async inspect() { return { state: 'missing' }; },
    async manual() { return { ok: false, state: 'invalid' }; },
    async logout() { return { ok: true, state: 'idle' }; },
    deactivate() {},
  };
  const ctx = {
    id: 'media-parser', name: '流媒体聚合解析', version: '0.3.0', prefix: '/',
    dataDir: dir, state: {},
    config: { ...DEFAULTS, biliDmEnabled: enabled, ...config },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    storage: {
      async get(key, fallback) { return this.map?.get(key) ?? fallback; },
      async set(key, value) { (this.map ??= new Map()).set(key, structuredClone(value)); },
      async update(key, fn, fallback) { const value = await fn((this.map ??= new Map()).get(key) ?? fallback); this.map.set(key, value); return value; },
      async delete(key) { this.map?.delete(key); },
      async all() { return Object.fromEntries(this.map ?? new Map()); },
      async flush() {},
    },
    api: { appId: 'startup-test' },
    delivery: { get: async () => null, fail: async () => {} },
    gate: { check: () => ({ ok: true, reasons: [] }) },
    async getGroup() { return null; },
    async isGroupAdmin() { return false; },
    async can() { return false; },
    isOwner: async () => true,
    async setConfig(patch) { Object.assign(ctx.config, patch); return ctx.config; },
    command() {}, on() {}, menu() {}, registerPage() {}, registerRoute() {},
    setDashboard() {}, onTeardown() {}, schedule() {},
    async callTool() { throw new Error('unexpected model call'); },
  };
  const plugin = createPlugin({
    engineFactory: () => engine,
    delivery: async () => ({ claimed: false }),
    dmModules: modules,
    biliClientFactory: () => client,
    biliLoginFactory: () => login,
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
  return { dir, ctx, calls, runtime, navStarted, plugin };
}

test('enabled startup with persisted Bili state starts the exact service and resumes the same baseline', async (t) => {
  const env = await startupFixture(t, {
    enabled: true,
    config: { biliDmPollSeconds: 1800, biliDmIncludeSystem: true },
  });
  await env.runtime.dmReady;
  assert.equal(env.runtime.dm.status().state !== 'disabled', true);
  await withTimeout(env.navStarted.promise);
  assert.equal(env.calls.nav, 1);

  const persisted = env.runtime.dmStore.read((value) => value);
  assert.equal(persisted.currentUid, '123');
  assert.equal(persisted.binding.target, 'owner-1');
  assert.equal(persisted.accounts['123'].discovery.baselineComplete, true);
  assert.equal(persisted.accounts['123'].discovery.phase, 'rescan');
  assert.equal(persisted.accounts['123'].discovery.pages, 10);
  assert.equal(persisted.accounts['123'].discovery.sessionCount, 1052);

  const status = await env.runtime.providerStatus('bilibili');
  assert.equal(status.polling.requestBudget, REQUEST_BUDGET);
  assert.equal(status.dm.polling.requestBudget, REQUEST_BUDGET);
  assert.equal(status.config.enabled, true);
  assert.equal(status.config.pollSeconds, 1800);
  assert.equal(status.config.includeSystem, true);

  await env.runtime.deactivate('test');
  const before = env.calls.nav;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(env.calls.nav, before, 'deactivation must prevent a late auto-start');
});
