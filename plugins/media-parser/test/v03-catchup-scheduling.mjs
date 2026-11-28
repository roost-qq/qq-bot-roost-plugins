import test from 'node:test';
import assert from 'node:assert/strict';
import { createBiliDmService } from '../bili-dm.js';
import { createBiliDmStore } from '../bili-dm-store.js';

const START = Date.UTC(2026, 10, 27, 12, 0, 0);
const UID = '9007199254740993';

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const fs = {
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
  return fs;
}

function settingsFake({ poll = 1800, cookie = 'SESSDATA=scheduling' } = {}) {
  let value = cookie;
  let revision = value ? 1 : 0;
  const listeners = new Set();
  return {
    ready: Promise.resolve(),
    current: () => ({
      biliDmEnabled: true,
      biliDmPollSeconds: poll,
      biliDmIncludeSystem: false,
    }),
    getBiliCookie: () => value,
    getBiliCookieRevision: () => revision,
    subscribeBiliCookie(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async set(next) {
      value = next;
      revision += 1;
      for (const listener of listeners) listener({ revision, hasCookie: value !== '' });
    },
    async flush() {},
  };
}

function rawMessage(seq, text) {
  return {
    sender_uid: '555',
    receiver_type: 1,
    receiver_id: UID,
    msg_type: 1,
    content: JSON.stringify({ content: text }),
    msg_seqno: String(seq),
    timestamp: Math.floor(START / 1000) + 200 + Number(seq),
    msg_key: String(7354295169819585966n + BigInt(seq)),
    msg_status: 0,
  };
}

function session(talker, high, extra = {}) {
  return {
    talker_id: talker,
    session_type: 1,
    max_seqno: String(high),
    session_ts: String(START * 1000 + Number(high)),
    unread_count: 0,
    ack_seqno: String(high),
    is_intercept: 0,
    is_dnd: 1,
    system_msg_type: 0,
    last_msg: { msg_seqno: String(high), msg_key: String(7354295169819585966n + BigInt(high)) },
    ...extra,
  };
}

function fakeTimers(clock) {
  let nextId = 1;
  const entries = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      entries.set(id, { id, fn, ms, cleared: false });
      return { id, unref() {} };
    },
    clearTimeout(handle) {
      const entry = entries.get(handle?.id);
      if (entry) entry.cleared = true;
    },
    pending() {
      return [...entries.values()].filter((entry) => !entry.cleared);
    },
    async fireNext() {
      const entry = [...entries.values()].find((candidate) => !candidate.cleared);
      assert.ok(entry, 'expected a pending timer');
      entry.cleared = true;
      clock.advance(entry.ms);
      entry.fn();
      return entry.ms;
    },
  };
}

function policyFake({
  nextAllowedAt = null, paused = false, intervalSeconds = 1800, allowRun = true,
} = {}) {
  const calls = { success: 0, failure: 0, status: 0, run: 0, blocked: 0 };
  const state = { nextAllowedAt, paused, intervalSeconds, allowRun };
  return {
    calls,
    state,
    async run(input, task) {
      calls.run += 1;
      if (state.allowRun !== true) {
        calls.blocked += 1;
        throw Object.assign(new Error('policy cooldown'), {
          code: 'REQUEST_COOLDOWN',
          nextAllowedAt: state.nextAllowedAt,
          retryAfterMs: state.nextAllowedAt ? Math.max(0, state.nextAllowedAt - START) : 0,
        });
      }
      return task();
    },
    async status() {
      calls.status += 1;
      return {
        paused: state.paused,
        pauseReason: state.paused ? 'rate_limit' : null,
        cooldownReason: state.paused ? 'rate_limit' : null,
        cooldownScope: state.paused ? 'provider' : null,
        nextAllowedAt: state.nextAllowedAt,
        requiresManualRecovery: false,
        recoveryProbePending: false,
        recoveryProbeExpiresAt: null,
        configuredIntervalSeconds: state.intervalSeconds,
        effectiveIntervalSeconds: state.intervalSeconds,
        adaptiveMultiplier: 1,
        budget: { totalUsed: 0, totalLimit: 10, dataUsed: 0, dataLimit: 6, windowSeconds: 60 },
        lastEffectiveSyncAt: null,
      };
    },
    async recordSyncSuccess() {
      calls.success += 1;
      return { recorded: true };
    },
    async recordFailure() {
      calls.failure += 1;
      return { recorded: true };
    },
  };
}

function pagedClient(clock, { pages = 7 } = {}) {
  const calls = [];
  let mode = 'scan';
  let scanPage = 0;
  function discoveryPage(page) {
    const base = START * 1000 - page * 1_000_000;
    if (page === 1) {
      return [
        session('100', 5, { session_ts: String(base) }),
        session('200', 2, { session_ts: String(base - 1) }),
      ];
    }
    if (page === pages) {
      return [
        session('100', 8, { session_ts: String(base - 1) }),
        session('700', 1, { session_ts: String(base - 2) }),
      ];
    }
    return [
      session(String(1_000 + page), 2, { session_ts: String(base) }),
      session(String(2_000 + page), 1, { session_ts: String(base - 1) }),
    ];
  }
  return {
    calls,
    setMode(value) { mode = value; },
    async nav() {
      calls.push({ kind: 'nav' });
      return { mid: UID, uname: '', serverTime: clock.value };
    },
    async sessions(cookie, options) {
      calls.push({ kind: 'sessions', endTs: options?.endTs || '' });
      if (mode === 'poll') {
        return {
          sessions: [session('100', 8, { session_ts: String(START * 1000) })],
          hasMore: false,
          serverTime: clock.value,
        };
      }
      scanPage += 1;
      return {
        sessions: discoveryPage(scanPage),
        hasMore: scanPage < pages,
        serverTime: clock.value,
      };
    },
    async messages(cookie, options) {
      calls.push({ kind: 'messages', beginSeqno: options?.beginSeqno });
      return {
        messages: [rawMessage(8, '八'), rawMessage(7, '七'), rawMessage(6, '六')],
        hasMore: false,
        minSeqno: '6',
        maxSeqno: '8',
        eInfos: [],
        serverTime: clock.value,
      };
    },
  };
}

function gatedClient(client, policy) {
  return {
    ...client,
    async nav(cookie, options) {
      return policy.run({ requestKey: 'nav', kind: 'control' }, () => client.nav(cookie, options));
    },
    async sessions(cookie, options) {
      return policy.run({ requestKey: 'sessions', kind: 'data' }, () => client.sessions(cookie, options));
    },
    async messages(cookie, options) {
      return policy.run({ requestKey: 'messages', kind: 'data' }, () => client.messages(cookie, options));
    },
  };
}

function deliveryFake(clock) {
  const sends = [];
  let store = null;
  return {
    sends,
    bindStore(value) { store = value; },
    async pump({ guard } = {}) {
      await store.transaction((draft) => {
        for (const account of Object.values(draft.accounts || {})) {
          for (const record of Object.values(account.messages || {})) {
            if (record.status !== 'unfinished') continue;
            record.status = 'sent';
            record.completedAt = clock.value;
            sends.push(record.seqno);
          }
        }
      }, { guard });
    },
    async pumpNotices() {},
    async notifyStatus() { return { accepted: true }; },
    async flush() {},
    deactivate() {},
  };
}

async function makeHarness({
  clock, timers, client, policy = null, delivery = null, autoSchedule = true, poll = 1800,
} = {}) {
  const store = createBiliDmStore({
    dataDir: '/data', robotKey: 'bot-1', fs: memoryFs(), now: () => clock.value,
  });
  await store.ready;
  await store.bind('owner-1');
  const settings = settingsFake({ poll });
  const service = createBiliDmService({
    settings,
    client,
    store,
    delivery,
    requestPolicy: policy,
    requestScope: policy
      ? () => ({ providerId: 'bilibili', accountKey: 'account-1', credentialVersion: 'credential-scheduling' })
      : null,
    autoSchedule,
    now: () => clock.value,
    random: () => 0,
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: (handle) => timers.clearTimeout(handle),
  });
  await service.ready;
  await service.start();
  return { store, service, settings };
}

test('budget catchup continues automatically after sixty seconds and completes the saved cursor once', async (t) => {
  const clock = { value: START, advance(ms) { this.value += ms; } };
  const timers = fakeTimers(clock);
  const policy = policyFake();
  const client = pagedClient(clock);
  const delivery = deliveryFake(clock);
  const { store, service } = await makeHarness({ clock, timers, client, policy, delivery });
  delivery.bindStore(store);
  t.after(() => service.deactivate());

  await service.check();
  let status = service.status();
  assert.equal(status.state, 'catching_up');
  assert.equal(status.reasonCode, 'DM_BUDGET');
  assert.equal(status.discovery.pages, 5);
  assert.equal(status.queue.pendingConversations, 0);
  assert.equal(client.calls.filter((call) => call.kind === 'nav').length, 1);
  assert.equal(client.calls.filter((call) => call.kind === 'sessions').length, 5);
  assert.equal(client.calls.filter((call) => call.kind === 'messages').length, 0);

  const catchupTimers = timers.pending();
  assert.equal(catchupTimers.length, 1);
  const catchupMs = catchupTimers[0].ms;
  assert.ok(catchupMs >= 60_000, `expected at least 60s, got ${catchupMs}`);
  assert.ok(catchupMs < 1_800_000, `expected much less than 1800s, got ${catchupMs}`);
  assert.equal(status.nextRetryAt, START + catchupMs);

  await timers.fireNext();
  await service.check();
  status = service.status();
  assert.equal(status.state, 'watching');
  const account = store.current().accounts[UID];
  assert.equal(account.discovery.baselineComplete, true);
  assert.equal(account.discovery.pages, 7);
  assert.deepEqual(
    Object.values(account.messages).map((record) => record.seqno),
    ['6', '7', '8'],
  );
  assert.deepEqual(delivery.sends, ['6', '7', '8']);
  assert.equal(policy.calls.success, 1);
  assert.equal(client.calls.filter((call) => call.kind === 'messages').length, 1);

  const normalTimers = timers.pending();
  assert.equal(normalTimers.length, 1);
  assert.ok(normalTimers[0].ms >= 1_800_000, `expected normal poll, got ${normalTimers[0].ms}`);

  client.setMode('poll');
  await timers.fireNext();
  await service.check();
  assert.equal(client.calls.filter((call) => call.kind === 'messages').length, 1);
  assert.equal(Object.keys(store.current().accounts[UID].messages).length, 3);
  assert.deepEqual(delivery.sends, ['6', '7', '8']);
});

test('future policy cooldown wins over the sixty second catchup floor', async (t) => {
  const clock = { value: START, advance(ms) { this.value += ms; } };
  const timers = fakeTimers(clock);
  const policy = policyFake();
  const client = pagedClient(clock);
  const scan = client.sessions;
  let pageCount = 0;
  client.sessions = async (...args) => {
    const result = await scan(...args);
    pageCount += 1;
    if (pageCount === 5) policy.state.nextAllowedAt = START + 10 * 60_000;
    return result;
  };
  const { store, service } = await makeHarness({ clock, timers, client, policy });
  t.after(() => service.deactivate());

  await service.check();
  assert.equal(service.status().state, 'catching_up');
  const pending = timers.pending();
  assert.equal(pending.length, 1);
  assert.ok(pending[0].ms >= 10 * 60_000, `expected policy cooldown, got ${pending[0].ms}`);
  assert.equal(service.status().nextRetryAt, START + pending[0].ms);

  await timers.fireNext();
  await service.check();
  assert.equal(service.status().state, 'watching');
  assert.equal(policy.calls.success, 1);
  assert.deepEqual(
    Object.values(store.current().accounts[UID].messages).map((record) => record.seqno),
    ['6', '7', '8'],
  );
});

test('manual checks still go through the outbound policy gate', async (t) => {
  const clock = { value: START, advance(ms) { this.value += ms; } };
  const timers = fakeTimers(clock);
  const policy = policyFake({
    nextAllowedAt: START + 5 * 60_000, paused: true, allowRun: false,
  });
  const raw = pagedClient(clock);
  const client = gatedClient(raw, policy);
  const { service } = await makeHarness({
    clock, timers, client, policy, autoSchedule: false,
  });
  t.after(() => service.deactivate());

  await service.check();
  assert.equal(raw.calls.length, 0);
  assert.ok(policy.calls.run > 0);
  assert.ok(policy.calls.blocked > 0);
  assert.equal(service.status().state, 'backoff');
  assert.equal(service.status().reasonCode, 'DM_RATE_LIMIT');
  assert.equal(policy.calls.success, 0);
  assert.equal(policy.calls.failure, 0);
});

test('cached paused status does not block a policy-approved recovery probe', async (t) => {
  const clock = { value: START, advance(ms) { this.value += ms; } };
  const timers = fakeTimers(clock);
  const policy = policyFake({ paused: true, allowRun: true });
  const raw = pagedClient(clock, { pages: 1 });
  const client = gatedClient(raw, policy);
  const { service } = await makeHarness({
    clock, timers, client, policy, autoSchedule: false,
  });
  t.after(() => service.deactivate());

  assert.equal(service.status().requestPolicy.paused, true);
  await service.check();
  assert.equal(raw.calls.filter((call) => call.kind === 'nav').length, 1);
  assert.equal(policy.calls.blocked, 0);
  assert.equal(service.status().state, 'watching');
  assert.equal(policy.calls.success, 1);
});

test('credential changes do not inherit a cached paused gate', async (t) => {
  const clock = { value: START, advance(ms) { this.value += ms; } };
  const timers = fakeTimers(clock);
  const policy = policyFake({ paused: true, allowRun: false });
  const raw = pagedClient(clock, { pages: 1 });
  const client = gatedClient(raw, policy);
  const { service, settings } = await makeHarness({
    clock, timers, client, policy, autoSchedule: false,
  });
  t.after(() => service.deactivate());

  assert.equal(service.status().requestPolicy.paused, true);
  await settings.set('SESSDATA=rotated');
  policy.state.allowRun = true;
  await service.check();
  assert.equal(raw.calls.filter((call) => call.kind === 'nav').length, 1);
  assert.equal(policy.calls.blocked, 0);
  assert.equal(service.status().state, 'watching');
  assert.equal(policy.calls.success, 1);
});

test('pause and deactivate invalidate a pending catchup timer', async (t) => {
  const makeScenario = async () => {
    const clock = { value: START, advance(ms) { this.value += ms; } };
    const timers = fakeTimers(clock);
    const client = pagedClient(clock);
    const { service } = await makeHarness({ clock, timers, client });
    await service.check();
    assert.equal(service.status().state, 'catching_up');
    assert.equal(timers.pending().length, 1);
    return { clock, timers, client, service };
  };

  const stopped = await makeScenario();
  stopped.service.pause();
  assert.equal(stopped.timers.pending().length, 0);
  const callsAfterPause = stopped.client.calls.length;
  stopped.service.deactivate();
  await stopped.service.check();
  assert.equal(stopped.client.calls.length, callsAfterPause);

  const disposed = await makeScenario();
  t.after(() => disposed.service.deactivate());
  disposed.service.deactivate();
  assert.equal(disposed.timers.pending().length, 0);
  const callsAfterDispose = disposed.client.calls.length;
  await disposed.service.check();
  assert.equal(disposed.client.calls.length, callsAfterDispose);
});
