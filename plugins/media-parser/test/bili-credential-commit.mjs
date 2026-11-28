import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettings } from '../settings.js';
import { createBiliLogin } from '../bili-login.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureParent = path.join(testDir, '.credential-commit');
const OLD = 'SESSDATA=offline-old-session';
const NEXT = 'SESSDATA=offline-new-session';

async function fixture(t) {
  await fs.mkdir(fixtureParent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(fixtureParent, 'run-'));
  const ctx = {
    dataDir: dir,
    config: {},
    async setConfig(patch) { Object.assign(this.config, patch); },
  };
  const settings = createSettings(ctx);
  await settings.ready;
  await settings.setBiliCookie(OLD, { guard: () => true });
  t.after(async () => {
    await settings.flush().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, ctx, settings };
}

function loginFor(settings, client = {}) {
  return createBiliLogin({
    settings,
    pollIntervalMs: 1,
    ttlMs: 3000,
    qrEncode: () => 'data:image/png;base64,QUJD',
    client: {
      async generateQr() { return { key: 'k'.repeat(32), url: 'https://offline.invalid' }; },
      async pollQr() { return { state: 'success', cookie: NEXT }; },
      async nav() { return { mid: '123456', uname: 'offline' }; },
      ...client,
    },
  });
}

test('real settings commit owns its new revision and persists metadata once', async (t) => {
  const { dir, ctx, settings } = await fixture(t);
  const revision = settings.getBiliCookieRevision();
  const events = [];
  const unsubscribe = settings.subscribeBiliCookie((event) => events.push(event));
  t.after(unsubscribe);

  await settings.setBiliCookie(NEXT, {
    guard: () => settings.getBiliCookieRevision() === revision,
  });

  assert.equal(settings.getBiliCookieRevision(), revision + 1);
  assert.deepEqual(events, [{ revision: revision + 1, hasCookie: true }]);
  const credentials = JSON.parse(await fs.readFile(path.join(dir, 'credentials.json'), 'utf8'));
  assert.equal(credentials.bilibili_enhanced.cookie, NEXT);
  const advanced = JSON.parse(await fs.readFile(path.join(dir, 'engine-settings.json'), 'utf8'));
  assert.equal(advanced.privateMessageSessionVersion, settings.getBiliSessionVersion());
  assert.equal(JSON.stringify(advanced).includes(NEXT), false);

  const restored = createSettings(ctx);
  await restored.ready;
  assert.equal(restored.getBiliCookie(), NEXT);
  await restored.flush();

  const stableRevision = settings.getBiliCookieRevision();
  const stableEvents = events.length;
  await settings.setBiliCookie(NEXT, { guard: () => true });
  assert.equal(settings.getBiliCookieRevision(), stableRevision);
  assert.equal(events.length, stableEvents);
});

test('a guard that expires before rename still prevents a late credential commit', async (t) => {
  const { dir, settings } = await fixture(t);
  const revision = settings.getBiliCookieRevision();
  const before = await fs.readFile(path.join(dir, 'credentials.json'), 'utf8');
  let checks = 0;

  await assert.rejects(settings.setBiliCookie(NEXT, {
    guard: () => {
      checks += 1;
      return checks === 1;
    },
  }), /未保存/);

  assert.equal(checks, 2);
  assert.equal(settings.getBiliCookie(), OLD);
  assert.equal(settings.getBiliCookieRevision(), revision);
  assert.equal(await fs.readFile(path.join(dir, 'credentials.json'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
});

test('real settings plus successful QR login reports success after persistence', async (t) => {
  const { dir, settings } = await fixture(t);
  const revision = settings.getBiliCookieRevision();
  const login = loginFor(settings);
  t.after(() => login.deactivate());
  await login.start();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && ['starting', 'waiting', 'scanned'].includes(login.status().state)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(settings.getBiliCookie(), NEXT);
  assert.equal(settings.getBiliCookieRevision(), revision + 1);
  assert.equal(login.status().state, 'success');
  assert.equal(login.status().errorCode, null);
  const credentials = JSON.parse(await fs.readFile(path.join(dir, 'credentials.json'), 'utf8'));
  assert.equal(credentials.bilibili_enhanced.cookie, NEXT);
});

test('real settings plus validated manual login reports success after persistence', async (t) => {
  const { settings } = await fixture(t);
  const login = loginFor(settings);
  t.after(() => login.deactivate());
  const result = await login.manual(NEXT);
  assert.deepEqual(result, { ok: true, state: 'valid' });
  assert.equal(settings.getBiliCookie(), NEXT);
  assert.equal(login.status().errorCode, null);
});

test('real credential write failure is a storage error, not a missing cookie', async (t) => {
  const { dir, settings } = await fixture(t);
  const revision = settings.getBiliCookieRevision();
  const credentialsFile = path.join(dir, 'credentials.json');
  await fs.rm(credentialsFile, { force: true });
  await fs.mkdir(credentialsFile);
  const login = loginFor(settings);
  t.after(() => login.deactivate());

  const result = await login.manual(NEXT);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'error');
  assert.equal(result.errorCode, 'BILI_STORAGE');
  assert.equal(settings.getBiliCookie(), OLD);
  assert.equal(settings.getBiliCookieRevision(), revision);
  assert.equal(login.status().errorCode, 'BILI_STORAGE');
});

test('a metadata IO failure after the credential commit is a storage error, not cancelled', async (t) => {
  const { dir, settings } = await fixture(t);
  const login = loginFor(settings);
  t.after(() => login.deactivate());
  const originalRename = fs.rename;
  fs.rename = async function (from, to, ...args) {
    if (String(to) === path.join(dir, 'engine-settings.json')) {
      throw Object.assign(new Error('offline simulated IO failure'), { code: 'EACCES' });
    }
    return originalRename.call(this, from, to, ...args);
  };
  try {
    const result = await login.manual(NEXT);
    assert.equal(settings.getBiliCookie(), NEXT);
    assert.equal(result.ok, false);
    assert.equal(result.state, 'error');
    assert.equal(result.errorCode, 'BILI_STORAGE');
    assert.equal(login.status().errorCode, 'BILI_STORAGE');
  } finally {
    fs.rename = originalRename;
  }
});

test('a late manual operation cannot overwrite a newer credential', async (t) => {
  const { dir, settings } = await fixture(t);
  let release;
  let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const paused = new Promise((resolve) => { reached = resolve; });
  const login = loginFor(settings, {
    async nav(cookie) {
      if (cookie.endsWith('slow')) {
        reached();
        await gate;
      }
      return { mid: '123456', uname: 'offline' };
    },
  });
  t.after(() => login.deactivate());

  const old = login.manual('SESSDATA=slow');
  await paused;
  await settings.setBiliCookie('SESSDATA=external', { guard: () => true });
  release();
  const result = await old;
  assert.equal(result.state, 'cancelled');
  assert.equal(settings.getBiliCookie(), 'SESSDATA=external');
  const credentials = JSON.parse(await fs.readFile(path.join(dir, 'credentials.json'), 'utf8'));
  assert.equal(credentials.bilibili_enhanced.cookie, 'SESSDATA=external');
});

test.after(async () => {
  await fs.rm(fixtureParent, { recursive: true, force: true });
});
