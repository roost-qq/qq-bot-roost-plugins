import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migratePollSeconds } from './private-message-request-policy.js';

export const PLATFORM_IDS = Object.freeze([
  'bilibili', 'douyin', 'kuaishou', 'acfun', 'hongguo', 'netease', 'ximalaya',
  'weibo', 'xiaohongshu', 'xianyu', 'toutiao', 'xiaoheihe', 'xueqiu', 'wechat',
  'zhihu', 'tieba', 'nga', 'hupu', 'douban', 'v2ex', 'juejin', 'csdn', 'cnblogs',
  'gitee', 'tiktok', 'youtube', 'steam', 'twitter', 'pixiv', 'github', 'gitlab',
]);

export const PLATFORM_NAMES = Object.freeze({
  bilibili: '哔哩哔哩', douyin: '抖音', kuaishou: '快手', acfun: 'AcFun',
  hongguo: '红果短剧', netease: '网易云音乐', ximalaya: '喜马拉雅', weibo: '微博',
  xiaohongshu: '小红书', xianyu: '闲鱼', toutiao: '今日头条', xiaoheihe: '小黑盒',
  xueqiu: '雪球', wechat: '微信', zhihu: '知乎', tieba: '百度贴吧', nga: 'NGA',
  hupu: '虎扑', douban: '豆瓣', v2ex: 'V2EX', juejin: '掘金', csdn: 'CSDN',
  cnblogs: '博客园', gitee: 'Gitee', tiktok: 'TikTok', youtube: 'YouTube',
  steam: 'Steam', twitter: 'X / Twitter', pixiv: 'Pixiv', github: 'GitHub', gitlab: 'GitLab',
});

// Use the engine's exact values; the page labels these as 仅文字 / 仅媒体.
export const PLATFORM_MODES = Object.freeze(['全部发送', '仅文本', '仅富媒体', '关闭']);
export const DEFAULTS = Object.freeze({
  enabled: true, privateEnabled: true, requireMention: false,
  engineMode: 'managed', engineUrl: 'http://127.0.0.1:3199',
  maxLinks: 3, maxFileMiB: 200, timeoutSeconds: 300, concurrency: 2,
  queueLimit: 10, queueWaitSeconds: 30, dedupeSeconds: 120,
  sendCaption: true, handleTextOnly: false, audioMode: 'auto',
  cacheSeconds: 1800, hotComments: 0, translation: false,
  pythonPath: '', ffmpegPath: '', externalCacheRoot: '',
  biliDmEnabled: false, biliDmPollSeconds: 300, biliDmIncludeSystem: false,
  xiaoheiheDmEnabled: false, xiaoheiheDmPollSeconds: 300,
});

const NUMBERS = {
  maxLinks: [1, 3], maxFileMiB: [1, 200], timeoutSeconds: [5, 300],
  concurrency: [1, 8], queueLimit: [0, 100], queueWaitSeconds: [1, 30],
  dedupeSeconds: [0, 3600], cacheSeconds: [60, 86400], hotComments: [0, 20],
  biliDmPollSeconds: [180, 3600],
  xiaoheiheDmPollSeconds: [180, 3600],
};
function rawConfigValue(ctx, key) {
  const raw = ctx?.config?.[key];
  return raw && typeof raw === 'object' && 'default' in raw ? raw.default : raw;
}
const SECRET_KEY = /(?:cookie|token|password|passwd|secret|api[_-]?key|authorization|access[_-]?key|credential)/i;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PRIVATE_PROVIDER_KEY = 'privateMessageProviders';
const PRIVATE_PROVIDER_IDS = new Set(['xiaoheihe']);
export const MASK = '••••••••';

// A credential transaction can fail after its atomic rename has already
// committed. Callers must be able to tell that bounded fact apart from a
// cancellation, without the error ever carrying the committed Cookie.
const COMMITTED_REVISION = Symbol('biliCommittedRevision');

export function committedCredentialRevision(error) {
  const value = error !== null && (typeof error === 'object' || typeof error === 'function')
    ? error[COMMITTED_REVISION] : undefined;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function markCommittedRevision(error, revision) {
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    try {
      Object.defineProperty(error, COMMITTED_REVISION, {
        value: revision, enumerable: false, configurable: true,
      });
    } catch { /* a frozen error still propagates as a real IO failure */ }
  }
  return error;
}

export function readConfig(ctx) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const raw = ctx?.config?.[key];
    const value = raw && typeof raw === 'object' && 'default' in raw ? raw.default : raw;
    out[key] = value === undefined || value === null ? fallback : value;
    if (typeof fallback === 'boolean') out[key] = out[key] === true || out[key] === 'true';
    else if (NUMBERS[key]) {
      const [min, max] = NUMBERS[key];
      const n = Number(out[key]);
      out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
    } else out[key] = String(out[key]).trim();
  }
  if (!['managed', 'external'].includes(out.engineMode)) out.engineMode = DEFAULTS.engineMode;
  if (!['auto', 'voice', 'file'].includes(out.audioMode)) out.audioMode = 'auto';
  // The native Xiaoheihe capability is available and selectable. Its default
  // stays off; an explicit user save of true or false is preserved here so the
  // dedicated runtime can honour the operator's choice without a hidden clamp.
  return out;
}

export function validateConfig(patch) {
  if (!isObject(patch)) throw new Error('配置必须是 JSON 对象');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) throw new Error(`未知配置：${key}`);
    const fallback = DEFAULTS[key];
    if (typeof fallback === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`);
      out[key] = value;
    } else if (NUMBERS[key]) {
      const [min, max] = NUMBERS[key];
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 范围为 ${min}～${max}`);
      out[key] = value;
    } else {
      if (typeof value !== 'string' || value.length > 2048 || /[\0\r\n]/.test(value)) throw new Error(`${key} 格式不合法`);
      out[key] = value.trim();
    }
  }
  if (out.engineMode && !['managed', 'external'].includes(out.engineMode)) throw new Error('引擎模式必须为 managed 或 external');
  if (out.audioMode && !['auto', 'voice', 'file'].includes(out.audioMode)) throw new Error('音频模式必须为 auto、voice 或 file');
  if (out.engineUrl !== undefined) {
    let url;
    try { url = new URL(out.engineUrl); } catch { throw new Error('引擎地址不合法'); }
    if (url.protocol !== 'http:' ||
        !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash ||
        !['', '/'].includes(url.pathname)) throw new Error('引擎地址只允许 http://127.0.0.1:端口 或 http://[::1]:端口');
    out.engineUrl = url.origin;
  }
  return out;
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copy(value) { return JSON.parse(JSON.stringify(value)); }

export function deepMerge(base, patch) {
  const out = isObject(base) ? copy(base) : {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (UNSAFE_KEYS.has(key)) throw new Error('配置含不允许的键');
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : copy(value);
  }
  return out;
}

function assertTree(value, depth = 0, count = { n: 0 }) {
  if (depth > 14 || ++count.n > 5000) throw new Error('配置嵌套或条目过多');
  if (Array.isArray(value)) {
    for (const item of value) assertTree(item, depth + 1, count);
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) throw new Error('配置含不允许的键');
      assertTree(child, depth + 1, count);
    }
  } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
    throw new Error('配置只能含 JSON 值');
  }
}

function splitSecrets(value, prefix = [], secrets = {}, clean = {}) {
  for (const [key, item] of Object.entries(value ?? {})) {
    let urlCredential = false;
    if (typeof item === 'string' && /^[a-z]+:\/\//i.test(item)) {
      try { const url = new URL(item); urlCredential = Boolean(url.username || url.password); } catch {}
    }
    if (SECRET_KEY.test(key) || urlCredential) {
      if (item !== MASK && item !== '********') secrets[key] = copy(item);
    } else if (isObject(item)) {
      const child = splitSecrets(item, [...prefix, key]);
      clean[key] = child.clean;
      if (Object.keys(child.secrets).length) secrets[key] = child.secrets;
    } else {
      // Arrays of named credential records must not silently leak credentials.
      if (Array.isArray(item) && item.some((x) => isObject(x) && Object.keys(x).some((k) => SECRET_KEY.test(k)))) {
        throw new Error('数组内凭据请改用命名对象并单独保存');
      }
      clean[key] = Array.isArray(item) ? item.map((x) => isObject(x) ? redact(x) : x) : copy(item);
    }
  }
  return { clean, secrets };
}

export function redactUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = ''; url.password = '';
    for (const key of url.searchParams.keys()) {
      if (SECRET_KEY.test(key) || /sign|session|auth|ticket/i.test(key)) url.searchParams.set(key, MASK);
    }
    return url.href.slice(0, 2048);
  } catch { return String(value ?? '').slice(0, 2048); }
}

export function redact(value, secrets = []) {
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, secrets));
  if (isObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = SECRET_KEY.test(key) ? (item ? MASK : '') : redact(item, secrets);
    }
    return out;
  }
  if (typeof value !== 'string') return value;
  let out = value.slice(0, 16000);
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join(MASK);
  out = out.replace(/\b(?:https?):\/\/[^\s<>"']+/gi, (url) => redactUrl(url));
  return out.replace(/((?:cookie|authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\r\n]+/gi, `$1${MASK}`);
}

function secretValues(value, out = []) {
  if (isObject(value)) for (const child of Object.values(value)) secretValues(child, out);
  else if (typeof value === 'string' && value) out.push(value);
  return out;
}

export function engineDefaults() {
  return {
    parsers: Object.fromEntries(PLATFORM_IDS.map((id) => [id, '全部发送'])),
    message: {
      opening: { enable: false }, packing: { mode: '不聚合' },
      media_display: { audio_send_mode: '语音', interleave_images: false },
      text_metadata: {
        show_title: true, show_author: true, show_timestamp: true,
        show_original_link: true, show_description: true, quote_user_message: false,
        render_to_image: false,
      },
      hot_comments: { count: 0 },
    },
    download: { max_video_size_mb: 200, max_audio_size_mb: 200, max_concurrent: 2 },
    translation: { enable: false },
  };
}

async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('配置文件超过 256 KiB');
    const data = JSON.parse(text);
    assertTree(data);
    if (!isObject(data)) throw new Error('配置文件必须是对象');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, data, { guard } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    if (guard !== undefined && (typeof guard !== 'function' || guard() !== true)) {
      throw new Error('登录会话已失效，未保存 Cookie');
    }
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

const BILI_COOKIE_MAX = 8192;
const PRIVATE_PROVIDER_MAX_BYTES = 128 * 1024;

function hasOwn(value, key) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function containsPrivateProviderKey(value, depth = 0) {
  if (depth > 14 || !isObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === PRIVATE_PROVIDER_KEY) return true;
    if (containsPrivateProviderKey(child, depth + 1)) return true;
  }
  return false;
}

function withoutPrivateProviderKeys(value, depth = 0) {
  if (depth > 14 || !isObject(value)) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === PRIVATE_PROVIDER_KEY) continue;
    out[key] = isObject(child) ? withoutPrivateProviderKeys(child, depth + 1) : child;
  }
  return out;
}

function requirePrivateProviderId(providerId) {
  const id = String(providerId ?? '');
  if (!PRIVATE_PROVIDER_IDS.has(id)) throw new Error('未知或未验证的私信平台');
  return id;
}

/**
 * Keep only the dedicated non-engine private-message credential partition.
 * Legacy or accidental copies under `upstream` are removed so a generic
 * engine configuration merge can never receive these secrets.
 */
function normalizePrivateMessageProviders(credentials) {
  if (!isObject(credentials)) return;
  const box = credentials[PRIVATE_PROVIDER_KEY];
  if (!isObject(box)) {
    delete credentials[PRIVATE_PROVIDER_KEY];
  } else {
    for (const id of Object.keys(box)) {
      if (!PRIVATE_PROVIDER_IDS.has(id) || !isObject(box[id])) delete box[id];
    }
    if (!Object.keys(box).length) delete credentials[PRIVATE_PROVIDER_KEY];
  }
  if (isObject(credentials.upstream)) {
    delete credentials.upstream[PRIVATE_PROVIDER_KEY];
  }
}

function privateProviderHints(value, prefix = '', out = {}) {
  if (!isObject(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (isObject(item)) privateProviderHints(item, full, out);
    else out[full] = { set: Boolean(item), value: item ? MASK : '' };
  }
  return out;
}

/** Return the canonical Bili cookie, preferring the legacy upstream location. */
function readCanonicalBiliCookie(credentials) {
  const root = isObject(credentials?.bilibili_enhanced) ? credentials.bilibili_enhanced : null;
  const upstream = isObject(credentials?.upstream) ? credentials.upstream : null;
  const nested = upstream && isObject(upstream.bilibili_enhanced) ? upstream.bilibili_enhanced : null;
  if (hasOwn(nested, 'cookie')) return typeof nested.cookie === 'string' ? nested.cookie : '';
  if (hasOwn(root, 'cookie')) return typeof root.cookie === 'string' ? root.cookie : '';
  return '';
}

/**
 * Move the Bili cookie to the single canonical root location. A present nested
 * value (including an explicit empty string) wins over the root legacy value.
 * Other platforms and unrelated fields are left untouched.
 */
function normalizeBiliCookie(credentials) {
  if (!isObject(credentials)) return '';
  const root = isObject(credentials.bilibili_enhanced) ? credentials.bilibili_enhanced : null;
  const upstream = isObject(credentials.upstream) ? credentials.upstream : null;
  const nested = upstream && isObject(upstream.bilibili_enhanced) ? upstream.bilibili_enhanced : null;

  let present = false;
  let value = '';
  if (hasOwn(nested, 'cookie')) {
    present = true;
    value = typeof nested.cookie === 'string' ? nested.cookie : '';
    delete nested.cookie;
  } else if (hasOwn(root, 'cookie')) {
    present = true;
    value = typeof root.cookie === 'string' ? root.cookie : '';
  }

  if (present) credentials.bilibili_enhanced = { ...(root || {}), cookie: value };
  return present ? value : readCanonicalBiliCookie(credentials);
}

/** An explicit root-level patch must not lose to a stale nested legacy value. */
function dropStaleNestedBiliCookie(target, patch) {
  const rootPatched = hasOwn(patch?.bilibili_enhanced, 'cookie');
  const nestedPatched = hasOwn(patch?.upstream?.bilibili_enhanced, 'cookie');
  if (rootPatched && !nestedPatched && isObject(target?.upstream?.bilibili_enhanced)) {
    delete target.upstream.bilibili_enhanced.cookie;
  }
}

export function createSettings(ctx, { initialBarrier, isActive } = {}) {
  if (!ctx?.dataDir) throw new Error('宿主未提供插件数据目录');
  const advancedFile = path.join(ctx.dataDir, 'engine-settings.json');
  const credentialsFile = path.join(ctx.dataDir, 'credentials.json');
  let advanced = engineDefaults();
  let credentials = {};
  let cookieRevision = 0;
  // Opaque UI ordering token. It is random rather than an account id or a
  // cookie fingerprint, and rotates exactly when the Bili credential changes.
  let biliAccountEpoch = randomUUID();
  // Public numeric ordering value consumed by the page. It is a bounded
  // per-bot counter, never an account id, Cookie hash or target id.
  let biliSessionVersion = 0;
  const nextSessionVersion = (previous = biliSessionVersion) => Math.min(
    Math.max(1, Date.now() - 1),
    Math.max(1, Math.floor(Number(previous) || 0) + 1),
  );
  let writeTail = Promise.resolve();
  let runtimeConfigOverride = {};
  let migrationNotice = '';
  const cookieListeners = new Set();
  const runtimeActive = () => {
    if (typeof isActive !== 'function') return true;
    try { return isActive() === true; } catch { return false; }
  };
  const inactiveError = () => {
    const error = new Error('插件已停用，已拒绝写入');
    error.code = 'DM_STALE';
    return error;
  };
  const assertActive = () => {
    if (!runtimeActive()) throw inactiveError();
  };
  const guardFails = (guard) => guard !== undefined
    && (typeof guard !== 'function' || guard() !== true);
  const commitGuard = (guard) => {
    if (guard === undefined) return typeof isActive === 'function' ? runtimeActive : undefined;
    return () => {
      if (typeof guard !== 'function' || guard() !== true) return false;
      return runtimeActive();
    };
  };
  // A successful credential rename owns the revision and cookie it just
  // committed. Follow-up metadata writes must stay bound to that commit and
  // the active runtime, but must not re-run a caller guard whose revision
  // field was intentionally advanced by this same commit.
  const postCommitGuard = () => {
    const committedCookie = readCanonicalBiliCookie(credentials);
    const committedRevision = cookieRevision;
    return () => runtimeActive()
      && cookieRevision === committedRevision
      && readCanonicalBiliCookie(credentials) === committedCookie;
  };
  const serial = (fn) => {
    const result = writeTail.then(fn);
    writeTail = result.catch(() => {});
    return result;
  };
  const configured = () => ({ ...readConfig(ctx), ...runtimeConfigOverride });
  const normalize = (target = advanced) => {
    const cfg = configured();
    target.parsers ??= {};
    for (const id of PLATFORM_IDS) {
      if (!PLATFORM_MODES.includes(target.parsers[id])) target.parsers[id] = '全部发送';
    }
    target.translation ??= {};
    target.translation.enable = cfg.translation;
    delete target.translation.enabled;
    target.message ??= {};
    target.message.hot_comments = { ...target.message.hot_comments, count: cfg.hotComments };
    target.message.text_metadata = { ...target.message.text_metadata, quote_user_message: false };
    target.download = {
      ...target.download,
      max_video_size_mb: Math.min(Number(target.download?.max_video_size_mb) || cfg.maxFileMiB, cfg.maxFileMiB),
      max_audio_size_mb: Math.min(Number(target.download?.max_audio_size_mb) || cfg.maxFileMiB, cfg.maxFileMiB),
    };
  };
  const publishCookie = async (before) => {
    const after = readCanonicalBiliCookie(credentials);
    if (after === before) return false;
    cookieRevision += 1;
    biliAccountEpoch = randomUUID();
    biliSessionVersion = nextSessionVersion();
    advanced.privateMessageSessionVersion = biliSessionVersion;
    const event = { revision: cookieRevision, hasCookie: Boolean(after) };
    for (const listener of [...cookieListeners]) {
      try {
        const result = listener(event);
        if (result && typeof result.then === 'function') {
          // Cookie saves complete only after the policy credential update has
          // entered its durable commit tail; teardown cannot race this write.
          await Promise.resolve(result).catch(() => {});
        }
      } catch { /* a subscriber cannot break storage */ }
    }
    return true;
  };
  const ready = serial(async () => {
    if (initialBarrier) await initialBarrier;
    assertActive();
    // The advanced engine file must never be a second storage location for
    // private-message credentials, including nested upstream spellings.
    const loaded = splitSecrets(withoutPrivateProviderKeys(await readJson(advancedFile, {})));
    advanced = deepMerge(advanced, loaded.clean);
    const loadedCredentials = deepMerge(await readJson(credentialsFile, {}), loaded.secrets);
    normalizeBiliCookie(loadedCredentials);
    normalizePrivateMessageProviders(loadedCredentials);
    credentials = loadedCredentials;
    cookieRevision = readCanonicalBiliCookie(credentials) ? 1 : 0;
    biliAccountEpoch = randomUUID();
    biliSessionVersion = nextSessionVersion(advanced.privateMessageSessionVersion);
    advanced.privateMessageSessionVersion = biliSessionVersion;
    if (advanced.privateMessageConfigVersion !== 1) {
      const rawPoll = rawConfigValue(ctx, 'biliDmPollSeconds');
      if (rawPoll === undefined || rawPoll === null) {
        advanced.privateMessageConfigVersion = 1;
      } else {
        const migration = migratePollSeconds(rawPoll);
        if (!migration.migrated) {
          advanced.privateMessageConfigVersion = 1;
        } else {
          runtimeConfigOverride = { biliDmPollSeconds: migration.seconds };
          migrationNotice = `原 ${migration.originalSeconds ?? '未记录'} 秒已调整为 ${migration.seconds} 秒，以减少连续请求；当前允许范围为 180–3600 秒`;
          try {
            if (typeof ctx.setConfig !== 'function') throw new Error('host cannot save migrated config');
            await ctx.setConfig({ biliDmPollSeconds: migration.seconds });
            runtimeConfigOverride = {};
            advanced.privateMessageConfigVersion = 1;
          } catch {
            migrationNotice += '。配置迁移尚未完成，当前运行已使用安全下限；修复宿主写入后请重新保存间隔。';
          }
        }
      }
    }
    normalize();
    assertActive();
    const guard = commitGuard();
    await writeJson(credentialsFile, credentials, { guard });
    await writeJson(advancedFile, advanced, { guard });
  });
  const api = {
    ready, advancedFile, credentialsFile,
    current: () => ({ ...configured(), platformModes: { ...advanced.parsers } }),
    publicConfig: () => ({ ...configured() }),
    configMigration: () => ({ complete: advanced.privateMessageConfigVersion === 1, notice: migrationNotice }),
    advanced: () => redact(copy(advanced), secretValues(credentials)),
    sanitize: (value) => redact(value, secretValues(credentials)),
    credentialHints: () => {
      const out = {};
      const visit = (obj, prefix = '') => {
        for (const [key, value] of Object.entries(obj)) {
          const full = prefix ? `${prefix}.${key}` : key;
          if (isObject(value)) visit(value, full);
          else out[full] = { set: Boolean(value), value: value ? MASK : '' };
        }
      };
      visit(credentials);
      return out;
    },
    platforms: () => PLATFORM_IDS.map((id) => ({
      id, name: PLATFORM_NAMES[id], mode: advanced.parsers[id],
      enabled: advanced.parsers[id] !== '关闭', verification: '未联网验证',
    })),
    getBiliCookie: () => readCanonicalBiliCookie(credentials),
    getBiliCookieRevision: () => cookieRevision,
    getBiliAccountEpoch: () => biliAccountEpoch,
    getBiliSessionVersion: () => biliSessionVersion,
    getPrivateMessageProviderCredentials(providerId) {
      const id = requirePrivateProviderId(providerId);
      const value = credentials?.[PRIVATE_PROVIDER_KEY]?.[id];
      return isObject(value) ? copy(value) : {};
    },
    privateMessageProviderCredentialHints(providerId) {
      const id = requirePrivateProviderId(providerId);
      return privateProviderHints(credentials?.[PRIVATE_PROVIDER_KEY]?.[id] ?? {}, '');
    },
    subscribeBiliCookie(listener) {
      if (typeof listener !== 'function') throw new Error('订阅回调必须是函数');
      cookieListeners.add(listener);
      return () => cookieListeners.delete(listener);
    },
    async setBiliCookie(cookie, { guard } = {}) {
      const value = String(cookie ?? '');
      if (value.length > BILI_COOKIE_MAX || /[\0\r\n]/.test(value)) throw new Error('Cookie 格式不合法');
      await ready;
      return serial(async () => {
        assertActive();
        if (guardFails(guard)) {
          throw new Error('登录会话已失效，未保存 Cookie');
        }
        const before = readCanonicalBiliCookie(credentials);
        const patch = { bilibili_enhanced: { cookie: value } };
        const next = deepMerge(credentials, patch);
        dropStaleNestedBiliCookie(next, patch);
        normalizeBiliCookie(next);
        normalizePrivateMessageProviders(next);
        // Recheck the commit guard after the temporary file exists and directly
        // before rename. A cancel during writeFile must not commit late Cookie.
        await writeJson(credentialsFile, next, { guard: commitGuard(guard) });
        credentials = next;
        if (await publishCookie(before)) {
          try {
            await writeJson(advancedFile, advanced, { guard: postCommitGuard() });
          } catch (error) {
            // The credential rename already succeeded and its revision is
            // durable. Surface the metadata failure with only the committed
            // revision so the caller can report a storage error instead of a
            // late cancellation. Nothing credential-shaped is attached.
            throw markCommittedRevision(error, cookieRevision);
          }
        }
        return { ok: true, hasCookie: Boolean(readCanonicalBiliCookie(credentials)) };
      });
    },
    async clearBiliCookie(options) {
      return api.setBiliCookie('', options);
    },
    async saveConfig(patch, { guard } = {}) {
      const valid = validateConfig(patch);
      await ready;
      return serial(async () => {
        assertActive();
        if (guardFails(guard)) {
          throw new Error('维护会话已失效，未保存配置');
        }
        if (typeof ctx.setConfig !== 'function') throw new Error('宿主不支持写插件配置');
        await ctx.setConfig(valid);
        assertActive();
        if (guardFails(guard)) {
          throw new Error('维护会话已失效，未保存配置');
        }
        // Only an explicit successful Bili interval save can complete the Bili
        // migration. Saving Xhh or an unrelated field must not clear the safe
        // runtime override or mark the still-unwritten Bili disk value valid.
        if (Object.prototype.hasOwnProperty.call(valid, 'biliDmPollSeconds')) {
          runtimeConfigOverride = {};
          migrationNotice = '';
          advanced.privateMessageConfigVersion = 1;
        }
        normalize();
        await writeJson(advancedFile, advanced, { guard: commitGuard(guard) });
        return api.publicConfig();
      });
    },
    async saveAdvanced(patch, { guard } = {}) {
      if (!isObject(patch) || Buffer.byteLength(JSON.stringify(patch)) > 256 * 1024) throw new Error('高级配置必须是 256 KiB 内的 JSON 对象');
      assertTree(patch);
      if (containsPrivateProviderKey(patch)) throw new Error('私信平台凭据请使用独立分区保存');
      if (patch.parsers && (!isObject(patch.parsers) || Object.entries(patch.parsers).some(([id, mode]) => !PLATFORM_IDS.includes(id) || !PLATFORM_MODES.includes(mode)))) throw new Error('平台 ID 或输出模式不合法');
      await ready;
      return serial(async () => {
        assertActive();
        if (guardFails(guard)) {
          throw new Error('维护会话已失效，未保存配置');
        }
        const before = readCanonicalBiliCookie(credentials);
        const parts = splitSecrets(patch);
        // The managed host owns transport authentication and cache roots.
        delete parts.clean.qq;
        const nextAdvanced = deepMerge(advanced, parts.clean);
        const nextCredentials = deepMerge(credentials, parts.secrets);
        dropStaleNestedBiliCookie(nextCredentials, parts.secrets);
        normalizeBiliCookie(nextCredentials);
        normalizePrivateMessageProviders(nextCredentials);
        normalize(nextAdvanced);
        await writeJson(advancedFile, nextAdvanced, { guard: commitGuard(guard) });
        await writeJson(credentialsFile, nextCredentials, { guard: commitGuard(guard) });
        advanced = nextAdvanced;
        credentials = nextCredentials;
        if (await publishCookie(before)) {
          await writeJson(advancedFile, advanced, { guard: postCommitGuard() });
        }
        return api.advanced();
      });
    },
    async saveCredentials(patch, { guard } = {}) {
      if (!isObject(patch)) throw new Error('凭据必须是 JSON 对象');
      assertTree(patch);
      if (containsPrivateProviderKey(patch)) throw new Error('私信平台凭据请使用独立分区保存');
      if (Buffer.byteLength(JSON.stringify(patch)) > 128 * 1024) throw new Error('凭据过大');
      const parts = splitSecrets(patch);
      const hasLeaf = (obj) => Object.values(obj).some((x) => isObject(x) ? hasLeaf(x) : x !== undefined);
      if (hasLeaf(parts.clean)) throw new Error('凭据配置只接受 cookie、token、api_key 等字段');
      await ready;
      return serial(async () => {
        assertActive();
        if (guardFails(guard)) {
          throw new Error('维护会话已失效，未保存配置');
        }
        const before = readCanonicalBiliCookie(credentials);
        const next = deepMerge(credentials, parts.secrets);
        dropStaleNestedBiliCookie(next, parts.secrets);
        normalizeBiliCookie(next);
        normalizePrivateMessageProviders(next);
        await writeJson(credentialsFile, next, { guard: commitGuard(guard) });
        credentials = next;
        if (await publishCookie(before)) {
          await writeJson(advancedFile, advanced, { guard: postCommitGuard() });
        }
        return api.credentialHints();
      });
    },
    async setPrivateMessageProviderCredentials(providerId, patch, { guard, replace = false } = {}) {
      const id = requirePrivateProviderId(providerId);
      if (!isObject(patch)) throw new Error('私信凭据必须是 JSON 对象');
      const exact = replace === true;
      assertTree(patch);
      if (Buffer.byteLength(JSON.stringify(patch)) > PRIVATE_PROVIDER_MAX_BYTES) throw new Error('私信凭据过大');
      await ready;
      return serial(async () => {
        assertActive();
        if (guardFails(guard)) throw new Error('维护会话已失效，未保存私信凭据');
        const before = readCanonicalBiliCookie(credentials);
        const next = copy(credentials);
        const box = isObject(next[PRIVATE_PROVIDER_KEY]) ? next[PRIVATE_PROVIDER_KEY] : {};
        // A logout tombstone must erase every prior secret in this platform's
        // partition, including fields this build no longer knows about. Exact
        // replacement stays scoped to the target provider; other platforms,
        // Bili credentials and the rest of the store are copied untouched.
        box[id] = exact ? copy(patch) : deepMerge(isObject(box[id]) ? box[id] : {}, patch);
        next[PRIVATE_PROVIDER_KEY] = box;
        normalizeBiliCookie(next);
        normalizePrivateMessageProviders(next);
        await writeJson(credentialsFile, next, { guard: commitGuard(guard) });
        credentials = next;
        await publishCookie(before);
        return {
          ok: true,
          providerId: id,
          hints: api.privateMessageProviderCredentialHints(id),
        };
      });
    },
    async clearPrivateMessageProviderCredentials(providerId, options = {}) {
      const id = requirePrivateProviderId(providerId);
      await ready;
      return serial(async () => {
        assertActive();
        if (guardFails(options.guard)) throw new Error('维护会话已失效，未保存私信凭据');
        const before = readCanonicalBiliCookie(credentials);
        const next = copy(credentials);
        if (isObject(next[PRIVATE_PROVIDER_KEY])) {
          delete next[PRIVATE_PROVIDER_KEY][id];
        }
        normalizeBiliCookie(next);
        normalizePrivateMessageProviders(next);
        await writeJson(credentialsFile, next, { guard: commitGuard(options.guard) });
        credentials = next;
        await publishCookie(before);
        return { ok: true, providerId: id };
      });
    },
    flush: () => writeTail,
  };
  return api;
}
