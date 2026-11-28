import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettings, DEFAULTS } from '../settings.js';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function root(t, config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-settings-lifecycle-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, config: { ...DEFAULTS, ...config } };
}

function context(dir, config, activeRef = { value: true }, gate = null) {
  return {
    dataDir: dir,
    config: { ...config },
    async setConfig(patch) {
      if (gate) await gate.promise;
      Object.assign(this.config, patch);
      return this.config;
    },
  };
}

test('an inactive generation cannot create settings or commit any queued write', async (t) => {
  const { dir, config } = await root(t);
  const active = { value: true };
  const settings = createSettings(context(dir, config, active), { isActive: () => active.value });
  await settings.ready;
  const advancedFile = path.join(dir, 'engine-settings.json');
  const credentialsFile = path.join(dir, 'credentials.json');
  const advancedBefore = await fs.readFile(advancedFile, 'utf8');
  const credentialsBefore = await fs.readFile(credentialsFile, 'utf8');

  active.value = false;
  await assert.rejects(settings.saveConfig({ biliDmEnabled: true }), /已拒绝写入/);
  await assert.rejects(settings.saveAdvanced({ parsers: { bilibili: '仅文本' } }), /已拒绝写入/);
  await assert.rejects(settings.saveCredentials({ github: { token: 'secret' } }), /已拒绝写入/);
  assert.equal(await fs.readFile(advancedFile, 'utf8'), advancedBefore);
  assert.equal(await fs.readFile(credentialsFile, 'utf8'), credentialsBefore);
});

test('a queued save rechecks activity after the host await and before the file rename', async (t) => {
  const { dir, config } = await root(t);
  const active = { value: true };
  const gate = deferred();
  const settings = createSettings(context(dir, config, active, gate), { isActive: () => active.value });
  await settings.ready;
  const file = path.join(dir, 'engine-settings.json');
  const before = await fs.readFile(file, 'utf8');
  const pending = settings.saveConfig({ biliDmEnabled: true });
  active.value = false;
  gate.resolve();
  await assert.rejects(pending, /已拒绝写入/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('saveConfig, saveAdvanced and saveCredentials honor an explicit commit guard', async (t) => {
  const { dir, config } = await root(t);
  const settings = createSettings(context(dir, config));
  await settings.ready;
  const file = path.join(dir, 'engine-settings.json');
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(settings.saveConfig({ biliDmEnabled: true }, { guard: () => false }), /未保存/);
  await assert.rejects(settings.saveAdvanced({ parsers: { bilibili: '仅文本' } }, { guard: () => false }), /未保存/);
  await assert.rejects(settings.saveCredentials({ github: { token: 'secret' } }, { guard: () => false }), /未保存/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(settings.credentialHints().github, undefined);
});

test('initial load waits for the write handoff before reading any file', async (t) => {
  const { dir, config } = await root(t);
  const file = path.join(dir, 'engine-settings.json');
  await fs.writeFile(file, JSON.stringify({ parsers: { bilibili: '仅文本' } }));
  const barrier = deferred();
  const settings = createSettings(context(dir, config), { initialBarrier: barrier.promise });
  await fs.writeFile(file, JSON.stringify({ parsers: { bilibili: '仅富媒体' } }));
  let loaded = false;
  settings.ready.then(() => { loaded = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaded, false);
  barrier.resolve();
  await settings.ready;
  assert.equal(settings.advanced().parsers.bilibili, '仅富媒体');
});

test('flush waits for queued writes and later writes are not accepted by a stale generation', async (t) => {
  const { dir, config } = await root(t);
  const active = { value: true };
  const settings = createSettings(context(dir, config, active), { isActive: () => active.value });
  await settings.ready;
  const pending = settings.saveConfig({ biliDmPollSeconds: 240 });
  const flushed = settings.flush();
  await Promise.all([pending, flushed]);
  assert.equal(settings.current().biliDmPollSeconds, 240);
  active.value = false;
  await assert.rejects(settings.saveConfig({ biliDmPollSeconds: 180 }), /已拒绝写入/);
  assert.equal(settings.current().biliDmPollSeconds, 240);
});
