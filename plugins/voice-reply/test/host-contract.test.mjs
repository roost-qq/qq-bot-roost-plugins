import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MANIFEST, ROOT } from '../lib/config.mjs';
import { temporary } from './helpers.mjs';

const host = process.env.DSH_ROOST_DIR;
test('自带面板请求 Roost 真实 quick 路由', () => {
  const html = readFileSync(join(ROOT, 'page.html'), 'utf8');
  assert.match(html, /fetch\('\/roost\/api\/quick'/);
  assert.doesNotMatch(html, /fetch\('\/api'/);
});
test('安装宿主清单、配置、面板和分级契约', { skip: !host && '设置 DSH_ROOST_DIR 后运行真实宿主契约检查' }, async () => {
  const load = name => import(pathToFileURL(join(host, 'src', name)).href);
  const { validateManifest } = await load('ext-registry.js');
  const { normalizeConfigSpec } = await load('ext-config.js');
  const { normalizeUiSpec } = await load('ext-ui.js');
  const { deriveTier } = await load('ext-tier.js');
  const m = validateManifest(MANIFEST, { expectedId: 'voice-reply' });
  assert.equal(m.ok, true, JSON.stringify(m.errors));
  const config = normalizeConfigSpec(MANIFEST.config); assert.equal(config.ok, true, JSON.stringify(config.errors));
  const ui = normalizeUiSpec(MANIFEST.ui); assert.equal(ui.ok, true, JSON.stringify(ui.errors));
  assert.equal(ui.spec.nav.group, 'express');
  const tier = deriveTier(MANIFEST);
  assert.equal(tier.level, 3); // 当前宿主将同源页面/进程内执行纳入分级。
  assert.ok(tier.reasons.some(x => x.kind === 'form' && x.key === 'inprocess'));
  assert.deepEqual(tier.scopes, []);
  assert.ok(MANIFEST.usage.length <= 200);
});
test('真实出站执行器将.silk路径送入一次sendVoice，未启用内置TTS也生效', { skip: !host && '设置 DSH_ROOST_DIR 后运行真实宿主契约检查' }, async () => {
  const { createActionRunner, parseOutboundActions } = await import(pathToFileURL(join(host, 'src/outbound-actions.js')).href);
  const path = resolve(ROOT, 'fixture-audio.silk');
  const marker = `<<voice: ${path}>>`;
  const parsed = parseOutboundActions(marker);
  assert.equal(parsed.actions[0].type, 'voice'); assert.equal(parsed.text, '');
  const calls = [];
  const run = createActionRunner({ channel: () => ({ sendVoice: async payload => { calls.push(payload); return { ok: true, id: 'fixture-message' }; }, send: async () => { throw new Error('不应发送额外文本'); } }), tts: null });
  let sent = 0;
  await run({ text: marker, scene: 'c2c', target: 'fixture', msgId: 'fixture-message', onSent: () => { sent++; } });
  // 宿主返回值只描述正文，媒体成功由 onSent 回调报告。
  assert.equal(calls.length, 1); assert.equal(calls[0].path, path); assert.equal(sent, 1);
});
test('正式registry临时安装后配置可编辑，密钥不回显且升级保留设置', { skip: !host && '设置 DSH_ROOST_DIR 后运行真实宿主契约检查' }, async t => {
  const { createExtRegistry } = await import(pathToFileURL(join(host, 'src/ext-registry.js')).href);
  const { createExtPanel } = await import(pathToFileURL(join(host, 'src/ext-panel.js')).href);
  const dir = temporary(t), registry = createExtRegistry({ dir });
  const installed = registry.install(ROOT, { source: { kind: 'review-fixture' } });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(registry.isForeign('voice-reply'), false);
  const panel = createExtPanel({ dir, registry, clientStore: {} });
  assert.equal(panel.configOf('voice-reply').canEdit, true);
  assert.equal(panel.saveConfig('voice-reply', { speed: 1.2 }, { translateKey: 'fixture-not-a-real-key' }).ok, true);
  const out = panel.configOf('voice-reply');
  assert.equal(out.values.speed, 1.2); assert.equal(out.secretSet.translateKey, true);
  assert.doesNotMatch(JSON.stringify(out), /fixture-not-a-real-key/);
  assert.equal(registry.install(ROOT, { source: { kind: 'review-fixture' } }).ok, true);
  assert.equal(panel.configOf('voice-reply').values.speed, 1.2);
});
test('市场发布物没有用户路径、凭证、运行记录或CRLF，版本一致', () => {
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, MANIFEST.version);
  assert.equal(MANIFEST.kind, 'dsh-extension'); assert.deepEqual(MANIFEST.scopes, []);
  function walk(root) {
    for (const name of readdirSync(root)) {
      assert.ok(!['node_modules', '.git', 'config.json', 'last.json', '.roost-cache'].includes(name), '夹带运行文件: ' + name);
      const file = join(root, name), st = lstatSync(file); assert.equal(st.isSymbolicLink(), false);
      if (st.isDirectory()) walk(file);
      else if (!file.endsWith('.wasm')) {
        const text = readFileSync(file, 'utf8');
        assert.equal(text.includes('\r'), false, 'CRLF: ' + file);
        assert.doesNotMatch(text, /[A-Z]:[\\/]Users[\\/]/);
      }
    }
  }
  walk(ROOT);
});
