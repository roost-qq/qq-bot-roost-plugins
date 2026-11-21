import { readFileSync, existsSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
export const DEFAULTS = Object.fromEntries(Object.entries(MANIFEST.config).filter(([, v]) => !v.secret).map(([k, v]) => [k, v.default]));

export function launcherDir(env = process.env, root = ROOT) {
  if (basename(dirname(root)) === 'extensions') return dirname(dirname(root));
  return env.ROOST_LAUNCHER_DIR || join(homedir(), '.dsh', 'dsh-roost');
}
export function dataDir(env = process.env) {
  return resolve(env.VOICE_REPLY_DATA_DIR || join(launcherDir(env), 'extension-data', 'voice-reply'));
}
function readObject(file) {
  const v = JSON.parse(readFileSync(file, 'utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('配置文件需要 JSON 对象');
  return v;
}
export function endpoint(value) {
  const u = new URL(String(value));
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('API 地址需要 http(s) 根地址，凭证请放密钥栏');
  return u.href.replace(/\/+$/, '');
}
export function normalizeConfig(input = {}, key = '') {
  const c = {};
  for (const [k, f] of Object.entries(MANIFEST.config)) {
    if (f.secret) continue;
    const v = Object.hasOwn(input, k) ? input[k] : f.default;
    if (f.type === 'boolean') {
      if (typeof v !== 'boolean') throw new Error(`${f.label}需要布尔值`);
    } else if (f.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < f.min || v > f.max || (f.integer && !Number.isInteger(v))) throw new Error(`${f.label}超出允许范围`);
    } else if (f.type === 'array') {
      if (!Array.isArray(v) || v.length > f.maxItems || v.some(x => typeof x !== 'string' || x.length > 1000)) throw new Error(`${f.label}格式有误`);
    } else {
      if (typeof v !== 'string' || (f.maxLength && v.length > f.maxLength) || (f.options && !f.options.includes(v))) throw new Error(`${f.label}格式有误`);
    }
    c[k] = typeof v === 'string' ? v.trim() : structuredClone(v);
  }
  c.api = endpoint(c.api);
  if (c.translateApi) c.translateApi = endpoint(c.translateApi);
  c.translateKey = String(key || '');
  return c;
}
/** MCP 与进程内面板共用原生配置；每次请求读盘，清空配置不会留下旧值。 */
export function currentConfig({ config, secrets, env = process.env, root = ROOT } = {}) {
  const installed = basename(dirname(root)) === 'extensions';
  const disk = join(root, 'config.json');
  // 安装后以原生文件为准：文件删除表示重置，不能退回进程启动时的旧 env。
  const values = existsSync(disk) ? readObject(disk) : installed ? {} : config ?? JSON.parse(env.ROOST_EXT_CONFIG || '{}');
  const secretFile = join(launcherDir(env, root), 'secrets', 'voice-reply.config.json');
  const secret = installed ? (existsSync(secretFile) ? readObject(secretFile) : {})
    : secrets ?? { translateKey: env.ROOST_EXT_SECRET_TRANSLATEKEY || '' };
  return normalizeConfig(values, secret.translateKey);
}
export function missingSetup(c) {
  return [['refAudio', '参考音频'], ['promptText', '参考文本'], ['sovitsWeights', 'SoVITS 权重'], ['gptWeights', 'GPT 权重']].filter(([k]) => !c[k]).map(([, label]) => label);
}
