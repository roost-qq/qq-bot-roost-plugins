import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSettings, MASK, readConfig, validateConfig,
} from '../settings.js';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureParent = path.join(pluginDir, '.test-data');
const fixtureDirs = [];

function directory() {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, 'settings-'));
  fixtureDirs.push(root);
  return root;
}

function context(dataDir) {
  return { dataDir, config: {} };
}

function writeCredentials(root, value) {
  fs.writeFileSync(path.join(root, 'credentials.json'), JSON.stringify(value, null, 2));
}

function readDisk(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'credentials.json'), 'utf8'));
}

test.after(() => {
  for (const root of fixtureDirs) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  try { fs.rmdirSync(fixtureParent); } catch { /* other test files may share it */ }
});

test('new Bili DM defaults and poll bounds are validated', () => {
  const defaults = readConfig(context(directory()));
  assert.equal(defaults.biliDmEnabled, false);
  assert.equal(defaults.biliDmPollSeconds, 300);
  assert.equal(defaults.biliDmIncludeSystem, false);
  assert.equal(validateConfig({ biliDmPollSeconds: 180 }).biliDmPollSeconds, 180);
  assert.equal(validateConfig({ biliDmPollSeconds: 1800 }).biliDmPollSeconds, 1800);
  assert.equal(validateConfig({ biliDmPollSeconds: 3600 }).biliDmPollSeconds, 3600);
  assert.throws(() => validateConfig({ biliDmPollSeconds: 179 }), /180～3600/);
  assert.throws(() => validateConfig({ biliDmPollSeconds: 3601 }), /180～3600/);
  assert.throws(() => validateConfig({ biliDmPollSeconds: 180.5 }), /180～3600/);
  assert.throws(() => validateConfig({ biliDmEnabled: 'yes' }), /布尔/);
});

test('legacy upstream Bili cookie normalizes to one root canonical value and preserves everything else', async () => {
  const root = directory();
  writeCredentials(root, {
    other: { cookie: 'KEEP-OTHER' },
    bilibili_enhanced: { cookie: 'ROOT-OLD', use_cookie: false, max_quality: '720P' },
    upstream: {
      bilibili_enhanced: { cookie: 'UPSTREAM-NEW', other_field: 7 },
      other_platform: { token: 'KEEP-TOKEN' },
    },
  });
  const settings = createSettings(context(root));
  await settings.ready;
  const disk = readDisk(root);
  assert.equal(disk.bilibili_enhanced.cookie, 'UPSTREAM-NEW');
  assert.equal(disk.bilibili_enhanced.use_cookie, false);
  assert.equal(disk.bilibili_enhanced.max_quality, '720P');
  assert.equal('cookie' in disk.upstream.bilibili_enhanced, false);
  assert.equal(disk.upstream.bilibili_enhanced.other_field, 7);
  assert.equal(disk.upstream.other_platform.token, 'KEEP-TOKEN');
  assert.equal(disk.other.cookie, 'KEEP-OTHER');
  assert.equal(settings.getBiliCookie(), 'UPSTREAM-NEW');
  assert.equal(settings.getBiliCookieRevision(), 1);
});

test('an explicit empty legacy cookie clears the canonical value', async () => {
  const root = directory();
  writeCredentials(root, {
    bilibili_enhanced: { cookie: 'ROOT-OLD' },
    upstream: { bilibili_enhanced: { cookie: '', keep: true } },
  });
  const settings = createSettings(context(root));
  await settings.ready;
  const disk = readDisk(root);
  assert.equal(disk.bilibili_enhanced.cookie, '');
  assert.equal('cookie' in disk.upstream.bilibili_enhanced, false);
  assert.equal(disk.upstream.bilibili_enhanced.keep, true);
  assert.equal(settings.getBiliCookie(), '');
});

test('Cookie values never appear in public config, status projections or credential hints', async () => {
  const root = directory();
  writeCredentials(root, { bilibili_enhanced: { cookie: 'CANONICAL-ONLY-VALUE' }, pixiv: { cookie: 'PIXIV-VALUE' } });
  const settings = createSettings(context(root));
  await settings.ready;
  const projections = [
    settings.publicConfig(), settings.current(), settings.advanced(),
    settings.credentialHints(), settings.platforms(),
  ].map((value) => JSON.stringify(value));
  for (const text of projections) {
    assert.equal(text.includes('CANONICAL-ONLY-VALUE'), false);
    assert.equal(text.includes('PIXIV-VALUE'), false);
  }
  assert.equal(settings.credentialHints()['bilibili_enhanced.cookie'].value, MASK);
});

test('set, guard and clear serialize through the existing queue and publish safe revisions', async () => {
  const root = directory();
  const settings = createSettings(context(root));
  await settings.ready;
  const events = [];
  const unsubscribe = settings.subscribeBiliCookie((event) => events.push(event));
  assert.equal(settings.getBiliCookieRevision(), 0);

  const saved = await settings.setBiliCookie('ALPHA-VALUE', { guard: () => true });
  assert.deepEqual(saved, { ok: true, hasCookie: true });
  assert.equal(settings.getBiliCookie(), 'ALPHA-VALUE');
  assert.equal(settings.getBiliCookieRevision(), 1);
  assert.equal(readDisk(root).bilibili_enhanced.cookie, 'ALPHA-VALUE');
  assert.deepEqual(events, [{ revision: 1, hasCookie: true }]);
  assert.equal(JSON.stringify(events).includes('ALPHA-VALUE'), false);

  await assert.rejects(settings.setBiliCookie('STALE-VALUE', { guard: () => false }), /未保存/);
  assert.equal(settings.getBiliCookie(), 'ALPHA-VALUE');
  assert.equal(settings.getBiliCookieRevision(), 1);
  assert.equal(readDisk(root).bilibili_enhanced.cookie, 'ALPHA-VALUE');
  assert.equal(events.length, 1);

  const cleared = await settings.clearBiliCookie({ guard: () => true });
  assert.deepEqual(cleared, { ok: true, hasCookie: false });
  assert.equal(settings.getBiliCookie(), '');
  assert.equal(settings.getBiliCookieRevision(), 2);
  assert.equal(readDisk(root).bilibili_enhanced.cookie, '');
  assert.deepEqual(events[1], { revision: 2, hasCookie: false });
  unsubscribe();
  await settings.setBiliCookie('NO-EVENT', { guard: () => true });
  assert.equal(events.length, 2);
  await settings.flush();
});

test('the commit guard is rechecked after the temp write and before rename', async () => {
  const root = directory();
  const settings = createSettings(context(root));
  await settings.ready;
  await settings.setBiliCookie('STABLE-VALUE', { guard: () => true });
  const file = path.join(root, 'credentials.json');
  const before = fs.readFileSync(file, 'utf8');
  const revision = settings.getBiliCookieRevision();
  const events = [];
  settings.subscribeBiliCookie((event) => events.push(event));

  let checks = 0;
  await assert.rejects(settings.setBiliCookie('LATE-VALUE', {
    guard: () => {
      checks += 1;
      return checks === 1;
    },
  }));
  assert.equal(checks, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(settings.getBiliCookie(), 'STABLE-VALUE');
  assert.equal(settings.getBiliCookieRevision(), revision);
  assert.equal(events.length, 0);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
});

test('a rejected subscriber promise is observed instead of crashing host storage', async () => {
  const root = directory();
  const settings = createSettings(context(root));
  await settings.ready;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  let unsubscribe = () => {};
  try {
    unsubscribe = settings.subscribeBiliCookie(() => Promise.reject(new Error('private subscriber failure')));
    await settings.setBiliCookie('SAFE-VALUE', { guard: () => true });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settings.getBiliCookie(), 'SAFE-VALUE');
    assert.deepEqual(unhandled, []);
  } finally {
    unsubscribe();
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('saveAdvanced and saveCredentials normalize and invalidate the Bili cookie while preserving other secrets', async () => {
  const root = directory();
  writeCredentials(root, { pixiv: { cookie: 'PIXIV-KEEP' }, bilibili_enhanced: { cookie: 'OLD' } });
  const settings = createSettings(context(root));
  await settings.ready;
  const events = [];
  settings.subscribeBiliCookie((event) => events.push(event));

  await settings.saveAdvanced({ upstream: { bilibili_enhanced: { cookie: 'FROM-ADVANCED' } } });
  assert.equal(settings.getBiliCookie(), 'FROM-ADVANCED');
  let disk = readDisk(root);
  assert.equal(disk.bilibili_enhanced.cookie, 'FROM-ADVANCED');
  assert.equal('cookie' in disk.upstream.bilibili_enhanced, false);
  assert.equal(disk.pixiv.cookie, 'PIXIV-KEEP');
  assert.equal(events.length, 1);

  await settings.saveCredentials({ bilibili_enhanced: { cookie: 'FROM-CREDENTIALS' }, github: { token: 'KEEP' } });
  assert.equal(settings.getBiliCookie(), 'FROM-CREDENTIALS');
  disk = readDisk(root);
  assert.equal(disk.bilibili_enhanced.cookie, 'FROM-CREDENTIALS');
  assert.equal(disk.pixiv.cookie, 'PIXIV-KEEP');
  assert.equal(disk.github.token, 'KEEP');
  assert.equal(events.length, 2);
});

test('disk failure leaves memory, revision and subscribers unchanged and cleans the temp file', async () => {
  const root = directory();
  const settings = createSettings(context(root));
  await settings.ready;
  await settings.setBiliCookie('STABLE-VALUE', { guard: () => true });
  const before = settings.getBiliCookie();
  const revision = settings.getBiliCookieRevision();
  const events = [];
  settings.subscribeBiliCookie((event) => events.push(event));

  const file = path.join(root, 'credentials.json');
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  await assert.rejects(settings.setBiliCookie('BROKEN-VALUE', { guard: () => true }));
  assert.equal(settings.getBiliCookie(), before);
  assert.equal(settings.getBiliCookieRevision(), revision);
  assert.equal(events.length, 0);
  const leftovers = fs.readdirSync(root).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  fs.rmdirSync(file);
  fs.writeFileSync(file, JSON.stringify({ bilibili_enhanced: { cookie: before } }));
});

test('an optional initial barrier is awaited before loading files', async () => {
  const root = directory();
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const settings = createSettings(context(root), { initialBarrier: barrier });
  let done = false;
  settings.ready.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false);
  release();
  await settings.ready;
  assert.equal(done, true);
});
