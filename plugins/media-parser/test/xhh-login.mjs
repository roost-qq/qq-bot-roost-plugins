import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSettings } from '../settings.js';
import { createXiaoheiheLogin } from '../xiaoheihe-login.js';

const PNG = 'data:image/png;base64,QUJD';
const QR_URL = 'https://www.xiaoheihe.cn/qr?qr=QR_TOKEN';
const BIG_ID = '9007199254740993';
const GOOD_COOKIE = `user_pkey=pkey-secret; heybox_id=${BIG_ID}; nickname=%E6%B5%8B%E8%AF%95`;
const STATUS_KEYS = [
  'accountEpoch', 'accountLabel', 'errorCode', 'errorSummary', 'expiresAt',
  'pngDataUrl', 'retryAfterMs', 'sessionVersion', 'state',
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check, timeoutMs = 1500) {
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

function fakeSettings(initial = {}) {
  let stored = { ...initial };
  const writes = [];
  const writeOptions = [];
  let changeCount = 0;
  const settings = {
    writes,
    writeOptions,
    get changeCount() { return changeCount; },
    getPrivateMessageProviderCredentials(providerId) {
      assert.equal(providerId, 'xiaoheihe');
      return { ...stored };
    },
    async setPrivateMessageProviderCredentials(providerId, patch, { guard, replace } = {}) {
      assert.equal(providerId, 'xiaoheihe');
      if (guard && guard() !== true) throw new Error('stale credential session');
      writes.push({ ...patch });
      writeOptions.push({ guard: typeof guard, replace: replace === true });
      stored = { ...patch };
      changeCount += 1;
      return { ok: true, providerId };
    },
    async clearPrivateMessageProviderCredentials(providerId, { guard } = {}) {
      assert.equal(providerId, 'xiaoheihe');
      if (guard && guard() !== true) throw new Error('stale credential session');
      writes.push(null);
      writeOptions.push({ clear: true });
      stored = {};
      changeCount += 1;
      return { ok: true, providerId };
    },
    async flush() {},
    getBiliCookie() { throw new Error('Bili credential must not be read'); },
    setBiliCookie() { throw new Error('Bili credential must not be written'); },
    clearBiliCookie() { throw new Error('Bili credential must not be cleared'); },
  };
  return {
    settings,
    writes,
    writeOptions,
    current: () => ({ ...stored }),
    setExternal(value) { stored = { ...value }; changeCount += 1; },
  };
}

function fakeClient(overrides = {}) {
  const client = {
    requestCalls: 0,
    pollCalls: 0,
    authCalls: 0,
    async requestQr() {
      this.requestCalls += 1;
      return {
        qrContent: QR_URL,
        qrId: 'QR_TOKEN',
        pollParams: { qr: 'QR_TOKEN', app: 'web' },
        cookies: { sid: 'session-secret' },
        expiresAt: 10_000_000,
      };
    },
    async pollQr() {
      this.pollCalls += 1;
      return { state: 'waiting' };
    },
    async checkAuthEndpoint() {
      this.authCalls += 1;
      return { authEndpointAccepted: true, messageCount: 0 };
    },
    ...overrides,
  };
  return client;
}

function loginWith(settings, client, options = {}) {
  return createXiaoheiheLogin({
    settings,
    client,
    qrEncode: () => PNG,
    pollIntervalMs: 2,
    ttlMs: 5000,
    ...options,
  });
}

test('start is lazy, reuses an active QR, then saves only after auth confirmation', async () => {
  const fake = fakeSettings();
  let pollResult = { state: 'waiting' };
  let changes = 0;
  const client = fakeClient({
    async pollQr() {
      this.pollCalls += 1;
      return pollResult;
    },
  });
  const login = loginWith(fake.settings, client, {
    onCredentialChange: async () => { changes += 1; },
  });
  try {
    await login.ready;
    assert.equal(client.requestCalls, 0);
    assert.equal(client.pollCalls, 0);
    assert.equal(fake.writes.length, 0);

    const started = await login.start();
    assert.equal(started.state, 'waiting');
    assert.equal(started.pngDataUrl, PNG);
    assert.equal(started.expiresAt - Date.now() >= 4900, true);
    assert.deepEqual(Object.keys(started).sort(), STATUS_KEYS);
    assert.equal(JSON.stringify(started).includes(QR_URL), false);
    assert.equal(JSON.stringify(started).includes('pkey-secret'), false);
    assert.equal(JSON.stringify(started).includes(BIG_ID), false);

    const reused = await login.start();
    assert.equal(reused.state, 'waiting');
    assert.equal(client.requestCalls, 1);

    await until(() => client.pollCalls >= 1 && login.status().state === 'waiting');
    pollResult = { state: 'scanned' };
    await until(() => login.status().state === 'scanned');
    pollResult = {
      state: 'success',
      cookie: GOOD_COOKIE,
      heyboxId: BIG_ID,
      nickname: '测试',
    };
    await until(() => login.status().state === 'success');

    assert.equal(client.authCalls, 1);
    assert.equal(fake.writes.length, 1);
    const saved = fake.writes[0];
    assert.equal(saved.cookie, GOOD_COOKIE);
    assert.equal(saved.heyboxId, BIG_ID);
    assert.equal(saved.nickname, '测试');
    assert.equal(saved.sessionVersion, 1);
    assert.match(saved.accountEpoch, /^[a-f0-9-]{36}$/);
    assert.deepEqual(Object.keys(saved).sort(), [
      'accountEpoch', 'cookie', 'heyboxId', 'nickname', 'sessionVersion',
    ]);
    assert.deepEqual(fake.writeOptions[0], { guard: 'function', replace: true });
    assert.equal(changes, 1);

    const finalStatus = login.status();
    assert.deepEqual(Object.keys(finalStatus).sort(), STATUS_KEYS);
    assert.equal(finalStatus.pngDataUrl, null);
    assert.equal(finalStatus.expiresAt, null);
    assert.match(finalStatus.accountLabel, /测试（90\*\*\*\*93）/);
    const serialized = JSON.stringify(finalStatus);
    assert.equal(serialized.includes(BIG_ID), false);
    assert.equal(serialized.includes('pkey-secret'), false);
    assert.equal(serialized.includes(QR_URL), false);
  } finally {
    login.deactivate();
  }
});

test('cancel stops polling and never commits a late QR success', async () => {
  const fake = fakeSettings();
  const gate = deferred();
  let polls = 0;
  const client = fakeClient({
    async pollQr() {
      polls += 1;
      if (polls === 1) return gate.promise;
      return { state: 'waiting' };
    },
  });
  const login = loginWith(fake.settings, client);
  try {
    await login.start();
    await until(() => polls === 1);
    const cancelled = login.cancel();
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.pngDataUrl, null);
    assert.equal(cancelled.expiresAt, null);
    gate.resolve({
      state: 'success', cookie: GOOD_COOKIE, heyboxId: BIG_ID, nickname: 'late',
    });
    await wait(25);
    assert.equal(fake.writes.length, 0);
    assert.equal(login.status().state, 'cancelled');
  } finally {
    login.deactivate();
  }
});

test('a cancelled session cannot commit after a newer session starts', async () => {
  const fake = fakeSettings();
  const gate = deferred();
  let polls = 0;
  const client = fakeClient({
    async pollQr() {
      polls += 1;
      if (polls === 1) return gate.promise;
      return { state: 'waiting' };
    },
  });
  const login = loginWith(fake.settings, client);
  try {
    await login.start();
    await until(() => polls === 1);
    login.cancel();
    await login.start();
    gate.resolve({
      state: 'success', cookie: 'user_pkey=stale; heybox_id=41', heyboxId: '41',
    });
    await wait(30);
    assert.equal(fake.writes.some((entry) => entry?.cookie?.includes('stale')), false);
    assert.equal(login.status().state, 'waiting');
  } finally {
    login.deactivate();
  }
});

test('start preserves a local cooldown or budget when QR application never completed', async () => {
  for (const [code, retryAfterMs] of [
    ['XHH_COOLDOWN', 900_000],
    ['XHH_BUDGET', 120_000],
  ]) {
    const fake = fakeSettings();
    const client = fakeClient({
      async requestQr() {
        this.requestCalls += 1;
        throw Object.assign(new Error('local gate'), {
          code, retryAfterMs, nextAllowedAt: Date.now() + retryAfterMs,
        });
      },
    });
    const login = loginWith(fake.settings, client, { ttlMs: 5000 });
    try {
      const status = await login.start();
      assert.equal(status.state, 'error', code);
      assert.equal(status.errorCode, code);
      assert.equal(status.retryAfterMs, retryAfterMs);
      assert.equal(status.expiresAt, null);
      assert.equal(status.pngDataUrl, null);
      const serialized = JSON.stringify(status);
      assert.equal(serialized.includes('local gate'), false);
      assert.equal(client.pollCalls, 0);
    } finally {
      login.deactivate();
    }
  }
});

test('an auth rejection keeps the previous credential and reports a safe error', async () => {
  const fake = fakeSettings({
    cookie: 'user_pkey=old', heyboxId: '7', nickname: '旧账号', sessionVersion: 4, accountEpoch: 'epoch-old',
  });
  const client = fakeClient({
    async pollQr() {
      this.pollCalls += 1;
      return { state: 'success', cookie: GOOD_COOKIE, heyboxId: BIG_ID, nickname: '新账号' };
    },
    async checkAuthEndpoint() {
      this.authCalls += 1;
      throw Object.assign(new Error('server-private-detail'), { code: 'XHH_AUTH' });
    },
  });
  const login = loginWith(fake.settings, client);
  try {
    await login.start();
    await until(() => login.status().state === 'error');
    assert.equal(fake.writes.length, 0);
    assert.equal(fake.current().cookie, 'user_pkey=old');
    assert.equal(login.status().errorCode, 'XHH_AUTH');
    assert.equal(JSON.stringify(login.status()).includes('server-private-detail'), false);
  } finally {
    login.deactivate();
  }
});

test('a storage write failure surfaces XHH_STORAGE without overwriting the old account', async () => {
  const fake = fakeSettings({
    cookie: 'user_pkey=keep', heyboxId: '7', nickname: '旧账号', sessionVersion: 2, accountEpoch: 'epoch-keep',
  });
  const originalSet = fake.settings.setPrivateMessageProviderCredentials;
  fake.settings.setPrivateMessageProviderCredentials = async () => {
    throw new Error('disk write failed with secret path');
  };
  const client = fakeClient({
    async pollQr() {
      this.pollCalls += 1;
      return { state: 'success', cookie: GOOD_COOKIE, heyboxId: BIG_ID, nickname: '新账号' };
    },
  });
  const login = loginWith(fake.settings, client);
  try {
    await login.start();
    await until(() => login.status().state === 'error');
    assert.equal(login.status().errorCode, 'XHH_STORAGE');
    assert.equal(fake.current().cookie, 'user_pkey=keep');
    assert.equal(JSON.stringify(login.status()).includes('secret path'), false);
  } finally {
    fake.settings.setPrivateMessageProviderCredentials = originalSet;
    login.deactivate();
  }
});

test('a QR session has a five second minimum lifetime even with a tiny ttl option', async () => {
  const fake = fakeSettings();
  const login = loginWith(fake.settings, fakeClient(), { ttlMs: 1 });
  try {
    const started = await login.start();
    assert.equal(started.expiresAt - Date.now() >= 4900, true);
    const second = await login.start();
    assert.equal(second.state, 'waiting');
  } finally {
    login.deactivate();
  }
});

test('manual login validates the cookie and account ID before saving', async () => {
  const fake = fakeSettings();
  const client = fakeClient();
  const login = loginWith(fake.settings, client);
  try {
    const missingPrimary = await login.manual('heybox_id=42; nickname=x');
    assert.equal(missingPrimary.ok, false);
    assert.equal(missingPrimary.state, 'invalid');
    assert.equal(missingPrimary.errorCode, 'XHH_AUTH');
    assert.equal(client.authCalls, 0);

    const missingId = await login.manual('user_pkey=pkey-only');
    assert.equal(missingId.ok, false);
    assert.equal(missingId.state, 'invalid');
    assert.equal(client.authCalls, 0);

    const saved = await login.manual(GOOD_COOKIE);
    assert.deepEqual(saved, { ok: true, state: 'valid' });
    assert.equal(client.authCalls, 1);
    assert.equal(fake.writes.length, 1);
    assert.equal(fake.writes[0].cookie, GOOD_COOKIE);
    assert.equal(fake.writes[0].heyboxId, BIG_ID);
    assert.equal(fake.writes[0].nickname, '测试');
    assert.equal(login.status().state, 'success');
    assert.equal(login.credentialState().cookie, GOOD_COOKIE);
    assert.equal(login.credentialState().heyboxId, BIG_ID);

    const invalid = loginWith(fake.settings, fakeClient({
      async checkAuthEndpoint() {
        this.authCalls += 1;
        throw Object.assign(new Error('private'), { code: 'XHH_AUTH' });
      },
    }));
    const rejected = await invalid.manual('user_pkey=bad; heybox_id=42');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.state, 'invalid');
    assert.equal(fake.current().cookie, GOOD_COOKIE);
    invalid.deactivate();
  } finally {
    login.deactivate();
  }
});

test('logout removes xiaoheihe secrets while keeping increasing ordering metadata', async () => {
  const fake = fakeSettings({
    cookie: GOOD_COOKIE, heyboxId: BIG_ID, nickname: '测试', sessionVersion: 9, accountEpoch: 'epoch-x',
  });
  const login = loginWith(fake.settings, fakeClient());
  try {
    const before = login.status().sessionVersion;
    const result = await login.logout();
    assert.deepEqual(result, { ok: true, state: 'idle' });
    const stored = fake.current();
    assert.equal(stored.cookie, '');
    assert.equal(stored.heyboxId, '');
    assert.equal(stored.nickname, '');
    assert.equal(stored.sessionVersion, before + 1);
    assert.match(stored.accountEpoch, /^[a-f0-9-]{36}$/);
    assert.notEqual(stored.accountEpoch, 'epoch-x');
    assert.deepEqual(Object.keys(stored).sort(), [
      'accountEpoch', 'cookie', 'heyboxId', 'nickname', 'sessionVersion',
    ]);
    assert.deepEqual(fake.writeOptions.at(-1), { guard: 'function', replace: true });
    assert.equal(fake.writes.some((write) => write === null), false);
    assert.equal(login.status().state, 'idle');
    assert.equal(login.status().sessionVersion, before + 1);
    assert.equal(login.credentialState().cookie, '');
    assert.equal(login.credentialState().heyboxId, '');

    const second = await login.logout();
    assert.equal(second.ok, true);
    assert.equal(fake.current().sessionVersion, before + 2);
  } finally {
    login.deactivate();
  }
});

test('inspect is cached, public-safe, while inspectAccount is internal-only', async () => {
  const fake = fakeSettings({
    cookie: GOOD_COOKIE, heyboxId: BIG_ID, nickname: '测试', sessionVersion: 3, accountEpoch: 'epoch-i',
  });
  const client = fakeClient();
  const login = loginWith(fake.settings, client);
  try {
    const publicResult = await login.inspect();
    assert.deepEqual(publicResult, { state: 'valid' });
    assert.equal(client.authCalls, 1);
    assert.equal(JSON.stringify(publicResult).includes(BIG_ID), false);

    const account = await login.inspectAccount();
    assert.deepEqual(account, {
      state: 'valid', heyboxId: BIG_ID, accountId: BIG_ID, nickname: '测试',
    });
    assert.equal(client.authCalls, 1);

    const status = login.status();
    assert.equal(status.state, 'valid');
    assert.match(status.accountLabel, /测试（90\*\*\*\*93）/);
    assert.equal(JSON.stringify(status).includes(BIG_ID), false);
    assert.equal(JSON.stringify(status).includes('pkey-secret'), false);

    const invalid = loginWith(fake.settings, fakeClient({
      async checkAuthEndpoint() {
        this.authCalls += 1;
        throw Object.assign(new Error('private'), { code: 'XHH_AUTH' });
      },
    }));
    const bad = await invalid.inspect();
    assert.equal(bad.state, 'invalid');
    assert.equal(bad.errorCode, 'XHH_AUTH');
    assert.equal('heyboxId' in bad, false);
    invalid.deactivate();
  } finally {
    login.deactivate();
  }
});

test('background inspection keeps a terminal QR error until explicit inspect', async () => {
  const fake = fakeSettings({
    cookie: GOOD_COOKIE, heyboxId: BIG_ID, nickname: '测试',
    sessionVersion: 2, accountEpoch: 'epoch-background',
  });
  const client = fakeClient({
    async requestQr() {
      this.requestCalls += 1;
      throw Object.assign(new Error('qr offline'), { code: 'XHH_QR' });
    },
  });
  const login = loginWith(fake.settings, client);
  try {
    const started = await login.start();
    assert.equal(started.state, 'error');
    assert.equal(started.errorCode, 'XHH_QR');

    const background = await login.inspectAccount();
    assert.equal(background.state, 'valid');
    assert.equal(login.status().state, 'error');
    assert.equal(login.status().errorCode, 'XHH_QR');

    const cachedBackground = await login.inspectAccount();
    assert.equal(cachedBackground.state, 'valid');
    assert.equal(login.status().state, 'error');
    assert.equal(login.status().errorCode, 'XHH_QR');
    assert.equal(client.authCalls, 1);

    const explicit = await login.inspect();
    assert.deepEqual(explicit, { state: 'valid' });
    assert.equal(login.status().state, 'valid');
    assert.equal(login.status().errorCode, null);
    assert.equal(client.authCalls, 1);
  } finally {
    login.deactivate();
  }
});

test('in-flight inspection cannot accept or cache externally replaced credentials', async () => {
  const initial = {
    cookie: GOOD_COOKIE, heyboxId: BIG_ID, nickname: '测试',
    sessionVersion: 4, accountEpoch: 'epoch-owned',
  };
  const fake = fakeSettings(initial);
  const gate = deferred();
  const client = fakeClient({
    async checkAuthEndpoint() {
      this.authCalls += 1;
      await gate.promise;
      return { authEndpointAccepted: true, messageCount: 0 };
    },
  });
  const login = loginWith(fake.settings, client);
  try {
    const pending = login.inspectAccount();
    await until(() => client.authCalls === 1);
    fake.setExternal({
      cookie: 'user_pkey=external; heybox_id=555555; nickname=external',
      heyboxId: '555555',
      nickname: '外部',
      sessionVersion: 5,
      accountEpoch: 'epoch-external',
    });
    gate.resolve();
    assert.equal((await pending).state, 'cancelled');
    assert.equal(login.status().state, 'idle');

    fake.setExternal(initial);
    const explicit = await login.inspect();
    assert.deepEqual(explicit, { state: 'valid' });
    assert.equal(client.authCalls, 2);
  } finally {
    login.deactivate();
  }
});

test('external account changes invalidate an in-flight manual save', async () => {
  const fake = fakeSettings({
    cookie: 'user_pkey=initial', heyboxId: '7', nickname: '旧账号', sessionVersion: 1, accountEpoch: 'epoch-a',
  });
  const gate = deferred();
  const client = fakeClient({
    async checkAuthEndpoint() {
      this.authCalls += 1;
      await gate.promise;
      return { authEndpointAccepted: true, messageCount: 0 };
    },
  });
  const login = loginWith(fake.settings, client);
  try {
    const pending = login.manual(GOOD_COOKIE);
    await until(() => client.authCalls === 1);
    fake.setExternal({
      cookie: 'user_pkey=external', heyboxId: '8', nickname: '外部', sessionVersion: 2, accountEpoch: 'epoch-b',
    });
    gate.resolve();
    const result = await pending;
    assert.equal(result.state, 'cancelled');
    assert.equal(fake.current().cookie, 'user_pkey=external');
  } finally {
    login.deactivate();
  }
});

test('deactivate aborts the session and later start stays local', async () => {
  const fake = fakeSettings();
  const client = fakeClient();
  const login = loginWith(fake.settings, client);
  await login.start();
  const stopped = login.deactivate();
  assert.equal(stopped.state, 'idle');
  assert.equal(stopped.pngDataUrl, null);
  const calls = client.requestCalls;
  const after = await login.start();
  assert.equal(after.state, 'idle');
  assert.equal(client.requestCalls, calls);
  await login.flush();
});

test('real settings logout persists empty credentials and monotonic metadata across reload', async () => {
  const dataDir = await fs.mkdtemp(path.join(process.cwd(), 'xhh-logout-test-'));
  try {
    const ctx = { dataDir, config: {}, setConfig: async () => {} };
    const settings = createSettings(ctx, { isActive: () => true });
    await settings.ready;
    await settings.setBiliCookie('SESSDATA=bili-unchanged');
    await settings.setPrivateMessageProviderCredentials('xiaoheihe', {
      cookie: GOOD_COOKIE, heyboxId: BIG_ID, nickname: '测试',
      sessionVersion: 9, accountEpoch: 'epoch-real',
    });
    const login = loginWith(settings, fakeClient());
    await login.ready;
    assert.equal(login.status().sessionVersion, 9);

    const result = await login.logout();
    assert.deepEqual(result, { ok: true, state: 'idle' });
    const stored = settings.getPrivateMessageProviderCredentials('xiaoheihe');
    assert.equal(stored.cookie, '');
    assert.equal(stored.heyboxId, '');
    assert.equal(stored.nickname, '');
    assert.equal(stored.sessionVersion, 10);
    assert.match(stored.accountEpoch, /^[a-f0-9-]{36}$/);
    assert.notEqual(stored.accountEpoch, 'epoch-real');
    assert.equal(settings.getBiliCookie(), 'SESSDATA=bili-unchanged');
    assert.equal(login.status().sessionVersion, 10);
    assert.equal(login.credentialState().cookie, '');
    assert.equal(login.credentialState().heyboxId, '');
    login.deactivate();

    const reloaded = createSettings(ctx, { isActive: () => true });
    await reloaded.ready;
    const after = reloaded.getPrivateMessageProviderCredentials('xiaoheihe');
    assert.equal(after.cookie, '');
    assert.equal(after.heyboxId, '');
    assert.equal(after.nickname, '');
    assert.equal(after.sessionVersion, 10);
    assert.equal(after.accountEpoch, stored.accountEpoch);
    assert.equal(reloaded.getBiliCookie(), 'SESSDATA=bili-unchanged');

    const reloadedLogin = createXiaoheiheLogin({
      settings: reloaded,
      client: fakeClient(),
      qrEncode: () => PNG,
      pollIntervalMs: 2,
      ttlMs: 5000,
    });
    await reloadedLogin.ready;
    assert.equal(reloadedLogin.status().state, 'idle');
    assert.equal(reloadedLogin.status().sessionVersion, 10);
    assert.equal(reloadedLogin.status().accountLabel, '');
    assert.equal(reloadedLogin.credentialState().cookie, '');
    assert.equal(reloadedLogin.credentialState().heyboxId, '');
    reloadedLogin.deactivate();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('real settings save survives reload without touching the Bili credential', async () => {
  const dataDir = await fs.mkdtemp(path.join(process.cwd(), 'xhh-login-test-'));
  try {
    const ctx = { dataDir, config: {}, setConfig: async () => {} };
    const settings = createSettings(ctx, { isActive: () => true });
    await settings.ready;
    const client = fakeClient({
      async pollQr() {
        this.pollCalls += 1;
        return { state: 'success', cookie: GOOD_COOKIE, heyboxId: BIG_ID, nickname: '测试' };
      },
    });
    const login = loginWith(settings, client);
    await login.start();
    await until(() => login.status().state === 'success');

    const beforeReload = login.credentialState();
    assert.equal(beforeReload.cookie, GOOD_COOKIE);
    assert.equal(beforeReload.heyboxId, BIG_ID);
    assert.equal(beforeReload.sessionVersion, 1);
    assert.match(beforeReload.accountEpoch, /^[a-f0-9-]{36}$/);
    assert.equal(settings.getBiliCookie(), '');
    login.deactivate();

    const reloaded = createSettings(ctx, { isActive: () => true });
    await reloaded.ready;
    const stored = reloaded.getPrivateMessageProviderCredentials('xiaoheihe');
    assert.equal(stored.cookie, GOOD_COOKIE);
    assert.equal(stored.heyboxId, BIG_ID);
    assert.equal(stored.nickname, '测试');
    assert.equal(stored.sessionVersion, beforeReload.sessionVersion);
    assert.equal(stored.accountEpoch, beforeReload.accountEpoch);
    assert.equal(reloaded.getBiliCookie(), '');

    const reloadedLogin = createXiaoheiheLogin({
      settings: reloaded,
      client: fakeClient(),
      qrEncode: () => PNG,
      pollIntervalMs: 2,
      ttlMs: 5000,
    });
    await reloadedLogin.ready;
    const state = reloadedLogin.credentialState();
    assert.equal(state.cookie, GOOD_COOKIE);
    assert.equal(state.heyboxId, BIG_ID);
    const publicStatus = reloadedLogin.status();
    assert.equal(publicStatus.state, 'idle');
    assert.match(publicStatus.accountLabel, /测试（90\*\*\*\*93）/);
    const serialized = JSON.stringify(publicStatus);
    assert.equal(serialized.includes(BIG_ID), false);
    assert.equal(serialized.includes('pkey-secret'), false);
    reloadedLogin.deactivate();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
