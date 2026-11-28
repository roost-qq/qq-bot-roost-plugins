import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tick } from './v03-integration-support.mjs';

const { createPlugin, VERSION } = await import('../index.js');
const settingsModule = await import('../settings.js');
const providersModule = await import('../private-message-providers.js');
const { credentialSecretConfig, stripPrivateMessageProviders } = await import('../engine-host.js');

const { DEFAULTS, validateConfig } = settingsModule;
const {
  PRIVATE_MESSAGE_PROVIDER_IDS, getPrivateMessageProvider,
  resolvePrivateMessageProvider, publicProviderCapabilities,
} = providersModule;
const testDir = path.dirname(fileURLToPath(import.meta.url));

function dmStatus(overrides = {}) {
  return {
    state: 'watching',
    reasonCode: '',
    lastCheckAt: null,
    lastSuccessAt: 1700000000000,
    nextRetryAt: null,
    account: { loggedIn: true, verified: true },
    binding: { bound: true, mask: '***1234', version: 1 },
    discovery: { phase: 'complete', baselineComplete: true, pages: 1, sessionCount: 1, gap: false },
    queue: {
      unfinished: 0, pending: 0, unknown: 0, failed: 0, sent: 0,
      pendingConversations: 0, gapConversations: 0,
    },
    polling: { seconds: 300, requestBudget: 20 },
    noticePending: false,
    ...overrides,
  };
}

function makeFakeModules(calls) {
  const store = {
    ready: Promise.resolve(),
    binding: () => calls.binding,
    flush: async () => { calls.storeFlush += 1; },
  };
  return {
    createBiliDmStore: () => store,
    createBiliDmDelivery: () => ({
      bind: async () => ({ mask: '***1234' }),
      claim: async () => ({ handled: false }),
      view: async () => ({ ok: false }),
      sendTest: async () => ({ sent: 1 }),
      configureTarget: async () => { calls.configureTarget += 1; },
    }),
    createBiliDmService: () => ({
      ready: Promise.resolve(),
      status: () => calls.dmStatus,
      start() { calls.serviceStart += 1; },
      pause() {},
      async check() { calls.check += 1; },
      deactivate() { calls.serviceDeactivate += 1; },
      configChanged() {},
    }),
  };
}

const XHH_SAFE_MESSAGES = Object.freeze({
  XHH_CANCELLED: '操作已取消。',
  XHH_AUTH: '小黑盒登录未通过。',
  XHH_RATE_LIMIT: '请求过于频繁。',
  XHH_RISK: '平台要求人工处理。',
  XHH_CHALLENGE: '平台要求完成验证。',
  XHH_TIMEOUT: '请求超时。',
  XHH_NETWORK: '网络暂时不可用。',
  XHH_HTTP: '平台服务暂时不可用。',
  XHH_RESPONSE: '响应无法识别。',
  XHH_API: '平台拒绝了请求。',
  XHH_LOGIN: '请先登录。',
  XHH_QR: '二维码不可用。',
  XHH_STORAGE: '本地保存失败。',
  XHH_REJECTED: '请求被拒绝。',
});

function makeFakeXhhRuntime(calls, ctx) {
  const qr = 'data:image/png;base64,' + Buffer.from('xhh-qr').toString('base64');
  let enabled = ctx?.config?.xiaoheiheDmEnabled === true;
  let pollSeconds = Number.isInteger(ctx?.config?.xiaoheiheDmPollSeconds)
    ? ctx.config.xiaoheiheDmPollSeconds : 300;
  let login = { state: 'missing', pngDataUrl: qr, sessionVersion: 7 };
  const status = () => ({
    config: { enabled, pollSeconds, effectivePollSeconds: pollSeconds, includeSystem: false, defaultTarget: 'c2c' },
    login,
    state: enabled ? 'watching_limited' : 'disabled',
    reasonCode: '',
    reasonText: '',
    lastCheckAt: 1700000000000,
    lastSuccessAt: 1700000000000,
    nextRetryAt: null,
    account: { loggedIn: login.state === 'valid', verified: false, version: 7 },
    binding: { bound: true, mask: '***1234', version: 1 },
    destination: { kind: 'c2c', label: '主人私聊' },
    discovery: { phase: 'limited', baselineComplete: false, pages: 1, sessionCount: 1, gap: true },
    queue: { unfinished: 0, pending: 0, unknown: 0, failed: 0, sent: 0 },
    polling: { requestBudget: 6, seconds: 300, paused: false },
    noticePending: false,
    accountEpoch: '11111111-2222-3333-4444-555555555555',
    sessionVersion: 7,
    accountVersion: 7,
  });
  return {
    ready: Promise.resolve(),
    getStatus: status,
    loginStatus: () => ({ ...login, pngDataUrl: undefined }),
    async loginStart() {
      calls.xhhLoginStart += 1;
      login = { state: 'waiting', pngDataUrl: qr, sessionVersion: 7 };
      return { ...login };
    },
    async loginCancel() {
      calls.xhhLoginCancel += 1;
      login = { state: 'cancelled', sessionVersion: 7 };
      return { ...login };
    },
    async loginInspect() {
      calls.xhhInspect += 1;
      login = { state: 'valid', sessionVersion: 7 };
      return { ...login };
    },
    async loginManual() {
      calls.xhhManual += 1;
      login = { state: 'valid', sessionVersion: 7 };
      return { ok: true, state: 'valid', sessionVersion: 7 };
    },
    async loginLogout() {
      calls.xhhLogout += 1;
      login = { state: 'idle', sessionVersion: 7 };
      return { ok: true, state: 'idle' };
    },
    async saveConfig(body) {
      calls.xhhSaveConfig += 1;
      if (body?.enabled === true || body?.config?.enabled === true) enabled = true;
      if (body?.enabled === false || body?.config?.enabled === false) enabled = false;
      if (Number.isInteger(body?.pollSeconds) && body.pollSeconds >= 180 && body.pollSeconds <= 3600) {
        pollSeconds = body.pollSeconds;
      }
      if (ctx?.config && body?.enabled !== undefined) ctx.config.xiaoheiheDmEnabled = enabled;
      if (ctx?.config && body?.pollSeconds !== undefined) ctx.config.xiaoheiheDmPollSeconds = pollSeconds;
      return { ok: true, dm: status() };
    },
    async groups() {
      return { groups: [{ id: 'group-1', name: '测试群' }], selected: { sendToGroup: false, groupId: '' } };
    },
    async setTarget() { calls.xhhSetTarget += 1; return { ok: true, selected: { sendToGroup: false, groupId: '' } }; },
    async check() {
      calls.xhhCheck += 1;
      login = { state: 'valid', sessionVersion: 7 };
      return { ok: true, dm: status() };
    },
    async sendTest() { calls.xhhSendTest += 1; return { ok: true, sent: 1, dm: status() }; },
    async acceptance({ limit }) {
      calls.xhhAcceptance += 1;
      calls.xhhAcceptanceLimit = limit;
      return {
        total: 2,
        events: [
          { phase: 'login', action: 'confirm', errorCode: 'XHH_AUTH', httpStatus: 401, counts: { pages: 1 }, at: 1700000000000, maskedTarget: '***1234' },
          { phase: 'sync', action: 'dedupe', counts: { messages: 2 }, serverTime: 1700000001000, messageHash: 'a'.repeat(32) },
        ].slice(0, limit),
      };
    },
    async pendingSummary() { calls.xhhPending += 1; return { pending: 2, unknown: 1 }; },
    async claim() { calls.xhhClaim += 1; return { handled: false }; },
    async view() { calls.xhhView += 1; return { ok: false }; },
    async clearRecovery() { calls.xhhRecovery += 1; return { cleared: true }; },
    deactivate() { calls.xhhDeactivate += 1; },
    async flush() { calls.xhhFlush += 1; },
  };
}

function makeFakeEngine() {
  return {
    status: () => ({ state: 'ready', ready: true }),
    async ensure() { return true; },
    async parse() { return { links: [], items: [], plan: { messages: [] } }; },
    async health() { return { state: 'ready', ready: true }; },
    async stop() { return true; },
    async restart() { return true; },
    async clean() { return { removed: 0 }; },
  };
}

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(testDir, '.v03-'));
  const calls = {
    clientFactory: 0, upstream: 0, inspect: 0, loginStart: 0, loginCancel: 0,
    manual: 0, logout: 0, check: 0, configureTarget: 0, serviceStart: 0,
    serviceDeactivate: 0, storeFlush: 0, setConfig: 0,
    xhhLoginStart: 0, xhhLoginCancel: 0, xhhInspect: 0, xhhManual: 0,
    xhhLogout: 0, xhhSaveConfig: 0, xhhSetTarget: 0, xhhCheck: 0,
    xhhSendTest: 0, xhhAcceptance: 0, xhhAcceptanceLimit: 0, xhhPending: 0,
    xhhClaim: 0, xhhView: 0, xhhRecovery: 0, xhhDeactivate: 0, xhhFlush: 0,
    binding: options.binding ?? { target: 'owner-openid', notifyKind: 'c2c' },
    dmStatus: dmStatus(options.dmStatus),
  };
  const xhhRuntimeFactory = options.fakeXhh
    ? () => makeFakeXhhRuntime(calls, ctx)
    : options.xhhRuntimeFactory ?? null;
  const commands = new Map();
  const routes = new Map();
  const listeners = new Map();
  const disposers = [];
  const ctx = {
    id: 'media-parser', name: '流媒体聚合解析', version: '0.3.0', prefix: '/',
    dataDir: dir, state: options.state ?? {},
    config: { ...DEFAULTS, ...(options.config ?? {}) },
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
    gate: { check: () => ({ ok: true, reasons: [] }) },
    async getGroup() { return null; },
    async isGroupAdmin() { return false; },
    async can() { return false; },
    isOwner: options.owner === true ? async () => true : async () => false,
    async setConfig(patch) {
      calls.setConfig += 1;
      if (options.setConfig) return options.setConfig(patch, ctx);
      Object.assign(ctx.config, patch);
      return ctx.config;
    },
    command(pattern, meta, fn) { commands.set(pattern.split(/\s+/)[0], { meta, fn }); },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
    menu() {},
    registerPage() { return 'media-parser:manage'; },
    registerRoute(method, url, fn) { routes.set(`${method} ${url}`, fn); return `${method} ${url}`; },
    setDashboard(value) { ctx.dashboard = value; },
    onTeardown(fn) { disposers.push(fn); },
    schedule() {},
    async callTool() { throw new Error('unexpected model call'); },
    registerTool() { throw new Error('unexpected tool'); },
  };
  const login = {
    status: () => ({ state: 'missing' }),
    async start() { calls.loginStart += 1; return { state: 'waiting' }; },
    cancel() { calls.loginCancel += 1; return { state: 'cancelled' }; },
    async inspect() { calls.inspect += 1; return { state: 'missing' }; },
    async manual() { calls.manual += 1; return { ok: false, state: 'invalid' }; },
    async logout() { calls.logout += 1; return { ok: true, state: 'idle' }; },
    deactivate() {},
  };
  const plugin = createPlugin({
    engineFactory: () => makeFakeEngine(),
    delivery: async () => ({ claimed: false }),
    dmModules: makeFakeModules(calls),
    biliClientFactory: ({ requestPolicy, requestScope }) => {
      calls.clientFactory += 1;
      calls.policy = requestPolicy;
      calls.requestScope = requestScope;
      return { request: async () => { calls.upstream += 1; } };
    },
    biliLoginFactory: () => login,
    xhhRuntimeFactory,
    xhhSafeMessages: XHH_SAFE_MESSAGES,
  });
  plugin.setup(ctx);
  const runtime = ctx.state.runtime;
  await runtime.ready;
  await runtime.dmReady.catch(() => {});
  await runtime.xhhReady.catch(() => {});
  const route = async (method, url, { body = null, params = {}, query = {} } = {}) => {
    const fn = routes.get(`${method} ${url}`);
    if (!fn) throw new Error(`missing route ${method} ${url}`);
    const out = await fn({ body, params, query, method, json: (code, data) => ({ __response: { code, data } }) });
    return out?.__response ?? { code: 200, data: out };
  };
  const makeMessage = ({ kind = 'c2c', userId = 'owner-1', chatId, args = [] } = {}) => {
    const replies = [];
    const msg = {
      kind, userId, chatId: chatId === undefined ? userId : chatId,
      groupId: kind === 'group' ? (chatId ?? userId) : '',
      userName: '测试用户', content: '', args, mentioned: false,
      isCommand: false, claimedBy: '', receivedAt: Date.now(), raw: {},
      async reply(text) { replies.push(String(text)); return null; },
    };
    return { msg, replies };
  };
  const runCommand = async (args, msgOptions = {}) => {
    const { msg, replies } = makeMessage({ ...msgOptions, args });
    await commands.get('解析').fn(msg);
    return replies;
  };
  t.after(async () => {
    const current = ctx.state.runtime ?? runtime;
    try { await current.deactivate?.('test cleanup'); } catch {}
    await current.requestPolicy?.flush?.().catch?.(() => {});
    await current.settings.flush().catch(() => {});
    await current.queue.flush?.().catch?.(() => {});
    await current.pageReady?.catch?.(() => {});
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 5) throw error;
        await tick();
      }
    }
  });
  return { dir, calls, ctx, plugin, runtime, commands, routes, route, runCommand, makeMessage };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('fixed provider registry keeps two ids, fixed aliases, and honest capabilities', () => {
  assert.deepEqual([...PRIVATE_MESSAGE_PROVIDER_IDS], ['bilibili', 'xiaoheihe']);
  assert.equal(resolvePrivateMessageProvider('B站').id, 'bilibili');
  assert.equal(resolvePrivateMessageProvider('哔哩哔哩').id, 'bilibili');
  assert.equal(resolvePrivateMessageProvider('bilibili').id, 'bilibili');
  assert.equal(resolvePrivateMessageProvider('小黑盒').id, 'xiaoheihe');
  assert.equal(resolvePrivateMessageProvider('heybox').id, 'xiaoheihe');
  assert.equal(resolvePrivateMessageProvider('weibo'), null);
  assert.equal(getPrivateMessageProvider('constructor'), null);
  assert.equal(publicProviderCapabilities('xiaoheihe').available, true);
  assert.deepEqual(publicProviderCapabilities('xiaoheihe'), {
    supportsPrivateMessages: true,
    supportsQrLogin: true,
    supportsManualLogin: true,
    transport: 'poll',
    verified: true,
    available: true,
  });
});

test('plugin/package version and 300s default with 180..3600 validation', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, '0.4.2');
  assert.equal(pkg.version, '0.4.2');
  assert.equal(DEFAULTS.biliDmPollSeconds, 300);
  assert.equal(DEFAULTS.xiaoheiheDmPollSeconds, 300);
  assert.equal(DEFAULTS.xiaoheiheDmEnabled, false);
  assert.equal(validateConfig({ biliDmPollSeconds: 180 }).biliDmPollSeconds, 180);
  assert.equal(validateConfig({ biliDmPollSeconds: 3600 }).biliDmPollSeconds, 3600);
  assert.equal(validateConfig({ xiaoheiheDmEnabled: true }).xiaoheiheDmEnabled, true);
  assert.equal(validateConfig({ xiaoheiheDmEnabled: false }).xiaoheiheDmEnabled, false);
  assert.throws(() => validateConfig({ biliDmPollSeconds: 179 }), /180/);
  assert.throws(() => validateConfig({ biliDmPollSeconds: 3601 }), /3600/);
  assert.throws(() => validateConfig({ xiaoheiheDmEnabled: 'true' }), /布尔值/);
});

test('real createSettings retains the complete baseline API and /status can read platforms', async (t) => {
  for (const name of [
    'PLATFORM_IDS', 'PLATFORM_NAMES', 'PLATFORM_MODES', 'DEFAULTS', 'MASK',
    'readConfig', 'validateConfig', 'isObject', 'deepMerge', 'redactUrl', 'redact',
    'engineDefaults', 'createSettings',
  ]) assert.ok(name in settingsModule, `missing export ${name}`);
  for (const name of [
    'readConfig', 'validateConfig', 'isObject', 'deepMerge', 'redactUrl', 'redact',
    'engineDefaults', 'createSettings',
  ]) assert.equal(typeof settingsModule[name], 'function', name);

  const env = await fixture(t);
  const settings = env.runtime.settings;
  for (const name of [
    'current', 'publicConfig', 'advanced', 'sanitize', 'credentialHints', 'platforms',
    'getBiliCookie', 'getBiliCookieRevision', 'getBiliAccountEpoch', 'subscribeBiliCookie',
    'setBiliCookie', 'clearBiliCookie', 'saveConfig', 'saveAdvanced', 'saveCredentials', 'flush',
  ]) assert.equal(typeof settings[name], 'function', `missing settings API ${name}`);
  assert.equal(settings.platforms().length, 31);
  assert.equal(settings.current().platformModes.bilibili, '全部发送');
  const status = await env.route('GET', '/status');
  assert.equal(status.code, 200);
  assert.equal(status.data.platformCount, 31);
});

test('Bili request scope hashes the supplied candidate cookie and preserves workflow identity', async (t) => {
  const env = await fixture(t);
  assert.equal(typeof env.calls.requestScope, 'function');
  const candidateCookie = ['DedeUserID=777', 'SESSDATA=candidate-value'].join('; ');
  const candidateContext = {
    workflowId: 'sync-run-42',
    endpoint: [],
    query: {},
    kind: 'control',
  };
  candidateContext.cookie = candidateCookie;
  const candidate = env.calls.requestScope(candidateContext);
  assert.equal(candidate.providerId, 'bilibili');
  assert.equal(candidate.accountKey, 'bilibili:uid:777');
  assert.match(candidate.credentialVersion, /^bilibili:777:[a-f0-9]{32}$/);
  assert.equal(candidate.workflowId, 'sync-run-42');
  const empty = env.calls.requestScope({ cookie: '' });
  assert.equal(empty.credentialVersion, 'bilibili:anonymous');
  assert.match(empty.accountKey, /^bilibili:anonymous:/);
});

test('provider status exposes a random account epoch that rotates on credential change', async (t) => {
  const env = await fixture(t);
  const before = await env.runtime.providerStatus('bilibili');
  assert.match(before.accountEpoch, /^[0-9a-f-]{36}$/);
  assert.equal(before.dm.accountEpoch, before.accountEpoch);
  assert.ok(Number.isSafeInteger(before.sessionVersion) && before.sessionVersion > 0);
  assert.ok(before.sessionVersion < Date.now());
  assert.equal(before.accountVersion, before.sessionVersion);
  assert.equal(before.account.version, before.sessionVersion);
  assert.equal(before.login.sessionVersion, before.sessionVersion);
  await env.runtime.settings.setBiliCookie('DedeUserID=123456; SESSDATA=private-cookie');
  const after = await env.runtime.providerStatus('bilibili');
  assert.notEqual(after.accountEpoch, before.accountEpoch);
  assert.equal(after.dm.accountEpoch, after.accountEpoch);
  assert.ok(after.sessionVersion > before.sessionVersion);
  assert.equal(after.accountVersion, after.sessionVersion);
  assert.equal(after.dm.sessionVersion, after.sessionVersion);
  assert.equal(after.dm.accountVersion, after.sessionVersion);
  assert.equal(after.dm.account.version, after.sessionVersion);
  assert.equal(after.login.sessionVersion, after.sessionVersion);
  assert.equal(env.runtime.dmLoginStatus(false).sessionVersion, after.sessionVersion);
  const loginAction = await env.runtime.providerLoginStart('bilibili');
  assert.equal(loginAction.sessionVersion, after.sessionVersion);
  const serialized = JSON.stringify(after);
  assert.equal(serialized.includes('123456'), false);
  assert.equal(serialized.includes('private-cookie'), false);
  assert.equal(env.calls.upstream, 0);
  assert.equal(env.calls.inspect, 0);
});

test('manual recovery requires an owner/panel operation and retains server-mandated waiting', async (t) => {
  const env = await fixture(t, { owner: true });
  const scope = { providerId: 'bilibili', accountKey: 'recovery-test-account', credentialVersion: 'recovery-test-version' };
  for (let i = 0; i < 3; i += 1) {
    await env.runtime.requestPolicy.recordFailure({
      ...scope, kind: 'rate_limit', retryAfterMs: 3_600_000, recoveryAttempt: true,
    });
  }
  const manual = await env.runtime.providerStatus('bilibili');
  assert.equal(manual.polling.manualRecoveryRequired, true);

  const route = await env.route('POST', '/dm/providers/:provider/recovery', {
    params: { provider: 'bilibili' },
  });
  assert.equal(route.code, 200);
  assert.equal(route.data.cleared, true);
  assert.equal(route.data.dm.polling.manualRecoveryRequired, false);
  assert.ok(route.data.dm.polling.serverNextAllowedAt > Date.now());
  assert.equal(route.data.dm.polling.paused, true);

  const legacy = await env.route('POST', '/bili/dm/recovery');
  assert.equal(legacy.code, 200);
  assert.equal(legacy.data.cleared, false);
  assert.equal(env.calls.upstream, 0);

  for (let i = 0; i < 3; i += 1) {
    await env.runtime.requestPolicy.recordFailure({
      ...scope, kind: 'rate_limit', retryAfterMs: 600_000, recoveryAttempt: true,
    });
  }
  const replies = await env.runCommand(['私信', '恢复']);
  assert.match(replies.join('\n'), /已清除人工恢复状态|受控恢复探测/);
  const afterCommand = await env.runtime.providerStatus('bilibili');
  assert.equal(afterCommand.polling.manualRecoveryRequired, false);
  assert.equal(env.calls.upstream, 0);
});

test('low interval migrates once to 300 and a failed host write keeps originals plus a safe floor', async (t) => {
  const failed = await fixture(t, {
    config: { biliDmPollSeconds: 60 },
    setConfig: async (patch, ctx) => {
      if (Object.prototype.hasOwnProperty.call(patch, 'biliDmPollSeconds')) {
        throw new Error('host write blocked');
      }
      Object.assign(ctx.config, patch);
    },
  });
  assert.equal(failed.runtime.settings.current().biliDmPollSeconds, 300);
  assert.equal(failed.ctx.config.biliDmPollSeconds, 60);
  assert.equal(failed.calls.setConfig, 1);
  assert.equal(failed.runtime.settings.configMigration().complete, false);
  assert.match(failed.runtime.settings.configMigration().notice, /原 60 秒已调整为 300 秒/);
  assert.match(failed.runtime.settings.configMigration().notice, /迁移尚未完成/);
  const failedAdvanced = await readJson(failed.runtime.settings.advancedFile);
  assert.notEqual(failedAdvanced.privateMessageConfigVersion, 1);

  await failed.runtime.settings.saveConfig({ xiaoheiheDmPollSeconds: 600 });
  assert.equal(failed.ctx.config.biliDmPollSeconds, 60);
  assert.equal(failed.runtime.settings.current().biliDmPollSeconds, 300);
  assert.equal(failed.runtime.settings.configMigration().complete, false);
  const afterXhhSave = await readJson(failed.runtime.settings.advancedFile);
  assert.notEqual(afterXhhSave.privateMessageConfigVersion, 1);

  const migrated = await fixture(t, { config: { biliDmPollSeconds: 60 } });
  assert.equal(migrated.ctx.config.biliDmPollSeconds, 300);
  assert.equal(migrated.runtime.settings.configMigration().complete, true);
  const migratedAdvanced = await readJson(migrated.runtime.settings.advancedFile);
  assert.equal(migratedAdvanced.privateMessageConfigVersion, 1);

  const kept = await fixture(t, { config: { biliDmPollSeconds: 600, biliDmEnabled: true } });
  assert.equal(kept.runtime.settings.current().biliDmPollSeconds, 600);
  assert.equal(kept.ctx.config.biliDmPollSeconds, 600);
  assert.equal(kept.runtime.settings.configMigration().complete, true);
});

test('xiaoheihe native runtime serves local status, explicit toggle, login and read-only acceptance', async (t) => {
  const env = await fixture(t, { fakeXhh: true, owner: true });
  const status = await env.runtime.providerStatus('xiaoheihe');
  assert.equal(status.provider.id, 'xiaoheihe');
  assert.equal(status.config.enabled, false);
  assert.equal(status.config.disabled, true);
  assert.equal(status.config.pollSeconds, 300);
  assert.equal(status.config.defaultTarget, 'c2c');
  assert.equal(status.login.state, 'missing');
  assert.equal(status.state, 'disabled');
  assert.equal(status.destination.kind, 'c2c');
  assert.equal(status.provider.capabilities.supportsPrivateMessages, true);
  assert.equal(status.provider.capabilities.verified, true);
  assert.equal(status.provider.capabilities.experimental, undefined);
  assert.equal(status.provider.capabilities.available, true);

  const loginStatus = await env.runtime.providerLoginStatus('xiaoheihe');
  assert.equal(loginStatus.state, 'missing');
  assert.equal(loginStatus.pngDataUrl, undefined);
  const started = await env.runtime.providerLoginStart('xiaoheihe');
  assert.equal(started.state, 'waiting');
  assert.match(started.pngDataUrl, /^data:image\/png;base64,/);
  assert.equal((await env.runtime.providerLoginCancel('xiaoheihe')).state, 'cancelled');
  assert.equal((await env.runtime.providerLoginInspect('xiaoheihe')).state, 'valid');
  assert.equal((await env.runtime.providerLoginManual('xiaoheihe', { cookie: 'xhh-cookie' })).ok, true);
  assert.equal((await env.runtime.providerLoginLogout('xiaoheihe')).ok, true);
  const groups = await env.runtime.providerGroupOptions('xiaoheihe');
  assert.deepEqual(groups.groups, [{ id: 'group-1', name: '测试群' }]);
  await env.runtime.providerSetTarget('xiaoheihe', { sendToGroup: false });
  const checked = await env.runtime.providerCheck('xiaoheihe');
  assert.equal(checked.state, 'disabled');
  const tested = await env.runtime.providerSendTest('xiaoheihe');
  assert.equal(tested.sent, 1);

  const enabled = await env.runtime.providerSaveConfig('xiaoheihe', { config: { enabled: true, pollSeconds: 360 } });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.dm.config.enabled, true);
  assert.equal(enabled.dm.config.pollSeconds, 360);
  assert.equal(env.ctx.config.xiaoheiheDmEnabled, true);
  assert.equal(env.calls.xhhSaveConfig, 1);
  const disabled = await env.runtime.providerSaveConfig('xiaoheihe', { config: { enabled: false } });
  assert.equal(disabled.dm.config.enabled, false);

  const generic = await env.route('PUT', '/config', { body: { config: { xiaoheiheDmEnabled: true } } });
  assert.equal(generic.code, 200);
  assert.equal(generic.data.config.xiaoheiheDmEnabled, true);
  const genericFalse = await env.route('PUT', '/config', { body: { config: { xiaoheiheDmEnabled: false } } });
  assert.equal(genericFalse.code, 200);
  assert.equal(genericFalse.data.config.xiaoheiheDmEnabled, false);
  assert.throws(() => validateConfig({ xiaoheiheDmEnabled: 1 }), /布尔值/);

  const legacy = await env.route('PUT', '/bili/dm/config', { body: { config: { xiaoheiheDmEnabled: true } } });
  assert.equal(legacy.code, 400);
  assert.match(legacy.data.error, /私信配置不完整/);

  const credentialRoute = await env.route('PUT', '/credentials', {
    body: { privateMessageProviders: { xiaoheihe: { cookie: 'UNVERIFIED_COOKIE' } } },
  });
  assert.equal(credentialRoute.code, 400);
  assert.match(credentialRoute.data.error, /独立分区/);

  const loginRoute = await env.route('GET', '/dm/providers/:provider/login/status', { params: { provider: 'xiaoheihe' } });
  assert.equal(loginRoute.code, 200);
  assert.equal(loginRoute.data.pngDataUrl, undefined);
  const inspectRoute = await env.route('POST', '/dm/providers/:provider/login/inspect', { params: { provider: 'xiaoheihe' } });
  assert.equal(inspectRoute.code, 200);
  assert.equal(inspectRoute.data.state, 'valid');
  assert.equal(env.calls.inspect, 0);
  assert.equal(env.calls.check, 0);

  const acceptance = await env.route('GET', '/dm/providers/:provider/acceptance', {
    params: { provider: 'xiaoheihe' }, query: { limit: '1' },
  });
  assert.equal(acceptance.code, 200);
  assert.equal(acceptance.data.providerId, 'xiaoheihe');
  assert.equal(acceptance.data.events.length, 1);
  assert.equal(env.calls.xhhAcceptanceLimit, 1);
  const serialized = JSON.stringify(acceptance.data);
  for (const secret of ['xhh-cookie', 'message-body', 'https://']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  const invalidLimit = await env.route('GET', '/dm/providers/:provider/acceptance', {
    params: { provider: 'xiaoheihe' }, query: { limit: '101' },
  });
  assert.equal(invalidLimit.code, 400);
  const biliAcceptance = await env.route('GET', '/dm/providers/:provider/acceptance', {
    params: { provider: 'bilibili' },
  });
  assert.equal(biliAcceptance.code, 400);
  assert.match(biliAcceptance.data.error, /B站.*不提供|验收记录/);
  const unknownAcceptance = await env.route('GET', '/dm/providers/:provider/acceptance', {
    params: { provider: 'weibo' },
  });
  assert.equal(unknownAcceptance.code, 400);
  assert.match(unknownAcceptance.data.error, /未知的私信平台/);
  assert.equal(env.calls.upstream, 0);
});

test('an explicit host xiaoheihe true is preserved as the user choice without a backend refusal', async (t) => {
  const env = await fixture(t, { config: { xiaoheiheDmEnabled: true }, fakeXhh: true });
  assert.equal(env.ctx.config.xiaoheiheDmEnabled, true);
  assert.equal(env.runtime.settings.current().xiaoheiheDmEnabled, true);
  assert.equal(env.runtime.settings.publicConfig().xiaoheiheDmEnabled, true);
  const status = await env.runtime.providerStatus('xiaoheihe');
  assert.equal(status.config.enabled, true);
  assert.equal(status.provider.capabilities.verified, true);
  assert.equal(status.provider.capabilities.experimental, undefined);
  const list = await env.route('GET', '/dm/providers');
  assert.equal(list.data.providers.find((item) => item.id === 'xiaoheihe').enabled, true);
});

test('unknown providers and unknown command actions never trigger a provider request', async (t) => {
  const env = await fixture(t, { owner: true });
  await assert.rejects(env.runtime.providerStatus('weibo'), (error) => error.code === 'DM_PROVIDER_UNKNOWN');
  const route = await env.route('GET', '/dm/providers/:provider/status', { params: { provider: 'weibo' } });
  assert.equal(route.code, 400);
  assert.match(route.data.error, /未知的私信平台/);
  const check = await env.route('POST', '/dm/providers/:provider/check', { params: { provider: 'weibo' } });
  assert.equal(check.code, 400);
  const replies = await env.runCommand(['私信', '微博', '检查']);
  assert.match(replies.join('\n'), /平台接入与私信提醒/);
  assert.equal(env.calls.check, 0);
  assert.equal(env.calls.inspect, 0);
  assert.equal(env.calls.upstream, 0);
});

test('legacy /解析 私信 remains Bilibili; owner C2C gate is unchanged', async (t) => {
  const env = await fixture(t, { owner: true });
  const old = await env.runCommand(['私信', '检查']);
  assert.equal(env.calls.check, 1);
  assert.match(old.join('\n'), /登录：/);

  const named = await env.runCommand(['私信', 'B站', '检查']);
  assert.equal(env.calls.check, 2);
  assert.match(named.join('\n'), /登录：/);

  const xhhEnv = await fixture(t, { owner: true, fakeXhh: true });
  const xhhStatus = await xhhEnv.runCommand(['私信', '小黑盒', '状态']);
  assert.match(xhhStatus.join('\n'), /小黑盒：私信提醒/);
  assert.doesNotMatch(xhhStatus.join('\n'), /验收中|协议未标记为已验证/);
  assert.equal(xhhEnv.calls.xhhCheck, 0);
  const xhhCheck = await xhhEnv.runCommand(['私信', '小黑盒', '检查']);
  assert.equal(xhhEnv.calls.xhhCheck, 1);
  assert.match(xhhCheck.join('\n'), /小黑盒：私信提醒/);
  assert.doesNotMatch(xhhCheck.join('\n'), /验收中/);
  const xhhStart = await xhhEnv.runCommand(['私信', '小黑盒', '登录']);
  assert.equal(xhhEnv.calls.xhhLoginStart, 1);
  assert.doesNotMatch(xhhStart.join('\n'), /data:image\/png/);
  const xhhOn = await xhhEnv.runCommand(['私信', '小黑盒', '开']);
  assert.match(xhhOn.join('\n'), /已按你的显式选择启用小黑盒私信提醒/);
  assert.doesNotMatch(xhhOn.join('\n'), /验收中/);
  assert.equal(xhhEnv.ctx.config.xiaoheiheDmEnabled, true);
  const xhhOff = await xhhEnv.runCommand(['私信', '小黑盒', '关']);
  assert.match(xhhOff.join('\n'), /已暂停小黑盒/);
  assert.equal(xhhEnv.ctx.config.xiaoheiheDmEnabled, false);
  const xhhTest = await xhhEnv.runCommand(['私信', '小黑盒', '测试']);
  assert.equal(xhhEnv.calls.xhhSendTest, 1);
  assert.match(xhhTest.join('\n'), /测试通知/);
  const xhhPending = await xhhEnv.runCommand(['私信', '小黑盒', '待发']);
  assert.match(xhhPending.join('\n'), /待发送：2/);
  const xhhClaim = await xhhEnv.runCommand(['私信', '小黑盒', '领取']);
  assert.equal(xhhEnv.calls.xhhClaim, 1);
  assert.match(xhhClaim.join('\n'), /暂无可领取/);
  const xhhView = await xhhEnv.runCommand(['私信', '小黑盒', '查看', 'abc']);
  assert.equal(xhhEnv.calls.xhhView, 1);
  assert.match(xhhView.join('\n'), /未找到/);
  const xhhLogout = await xhhEnv.runCommand(['私信', '小黑盒', '退出登录']);
  assert.equal(xhhEnv.calls.xhhLogout, 1);
  assert.match(xhhLogout.join('\n'), /已清除本插件保存的小黑盒登录|不会影响其他客户端/);
  assert.equal(xhhEnv.ctx.config.xiaoheiheDmEnabled, false);

  const denied = await fixture(t);
  const deniedReplies = await denied.runCommand(['私信', '检查']);
  assert.match(deniedReplies.join('\n'), /仅机器人主人/);
  assert.equal(denied.calls.check, 0);

  const groupReplies = await denied.runCommand(['私信', '检查'], { kind: 'group', chatId: 'group-1' });
  assert.match(groupReplies.join('\n'), /私聊/);
  assert.equal(denied.calls.check, 0);

  const mismatch = await denied.runCommand(['私信', '检查'], { kind: 'c2c', userId: 'owner-1', chatId: 'other-chat' });
  assert.match(mismatch.join('\n'), /普通 QQ 私聊/);
  assert.equal(denied.calls.check, 0);
});

test('unified and legacy routes share the same runtime service and keep GET snapshots local', async (t) => {
  const env = await fixture(t, { owner: true });
  const list = await env.route('GET', '/dm/providers');
  assert.deepEqual(list.data.providers.map((item) => item.id), ['bilibili', 'xiaoheihe']);
  const status = await env.route('GET', '/dm/providers/:provider/status', { params: { provider: 'bilibili' } });
  assert.equal(status.code, 200);
  assert.equal(status.data.provider.id, 'bilibili');
  assert.equal(status.data.config.pollSeconds, 300);
  assert.equal(typeof status.data.login.state, 'string');
  assert.equal(status.data.dm.state, 'watching');
  assert.equal(typeof status.data.polling.paused, 'boolean');
  assert.equal(status.data.migration.complete, true);

  const legacyStatus = await env.route('GET', '/bili/dm/status');
  assert.equal(legacyStatus.code, 200);
  assert.equal(legacyStatus.data.state, 'watching');

  assert.equal(env.calls.upstream, 0);
  assert.equal(env.calls.inspect, 0);
  assert.equal(env.calls.check, 0);

  let checks = 0;
  env.runtime.dmCheck = async () => { checks += 1; return env.runtime.safeDmStatus(); };
  const unifiedCheck = await env.route('POST', '/dm/providers/:provider/check', { params: { provider: 'bilibili' } });
  const legacyCheck = await env.route('POST', '/bili/dm/check');
  assert.equal(unifiedCheck.code, 200);
  assert.equal(legacyCheck.code, 200);
  assert.equal(checks, 2);

  const inspectNew = await env.route('POST', '/dm/providers/:provider/login/inspect', { params: { provider: 'bilibili' } });
  const inspectOld = await env.route('GET', '/bili/login/inspect');
  assert.equal(inspectNew.code, 200);
  assert.equal(inspectOld.code, 200);
  assert.equal(env.calls.inspect, 2);
  assert.equal(env.calls.upstream, 0);

  const xhhTarget = await env.route('PUT', '/dm/providers/:provider/target', { params: { provider: 'xiaoheihe' }, body: { sendToGroup: true, groupId: 'g' } });
  assert.equal(xhhTarget.code, 400);
  assert.equal(env.calls.configureTarget, 0);
});

test('private-message credentials stay in their own partition and never enter engine config', async (t) => {
  const env = await fixture(t);
  const raw = {
    bilibili_enhanced: { cookie: 'BILI_PRIVATE_COOKIE' },
    privateMessageProviders: {
      xiaoheihe: { cookie: 'XHH_ROOT_SECRET', account: 'XHH_ACCOUNT_SECRET' },
    },
    config: {
      privateMessageProviders: { xiaoheihe: { cookie: 'XHH_CONFIG_SECRET' } },
      download: { max_video_size_mb: 123 },
      parsers: { bilibili: '仅富媒体' },
    },
    upstream: {
      privateMessageProviders: { xiaoheihe: { cookie: 'XHH_NESTED_SECRET' } },
      translation: { llm: { api_key: 'UPSTREAM_KEY' } },
      config: {
        privateMessageProviders: { xiaoheihe: { cookie: 'XHH_UPSTREAM_CONFIG_SECRET' } },
        translation: { enable: true },
      },
    },
    list: [{ privateMessageProviders: { xiaoheihe: { cookie: 'XHH_ARRAY_SECRET' } }, keep: 'KEEP' }],
  };
  const filter = credentialSecretConfig(raw);
  const serialized = JSON.stringify(filter);
  for (const secret of [
    'XHH_ROOT_SECRET', 'XHH_ACCOUNT_SECRET', 'XHH_NESTED_SECRET',
    'XHH_CONFIG_SECRET', 'XHH_UPSTREAM_CONFIG_SECRET', 'XHH_ARRAY_SECRET',
  ]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(filter.bilibili_enhanced.cookie, 'BILI_PRIVATE_COOKIE');
  assert.equal(filter.translation.llm.api_key, 'UPSTREAM_KEY');
  assert.equal(filter.config.download.max_video_size_mb, 123);
  assert.equal(filter.config.parsers.bilibili, '仅富媒体');
  assert.equal(filter.config.translation.enable, true);

  const stripped = stripPrivateMessageProviders(raw);
  assert.equal(JSON.stringify(stripped).includes('XHH_'), false);
  assert.equal(stripped.config.download.max_video_size_mb, 123);
  assert.equal(stripped.config.parsers.bilibili, '仅富媒体');
  assert.equal(stripped.upstream.translation.llm.api_key, 'UPSTREAM_KEY');
  assert.equal(stripped.upstream.config.translation.enable, true);
  assert.deepEqual(stripped.list, [{ keep: 'KEEP' }]);

  const xhhValue = ['XHH', 'PARTITION', 'COOKIE'].join('_');
  const xhhAccount = ['XHH', 'PARTITION', 'ACCOUNT'].join('_');
  const privatePatch = { account: xhhAccount };
  privatePatch.cookie = xhhValue;
  const result = await env.runtime.settings.setPrivateMessageProviderCredentials('xiaoheihe', privatePatch);
  assert.equal(result.ok, true);
  const credentials = await readJson(env.runtime.settings.credentialsFile);
  assert.equal(credentials.privateMessageProviders.xiaoheihe.cookie, xhhValue);
  assert.equal(credentials.privateMessageProviders.xiaoheihe.account, xhhAccount);
  const advanced = await readJson(env.runtime.settings.advancedFile);
  assert.equal(JSON.stringify(advanced).includes('XHH_PARTITION'), false);
  assert.equal(JSON.stringify(env.runtime.settings.publicConfig()).includes('XHH_PARTITION'), false);
  assert.equal(JSON.stringify(env.runtime.settings.credentialHints()).includes('XHH_PARTITION'), false);
  assert.equal(JSON.stringify(env.runtime.settings.advanced()).includes('XHH_PARTITION'), false);
  assert.equal(env.runtime.settings.sanitize(`cookie ${xhhValue}`).includes(xhhValue), false);
  assert.equal(env.runtime.settings.getPrivateMessageProviderCredentials('xiaoheihe').cookie, xhhValue);

  const cleared = await env.runtime.settings.clearPrivateMessageProviderCredentials('xiaoheihe');
  assert.equal(cleared.ok, true);
  const after = await readJson(env.runtime.settings.credentialsFile);
  assert.equal(after.privateMessageProviders, undefined);
});

test('each runtime gets a fresh policy facade; handoff drains only its own instance', async (t) => {
  const env = await fixture(t);
  const first = env.runtime.requestPolicy;
  const firstSettings = env.runtime.settings;
  let firstDrained = 0;
  let firstClosed = 0;
  first.drain = async () => { await tick(); firstDrained += 1; };
  first.close = async () => { firstClosed += 1; };
  await env.runtime.deactivate('reload');
  assert.equal(firstDrained, 1);
  assert.equal(firstClosed, 0);
  assert.equal(env.calls.storeFlush, 1);

  env.plugin.setup(env.ctx);
  const second = env.ctx.state.runtime;
  await second.ready;
  await second.dmReady.catch(() => {});
  assert.notEqual(second.requestPolicy, first);
  assert.ok(second.settings.getBiliSessionVersion() > firstSettings.getBiliSessionVersion());
  // The successor facade is independent and can still read shared state.
  await second.requestPolicy.status({ providerId: 'bilibili', accountKey: 'reload-check', pollSeconds: 300 });

  let secondDrained = 0;
  let secondClosed = 0;
  second.requestPolicy.drain = async () => { secondDrained += 1; };
  second.requestPolicy.close = async () => { secondClosed += 1; };
  await env.plugin.teardown(env.ctx);
  await second.shutdown;
  for (let i = 0; i < 5 && secondDrained === 0; i += 1) await tick();
  assert.equal(secondDrained, 1);
  assert.equal(secondClosed, 0);

  env.plugin.setup(env.ctx);
  const third = env.ctx.state.runtime;
  await third.ready;
  await third.dmReady.catch(() => {});
  assert.notEqual(third.requestPolicy, first);
  assert.notEqual(third.requestPolicy, second);
});
