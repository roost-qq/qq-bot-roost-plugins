import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// 面板长期运行时，裸路径 config.mjs 可能仍缓存旧版字段表。
// 每个方案模块必须与自己安装版本的配置校验器绑定。
const VERSION = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')).version;
const { ROOT, dataDir, normalizeConfig, missingSetup } = await import(`./config.mjs?v=${VERSION}`);

const LEGACY_FIELDS = ['api', 'sovitsWeights', 'gptWeights', 'refAudio', 'promptText', 'promptLang', 'textLang', 'speed'];
export const PROFILE_FIELDS = Object.freeze([...LEGACY_FIELDS, 'textSplitMethod', 'fragmentInterval', 'topK', 'topP', 'temperature', 'freeze']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const pick = value => Object.fromEntries(PROFILE_FIELDS.filter(key => own(value, key)).map(key => [key, value[key]]));

function nameOf(name) {
  if (typeof name !== 'string' || !name.trim() || Array.from(name.trim()).length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('方案名需要 1–40 个字符，请使用单行名称');
  return name.trim();
}
function valuesOf(values) {
  if (!object(values)) throw new Error('请提供当前编辑的音色设置');
  const normalized = normalizeConfig(pick(values));
  const missing = missingSetup(normalized);
  if (missing.length) throw new Error(`音色方案缺少必填项：${missing.join('、')}`);
  return pick(normalized);
}
function readObject(file, fallback, label) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!object(value)) throw new Error('expected object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`${label}读取失败或文件损坏，原文件已保留，请检查后重试`, { cause: error });
  }
}
function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally { try { unlinkSync(temporary); } catch {} }
}

/** Short, fail-fast lock, independent of synthesis.lock. Every mutation re-reads inside it. */
function locked(dir, fn) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'profiles.lock');
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('音色方案正由另一个请求更新，请稍后重试；若进程异常退出，请在确认相关进程已停止后清理 profiles.lock');
    throw error;
  }
  const nonce = randomUUID();
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
    closeSync(fd); fd = undefined;
    return fn();
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { if (JSON.parse(readFileSync(lock, 'utf8')).nonce === nonce) unlinkSync(lock); } catch {}
  }
}

export function createProfiles({ root = ROOT, dir = dataDir() } = {}) {
  const file = join(dir, 'profiles.json');
  const configFile = join(root, 'config.json');
  function readState() {
    const state = readObject(file, { items: [] }, '音色方案');
    try {
      if (!Array.isArray(state.items) || state.items.length > 50 || Object.keys(state).some(key => !['items', 'activeId'].includes(key))) throw new Error('invalid state');
      const ids = new Set(), names = new Set();
      for (const item of state.items) {
        if (!object(item) || typeof item.id !== 'string' || !UUID.test(item.id) || ids.has(item.id) || nameOf(item.name) !== item.name || names.has(item.name) || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) throw new Error('invalid item');
        // Only the six v4 additions may be absent in older records. Unknown fields,
        // missing legacy fields and explicitly invalid new values remain corruption.
        if (!object(item.values) || Object.keys(item.values).some(key => !PROFILE_FIELDS.includes(key)) || LEGACY_FIELDS.some(key => !own(item.values, key))) throw new Error('invalid fields');
        const normalized = valuesOf(item.values);
        if (Object.keys(item.values).some(key => normalized[key] !== item.values[key])) throw new Error('invalid values');
        item.values = normalized;
        if (Object.keys(item).some(key => !['id', 'name', 'values', 'updatedAt'].includes(key))) throw new Error('invalid item fields');
        ids.add(item.id); names.add(item.name);
      }
      if (own(state, 'activeId') && (typeof state.activeId !== 'string' || !ids.has(state.activeId))) throw new Error('invalid active id');
      return state;
    } catch (error) { throw new Error('音色方案文件损坏，原文件已保留，请检查 profiles.json 后重试', { cause: error }); }
  }
  function view(state) {
    const result = { items: structuredClone(state.items) };
    if (state.activeId) {
      const current = pick(normalizeConfig(pick(readObject(configFile, {}, '扩展配置'))));
      const selected = state.items.find(item => item.id === state.activeId);
      if (selected && PROFILE_FIELDS.every(key => current[key] === selected.values[key])) result.activeId = selected.id;
    }
    return result;
  }
  function itemById(state, id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('请选择有效的音色方案');
    const item = state.items.find(item => item.id === id);
    if (!item) throw new Error('该音色方案已删除，请刷新列表');
    return item;
  }
  return {
    list() { return view(readState()); },
    save({ name, id, values } = {}) {
      const nextName = nameOf(name), nextValues = valuesOf(values);
      return locked(dir, () => {
        const state = readState();
        const existing = id === undefined ? undefined : itemById(state, id);
        if (state.items.some(item => item.name === nextName && item.id !== existing?.id)) throw new Error('已有同名音色方案，请选择该方案后修改名称并点击「保存方案」，或换一个名称');
        const duplicate = !existing && state.items.find(item => PROFILE_FIELDS.every(key => item.values[key] === nextValues[key]));
        if (duplicate) throw new Error(`当前音色设置与已有方案「${duplicate.name}」相同，请选择该项修改名称并点击「保存方案」；本次未新建`);
        if (!existing && state.items.length >= 50) throw new Error('最多保存 50 套音色方案，请先删除旧方案');
        const next = { id: existing?.id ?? randomUUID(), name: nextName, values: nextValues, updatedAt: new Date().toISOString() };
        if (existing) state.items[state.items.indexOf(existing)] = next;
        else state.items.push(next);
        // Saving edited values does not apply them to the running configuration.
        if (state.activeId === next.id && existing && PROFILE_FIELDS.some(key => existing.values[key] !== next.values[key])) delete state.activeId;
        const result = view(state);
        atomicJson(file, state);
        return { ...result, message: `已${existing ? '更新' : '保存'}音色方案「${next.name}」；点击「应用方案」后切换` };
      });
    },
    apply({ id } = {}) {
      return locked(dir, () => {
        const state = readState(), item = itemById(state, id);
        const raw = readObject(configFile, {}, '扩展配置');
        // Preserve unknown/global keys verbatim. Secret storage is owned by Roost.
        const next = { ...raw, ...item.values };
        mkdirSync(root, { recursive: true });
        // Detect an external config writer before replacing its snapshot.
        let before;
        try { before = statSync(configFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const latest = readObject(configFile, {}, '扩展配置');
        if (JSON.stringify(latest) !== JSON.stringify(raw)) throw new Error('扩展配置刚被其他请求更新，请重新应用方案');
        if (before) {
          const after = statSync(configFile);
          if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('扩展配置刚被其他请求更新，请重新应用方案');
        }
        atomicJson(configFile, next);
        state.activeId = item.id;
        atomicJson(file, state);
        return { ...view(state), message: `已应用音色方案「${item.name}」` };
      });
    },
    remove({ id } = {}) {
      return locked(dir, () => {
        const state = readState(), item = itemById(state, id);
        state.items = state.items.filter(candidate => candidate.id !== item.id);
        if (state.activeId === item.id) delete state.activeId;
        const result = view(state);
        atomicJson(file, state);
        return { ...result, message: `已删除音色方案「${item.name}」；正在使用的音色设置保持原值` };
      });
    },
  };
}
