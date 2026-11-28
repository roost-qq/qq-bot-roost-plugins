import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  RequestPolicyError,
  createPrivateMessageRequestPolicy,
} from '../private-message-request-policy.js';
import { createBiliClient } from '../bili-client.js';
import { createBiliDmService } from '../bili-dm.js';
import { createBiliDmStore } from '../bili-dm-store.js';
import { createBiliLogin } from '../bili-login.js';

const START = Date.UTC(2026, 10, 27, 12, 0, 0);
const UID = '9007199254740993';
const QR_KEY = ['a1b2', 'c3d4', 'e5f6', '0718', '293a', '4b5c', '6d7e', '8f90'].join('');
const COOKIE_KEY = 'SESS' + 'DATA';
const SERVER_DATE = 'Mon, 05 Sep 2022 07:30:09 GMT';
let originCounter = 0;

function nextOrigin() {
  originCounter += 1;
  return `v03-bili-${process.pid}-${originCounter}`;
}

function cookieFor(tag) {
  return `${COOKIE_KEY}=${tag}`;
}

function hashOf(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function policyFixture(t, { start = START } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-bili-v03-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clock = { value: start };
  const originKey = nextOrigin();
  const policy = createPrivateMessageRequestPolicy({
    statePath: path.join(dir, 'request-state.json'),
    originKey,
    now: () => clock.value,
    random: () => 0,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new RequestPolicyError('REQUEST_CANCELLED');
      clock.value += ms;
    },
  });
  return {
    dir,
    originKey,
    policy,
    now: () => clock.value,
    advance: (ms) => { clock.value += ms; },
    statePath: path.join(dir, 'request-state.json'),
  };
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  const merged = new Headers(headers);
  if (!merged.has('content-type')) merged.set('content-type', 'application/json');
  if (!merged.has('date')) merged.set('date', SERVER_DATE);
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status, headers: merged,
  });
}

function navBody(mid = UID) {
  return { code: 0, data: { isLogin: true, mid, uname: '测试账号' } };
}

function qrBody() {
  return {
    code: 0,
    data: {
      url: `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${QR_KEY}`,
      qrcode_key: QR_KEY,
    },
  };
}

function messageBody() {
  return {
    code: 0,
    data: { messages: [], has_more: 0, min_seqno: 0, max_seqno: 0 },
  };
}

function requestScopeFor(context) {
  const cookie = String(context?.cookie || '');
  const fingerprint = hashOf(cookie || 'anonymous');
  return {
    providerId: 'bilibili',
    accountKey: `account-${fingerprint.slice(0, 24)}`,
    credentialVersion: cookie ? fingerprint : undefined,
  };
}

test('real fake-fetch dispatch timestamps follow five-second spacing and total budget', async (t) => {
  const env = await policyFixture(t);
  const dispatches = [];
  const client = createBiliClient({
    requestPolicy: env.policy,
    requestScope: requestScopeFor,
    fetchImpl: async () => {
      dispatches.push(env.now());
      return jsonResponse(qrBody());
    },
  });
  for (let index = 0; index < 10; index += 1) await client.generateQr();
  assert.equal(dispatches.length, 10);
  for (let index = 1; index < dispatches.length; index += 1) {
    assert.equal(dispatches[index] - dispatches[index - 1], 5_000);
  }
  await assert.rejects(client.generateQr(), { code: 'REQUEST_BUDGET' });
  assert.equal(dispatches.length, 10);
});

test('data requests are capped at six per window through the real client', async (t) => {
  const env = await policyFixture(t);
  let dispatched = 0;
  const client = createBiliClient({
    requestPolicy: env.policy,
    requestScope: requestScopeFor,
    fetchImpl: async () => {
      dispatched += 1;
      return jsonResponse(messageBody());
    },
  });
  for (let index = 0; index < 6; index += 1) {
    await client.messages(cookieFor('data'), {
      talkerId: '42', beginSeqno: String(index), endSeqno: String(index + 1),
    });
  }
  assert.equal(dispatched, 6);
  await assert.rejects(
    client.messages(cookieFor('data'), { talkerId: '42', beginSeqno: '7', endSeqno: '8' }),
    { code: 'REQUEST_BUDGET' },
  );
  assert.equal(dispatched, 6);
});

test('trusted envelope failures are recorded by policy and block further dispatch', async (t) => {
  const env = await policyFixture(t);
  let calls = 0;
  const client = createBiliClient({
    requestPolicy: env.policy,
    requestScope: requestScopeFor,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ code: -101, message: `${COOKIE_KEY}=private` });
    },
  });
  await assert.rejects(client.nav(cookieFor('auth')), { code: 'BILI_AUTH' });
  assert.equal(calls, 1);
  const status = await env.policy.status({
    providerId: 'bilibili', accountKey: requestScopeFor({ cookie: cookieFor('auth') }).accountKey,
    credentialVersion: requestScopeFor({ cookie: cookieFor('auth') }).credentialVersion,
    pollSeconds: 300,
  });
  assert.equal(status.paused, true);
  assert.equal(status.pauseReason, 'auth');
  await assert.rejects(client.nav(cookieFor('auth')), { code: 'REQUEST_COOLDOWN' });
  assert.equal(calls, 1);
});

test('HTTP 403, 412 and Bili -412 are unknown rejections, not challenge or auth', async (t) => {
  for (const status of [403, 412]) {
    const env = await policyFixture(t);
    const client = createBiliClient({
      requestPolicy: env.policy,
      requestScope: requestScopeFor,
      fetchImpl: async () => jsonResponse({ message: 'private server detail' }, { status }),
    });
    await assert.rejects(client.nav(cookieFor('unknown')), (error) => {
      assert.equal(error.code, 'BILI_HTTP');
      assert.equal(error.status, status);
      assert.equal(String(error.message).includes('private server detail'), false);
      return true;
    });
    const scope = requestScopeFor({ cookie: cookieFor('unknown') });
    const policyStatus = await env.policy.status({ ...scope, pollSeconds: 300 });
    assert.equal(policyStatus.cooldownReason, 'rejected');
    assert.equal(policyStatus.cooldownScope, 'provider');
  }

  const env = await policyFixture(t);
  const client = createBiliClient({
    requestPolicy: env.policy,
    requestScope: requestScopeFor,
    fetchImpl: async () => jsonResponse({ code: -412, message: 'private risk body' }),
  });
  await assert.rejects(client.nav(cookieFor('risk')), (error) => {
    assert.equal(error.code, 'BILI_RISK');
    assert.equal(String(error.message).includes('private risk body'), false);
    return true;
  });
  const scope = requestScopeFor({ cookie: cookieFor('risk') });
  const policyStatus = await env.policy.status({ ...scope, pollSeconds: 300 });
  assert.equal(policyStatus.cooldownReason, 'rejected');
});

test('seconds and HTTP-date Retry-After remain untruncated in persisted cooldown', async (t) => {
  const secondsEnv = await policyFixture(t);
  const secondsClient = createBiliClient({
    requestPolicy: secondsEnv.policy,
    requestScope: requestScopeFor,
    fetchImpl: async () => jsonResponse({ code: 0 }, {
      status: 429, headers: { 'retry-after': String(9 * 60 * 60) },
    }),
  });
  await assert.rejects(secondsClient.nav(cookieFor('seconds')), { code: 'BILI_RATE_LIMIT' });
  const secondsScope = requestScopeFor({ cookie: cookieFor('seconds') });
  let policyStatus = await secondsEnv.policy.status({ ...secondsScope, pollSeconds: 300 });
  assert.equal(policyStatus.nextAllowedAt, secondsEnv.now() + 9 * 60 * 60_000);

  const dateEnv = await policyFixture(t);
  const future = new Date(Date.now() + 9 * 60 * 60_000 + 30_000).toUTCString();
  const dateClient = createBiliClient({
    requestPolicy: dateEnv.policy,
    requestScope: requestScopeFor,
    fetchImpl: async () => jsonResponse({ code: 0 }, {
      status: 429, headers: { 'retry-after': future },
    }),
  });
  await assert.rejects(dateClient.nav(cookieFor('date')), { code: 'BILI_RATE_LIMIT' });
  const dateScope = requestScopeFor({ cookie: cookieFor('date') });
  policyStatus = await dateEnv.policy.status({ ...dateScope, pollSeconds: 300 });
  const remaining = policyStatus.nextAllowedAt - dateEnv.now();
  assert.ok(remaining >= 8.5 * 60 * 60_000, `expected long wait, got ${remaining}`);
});

test('manual cookie requests coalesce only when the actual candidate credential matches', async (t) => {
  const env = await policyFixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dispatched = [];
  const client = createBiliClient({
    requestPolicy: env.policy,
    requestScope: requestScopeFor,
    fetchImpl: async (url, options) => {
      dispatched.push(options.headers.cookie);
      if (dispatched.length === 1) await gate;
      return jsonResponse(navBody());
    },
  });
  const first = client.nav(cookieFor('candidate-a'));
  const duplicate = client.nav(cookieFor('candidate-a'));
  const different = client.nav(cookieFor('candidate-b'));
  for (let attempt = 0; attempt < 50 && dispatched.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(dispatched.length, 1);
  release();
  const results = await Promise.all([first, duplicate, different]);
  assert.equal(results[0].mid, UID);
  assert.equal(results[1].mid, UID);
  assert.equal(results[2].mid, UID);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0], cookieFor('candidate-a'));
  assert.equal(dispatched[1], cookieFor('candidate-b'));
  assert.equal(new Set(dispatched).size, 2);
});

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async readFile(file) {
      if (!files.has(file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    async writeFile(file, data) { files.set(file, String(data)); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async unlink(file) { files.delete(file); },
    async mkdir() {},
  };
}

function dmSettingsFake(cookie = cookieFor('dm')) {
  let value = cookie;
  let revision = value ? 1 : 0;
  const listeners = new Set();
  return {
    ready: Promise.resolve(),
    current: () => ({ biliDmEnabled: true, biliDmPollSeconds: 300, biliDmIncludeSystem: false }),
    getBiliCookie: () => value,
    getBiliCookieRevision: () => revision,
    subscribeBiliCookie(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async flush() {},
    async clearBiliCookie() {
      value = '';
      revision += 1;
      for (const listener of listeners) listener({ revision, hasCookie: false });
    },
  };
}

function dmClientFake(overrides = {}) {
  return {
    async nav() { return { mid: UID, uname: '', serverTime: START }; },
    async sessions() { return { sessions: [], hasMore: false, serverTime: START }; },
    async messages() { return { messages: [], hasMore: false, minSeqno: '0', maxSeqno: '0' }; },
    ...overrides,
  };
}

function policySpy() {
  const calls = { success: 0, failure: 0, status: 0 };
  const scopes = [];
  return {
    calls,
    scopes,
    async status() {
      calls.status += 1;
      return {
        paused: false,
        cooldownReason: null,
        nextAllowedAt: null,
        requiresManualRecovery: false,
        recoveryProbePending: false,
        configuredIntervalSeconds: 300,
        effectiveIntervalSeconds: 600,
        adaptiveMultiplier: 2,
        budget: { totalUsed: 1, totalLimit: 10, dataUsed: 1, dataLimit: 6, windowSeconds: 60 },
        lastEffectiveSyncAt: null,
      };
    },
    async recordSyncSuccess(scopeValue) {
      calls.success += 1;
      scopes.push(scopeValue);
      return { recorded: true };
    },
    async recordFailure() {
      calls.failure += 1;
      return { recorded: true };
    },
  };
}

async function dmHarness({ client = dmClientFake(), policy = null } = {}) {
  const fs = memoryFs();
  const store = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs, now: () => START });
  await store.ready;
  await store.bind('owner-1');
  const settings = dmSettingsFake();
  const service = createBiliDmService({
    settings,
    client,
    store,
    requestPolicy: policy,
    requestScope: policy ? requestScopeFor : null,
    autoSchedule: false,
    now: () => START,
    random: () => 0,
  });
  await service.ready;
  await service.start();
  return { service, store, settings };
}

test('Bili DM records sync success only after a complete effective sync', async (t) => {
  const policy = policySpy();
  const { service } = await dmHarness({
    client: dmClientFake({
      async sessions() {
        return {
          sessions: [{ talker_id: '844424930131966', session_type: 1, max_seqno: '5', session_ts: String(START * 1000) }],
          hasMore: false,
          serverTime: START,
        };
      },
    }),
    policy,
  });
  await service.check();
  assert.equal(service.status().state, 'watching');
  assert.equal(policy.calls.success, 1);
  const status = service.status();
  assert.equal(status.requestPolicy.effectiveIntervalSeconds, 600);
  assert.equal(status.polling.effectiveSeconds, 600);
  assert.equal(status.polling.requestBudget, 6);
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(UID), false);
  assert.equal(serialized.includes(cookieFor('dm')), false);
});

test('Bili DM never records sync success for a partial budget round', async (t) => {
  const policy = policySpy();
  let page = 0;
  const { service } = await dmHarness({
    client: dmClientFake({
      async sessions() {
        page += 1;
        const sessions = Array.from({ length: 100 }, (_, index) => ({
          talker_id: String(10_000 + page * 1_000 + index),
          session_type: 1,
          max_seqno: '3',
          session_ts: String(START * 1000 - page * 1_000 - index),
        }));
        return { sessions, hasMore: true, serverTime: START };
      },
    }),
    policy,
  });
  await service.check();
  assert.equal(service.status().state, 'catching_up');
  assert.equal(service.status().reasonCode, 'DM_BUDGET');
  assert.equal(policy.calls.success, 0);
});

test('Bili DM maps policy cooldown errors to visible backoff without double recording', async (t) => {
  const policy = policySpy();
  const { service } = await dmHarness({
    client: dmClientFake({
      async nav() {
        throw Object.assign(new Error('private cooldown'), {
          code: 'REQUEST_COOLDOWN',
          nextAllowedAt: START + 10 * 60_000,
          retryAfterMs: 10 * 60_000,
        });
      },
    }),
    policy,
  });
  await service.check();
  const status = service.status();
  assert.equal(status.state, 'backoff');
  assert.equal(status.reasonCode, 'DM_RATE_LIMIT');
  assert.ok(status.nextRetryAt >= START + 10 * 60_000);
  assert.equal(policy.calls.failure, 0);
  assert.equal(JSON.stringify(status).includes('private cooldown'), false);
});

test('client forwards expiresAt and workflowId to the policy and 503 is transient, not rate', async (t) => {
  const calls = [];
  const spy = {
    async run(meta, task) {
      calls.push(meta);
      return task();
    },
  };
  const client = createBiliClient({
    requestPolicy: spy,
    requestScope: requestScopeFor,
    fetchImpl: async (url) => {
      if (url.includes('get_sessions')) {
        return jsonResponse({ code: 0, data: { session_list: [], has_more: 0 } });
      }
      if (url.includes('/poll')) {
        return jsonResponse({ code: 0, data: { code: 86101 } });
      }
      return jsonResponse(qrBody());
    },
  });
  await client.sessions(cookieFor('deadline'), {
    expiresAt: START + 60_000, workflowId: 'complete-sync-deadline',
  });
  assert.equal(calls[0].kind, 'data');
  assert.equal(calls[0].workflowId, 'complete-sync-deadline');
  assert.equal(calls[0].expiresAt, START + 60_000);
  await client.generateQr({ expiresAt: START + 120_000 });
  assert.equal(calls[1].kind, 'control');
  assert.equal(calls[1].expiresAt, START + 120_000);
  await client.pollQr(QR_KEY, { expiresAt: START + 180_000 });
  assert.equal(calls[2].expiresAt, START + 180_000);

  const env = await policyFixture(t);
  const transient = createBiliClient({
    requestPolicy: env.policy,
    requestScope: requestScopeFor,
    fetchImpl: async () => jsonResponse({ error: 'private' }, { status: 503 }),
  });
  await assert.rejects(transient.nav(cookieFor('transient')), (error) => {
    assert.equal(error.code, 'BILI_HTTP');
    assert.equal(error.status, 503);
    return true;
  });
  const scope = requestScopeFor({ cookie: cookieFor('transient') });
  const status = await env.policy.status({ ...scope, pollSeconds: 300 });
  assert.equal(status.cooldownReason, 'transient');
  assert.notEqual(status.cooldownReason, 'rate_limit');
});

test('Bili DM passes one stable workflow and round deadline through every client call', async (t) => {
  const env = await policyFixture(t);
  const seen = [];
  const client = {
    async nav(cookie, options) {
      seen.push({ kind: 'nav', options });
      return { mid: UID, uname: '', serverTime: START };
    },
    async sessions(cookie, options) {
      seen.push({ kind: 'sessions', options });
      return {
        sessions: [{
          talker_id: '844424930131966',
          session_type: 1,
          max_seqno: '5',
          session_ts: String(START * 1000),
        }],
        hasMore: false,
        serverTime: START,
      };
    },
    async messages(cookie, options) {
      seen.push({ kind: 'messages', options });
      return { messages: [], hasMore: false, minSeqno: '0', maxSeqno: '0' };
    },
  };
  const policy = policySpy();
  const fs = memoryFs();
  const store = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-1', fs, now: () => START });
  await store.ready;
  await store.bind('owner-1');
  const service = createBiliDmService({
    settings: dmSettingsFake(cookieFor('workflow')),
    client,
    store,
    requestPolicy: policy,
    requestScope: requestScopeFor,
    autoSchedule: false,
    now: () => START,
    random: () => 0,
  });
  await service.ready;
  await service.start();
  await service.check();
  const nav = seen.find((entry) => entry.kind === 'nav');
  const sessions = seen.find((entry) => entry.kind === 'sessions');
  assert.equal(nav.options.workflowId, sessions.options.workflowId);
  assert.match(nav.options.workflowId, /^bili-sync:[a-f0-9]{64}$/);
  assert.equal(nav.options.expiresAt, START + 120_000);
  assert.equal(sessions.options.expiresAt, START + 120_000);
  assert.equal(policy.calls.success, 1);
  assert.equal(policy.scopes[0].workflowId, nav.options.workflowId);
});

test('QR login forwards the session deadline to generation and polling', async (t) => {
  let clock = START;
  const seen = {};
  const login = createBiliLogin({
    settings: loginSettingsFake(),
    now: () => clock,
    pollIntervalMs: 5,
    ttlMs: 5_000,
    qrEncode: () => 'data:image/png;base64,QUJD',
    client: {
      async generateQr(options) {
        seen.generate = options;
        return {
          url: `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${QR_KEY}`,
          key: QR_KEY,
        };
      },
      async pollQr(key, options) {
        seen.poll = options;
        return { state: 'waiting' };
      },
      async nav() { return { mid: UID }; },
    },
  });
  t.after(() => login.deactivate());
  const started = await login.start();
  for (let attempt = 0; attempt < 100 && !seen.poll; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(started.expiresAt, START + 5_000);
  assert.equal(seen.generate.expiresAt, START + 5_000);
  assert.equal(seen.poll.expiresAt, START + 5_000);
});

test('adaptive effective interval governs the real next timer and manual checks cannot shorten it', async (t) => {
  const fs = memoryFs();
  const store = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-timer', fs, now: () => START });
  await store.ready;
  await store.bind('owner-1');
  let effective = 600;
  const timers = [];
  const policy = {
    async status() {
      return {
        paused: false,
        configuredIntervalSeconds: 300,
        effectiveIntervalSeconds: effective,
        adaptiveMultiplier: 2,
        budget: { totalUsed: 0, totalLimit: 10, dataUsed: 0, dataLimit: 6, windowSeconds: 60 },
      };
    },
    async recordSyncSuccess() { return { recorded: true }; },
    async recordFailure() {},
  };
  const service = createBiliDmService({
    settings: dmSettingsFake(cookieFor('timer')),
    client: dmClientFake(),
    store,
    requestPolicy: policy,
    requestScope: requestScopeFor,
    now: () => START,
    random: () => 0,
    autoSchedule: true,
    setTimeout(_fn, ms) { timers.push(ms); return { unref() {} }; },
    clearTimeout() {},
  });
  t.after(async () => {
    service.deactivate();
    await service.flush();
  });
  await service.ready;
  await service.start();
  await service.check();
  assert.equal(service.status().state, 'watching');
  assert.ok(timers.at(-1) >= 600_000, JSON.stringify(timers));

  effective = 1200;
  await service.check();
  assert.ok(timers.at(-1) >= 1_200_000, JSON.stringify(timers));
  const before = timers.length;
  await service.check();
  assert.ok(timers.length > before);
  assert.ok(timers.slice(before).every((ms) => ms >= 1_200_000), JSON.stringify(timers));
});

test('one workflow identity survives partial rounds and rotates only after complete sync', async (t) => {
  const fs = memoryFs();
  const store = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-workflow', fs, now: () => START });
  await store.ready;
  await store.bind('owner-1');
  const workflows = [];
  let complete = false;
  let page = 0;
  const client = {
    async nav() { return { mid: UID, serverTime: START }; },
    async sessions(cookie, options) {
      workflows.push(options.workflowId);
      if (complete) return { sessions: [], hasMore: false, serverTime: START };
      page += 1;
      const sessions = Array.from({ length: 100 }, (_, index) => ({
        talker_id: String(20_000 + page * 1_000 + index),
        session_type: 1,
        max_seqno: '3',
        session_ts: String(START * 1000 - page * 1_000 - index),
      }));
      return { sessions, hasMore: true, serverTime: START };
    },
    async messages() { return { messages: [], hasMore: false, minSeqno: '0', maxSeqno: '0' }; },
  };
  const policy = policySpy();
  const service = createBiliDmService({
    settings: dmSettingsFake(cookieFor('workflow-cycle')),
    client,
    store,
    requestPolicy: policy,
    requestScope: requestScopeFor,
    autoSchedule: false,
    now: () => START,
    random: () => 0,
  });
  t.after(async () => {
    service.deactivate();
    await service.flush();
  });
  await service.ready;
  await service.start();
  await service.check();
  assert.equal(service.status().state, 'catching_up');
  const first = workflows.at(-1);
  await service.check();
  assert.equal(service.status().state, 'catching_up');
  assert.equal(workflows.at(-1), first);
  const persisted = store.read((state) => Object.values(state.syncCycles || {})[0]?.workflowId);
  assert.equal(persisted, first);
  assert.equal(policy.calls.success, 0);

  complete = true;
  await service.check();
  assert.equal(service.status().state, 'watching');
  assert.equal(workflows.at(-1), first);
  assert.equal(policy.calls.success, 1);
  const rotated = store.read((state) => Object.values(state.syncCycles || {})[0]?.workflowId);
  assert.notEqual(rotated, first);

  await service.check();
  assert.notEqual(workflows.at(-1), first);
});

test('complete-sync success uses the scope captured before requests, not a later cookie', async (t) => {
  const fs = memoryFs();
  const store = createBiliDmStore({ dataDir: '/data', robotKey: 'bot-captured', fs, now: () => START });
  await store.ready;
  await store.bind('owner-1');
  let switched = false;
  const requestScope = () => ({
    providerId: 'bilibili',
    accountKey: switched ? 'new-account' : 'old-account',
    credentialVersion: switched ? 'new-credential' : 'old-credential',
  });
  const client = {
    async nav() {
      switched = true;
      return { mid: UID, serverTime: START };
    },
    async sessions() { return { sessions: [], hasMore: false, serverTime: START }; },
    async messages() { return { messages: [], hasMore: false, minSeqno: '0', maxSeqno: '0' }; },
  };
  const policy = policySpy();
  const service = createBiliDmService({
    settings: dmSettingsFake(cookieFor('captured')),
    client,
    store,
    requestPolicy: policy,
    requestScope,
    autoSchedule: false,
    now: () => START,
    random: () => 0,
  });
  t.after(async () => {
    service.deactivate();
    await service.flush();
  });
  await service.ready;
  await service.start();
  await service.check();
  assert.equal(service.status().state, 'watching');
  assert.equal(policy.calls.success, 1);
  assert.equal(policy.scopes[0].accountKey, 'old-account');
  assert.equal(policy.scopes[0].credentialVersion, 'old-credential');
});

function loginSettingsFake(initial = '') {
  let cookie = initial;
  let revision = initial ? 1 : 0;
  const listeners = new Set();
  return {
    getBiliCookie: () => cookie,
    getBiliCookieRevision: () => revision,
    subscribeBiliCookie(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async setBiliCookie(value) {
      cookie = value;
      revision += 1;
      for (const listener of [...listeners]) listener({ revision, hasCookie: Boolean(value) });
      return { ok: true };
    },
    async clearBiliCookie() {
      cookie = '';
      revision += 1;
      for (const listener of [...listeners]) listener({ revision, hasCookie: false });
      return { ok: true };
    },
    async flush() {},
  };
}

test('login inspection caches by actual credential for ten minutes and invalidates on change', async (t) => {
  let clock = START;
  let navCalls = 0;
  const settings = loginSettingsFake(cookieFor('inspect-a'));
  const login = createBiliLogin({
    settings,
    now: () => clock,
    pollIntervalMs: 5_000,
    qrEncode: () => 'data:image/png;base64,QUJD',
    client: {
      async nav() { navCalls += 1; return { mid: UID, uname: 'cached' }; },
      async generateQr() { throw new Error('unused'); },
      async pollQr() { throw new Error('unused'); },
    },
  });
  t.after(() => login.deactivate());
  assert.deepEqual(await login.inspect(), { state: 'valid' });
  assert.deepEqual(await login.inspectAccount(), { state: 'valid', mid: UID, uname: 'cached' });
  clock += 5 * 60_000;
  assert.deepEqual(await login.inspect(), { state: 'valid' });
  assert.equal(navCalls, 1);
  clock += 6 * 60_000;
  assert.deepEqual(await login.inspect(), { state: 'valid' });
  assert.equal(navCalls, 2);
  await settings.setBiliCookie(cookieFor('inspect-b'));
  assert.deepEqual(await login.inspect(), { state: 'valid' });
  assert.equal(navCalls, 3);
});

test('a QR session ends instead of waiting when policy cooldown outlives the QR', async (t) => {
  let clock = START;
  const settings = loginSettingsFake();
  const login = createBiliLogin({
    settings,
    now: () => clock,
    pollIntervalMs: 5_000,
    ttlMs: 5_000,
    qrEncode: () => 'data:image/png;base64,QUJD',
    client: {
      async generateQr() {
        throw Object.assign(new Error('cooldown'), {
          code: 'REQUEST_COOLDOWN',
          nextAllowedAt: clock + 60_000,
          retryAfterMs: 60_000,
        });
      },
      async pollQr() { throw new Error('unused'); },
      async nav() { throw new Error('unused'); },
    },
  });
  t.after(() => login.deactivate());
  const status = await login.start();
  assert.equal(status.state, 'expired');
  assert.equal(status.pngDataUrl, null);
  assert.equal(status.expiresAt, null);
  assert.equal(login.hasSession(), false);
});
