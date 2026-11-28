import test from 'node:test';
import assert from 'node:assert/strict';
import { createBiliLogin } from '../bili-login.js';

const PNG = 'data:image/png;base64,QUJD';
const KEY = 'k'.repeat(32);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check, timeoutMs = 800) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await wait(2);
  }
  throw new Error('condition was not reached');
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeSettings(initial = '') {
  let cookie = initial;
  let revision = initial ? 1 : 0;
  const listeners = new Set();
  const writes = [];
  const settings = {
    writes,
    getBiliCookie: () => cookie,
    getBiliCookieRevision: () => revision,
    subscribeBiliCookie(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setBiliCookie(value, { guard } = {}) {
      if (guard && guard() !== true) throw new Error('stale');
      writes.push(value);
      cookie = value;
      revision += 1;
      for (const listener of [...listeners]) listener({ revision, hasCookie: Boolean(value) });
      return { ok: true, hasCookie: Boolean(value) };
    },
    async clearBiliCookie(options) {
      return settings.setBiliCookie('', options);
    },
    async flush() {},
  };
  return settings;
}

function fakeClient(overrides = {}) {
  return {
    generateCalls: 0,
    pollCalls: 0,
    async generateQr() {
      this.generateCalls += 1;
      return { url: `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${KEY}`, key: KEY };
    },
    async pollQr() {
      this.pollCalls += 1;
      return { state: 'waiting' };
    },
    async nav() {
      return { mid: '425503913', uname: '测试账号' };
    },
    ...overrides,
  };
}

function loginWith(settings, client) {
  return createBiliLogin({
    settings, client, qrEncode: () => PNG, pollIntervalMs: 5, ttlMs: 5000,
  });
}

test('start reuses one active session and wait -> scanned -> success commits only after nav', async () => {
  const settings = fakeSettings();
  let pollResult = { state: 'waiting' };
  const client = fakeClient({
    async pollQr() {
      this.pollCalls += 1;
      return pollResult;
    },
  });
  const login = loginWith(settings, client);

  const first = await login.start();
  assert.equal(first.state, 'waiting');
  assert.equal(typeof first.expiresAt, 'number');
  assert.equal(first.pngDataUrl, PNG);
  assert.deepEqual(Object.keys(first).sort(), [
    'errorCode', 'errorSummary', 'expiresAt', 'pngDataUrl', 'retryAfterMs', 'state',
  ]);
  assert.equal(first.errorCode, null);
  assert.equal(login.hasSession(), true);

  const reused = await login.start();
  assert.equal(reused.state, 'waiting');
  assert.equal(client.generateCalls, 1);

  await until(() => login.status().state === 'waiting' && client.pollCalls >= 1);
  pollResult = { state: 'scanned' };
  await until(() => login.status().state === 'scanned');

  pollResult = { state: 'success', cookie: 'COOKIE-INITIAL' };
  await until(() => login.status().state === 'success');
  assert.deepEqual(settings.writes, ['COOKIE-INITIAL']);
  assert.equal(login.status().pngDataUrl, null);
  assert.equal(login.status().expiresAt, null);
  assert.equal(login.hasSession(), false);
  const polls = client.pollCalls;
  await wait(25);
  assert.equal(client.pollCalls, polls);
});

test('cancel clears timer, QR and key and stops polling', async () => {
  const settings = fakeSettings();
  const client = fakeClient();
  const login = loginWith(settings, client);
  await login.start();
  const cancelled = login.cancel();
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.pngDataUrl, null);
  assert.equal(cancelled.expiresAt, null);
  assert.equal(login.hasSession(), false);
  const calls = client.pollCalls;
  await wait(30);
  assert.equal(client.pollCalls, calls);
  assert.deepEqual(settings.writes, []);
});

test('a waiting session expires after the TTL and stops polling', async () => {
  const settings = fakeSettings();
  const client = fakeClient();
  const login = createBiliLogin({
    settings, client, qrEncode: () => PNG, pollIntervalMs: 4, ttlMs: 20,
  });
  await login.start();
  await until(() => login.status().state === 'expired');
  assert.equal(login.status().pngDataUrl, null);
  assert.equal(login.status().expiresAt, null);
  assert.equal(login.hasSession(), false);
  const calls = client.pollCalls;
  await wait(25);
  assert.equal(client.pollCalls, calls);
});

test('an invalid account validation never overwrites the previous Cookie', async () => {
  const settings = fakeSettings('KEEP-ME');
  const client = fakeClient({
    async pollQr() { return { state: 'success', cookie: 'BAD-COOKIE' }; },
    async nav() { throw Object.assign(new Error('bad'), { code: 'BILI_AUTH' }); },
  });
  const login = loginWith(settings, client);
  await login.start();
  await until(() => login.status().state === 'error');
  assert.deepEqual(settings.writes, []);
  assert.equal(settings.getBiliCookie(), 'KEEP-ME');
});

test('a stale completed poll cannot commit after cancel or after a new session starts', async () => {
  const settings = fakeSettings();
  let releaseOld;
  let polls = 0;
  const client = fakeClient({
    async pollQr() {
      polls += 1;
      if (polls === 1) return new Promise((resolve) => { releaseOld = resolve; });
      return { state: 'waiting' };
    },
  });
  const login = loginWith(settings, client);
  await login.start();
  await until(() => typeof releaseOld === 'function');
  login.cancel();
  await login.start();
  releaseOld({ state: 'success', cookie: 'STALE-COOKIE' });
  await wait(30);
  assert.equal(settings.writes.includes('STALE-COOKIE'), false);
  assert.equal(login.status().state, 'waiting');
});

test('QR expires on the absolute start deadline despite a long Retry-After', async () => {
  const settings = fakeSettings();
  const client = fakeClient({
    async pollQr() {
      throw Object.assign(new Error('limited'), { code: 'BILI_RATE_LIMIT', retryAfterMs: 3_600_000 });
    },
  });
  const login = createBiliLogin({
    settings, client, qrEncode: () => PNG, pollIntervalMs: 5, ttlMs: 40,
  });
  try {
    await login.start();
    await until(() => login.status().state === 'expired');
    assert.equal(login.status().pngDataUrl, null);
    assert.equal(login.status().expiresAt, null);
    assert.equal(login.hasSession(), false);
  } finally { login.deactivate(); }
});

test('QR poll network failures stay visible as safe error metadata and clear on recovery', async () => {
  const settings = fakeSettings();
  let calls = 0;
  const client = fakeClient({
    async pollQr() {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('private network detail'), { code: 'BILI_NETWORK' });
      return { state: 'waiting' };
    },
  });
  const login = createBiliLogin({
    settings, client, qrEncode: () => PNG, pollIntervalMs: 20, ttlMs: 5000,
  });
  try {
    await login.start();
    await until(() => login.status().errorCode === 'BILI_NETWORK');
    assert.equal(login.status().state, 'waiting');
    assert.equal(JSON.stringify(login.status()).includes('private network detail'), false);
    await until(() => login.status().errorCode === null);
    assert.equal(login.status().state, 'waiting');
  } finally { login.deactivate(); }
});

test('a QR nav success after the deadline never commits', async () => {
  const settings = fakeSettings();
  const client = fakeClient({
    async pollQr() {
      await wait(60);
      return { state: 'success', cookie: 'LATE-COOKIE' };
    },
    async nav() { return { mid: '425503913' }; },
  });
  const login = createBiliLogin({
    settings, client, qrEncode: () => PNG, pollIntervalMs: 5, ttlMs: 25,
  });
  try {
    await login.start();
    await until(() => login.status().state === 'expired');
    await wait(60);
    assert.deepEqual(settings.writes, []);
    assert.equal(settings.getBiliCookie(), '');
    assert.equal(login.status().state, 'expired');
  } finally { login.deactivate(); }
});

for (const competing of ['newer-manual', 'logout', 'cancel', 'external-edit', 'deactivate']) {
  test(`stale manual verification cannot commit after ${competing}`, async () => {
    const gate = deferred();
    const settings = fakeSettings('SESSDATA=initial');
    const login = loginWith(settings, fakeClient({
      async nav(cookie) {
        if (cookie.endsWith('slow')) await gate.promise;
        return { mid: cookie.endsWith('slow') ? '41' : '42', uname: 'test' };
      },
    }));
    const old = login.manual('SESSDATA=slow');
    await tick();
    if (competing === 'newer-manual') await login.manual('SESSDATA=newer');
    if (competing === 'logout') await login.logout();
    if (competing === 'cancel') login.cancel();
    if (competing === 'external-edit') await settings.setBiliCookie('SESSDATA=external');
    if (competing === 'deactivate') login.deactivate();
    const expected = settings.getBiliCookie();
    gate.resolve();
    const result = await old;
    assert.equal(settings.getBiliCookie(), expected);
    assert.equal('mid' in result, false);
    assert.equal('uname' in result, false);
    login.deactivate();
  });
}

test('a newer manual intent invalidates the old intent at start, before nav resolves', async () => {
  const gate = deferred();
  const settings = fakeSettings('SESSDATA=initial');
  const login = loginWith(settings, fakeClient({
    async nav(cookie) {
      if (cookie.endsWith('slow')) await gate.promise;
      return { mid: '42', uname: 'test' };
    },
  }));
  const old = login.manual('SESSDATA=slow');
  await tick();
  const newer = await login.manual('SESSDATA=newer');
  assert.deepEqual(newer, { ok: true, state: 'valid' });
  gate.resolve();
  assert.equal((await old).state, 'cancelled');
  assert.equal(settings.getBiliCookie(), 'SESSDATA=newer');
  login.deactivate();
});
test('a stale generate failure cannot overwrite the new session state', async () => {
  const settings = fakeSettings();
  let rejectOld;
  let calls = 0;
  const client = fakeClient({
    async generateQr() {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve, reject) => { rejectOld = reject; });
      }
      return { url: `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${KEY}`, key: KEY };
    },
  });
  const login = loginWith(settings, client);
  const first = login.start();
  await login.cancel();
  await login.start();
  rejectOld(Object.assign(new Error('old failure'), { code: 'BILI_NETWORK' }));
  await first.catch(() => {});
  await wait(20);
  assert.equal(login.status().state, 'waiting');
  assert.equal(login.status().pngDataUrl, PNG);
});

test('inspect validates the shared Cookie without exposing account identity', async () => {
  const missingSettings = fakeSettings('');
  const missing = loginWith(missingSettings, fakeClient());
  assert.deepEqual(await missing.inspect(), { state: 'missing' });

  const validClient = fakeClient();
  const valid = loginWith(fakeSettings('COOKIE-A'), validClient);
  assert.deepEqual(await valid.inspect(), { state: 'valid' });
  const account = await valid.inspectAccount();
  assert.equal(account.state, 'valid');
  assert.equal(account.mid, '425503913');
  assert.equal(account.uname, '测试账号');

  const invalid = loginWith(fakeSettings('COOKIE-A'), fakeClient({
    async nav() { throw Object.assign(new Error('bad'), { code: 'BILI_AUTH' }); },
  }));
  const invalidResult = await invalid.inspect();
  assert.equal(invalidResult.state, 'invalid');
  assert.equal(invalidResult.errorCode, 'BILI_AUTH');

  const offline = loginWith(fakeSettings('COOKIE-A'), fakeClient({
    async nav() { throw Object.assign(new Error('offline'), { code: 'BILI_NETWORK' }); },
  }));
  const offlineResult = await offline.inspect();
  assert.equal(offlineResult.state, 'error');
  assert.equal(offlineResult.errorCode, 'BILI_NETWORK');
  assert.equal('mid' in offlineResult, false);
  assert.equal('uname' in offlineResult, false);
});

test('explicit inspect success replaces a stale QR error unless a QR session is active', async () => {
  const settings = fakeSettings('COOKIE-A');
  let failPoll = true;
  const client = fakeClient({
    async pollQr() {
      this.pollCalls += 1;
      if (failPoll) throw Object.assign(new Error('offline failure'), { code: 'BILI_COOKIE' });
      return { state: 'waiting' };
    },
  });
  const login = loginWith(settings, client);
  try {
    await login.start();
    await until(() => login.status().state === 'error');
    assert.equal(login.status().errorCode, 'BILI_COOKIE');
    assert.deepEqual(await login.inspect(), { state: 'valid' });
    assert.equal(login.status().state, 'valid');
    assert.equal(login.status().errorCode, null);
    assert.equal(login.status().errorSummary, null);

    failPoll = false;
    const started = await login.start();
    assert.equal(['starting', 'waiting'].includes(started.state), true);
    const activeState = login.status().state;
    assert.deepEqual(await login.inspect(), { state: 'valid' });
    assert.equal(login.status().state, activeState);
  } finally {
    login.deactivate();
  }
});

test('manual Cookie save uses the same nav check and never enables anything else', async () => {
  const settings = fakeSettings();
  let navCalls = 0;
  const client = fakeClient({
    async nav() { navCalls += 1; return { mid: '425503913' }; },
  });
  const login = loginWith(settings, client);
  const saved = await login.manual('COOKIE-MANUAL');
  assert.deepEqual(saved, { ok: true, state: 'valid' });
  assert.deepEqual(settings.writes, ['COOKIE-MANUAL']);
  assert.equal(navCalls, 1);
  assert.equal(login.status().state, 'success');

  const rejected = await login.manual('COOKIE-BAD');
  assert.equal(navCalls, 2);
  assert.equal(rejected.ok, true);

  const invalidClient = loginWith(fakeSettings(), fakeClient({
    async nav() { throw Object.assign(new Error('bad'), { code: 'BILI_AUTH' }); },
  }));
  const invalidResult = await invalidClient.manual('COOKIE-NEVER');
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.state, 'invalid');
  assert.equal(invalidResult.errorCode, 'BILI_AUTH');
  const emptyResult = await invalidClient.manual('');
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.state, 'invalid');
  assert.equal(emptyResult.errorCode, 'BILI_AUTH');
});

test('manual distinguishes network/timeout/rate failures from an invalid Cookie', async () => {
  const settings = fakeSettings('KEEP-ME');
  let throwCode = 'BILI_TIMEOUT';
  const login = loginWith(settings, fakeClient({
    async nav() { throw Object.assign(new Error('private detail'), { code: throwCode, retryAfterMs: 5000 }); },
  }));
  const timeout = await login.manual('COOKIE-TIMEOUT');
  assert.equal(timeout.ok, false);
  assert.equal(timeout.state, 'error');
  assert.equal(timeout.errorCode, 'BILI_TIMEOUT');
  assert.equal(timeout.retryAfterMs, 0);
  assert.equal(settings.getBiliCookie(), 'KEEP-ME');
  assert.equal(JSON.stringify(timeout).includes('private detail'), false);

  throwCode = 'BILI_RATE_LIMIT';
  const limited = await login.manual('COOKIE-LIMITED');
  assert.equal(limited.state, 'error');
  assert.equal(limited.errorCode, 'BILI_RATE_LIMIT');
  assert.equal(limited.retryAfterMs, 5000);
  assert.equal(login.status().errorCode, 'BILI_RATE_LIMIT');
  assert.equal(settings.getBiliCookie(), 'KEEP-ME');
});

test('logout clears the shared credential without calling a remote logout endpoint', async () => {
  const settings = fakeSettings('COOKIE-A');
  const client = fakeClient();
  const login = loginWith(settings, client);
  await login.start();
  const result = await login.logout();
  assert.deepEqual(result, { ok: true, state: 'idle' });
  assert.equal(settings.getBiliCookie(), '');
  assert.equal(login.hasSession(), false);
  assert.equal(login.status().state, 'idle');
});

test('deactivate aborts the session and prevents a later start', async () => {
  const settings = fakeSettings();
  const client = fakeClient();
  const login = loginWith(settings, client);
  await login.start();
  const stopped = login.deactivate();
  assert.equal(stopped.state, 'idle');
  assert.equal(login.hasSession(), false);
  const calls = client.generateCalls;
  const after = await login.start();
  assert.equal(after.state, 'idle');
  assert.equal(client.generateCalls, calls);
  await login.flush();
});
