import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createProfiles, PROFILE_FIELDS } from '../lib/profiles.mjs';

const legacyVoice = (suffix = 'a') => ({ api: 'http://127.0.0.1:9880', sovitsWeights: `${suffix}.pth`, gptWeights: `${suffix}.ckpt`, refAudio: `${suffix}.wav`, promptText: `参考文本 ${suffix}`, promptLang: 'ja', textLang: 'auto', speed: 1 });
const additions = { textSplitMethod: 'cut5', fragmentInterval: 0.3, topK: 15, topP: 1, temperature: 1, freeze: false };
const voice = (suffix = 'a') => ({ ...legacyVoice(suffix), ...additions });
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'roost-profiles-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'code'), dir = join(base, 'data');
  mkdirSync(root); mkdirSync(dir);
  return { root, dir, config: join(root, 'config.json'), file: join(dir, 'profiles.json'), profiles: createProfiles({ root, dir }) };
}

test('保存只捕捉14项、切换保留全局配置与原生secret机制', t => {
  const { profiles, file, config, root, dir } = fixture(t);
  const globals = { enabled: false, cooldownSec: 47, lines: ['global line'], translateModel: 'global-model', translateKey: '{{SECRET_fixture}}', serviceDir: 'E:/GPT-SoVITS', custom: { userField: true } };
  writeFileSync(config, JSON.stringify({ ...voice('original'), ...globals }));
  const secretFile = join(dir, 'untouched-secret.json');
  writeFileSync(secretFile, 'secret fixture');
  assert.deepEqual(profiles.list(), { items: [] });
  const first = profiles.save({ name: '角色 A', values: { ...voice('a'), ...globals, otherSecret: 'exclude-me' } });
  const second = profiles.save({ name: '角色 B', values: voice('b') });
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 2);
  const idA = first.items[0].id, idB = second.items[1].id;
  assert.match(idA, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(first.items[0].values).sort(), [...PROFILE_FIELDS].sort());
  assert.doesNotMatch(readFileSync(file, 'utf8'), /translateKey|SECRET_fixture|cooldownSec|otherSecret|exclude-me|global line/);
  assert.equal(JSON.parse(readFileSync(config)).refAudio, 'original.wav', 'save does not apply');
  assert.equal(profiles.apply({ id: idA }).activeId, idA);
  assert.equal(profiles.apply({ id: idB }).activeId, idB);
  assert.deepEqual(JSON.parse(readFileSync(config)), { ...voice('b'), ...globals });
  assert.equal(readFileSync(secretFile, 'utf8'), 'secret fixture');
  assert.equal(createProfiles({ root, dir }).list().activeId, idB, 'persists across instances');
  writeFileSync(config, JSON.stringify({ ...voice('manual'), ...globals }));
  assert.equal(profiles.list().activeId, undefined, 'manual edits do not claim old profile is active');
  assert.ok(first.message); assert.ok(second.items[1].updatedAt);
});

test('旧8字段方案平滑补默认、保留原记录且后续保存持久化14字段', t => {
  const { profiles, file, config } = fixture(t);
  const id = '01234567-89ab-4cde-8123-456789abcdef';
  const old = { items: [{ id, name: '旧音色', values: legacyVoice(), updatedAt: '2026-01-01T00:00:00.000Z' }], activeId: id };
  const original = JSON.stringify(old);
  writeFileSync(file, original); writeFileSync(config, JSON.stringify({ ...legacyVoice(), serviceDir: 'saved-dir', secret: 'global' }));
  const listed = profiles.list();
  assert.equal(listed.items.length, 1); assert.equal(listed.activeId, id);
  assert.deepEqual(listed.items[0].values, voice());
  assert.equal(readFileSync(file, 'utf8'), original, 'read migration leaves persisted source intact');
  const renamed = profiles.save({ id, name: '重命名旧音色', values: listed.items[0].values });
  assert.equal(renamed.activeId, id); assert.equal(renamed.items[0].id, id);
  assert.equal(renamed.items.length, 1); assert.equal(Object.keys(JSON.parse(readFileSync(file)).items[0].values).length, 14);
  profiles.apply({ id });
  assert.deepEqual(JSON.parse(readFileSync(config)), { ...voice(), serviceDir: 'saved-dir', secret: 'global' });
});

test('迁移仅补缺失的新字段，非法新值、未知字段、缺失旧字段仍报损坏并保留原文', t => {
  const { profiles, file } = fixture(t);
  const base = { id: '01234567-89ab-4cde-8123-456789abcdef', name: '旧音色', updatedAt: '2026-01-01T00:00:00Z' };
  const badValues = [
    { ...legacyVoice(), newUnexpected: true }, { ...legacyVoice(), textSplitMethod: 'cut9' },
    { ...legacyVoice(), fragmentInterval: 0 }, { ...legacyVoice(), topK: 1.2 },
    { ...legacyVoice(), topP: 2 }, { ...legacyVoice(), temperature: null },
    { ...legacyVoice(), freeze: 'false' }, Object.fromEntries(Object.entries(legacyVoice()).filter(([key]) => key !== 'speed'))
  ];
  for (const values of badValues) {
    const raw = JSON.stringify({ items: [{ ...base, values }] }); writeFileSync(file, raw);
    assert.throws(() => profiles.list(), /文件损坏/); assert.equal(readFileSync(file, 'utf8'), raw);
  }
  const partial = { ...legacyVoice(), topK: 20 }; writeFileSync(file, JSON.stringify({ items: [{ ...base, values: partial }] }));
  assert.deepEqual(profiles.list().items[0].values, { ...voice(), topK: 20 });
});

test('无ID相同14项给出选已有项改名提示，已有重复项保留且按ID改名', t => {
  const { profiles, file } = fixture(t);
  const first = profiles.save({ name: '已存音色', values: voice() });
  const before = readFileSync(file, 'utf8');
  assert.throws(() => profiles.save({ name: '误另存名称', values: voice() }), /相同.*选择该项修改名称.*未新建/);
  assert.equal(readFileSync(file, 'utf8'), before);
  const original = first.items[0];
  const duplicate = { ...original, id: '01234567-89ab-4cde-8123-456789abcdef', name: '历史副本' };
  writeFileSync(file, JSON.stringify({ items: [original, duplicate] }));
  assert.equal(profiles.list().items.length, 2, 'never auto-merges historical copies');
  const renamed = profiles.save({ id: duplicate.id, name: '保留副本改名', values: voice() });
  assert.equal(renamed.items.length, 2); assert.equal(renamed.items[1].id, duplicate.id);
});

test('默认服务/语言/语速归一化，必需音色字段及名称明确验证', t => {
  const { profiles } = fixture(t);
  const required = { sovitsWeights: 'a.pth', gptWeights: 'a.ckpt', refAudio: 'a.wav', promptText: '测试' };
  const saved = profiles.save({ name: '  默认语言  ', values: required });
  assert.equal(saved.items[0].name, '默认语言');
  assert.equal(saved.items[0].values.speed, 1);
  assert.equal(saved.items[0].values.api, 'http://127.0.0.1:9880');
  for (const key of Object.keys(required)) assert.throws(() => profiles.save({ name: '缺失项', values: { ...required, [key]: '' } }), /缺少必填项/);
  for (const name of ['', '   ', 'x'.repeat(41), 'line\nbreak']) assert.throws(() => profiles.save({ name, values: voice() }), /方案名/);
  for (const values of [null, [], 'bad']) assert.throws(() => profiles.save({ name: '格式', values }), /音色设置/);
  assert.throws(() => profiles.save({ name: '语速', values: { ...voice(), speed: 8 } }), /语速/);
  assert.throws(() => profiles.save({ name: '语言', values: { ...voice(), textLang: 'invalid' } }), /语言/);
  assert.throws(() => profiles.save({ name: '凭证', values: { ...voice(), api: 'https://user:secret@example.test' } }), /凭证/);
});

test('同名提示、按已有ID重命名更新、删除当前方案保留使用配置', t => {
  const { profiles, config } = fixture(t);
  const id = profiles.save({ name: '同名', values: voice() }).items[0].id;
  const other = profiles.save({ name: '其他', values: voice('other') }).items[1].id;
  assert.throws(() => profiles.save({ name: '同名', values: voice('new') }), /同名.*保存方案/);
  assert.throws(() => profiles.save({ id: other, name: '同名', values: voice() }), /同名/);
  assert.equal(profiles.save({ id, name: '重命名', values: voice('updated') }).items.length, 2);
  profiles.apply({ id });
  const before = readFileSync(config, 'utf8');
  const removed = profiles.remove({ id });
  assert.equal(removed.items.length, 1); assert.equal(removed.activeId, undefined);
  assert.equal(readFileSync(config, 'utf8'), before);
  assert.throws(() => profiles.apply({ id }), /已删除/);
  assert.throws(() => profiles.save({ id, name: '已删除', values: voice() }), /已删除/);
  assert.throws(() => profiles.remove({ id: '../bad-path' }), /有效/);
  assert.ok(removed.message);
});

test('覆盖当前方案只保存，修改值后须再次应用才标记为正在使用', t => {
  const { profiles, config } = fixture(t);
  const id = profiles.save({ name: '角色', values: voice() }).items[0].id;
  profiles.apply({ id });
  assert.equal(profiles.save({ id, name: '新名称', values: voice() }).activeId, id, 'rename does not change voice');
  const result = profiles.save({ id, name: '新名称', values: voice('next') });
  assert.equal(result.activeId, undefined);
  assert.equal(JSON.parse(readFileSync(config)).refAudio, 'a.wav');
  assert.equal(profiles.apply({ id }).activeId, id);
  assert.equal(JSON.parse(readFileSync(config)).refAudio, 'next.wav');
});

test('最多50套，满额仍支持按ID更新', t => {
  const { profiles } = fixture(t);
  for (let n = 0; n < 50; n++) profiles.save({ name: `方案 ${n}`, values: voice(String(n)) });
  const id = profiles.list().items[0].id;
  assert.throws(() => profiles.save({ name: '第51套', values: voice() }), /50/);
  assert.equal(profiles.save({ id, name: '满额更新', values: voice() }).items.length, 50);
  profiles.remove({ id });
  assert.equal(profiles.save({ name: '空位', values: voice() }).items.length, 50);
});

test('损坏profiles.json完整保留，list/save/apply/remove均明确报错', t => {
  const { profiles, file, config } = fixture(t);
  const id = profiles.save({ name: '有效', values: voice() }).items[0].id;
  writeFileSync(config, JSON.stringify({ ...voice('config'), global: 1 }));
  const configBefore = readFileSync(config, 'utf8');
  const badStates = ['{broken', '[]', JSON.stringify({ items: 'bad' }), JSON.stringify({ items: [{ id, name: 'bad', values: voice(), updatedAt: 'bad-date' }] }), JSON.stringify({ items: [], activeId: id })];
  for (const bad of badStates) {
    writeFileSync(file, bad);
    for (const op of [() => profiles.list(), () => profiles.save({ name: '新项', values: voice() }), () => profiles.apply({ id }), () => profiles.remove({ id })]) {
      assert.throws(op, /文件损坏.*原文件已保留/);
      assert.equal(readFileSync(file, 'utf8'), bad);
      assert.equal(readFileSync(config, 'utf8'), configBefore);
    }
  }
});

test('损坏原生配置保持原文，应用未覆盖它或方案记录', t => {
  const { profiles, file, config } = fixture(t);
  const id = profiles.save({ name: '有效', values: voice() }).items[0].id;
  const before = readFileSync(file, 'utf8');
  writeFileSync(config, '{broken-config');
  assert.throws(() => profiles.apply({ id }), /扩展配置读取失败或文件损坏/);
  assert.equal(readFileSync(config, 'utf8'), '{broken-config');
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('独立方案锁快速报冲突、不等待合成锁；错误后释放方案锁', t => {
  const { profiles, dir } = fixture(t);
  writeFileSync(join(dir, 'synthesis.lock'), 'a synthesis may take minutes');
  const id = profiles.save({ name: '独立', values: voice() }).items[0].id;
  const lock = join(dir, 'profiles.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'another-request' }));
  for (const op of [() => profiles.save({ name: '并发', values: voice() }), () => profiles.apply({ id }), () => profiles.remove({ id })]) assert.throws(op, /另一个请求更新/);
  assert.equal(profiles.list().items.length, 1, 'atomic reads do not queue on write lock');
  rmSync(lock);
  assert.throws(() => profiles.save({ name: '独立', values: voice() }), /同名/);
  assert.equal(existsSync(lock), false, 'validation error releases lock');
  profiles.apply({ id });
  assert.equal(existsSync(lock), false);
});

test('多个进程竞争保存时，已确认成功项不会因覆盖丢失', async t => {
  const { profiles, root, dir } = fixture(t);
  const moduleUrl = new URL('../lib/profiles.mjs', import.meta.url).href;
  const code = `import { createProfiles } from ${JSON.stringify(moduleUrl)}; const p=createProfiles(JSON.parse(process.argv[1])); for(let n=0;n<12;n++){ let done=false; for(let attempt=0;attempt<100;attempt++){try{p.save({name:process.argv[2]+'-'+n,values:{...JSON.parse(process.argv[3]),promptText:process.argv[2]+' text '+n}});done=true;break;}catch(e){if(!e.message.includes('另一个请求更新'))throw e;await new Promise(r=>setTimeout(r,5));}}if(!done)throw new Error('contention timeout');}`;
  await Promise.all(['left', 'right', 'third'].map(label => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ root, dir }), label, JSON.stringify(voice(label))], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', status => status === 0 ? resolve() : reject(new Error(stderr || `child exit ${status}`)));
  })));
  assert.equal(profiles.list().items.length, 36);
  assert.equal(new Set(profiles.list().items.map(item => item.name)).size, 36);
});

test('页面脚本语法有效并保持真实quick API路由', () => {
  const page = readFileSync(fileURLToPath(new URL('../page.html', import.meta.url)), 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /fetch\('\/roost\/api\/quick'/);
  // 白名单请求、应用时保留全局/密钥由 panel-v4 的实际交互测试验证。
});
