import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST, DEFAULTS } from '../lib/config.mjs';
import { createProfiles } from '../lib/profiles.mjs';

const page = readFileSync(new URL('../page.html', import.meta.url), 'utf8');
const source = page.match(/<script>([\s\S]*?)<\/script>/)[1];
const voice = { api: 'http://127.0.0.1:9880', sovitsWeights: 'a.pth', gptWeights: 'a.ckpt', refAudio: 'a.wav', promptText: '参考', promptLang: 'ja', textLang: 'auto', speed: 1, textSplitMethod: 'cut5', fragmentInterval: 0.3, topK: 15, topP: 1, temperature: 1, freeze: true };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.listeners = new Map(); this.style = {}; this.dataset = {};
    this.classList = { add() {} }; this.value = ''; this.textContent = ''; this.checked = false; this.disabled = false; this.hidden = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this[key] = String(value); }
  removeAttribute(key) { delete this[key]; }
  addEventListener(name, callback) { const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks); }
  dispatch(name, event = {}) { for (const callback of this.listeners.get(name) || []) callback(event); }
  reportValidity() { return true; }
  pause() {}
  load() {}
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

async function harness(t, { seeded = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'roost-panel-v4-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'root'), dir = join(base, 'data'); mkdirSync(root); mkdirSync(dir);
  const config = join(root, 'config.json'); writeFileSync(config, JSON.stringify({ ...DEFAULTS, ...voice, serviceDir: 'E:/saved-service' }));
  const profiles = createProfiles({ root, dir });
  const id = seeded ? profiles.save({ name: '当前角色', values: voice }).items[0].id : undefined;
  if (id) profiles.apply({ id });
  const nodes = new Map([...page.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  nodes.get('audio').hidden = true;
  const document = new Element(); document.hidden = false;
  document.getElementById = id => nodes.get(id);
  document.createElement = tag => new Element(tag);
  document.createTextNode = text => ({ textContent: text });
  const window = new Element();
  const confirmations = []; window.confirm = text => { confirmations.push(text); return true; };
  const timers = new Map(); let timerId = 0;
  const setTimer = (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; };
  const calls = [];
  let serviceHook = payload => ({ phase: payload.op === 'start' ? 'starting' : 'stopped', api: voice.api, pid: null, message: '', features: { semanticFreeze: true } });
  let actionHook;
  const fetch = async (url, options) => {
    assert.equal(url, '/roost/api/quick');
    const body = JSON.parse(options.body); calls.push(body);
    const { op, arg } = body;
    let out;
    if (op === 'extensions.config.get') {
      const raw = JSON.parse(readFileSync(config, 'utf8'));
      out = { ok: true, id: 'voice-reply', spec: Object.entries(MANIFEST.config).map(([key, field]) => ({ key, ...field })), values: Object.fromEntries(Object.entries(raw).filter(([key]) => !MANIFEST.config[key]?.secret)), secretSet: {}, canEdit: true };
    } else if (op === 'extensions.config.save') {
      // Match the Host: saving non-secret values replaces the whole config file.
      writeFileSync(config, JSON.stringify(arg.values)); out = { ok: true };
    } else if (op === 'extensions.ui.action') {
      let data;
      if (actionHook) data = await actionHook(arg, options.signal);
      if (data === undefined) {
        if (arg.action === 'profiles') data = profiles[arg.payload.op](arg.payload);
        else if (arg.action === 'service') data = await serviceHook(arg.payload, options.signal);
        else if (arg.action === 'status') data = { version: '1.1.4', missing: [], enabled: true, lineCount: 0 };
        else if (arg.action === 'probe') data = { ok: true, features: { semanticFreeze: false } };
        else throw new Error('Unexpected action ' + arg.action);
      }
      out = { ok: true, data };
    } else throw new Error('Unexpected operation ' + op);
    return { ok: true, status: 200, json: async () => out };
  };
  const script = source.replace(/\}\)\(\);\s*$/, `globalThis.panel = { controls, collectConfig, changeProfile, runService, leave, saveConfig, probe, updateFreezeSupport, profileDirty, selectProfile, guardDraft, updateProfileControls, getState: () => ({ serviceBusy, requests: requests.size, servicePhase, selectedProfileId }) }; })();`);
  const context = vm.createContext({ document, window, fetch, AbortController, URL, setTimeout: setTimer, clearTimeout: id => timers.delete(id), console, Date });
  new vm.Script(script).runInContext(context);
  await flush();
  return {
    panel: context.panel, nodes, profiles, id, config, timers, calls, confirmations, document, window,
    setService: hook => { serviceHook = hook; }, setAction: hook => { actionHook = hook; },
    async tick(ms) { const entry = [...timers].find(([, timer]) => timer.ms === ms); assert.ok(entry, `expected ${ms}ms timer`); timers.delete(entry[0]); entry[1].callback(); await flush(); }
  };
}

test('v4页面删除指定整行，五组range/number同步、中文选项与14项收集', async t => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.doesNotMatch(page, /msg\.claim|无须开启内置 TTS|overwriteProfile/);
  const h = await harness(t);
  const expected = { speed: [0.5, 2, 0.05], fragmentInterval: [0.01, 1, 0.01], topK: [1, 100, 1], topP: [0, 1, 0.05], temperature: [0.01, 2, 0.05] };
  for (const [key, [min, max, step]] of Object.entries(expected)) {
    const { range, input, field } = h.panel.controls.get(key);
    assert.equal(range.type, 'range'); assert.equal(input.type, 'number');
    assert.equal(Number(input.min), min); assert.equal(Number(input.max), max); assert.equal(field.step, step);
    if (key === 'temperature') { assert.equal(input.step, 'any'); assert.equal(input.dataset.step, '0.05'); }
    else assert.equal(Number(input.step), step);
    assert.equal(range.value, input.value, `${key} starts synchronized`);
    range.value = key === 'topK' ? '22' : '0.8'; range.dispatch('input'); assert.equal(range.value, input.value);
    input.value = key === 'topK' ? '31' : '0.9'; input.dispatch('input'); assert.equal(range.value, input.value);
  }
  const temp = h.panel.controls.get('temperature'); temp.input.value = '1';
  temp.input.dispatch('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.equal(temp.input.value, '1.05'); assert.equal(temp.range.value, '1.05');
  const split = h.panel.controls.get('textSplitMethod').input.children;
  assert.deepEqual(split.map(option => option.textContent), ['不切', '四句', '50字', '中文句号', '英文句号', '标点']);
  assert.ok(h.panel.controls.get('textLang').input.children.some(option => option.value === 'ja' && option.textContent === '日语'));
  assert.equal(h.panel.collectConfig().values.temperature, 1.05);
  assert.equal(h.panel.collectConfig().values.topK, 31);
  const topK = h.panel.controls.get('topK').input; topK.value = '1.5';
  assert.throws(() => h.panel.collectConfig(), /整数/); topK.value = '101';
  assert.throws(() => h.panel.collectConfig(), /允许范围/);
  topK.value = '15'; temp.input.value = '0'; assert.throws(() => h.panel.collectConfig(), /允许范围/);
});

test('选中activeId后纯改名保存同ID且无确认，新建重置全部14项原生默认值', async t => {
  const h = await harness(t);
  assert.equal(h.nodes.get('profileSelect').value, h.id); assert.equal(h.nodes.get('profileName').value, '当前角色');
  h.nodes.get('profileName').value = '改名后的角色';
  await h.panel.changeProfile('save');
  assert.equal(h.confirmations.length, 0); assert.equal(h.profiles.list().items.length, 1); assert.equal(h.profiles.list().activeId, h.id);
  assert.equal(h.profiles.list().items[0].name, '改名后的角色');
  const request = h.calls.findLast(call => call.arg?.action === 'profiles' && call.arg.payload.op === 'save');
  assert.equal(request.arg.payload.id, h.id); assert.equal(Object.keys(request.arg.payload.values).length, 14);
  assert.equal(request.arg.payload.values.serviceDir, undefined);
  const ref = h.panel.controls.get('refAudio').input;
  h.panel.controls.get('serviceDir').input.value = 'E:/global-draft';
  h.panel.controls.get('translateKey').input.value = 'draft-secret';
  h.nodes.get('newProfile').dispatch('click'); await flush();
  assert.equal(h.nodes.get('profileSelect').value, ''); assert.equal(h.nodes.get('profileName').value, ''); assert.equal(ref.value, '');
  for (const key of Object.keys(voice)) {
    const { field, input, range } = h.panel.controls.get(key);
    assert.equal(field.type === 'boolean' ? input.checked : field.type === 'number' ? Number(input.value) : input.value, field.default, key);
    if (range) assert.equal(range.value, input.value);
  }
  assert.equal(h.panel.controls.get('serviceDir').input.value, 'E:/global-draft');
  assert.equal(h.panel.controls.get('translateKey').input.value, 'draft-secret');
  assert.equal(h.panel.profileDirty(), false); assert.equal(h.nodes.get('saveProfile').disabled, true);
  h.nodes.get('profileName').value = '新的角色';
  for (const key of ['refAudio', 'promptText', 'sovitsWeights', 'gptWeights']) h.panel.controls.get(key).input.value = 'new-' + voice[key];
  await h.panel.changeProfile('save');
  assert.equal(h.profiles.list().items.length, 2); assert.equal(h.confirmations.length, 0);
  assert.equal(h.nodes.get('profileName').value, '新的角色'); assert.equal(h.panel.profileDirty(), false);
});

test('保存更新同ID无确认且不应用，新建缺少必填项保存失败保留草稿', async t => {
  const h = await harness(t);
  h.panel.controls.get('speed').input.value = '1.2';
  await h.panel.changeProfile('save'); assert.equal(h.confirmations.length, 0);
  assert.equal(JSON.parse(readFileSync(h.config)).speed, 1, 'saving a profile does not apply it');
  assert.equal(h.profiles.list().activeId, undefined);
  assert.match(h.nodes.get('profilesMessage').textContent, /保存.*应用方案/);
  h.nodes.get('newProfile').dispatch('click'); await flush(); h.nodes.get('profileName').value = '新草稿';
  assert.equal(await h.panel.changeProfile('save'), false);
  assert.equal(h.profiles.list().items.length, 1);
  assert.match(h.nodes.get('profilesMessage').textContent, /缺少必填/);
  assert.equal(h.nodes.get('profileName').value, '新草稿'); assert.equal(h.panel.profileDirty(), true);
  assert.equal(h.nodes.get('profilesFieldset').disabled, false);
});

test('服务启动仅发送action并明确使用已保存目录，每2秒查到running后清理', async t => {
  const h = await harness(t);
  h.panel.controls.get('serviceDir').input.value = 'E:/unsaved-service';
  h.panel.controls.get('serviceDir').input.dispatch('input');
  assert.match(h.nodes.get('serviceDirectory').textContent, /E:\/saved-service.*尚未保存/);
  let statusCount = 0;
  h.setService(payload => ({ phase: payload.op === 'start' ? 'starting' : ++statusCount === 1 ? 'starting' : 'running', api: voice.api, pid: 123, canStop: true, message: 'fixture', features: { semanticFreeze: true }, logTail: ['ready'] }));
  const pending = h.panel.runService(true); await flush();
  assert.equal(h.nodes.get('startService').disabled, false);
  assert.equal(h.nodes.get('startService').textContent, '关闭服务');
  const start = h.calls.findLast(call => call.arg?.action === 'service' && call.arg.payload.op === 'start');
  assert.deepEqual(start.arg.payload, { op: 'start' });
  await h.tick(2000); assert.match(h.nodes.get('serviceState').textContent, /启动中/);
  await h.tick(2000); await pending;
  assert.match(h.nodes.get('serviceState').textContent, /运行中.*PID 123/);
  assert.equal(h.nodes.get('serviceLogs').hidden, false);
  assert.equal([...h.timers.values()].filter(timer => [2000, 180000].includes(timer.ms)).length, 0);
});

test('服务180秒超时和异步失败均恢复，离开清理轮询并abort挂起请求', async t => {
  const h = await harness(t);
  h.setService(() => ({ phase: 'starting', api: voice.api, message: '' }));
  const pending = h.panel.runService(true); await flush(); await h.tick(180000); await pending;
  assert.match(h.nodes.get('serviceState').textContent, /180 秒/); assert.equal(h.nodes.get('startService').disabled, false);
  h.setService(() => { throw new Error('fixture startup error'); }); await h.panel.runService(true);
  assert.match(h.nodes.get('serviceState').textContent, /fixture startup error/); assert.equal(h.nodes.get('startService').disabled, false);
  let signal;
  h.setService((_payload, requestSignal) => new Promise((_resolve, reject) => { signal = requestSignal; requestSignal.addEventListener('abort', () => reject(new Error('aborted'))); }));
  const waiting = h.panel.runService(true); await flush(); h.panel.leave(); await waiting;
  assert.equal(signal.aborted, true); assert.equal(h.panel.getState().requests, 0); assert.equal(h.timers.size, 0);
});

test('离开服务轮询立即清理定时器，重新进入可读取运行态；后端error停止轮询', async t => {
  const h = await harness(t);
  h.setService(() => ({ phase: 'starting', api: voice.api, message: '' }));
  const pending = h.panel.runService(true); await flush();
  assert.ok([...h.timers.values()].some(timer => timer.ms === 2000));
  h.panel.leave(); await pending;
  assert.equal(h.timers.size, 0); assert.equal(h.panel.getState().serviceBusy, false);
  h.setService(() => ({ phase: 'running', api: voice.api, message: 'reconnected' }));
  h.window.dispatch('pageshow'); await flush();
  assert.match(h.nodes.get('serviceState').textContent, /运行中.*reconnected/);
  h.setService(() => ({ phase: 'error', api: voice.api, message: 'backend startup error' }));
  await h.panel.runService();
  assert.match(h.nodes.get('serviceState').textContent, /服务异常.*backend startup error/);
  assert.equal(h.nodes.get('startService').disabled, false); assert.equal(h.timers.size, 0);
});

test('安装目录必须先保存，启动使用已保存目录且保存失败后按钮恢复', async t => {
  const h = await harness(t);
  h.panel.controls.get('serviceDir').input.value = 'E:/next-service';
  await h.panel.saveConfig({ preventDefault() {} });
  assert.equal(JSON.parse(readFileSync(h.config)).serviceDir, 'E:/next-service');
  assert.match(h.nodes.get('serviceDirectory').textContent, /E:\/next-service/);
  h.setAction(arg => { if (arg.action === 'profiles' && arg.payload.op === 'save') throw new Error('fixture save failure'); });
  h.nodes.get('profileName').value = '失败改名'; await h.panel.changeProfile('save');
  assert.match(h.nodes.get('profilesMessage').textContent, /fixture save failure/);
  assert.equal(h.nodes.get('profilesFieldset').disabled, false);
});

test('不支持语义复用时禁用编辑但保留用户true值，probe同样更新功能状态', async t => {
  const h = await harness(t);
  const freeze = h.panel.controls.get('freeze').input; assert.equal(freeze.checked, true);
  await h.panel.probe();
  assert.equal(freeze.disabled, true); assert.equal(freeze.checked, true);
  assert.equal(h.panel.collectConfig().values.freeze, true);
  assert.match(h.nodes.get('freezeSupport').textContent, /普通 api_v2\.py.*已保存的值仍会保留/);
  h.panel.updateFreezeSupport({ semanticFreeze: true }); assert.equal(freeze.disabled, false);
});

function editField(h, key, value, event = 'input') {
  const input = key === 'profileName' ? h.nodes.get(key) : h.panel.controls.get(key).input;
  if (typeof value === 'boolean') input.checked = value; else input.value = value;
  input.dispatch(event);
}
async function choose(h, button) { h.nodes.get(button).dispatch('click'); await flush(); }
async function switchTo(h, id) { h.nodes.get('profileSelect').value = id; h.nodes.get('profileSelect').dispatch('change'); await flush(); }
const profileCalls = (h, op) => h.calls.filter(call => call.arg?.action === 'profiles' && call.arg.payload.op === op);

// Run the real inline page script with instrumented controls, actions and timers.
test('dirty typed比较覆盖无改、改回、name-only、global/key-only及range keyboard/change', async t => {
  const h = await harness(t);
  assert.equal(h.panel.profileDirty(), false); assert.equal(h.nodes.get('saveProfile').disabled, true); assert.equal(h.nodes.get('profileDirty').hidden, true);
  await h.panel.changeProfile('save'); assert.equal(profileCalls(h, 'save').length, 0);
  editField(h, 'speed', '1.00', 'change'); assert.equal(h.panel.profileDirty(), false);
  editField(h, 'freeze', false, 'change'); assert.equal(h.nodes.get('saveProfile').disabled, false);
  editField(h, 'freeze', true, 'change'); assert.equal(h.nodes.get('saveProfile').disabled, true);
  editField(h, 'speed', '1.3'); assert.equal(h.nodes.get('profileDirty').hidden, false);
  assert.match(page, /方案有未保存修改，请保存方案/);
  editField(h, 'speed', '1'); assert.equal(h.nodes.get('profileDirty').hidden, true);
  editField(h, 'profileName', '仅改名'); assert.equal(h.nodes.get('saveProfile').disabled, false);
  editField(h, 'profileName', '当前角色'); assert.equal(h.nodes.get('saveProfile').disabled, true);
  editField(h, 'serviceDir', 'E:/unsaved-global'); editField(h, 'translateKey', 'unsaved-key');
  assert.equal(h.panel.profileDirty(), false); assert.equal(h.nodes.get('saveProfile').disabled, true);
  const temperature = h.panel.controls.get('temperature');
  temperature.range.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(h.panel.profileDirty(), true); assert.equal(h.nodes.get('saveProfile').disabled, false);
  temperature.input.value = '1'; temperature.input.dispatch('change'); assert.equal(h.panel.profileDirty(), false);
  const speed = h.panel.controls.get('speed'); speed.range.value = '1.2'; speed.range.dispatch('change');
  assert.equal(speed.input.value, '1.2'); assert.equal(h.nodes.get('saveProfile').disabled, false);
  await choose(h, 'revertProfile'); assert.equal(h.panel.profileDirty(), false); assert.equal(speed.input.value, '1');
  assert.equal(h.panel.controls.get('translateKey').input.value, 'unsaved-key');
  editField(h, 'profileName', '保留名称草稿'); editField(h, 'speed', '1.4');
  const applied = { ...JSON.parse(readFileSync(h.config, 'utf8')), speed: 1.65, refAudio: 'latest-applied.wav' };
  writeFileSync(h.config, JSON.stringify(applied));
  const draftSpeed = h.panel.controls.get('speed').input;
  await h.panel.saveConfig({ preventDefault() {} });
  assert.equal(h.nodes.get('profileName').value, '保留名称草稿'); assert.equal(h.panel.profileDirty(), true);
  assert.equal(h.nodes.get('saveProfile').disabled, false);
  const globalSave = h.calls.findLast(call => call.op === 'extensions.config.save');
  assert.equal(globalSave.arg.values.serviceDir, 'E:/unsaved-global');
  for (const key of Object.keys(voice)) assert.equal(globalSave.arg.values[key], applied[key], `global save retains latest applied ${key}`);
  assert.equal(globalSave.arg.secrets.translateKey, 'unsaved-key');
  assert.equal(h.panel.controls.get('speed').input, draftSpeed); assert.equal(draftSpeed.value, '1.4');
  assert.equal(h.panel.controls.get('refAudio').input.value, voice.refAudio, 'global save never rebuilds profile draft controls');
  assert.equal(JSON.parse(readFileSync(h.config)).speed, 1.65); assert.equal(JSON.parse(readFileSync(h.config)).refAudio, 'latest-applied.wav');
});

test('dirty切换三分支：取消恢复选择及草稿、放弃加载目标、保存成功再切换', async t => {
  const h = await harness(t);
  const other = h.profiles.save({ name: '第二角色', values: { ...voice, speed: 1.5 } }).items.find(item => item.name === '第二角色');
  await choose(h, 'reloadProfiles');
  editField(h, 'speed', '1.2'); await switchTo(h, other.id);
  assert.equal(h.nodes.get('draftDialog').open, true); assert.equal(h.nodes.get('profileSelect').value, h.id);
  await choose(h, 'draftCancel');
  assert.equal(h.nodes.get('profileSelect').value, h.id); assert.equal(h.panel.controls.get('speed').input.value, '1.2'); assert.equal(h.panel.profileDirty(), true);
  await switchTo(h, other.id); await choose(h, 'draftDiscard');
  assert.equal(h.nodes.get('profileSelect').value, other.id); assert.equal(h.panel.controls.get('speed').input.value, '1.5'); assert.equal(h.panel.profileDirty(), false);
  assert.equal(JSON.parse(readFileSync(h.config)).speed, 1, 'dropdown never applies');
  editField(h, 'profileName', '第二角色改名'); await switchTo(h, h.id); await choose(h, 'draftSave');
  assert.equal(h.profiles.list().items.find(item => item.id === other.id).name, '第二角色改名');
  assert.equal(h.nodes.get('profileSelect').value, h.id); assert.equal(h.panel.profileDirty(), false); assert.equal(h.confirmations.length, 0);
});

test('保存并继续失败保留选择、名称、14项、全局与密钥草稿，重试成功才切换', async t => {
  const h = await harness(t);
  const other = h.profiles.save({ name: '目标角色', values: { ...voice, refAudio: 'other.wav' } }).items.find(item => item.name === '目标角色');
  await choose(h, 'reloadProfiles');
  editField(h, 'profileName', '失败保留名称'); editField(h, 'speed', '1.25'); editField(h, 'serviceDir', 'global-stays'); editField(h, 'translateKey', 'key-stays');
  h.setAction(arg => { if (arg.action === 'profiles' && arg.payload.op === 'save') throw new Error('fixture save failed'); });
  const before = JSON.stringify(h.panel.collectConfig());
  await switchTo(h, other.id); await choose(h, 'draftSave');
  assert.equal(h.nodes.get('profileSelect').value, h.id); assert.equal(h.nodes.get('profileName').value, '失败保留名称');
  assert.equal(JSON.stringify(h.panel.collectConfig()), before); assert.equal(h.panel.profileDirty(), true);
  assert.match(h.nodes.get('profilesMessage').textContent, /fixture save failed/); assert.equal(h.nodes.get('saveProfile').disabled, false);
  h.setAction(undefined);
  await switchTo(h, other.id); await choose(h, 'draftSave');
  assert.equal(h.nodes.get('profileSelect').value, other.id); assert.equal(h.panel.profileDirty(), false);
  assert.equal(h.panel.controls.get('serviceDir').input.value, 'global-stays'); assert.equal(h.panel.controls.get('translateKey').input.value, 'key-stays');
});

test('新方案空名称或缺必填时保存并继续暂停，保留新建选择及草稿', async t => {
  const h = await harness(t);
  await choose(h, 'newProfile'); editField(h, 'speed', '1.2');
  await switchTo(h, h.id); await choose(h, 'draftSave');
  assert.equal(h.nodes.get('profileSelect').value, ''); assert.equal(h.panel.controls.get('speed').input.value, '1.2');
  assert.match(h.nodes.get('profilesMessage').textContent, /方案名/); assert.equal(h.nodes.get('saveProfile').disabled, true);
  editField(h, 'profileName', '必填未完整');
  await switchTo(h, h.id); await choose(h, 'draftSave');
  assert.equal(h.nodes.get('profileSelect').value, ''); assert.equal(h.nodes.get('profileName').value, '必填未完整');
  assert.match(h.nodes.get('profilesMessage').textContent, /缺少必填/); assert.equal(h.panel.profileDirty(), true);
  assert.equal(profileCalls(h, 'save').length, 0);
});

test('新建和刷新仅dirty时询问，刷新失败保留草稿，放弃并刷新成功清除dirty', async t => {
  const h = await harness(t);
  await choose(h, 'reloadProfiles'); assert.notEqual(h.nodes.get('draftDialog').open, true);
  editField(h, 'speed', '1.2'); await choose(h, 'newProfile'); assert.equal(h.nodes.get('draftDialog').open, true);
  await choose(h, 'draftCancel'); assert.equal(h.nodes.get('profileSelect').value, h.id); assert.equal(h.panel.profileDirty(), true);
  const lists = profileCalls(h, 'list').length;
  await choose(h, 'reloadProfiles'); await choose(h, 'draftCancel'); assert.equal(profileCalls(h, 'list').length, lists);
  h.setAction(arg => { if (arg.action === 'profiles' && arg.payload.op === 'list') throw new Error('fixture list failure'); });
  await choose(h, 'reloadProfiles'); await choose(h, 'draftDiscard');
  assert.equal(h.panel.controls.get('speed').input.value, '1.2'); assert.equal(h.panel.profileDirty(), true);
  h.setAction(undefined);
  await choose(h, 'reloadProfiles'); await choose(h, 'draftDiscard');
  assert.equal(h.panel.controls.get('speed').input.value, '1'); assert.equal(h.panel.profileDirty(), false);
  editField(h, 'speed', '1.2'); await choose(h, 'newProfile'); await choose(h, 'draftDiscard');
  assert.equal(h.nodes.get('profileSelect').value, ''); assert.equal(h.panel.controls.get('refAudio').input.value, ''); assert.equal(h.panel.profileDirty(), false);
});

test('应用无修改无询问且只更新音色，保留未保存全局和密钥；dirty应用三分支', async t => {
  const h = await harness(t);
  editField(h, 'serviceDir', 'E:/unpersisted'); editField(h, 'translateKey', 'secret-stays');
  const directory = h.panel.controls.get('serviceDir').input, secret = h.panel.controls.get('translateKey').input;
  const reads = h.calls.filter(call => call.op === 'extensions.config.get').length;
  await choose(h, 'applyProfile');
  assert.equal(h.confirmations.length, 0); assert.notEqual(h.nodes.get('draftDialog').open, true);
  assert.equal(profileCalls(h, 'apply').length, 1); assert.equal(h.panel.profileDirty(), false);
  assert.equal(h.panel.controls.get('serviceDir').input, directory); assert.equal(directory.value, 'E:/unpersisted');
  assert.equal(h.panel.controls.get('translateKey').input, secret); assert.equal(secret.value, 'secret-stays');
  assert.equal(h.calls.filter(call => call.op === 'extensions.config.get').length, reads);
  assert.equal(JSON.parse(readFileSync(h.config)).serviceDir, 'E:/saved-service');
  editField(h, 'speed', '1.4'); await choose(h, 'applyProfile'); await choose(h, 'draftCancel'); assert.equal(profileCalls(h, 'apply').length, 1);
  await choose(h, 'applyProfile'); await choose(h, 'draftDiscard');
  assert.equal(profileCalls(h, 'apply').length, 2); assert.equal(h.panel.controls.get('speed').input.value, '1');
  editField(h, 'speed', '1.4'); await choose(h, 'applyProfile'); await choose(h, 'draftSave');
  assert.equal(JSON.parse(readFileSync(h.config)).speed, 1.4); assert.equal(h.panel.profileDirty(), false);
  assert.equal(directory.value, 'E:/unpersisted'); assert.equal(secret.value, 'secret-stays');
});

test('服务start→stop→start按钮及stopping每2秒poll，外部运行禁用stop', async t => {
  const h = await harness(t);
  let phase = 'stopped', polls = 0;
  h.setService(payload => {
    if (payload.op === 'start') phase = 'running';
    else if (payload.op === 'stop') { phase = 'stopping'; polls = 0; }
    else if (phase === 'stopping' && ++polls === 2) phase = 'stopped';
    return { phase, canStop: phase === 'running', pid: phase === 'stopped' ? null : 123, api: voice.api };
  });
  await choose(h, 'startService'); assert.equal(h.nodes.get('startService').textContent, '关闭服务'); assert.equal(h.nodes.get('startService').disabled, false);
  await choose(h, 'startService'); assert.equal(h.nodes.get('startService').textContent, '正在关闭…'); assert.equal(h.nodes.get('startService').disabled, true);
  await h.tick(2000); assert.equal(h.nodes.get('startService').textContent, '正在关闭…');
  await h.tick(2000); assert.equal(h.nodes.get('startService').textContent, '一键启动服务'); assert.equal(h.nodes.get('startService').disabled, false);
  await choose(h, 'startService'); assert.equal(h.nodes.get('startService').textContent, '关闭服务');
  const operations = h.calls.filter(call => call.arg?.action === 'service').map(call => call.arg.payload.op);
  assert.deepEqual(operations.slice(-5), ['start', 'stop', 'status', 'status', 'start']);
  h.setService(() => ({ phase: 'running', canStop: false, api: voice.api })); await h.panel.runService();
  assert.equal(h.nodes.get('startService').disabled, true); assert.match(h.nodes.get('serviceDirectory').textContent, /外部启动/);
  h.setService(() => ({ phase: 'error', canStop: true, pid: 123, api: voice.api })); await h.panel.runService();
  assert.equal(h.nodes.get('startService').textContent, '关闭服务'); assert.equal(h.nodes.get('startService').disabled, false);
});

test('starting自有PID可关闭取消加载，旧poll清理，回到启动状态', async t => {
  const h = await harness(t);
  h.setService(payload => ({ phase: payload.op === 'stop' ? 'stopped' : 'starting', canStop: payload.op !== 'stop', pid: payload.op === 'stop' ? null : 123, api: voice.api }));
  const pending = h.panel.runService('start'); await flush();
  assert.equal(h.nodes.get('startService').textContent, '关闭服务'); assert.equal(h.nodes.get('startService').disabled, false);
  await choose(h, 'startService'); await pending;
  assert.equal(h.nodes.get('startService').textContent, '一键启动服务'); assert.equal(h.nodes.get('startService').disabled, false);
  assert.equal(h.timers.size, 0); assert.equal(h.panel.getState().requests, 0);
});

test('保存全局设置后name-only草稿仍dirty且不重建音色控件，整份替换保留live14项', async t => {
  const h = await harness(t);
  editField(h, 'profileName', '只改名称的草稿'); editField(h, 'serviceDir', 'E:/new-global'); editField(h, 'translateKey', 'new-secret');
  const voiceNodes = Object.fromEntries(Object.keys(voice).map(key => [key, h.panel.controls.get(key).input]));
  await h.panel.saveConfig({ preventDefault() {} });
  assert.equal(h.nodes.get('profileName').value, '只改名称的草稿');
  assert.equal(h.panel.profileDirty(), true); assert.equal(h.nodes.get('saveProfile').disabled, false); assert.equal(h.nodes.get('profileDirty').hidden, false);
  const posted = h.calls.findLast(call => call.op === 'extensions.config.save');
  for (const key of Object.keys(voice)) {
    assert.equal(posted.arg.values[key], voice[key]); assert.equal(h.panel.controls.get(key).input, voiceNodes[key]);
  }
  assert.equal(posted.arg.values.serviceDir, 'E:/new-global'); assert.deepEqual(posted.arg.secrets, { translateKey: 'new-secret' });
  assert.equal(h.panel.controls.get('translateKey').input.value, '');
  assert.equal(h.profiles.list().items[0].name, '当前角色'); assert.equal(profileCalls(h, 'apply').length, 0);
});
