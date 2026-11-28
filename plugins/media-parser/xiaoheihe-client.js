/**
 * Minimal native XiaoHeiHe (heybox) web client for QR login and private data.
 *
 * Only five fixed HTTPS paths are constructed here. Every upstream request is
 * GET, redirects are never followed, and no send/read/reply/arbitrary-URL API
 * exists. Public results never expose cookies, full response bodies, URLs or
 * server text; only fixed error codes, status/apiCode/retryAfterMs and safe
 * shape metadata leave this module.
 *
 * Signature algorithm and conversation/history field extraction are adapted
 * from advent259141/astrbot_plugin_xiaoheihe_adapter, xhh_client.py at commit
 * 534b9479e9bebe4ef82d9ec959d0c11146c90078 (Apache-2.0). Local reference:
 * media-parser-v03-20261127/protocol-research/xhh-client.py.txt; the license
 * text is bundled at licenses/xiaoheihe-adapter-Apache-2.0.txt. QR path/state
 * shapes were reviewed from WenfuRainbow/heybox at commit
 * afbe8a5f0629aafcd7e17d1c56eeec84ff4dd1bf (license unverified; no wholesale
 * copy). The QR apply/poll and list paths below are independently allowlisted.
 * Lossless JSON parsing reuses the existing bili-client parser for Node 20+.
 */

import { createHash, randomUUID } from 'node:crypto';
import { parseLosslessJson } from './bili-client.js';
import { parseRetryAfter } from './private-message-request-policy.js';
import { createXiaoheiheTransport, XHH_MAX_BODY_BYTES } from './xiaoheihe-transport.js';

export const API_ORIGIN = 'https://api.xiaoheihe.cn';
export const API_HOST = 'api.xiaoheihe.cn';

export const PATHS = Object.freeze({
  qrRequest: '/account/get_qrcode_url/',
  qrPoll: '/account/qr_state/',
  authCheck: '/bbs/app/user/message',
  normalConversations: '/bbs/app/user/message',
  strangerConversations: '/chat/stranger_messages/',
  directMessages: '/chatroom/v2/msg/user',
});

const ALLOWED_PATHS = new Set(Object.values(PATHS));
const ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';
const MAX_BODY_BYTES = XHH_MAX_BODY_BYTES;
const DEFAULT_TIMEOUT_MS = 15_000;
const COOKIE_MAX = 8192;
const COOKIE_VALUE_MAX = 4096;
const CONTROL_OR_SEMICOLON = /[\u0000-\u001f\u007f;]/;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ID_RE = /^\d{1,32}$/;
const IDENTITY_MAX = 256;
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const NUMBER_TOKEN_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

const LOGIN_COOKIE_NAMES = Object.freeze([
  'user_pkey', 'pkey', 'user_heybox_id', 'heybox_id',
  'x_xhh_tokenid', 'nickname', 'avatar', 'level',
]);
const LOGIN_COOKIE_SET = new Set(LOGIN_COOKIE_NAMES);
const PRIMARY_COOKIE_NAMES = Object.freeze(['user_pkey']);
const ACCOUNT_COOKIE_NAMES = Object.freeze(['heybox_id', 'user_heybox_id']);

const MIN_SERVER_MS = Date.UTC(2000, 0, 1);
const MAX_SERVER_MS = Date.UTC(2100, 0, 1);
const MIN_SERVER_SECONDS = MIN_SERVER_MS / 1000;
const MAX_SERVER_SECONDS = MAX_SERVER_MS / 1000;

export const XHH_SAFE_MESSAGES = Object.freeze({
  XHH_CANCELLED: '请求已取消',
  XHH_NETWORK: '无法连接小黑盒',
  XHH_TIMEOUT: '请求小黑盒超时',
  XHH_HTTP: '小黑盒服务暂时不可用',
  XHH_RATE_LIMIT: '请求过于频繁，请稍后重试',
  XHH_BUDGET: '本地请求预算已用完，请稍后重试',
  XHH_COOLDOWN: '本地请求冷却中，请稍后重试',
  XHH_AUTH: '小黑盒账号未登录或登录已失效',
  XHH_CHALLENGE: '小黑盒要求完成安全验证',
  XHH_API: '小黑盒拒绝了请求',
  XHH_RESPONSE: '小黑盒返回了无法识别的数据',
  XHH_PRECISION: '小黑盒返回的标识精度不安全',
  XHH_QR: '小黑盒二维码响应无效',
  XHH_QR_CREDENTIAL: '扫码成功但未取得有效登录凭据',
  XHH_STORAGE: '登录成功但凭据保存失败，请稍后重试',
});

const KNOWN_CODES = new Set(Object.keys(XHH_SAFE_MESSAGES));

export class XhhClientError extends Error {
  constructor(code = 'XHH_RESPONSE', options = {}) {
    const safe = KNOWN_CODES.has(code) ? code : 'XHH_RESPONSE';
    super(XHH_SAFE_MESSAGES[safe]);
    this.name = 'XhhClientError';
    this.code = safe;
    this.status = Number.isFinite(options.status) ? options.status : 0;
    this.apiCode = Number.isFinite(options.apiCode) ? options.apiCode : 0;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs)
      ? Math.max(0, options.retryAfterMs) : 0;
    this.nextAllowedAt = Number.isFinite(options.nextAllowedAt)
      ? options.nextAllowedAt : null;
    this.requestPolicyRecorded = options.requestPolicyRecorded === true;
  }
}

function fail(code, options) {
  throw new XhhClientError(code, options);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function md5(value) {
  return createHash('md5').update(String(value), 'utf8').digest('hex');
}

function md5Upper(value) {
  return md5(value).toUpperCase();
}

function mixColumns(values) {
  const source = Array.from(values);
  const xtime = (value) => (value & 128 ? ((value << 1) ^ 27) & 255 : value << 1);
  const q = (value) => xtime(value) ^ value;
  const r = (value) => q(xtime(value));
  const y = (value) => r(q(xtime(value)));
  const g = (value) => y(value) ^ r(value) ^ q(value);
  const result = [0, 0, 0, 0];
  result[0] = g(source[0]) ^ y(source[1]) ^ r(source[2]) ^ q(source[3]);
  result[1] = q(source[0]) ^ g(source[1]) ^ y(source[2]) ^ r(source[3]);
  result[2] = r(source[0]) ^ q(source[1]) ^ g(source[2]) ^ y(source[3]);
  result[3] = y(source[0]) ^ r(source[1]) ^ q(source[2]) ^ g(source[3]);
  source[0] = result[0];
  source[1] = result[1];
  source[2] = result[2];
  source[3] = result[3];
  return source;
}

function mapByAlphabet(value, alphabet, end) {
  const source = alphabet.slice(0, end);
  return Array.from(String(value))
    .map((char) => source[char.charCodeAt(0) % source.length])
    .join('');
}

function pathToAlphabet(value) {
  return Array.from(String(value))
    .map((char) => ALPHABET[char.charCodeAt(0) % ALPHABET.length]).join('');
}

function interleave(values) {
  const items = values.map((value) => String(value));
  const longest = items.reduce((max, value) => Math.max(max, value.length), 0);
  const result = [];
  for (let index = 0; index < longest; index += 1) {
    for (const value of items) {
      if (index < value.length) result.push(value[index]);
    }
  }
  return result.join('');
}

function normalizePath(path) {
  return `/${String(path).split('/').filter(Boolean).join('/')}/`;
}

export function createSignedParams(path, { nowSeconds, nonce, random = Math.random } = {}) {
  const now = Number.isFinite(nowSeconds) ? Math.trunc(nowSeconds) : Math.floor(Date.now() / 1000);
  const nonceValue = nonce ? String(nonce) : md5Upper(`${now}${random()}`);
  const seed = interleave([
    mapByAlphabet(String(now + 1), ALPHABET, -2),
    pathToAlphabet(normalizePath(path)),
    pathToAlphabet(nonceValue),
  ]).slice(0, 20);
  const hash = md5(seed);
  const checksumValues = Array.from(hash.slice(-6)).map((char) => char.charCodeAt(0));
  const checksum = String(mixColumns(checksumValues).reduce((sum, value) => sum + value, 0) % 100)
    .padStart(2, '0');
  return {
    hkey: `${mapByAlphabet(hash.slice(0, 5), ALPHABET, -4)}${checksum}`,
    _time: now,
    nonce: nonceValue,
  };
}

export function commonParams(heyboxId = '', deviceId = '') {
  return {
    os_type: 'web',
    app: 'heybox',
    client_type: 'web',
    version: '999.0.4',
    web_version: '2.5',
    x_client_type: 'web',
    x_app: 'heybox_website',
    heybox_id: String(heyboxId || ''),
    x_os_type: 'Windows',
    device_info: 'Chrome',
    device_id: String(deviceId || ''),
  };
}

function encodeParams(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

export function buildUrl(path, params = {}) {
  if (!ALLOWED_PATHS.has(path)) fail('XHH_RESPONSE');
  const query = encodeParams(params);
  return query ? `${API_ORIGIN}${path}?${query}` : `${API_ORIGIN}${path}`;
}

function headerValue(headers, name) {
  try {
    if (typeof headers?.get === 'function') {
      const value = headers.get(name);
      return value === undefined || value === null ? '' : String(value);
    }
    if (isObject(headers)) {
      const wanted = String(name).toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === wanted) {
          if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
          return value === undefined || value === null ? '' : String(value);
        }
      }
    }
  } catch { /* untrusted headers must not create errors */ }
  return '';
}

function headerList(headers, name) {
  try {
    if (typeof headers?.getSetCookie === 'function') {
      const values = headers.getSetCookie();
      if (Array.isArray(values)) return values.map((value) => String(value));
    }
    if (isObject(headers)) {
      const wanted = String(name).toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() !== wanted) continue;
        if (Array.isArray(value)) return value.map((item) => String(item));
        return value === undefined || value === null
          ? [] : String(value).split(/,(?=[^;]+=)/);
      }
    }
  } catch { /* fall through to the single header value */ }
  const value = headerValue(headers, name);
  return value ? value.split(/,(?=[^;]+=)/) : [];
}

function parseServerTime(headers) {
  const text = headerValue(headers, 'date');
  if (!text) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

function cookieValueOk(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= COOKIE_VALUE_MAX && !CONTROL_OR_SEMICOLON.test(value);
}

export function parseSetCookie(headers) {
  const cookies = {};
  for (const line of headerList(headers, 'set-cookie')) {
    const first = String(line).split(';', 1)[0];
    const index = first.indexOf('=');
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    const value = first.slice(index + 1).trim();
    if (!name || UNSAFE_KEYS.has(name) || !cookieValueOk(value)) continue;
    cookies[name] = value;
  }
  return cookies;
}

function cookieHeader(cookies) {
  return Object.entries(cookies || {})
    .filter(([name, value]) => name && !UNSAFE_KEYS.has(name) && cookieValueOk(value))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function loginCookies(cookies) {
  const result = {};
  for (const name of LOGIN_COOKIE_NAMES) {
    const value = cookies?.[name];
    if (LOGIN_COOKIE_SET.has(name) && cookieValueOk(value)) result[name] = value;
  }
  return result;
}

function loginCookieString(cookies) {
  return LOGIN_COOKIE_NAMES
    .filter((name) => cookieValueOk(cookies?.[name]))
    .map((name) => `${name}=${cookies[name]}`)
    .join('; ');
}

function hasPrimaryCredential(cookies) {
  return PRIMARY_COOKIE_NAMES.some((name) => cookieValueOk(cookies?.[name]));
}

function normalizeAccountId(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!ID_RE.test(text) || !/[1-9]/.test(text)) return '';
  return text;
}

function resolveAccountId(result, login) {
  const candidates = [
    result?.heyboxid,
    result?.heybox_id,
    result?.user_heybox_id,
    ...ACCOUNT_COOKIE_NAMES.map((name) => login?.[name]),
  ];
  for (const candidate of candidates) {
    const id = normalizeAccountId(candidate);
    if (id) return id;
  }
  return '';
}

function sanitizeCookieValue(cookie) {
  const value = String(cookie ?? '').trim();
  if (!value || value.length > COOKIE_MAX || /[\0\r\n]/.test(value)) return '';
  return value;
}

function tokenString(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return TOKEN_RE.test(text) ? text : '';
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return '';
}

function idString(value) {
  return normalizeAccountId(value);
}

function opaqueIdString(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
  }
  if (typeof value !== 'string') return '';
  if (!value || value.length > IDENTITY_MAX || value !== value.trim()) return '';
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return '';
  return value;
}

function safeText(value, max = 64) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
}

function safeFieldName(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/.test(name)
    ? name : '';
}

function fieldType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function boundedFields(value) {
  const fields = [];
  for (const name of Object.keys(value).slice(0, 24)) {
    const safeName = safeFieldName(name);
    if (!safeName) continue;
    fields.push({ name: safeName, type: fieldType(value[name]) });
  }
  return fields;
}

function asObject(value) {
  return isObject(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function firstObject(...values) {
  for (const value of values) {
    if (isObject(value) && Object.keys(value).length > 0) return value;
  }
  return {};
}

function firstList(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

function shapeOf(payload, result, listField, listValue) {
  const items = asList(listValue);
  const item = items.find((entry) => isObject(entry));
  return {
    recognized: listField.length > 0 && Array.isArray(listValue),
    listField,
    entryCount: items.length,
    statusType: fieldType(payload?.status),
    resultType: fieldType(payload?.result),
    listType: fieldType(listValue),
    itemFieldNames: item ? boundedFields(item).map((field) => field.name).slice(0, 12) : [],
  };
}

function conversationPayloadShape(payload, kind) {
  if (!isObject(payload) || payload.status !== 'ok') {
    return shapeOf(payload, asObject(payload?.result), '', []);
  }
  const result = asObject(payload.result);
  const candidates = kind === 'stranger'
    ? [['list', result.list], ['messages', result.messages], ['items', result.items], ['payload.list', payload.list]]
    : [['messages', result.messages], ['message', result.message]];
  const found = candidates.find(([, value]) => Array.isArray(value));
  return found
    ? shapeOf(payload, payload.result, found[0], found[1])
    : shapeOf(payload, payload.result, '', []);
}

function directPayloadShape(payload) {
  if (!isObject(payload) || payload.status !== 'ok') {
    return shapeOf(payload, asObject(payload?.result), '', []);
  }
  const result = asObject(payload.result);
  return Array.isArray(result.list)
    ? shapeOf(payload, result, 'list', result.list)
    : shapeOf(payload, result, '', []);
}

function userIdOf(user) {
  const item = asObject(user);
  return idString(item.heybox_id)
    || idString(item.user_heybox_id)
    || idString(item.userid)
    || idString(item.user_id)
    || idString(item.uid)
    || idString(item.id);
}

function displayNameOf(user) {
  const item = asObject(user);
  return safeText(item.username) || safeText(item.nickname) || safeText(item.name);
}

export function extractConversationEntries(payload, kind) {
  if (!isObject(payload) || payload.status !== 'ok') {
    fail('XHH_API', { apiCode: apiCodeOf(payload) });
  }
  const result = asObject(payload.result);
  const raw = kind === 'stranger'
    ? firstList(result.list, result.messages, result.items, payload.list)
    : firstList(result.messages, result.message);
  const entries = [];
  const seen = new Set();
  for (const item of asList(raw)) {
    if (!isObject(item)) continue;
    if (kind !== 'stranger' && String(item.entry || '') !== 'message') continue;
    const user = firstObject(item.user_a, item.user, item.recipient_info, item.sender_info);
    const userId = userIdOf(user)
      || idString(item.to_user_id)
      || idString(item.target_user_id)
      || idString(item.user_id)
      || idString(item.userid)
      || (String(item.entry || '') === 'message' ? idString(item.message_id) : '');
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    entries.push({ userId, nickname: displayNameOf(user) });
  }
  return entries;
}

function apiCodeOf(payload) {
  const candidates = [payload?.code, payload?.result?.code];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return candidate;
    if (typeof candidate === 'string' && /^-?\d{1,15}$/.test(candidate)) {
      const value = Number(candidate);
      if (Number.isSafeInteger(value)) return value;
    }
  }
  return 0;
}

function isAuthExpired(payload) {
  const status = String(payload?.status ?? '').trim().toLowerCase();
  if (status === 'unauthorized' || status === 'login_required') return true;
  const text = [payload?.status, payload?.msg, payload?.message, payload?.error]
    .filter((value) => typeof value === 'string').join(' ');
  return /登录|login|unauthorized|401/i.test(text);
}

function requireOkPayload(payload, statusCode) {
  if (!isObject(payload)) fail('XHH_RESPONSE', { status: statusCode });
  if (payload.status !== 'ok') {
    if (isAuthExpired(payload)) {
      fail('XHH_AUTH', { status: statusCode, apiCode: apiCodeOf(payload) });
    }
    fail('XHH_API', { status: statusCode, apiCode: apiCodeOf(payload) });
  }
  return payload;
}

function normalizeOffset(value, fallback = '0') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  const text = String(value).trim();
  if (!/^(0|[1-9]\d{0,18})$/.test(text)) fail('XHH_RESPONSE');
  return text;
}

function boundedLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(50, Math.floor(parsed)));
}

function explicitBoolean(result, keys, rejectValue = undefined) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    const value = result[key];
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    return rejectValue;
  }
  return undefined;
}

function explicitCursor(result, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    const value = result[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    const text = typeof value === 'string' ? value.trim() : '';
    if (/^(0|[1-9]\d{0,39})$/.test(text) || TOKEN_RE.test(text)) return text;
  }
  return null;
}

function pageOf(result) {
  const hasMoreRaw = explicitBoolean(result, ['has_more', 'hasmore', 'has_next'], null);
  let hasMore = hasMoreRaw === undefined ? null : hasMoreRaw;
  if (hasMoreRaw === null) hasMore = null;
  if (hasMore === null) {
    const noMore = explicitBoolean(result, ['no_more', 'is_end', 'no_more_data'], null);
    if (noMore === true || noMore === false) hasMore = !noMore;
  }
  const complete = hasMore === false;
  return {
    hasMore,
    nextOffset: explicitCursor(result, ['next_offset']),
    nextCursor: explicitCursor(result, ['next_cursor', 'next_seq', 'next']),
    complete,
    limited: !complete,
  };
}

function precisionOf(response) {
  const convertedIntegerCount = Number.isInteger(response?.convertedIntegerCount)
    ? response.convertedIntegerCount : 0;
  return {
    precisionSafe: response?.precisionSafe !== false,
    convertedIntegerCount,
  };
}

function scanNumericTokens(text, visit) {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      let end = index + 1;
      while (end < text.length && /[-+0-9.eE]/.test(text[end])) end += 1;
      const token = text.slice(index, end);
      if (new RegExp(`^${NUMBER_TOKEN_RE.source}$`).test(token)) visit(token);
      index = end - 1;
    }
  }
}

function analyzeJsonNumbers(text) {
  let convertedIntegerCount = 0;
  let precisionSafe = true;
  scanNumericTokens(text, (token) => {
    if (/^-?(?:0|[1-9]\d*)$/.test(token)) {
      if (!Number.isSafeInteger(Number(token))) convertedIntegerCount += 1;
      return;
    }
    if (token.includes('.') || /[eE]/.test(token)) {
      const value = Number(token);
      if (Number.isInteger(value)) precisionSafe = false;
    }
  });
  return { convertedIntegerCount, precisionSafe };
}

function decodeRawResponse(raw, path) {
  const statusCode = Number(raw?.statusCode ?? raw?.status) || 0;
  const headers = raw?.headers || {};
  const serverTime = parseServerTime(headers);
  const retryAfterMs = parseRetryAfter(headerValue(headers, 'retry-after'), { now: Date.now() });

  if (statusCode === 429) {
    fail('XHH_RATE_LIMIT', { status: statusCode, retryAfterMs });
  }
  if (statusCode === 401) {
    fail('XHH_AUTH', { status: statusCode });
  }
  if (statusCode === 403) {
    fail('XHH_CHALLENGE', { status: statusCode, retryAfterMs });
  }
  if (statusCode >= 300 && statusCode < 400) {
    fail('XHH_HTTP', { status: statusCode });
  }
  if (statusCode < 200 || statusCode >= 300) {
    fail('XHH_HTTP', { status: statusCode, retryAfterMs });
  }

  const text = typeof raw?.text === 'string'
    ? raw.text
    : Buffer.isBuffer(raw?.body) ? raw.body.toString('utf8') : '';
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    fail('XHH_RESPONSE', { status: statusCode });
  }

  const analysis = analyzeJsonNumbers(text);
  if (!analysis.precisionSafe) {
    fail('XHH_PRECISION', { status: statusCode });
  }

  let payload;
  try {
    payload = parseLosslessJson(text, { maxBytes: MAX_BODY_BYTES });
  } catch {
    fail('XHH_RESPONSE', { status: statusCode });
  }
  return {
    payload,
    statusCode,
    serverTime,
    setCookies: headerList(headers, 'set-cookie'),
    convertedIntegerCount: analysis.convertedIntegerCount,
    precisionSafe: true,
  };
}

function requestError(error, path, { timedOut = false, aborted = false } = {}) {
  if (error instanceof XhhClientError) return error;
  if (timedOut) return new XhhClientError('XHH_TIMEOUT');
  if (aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return new XhhClientError('XHH_CANCELLED');
  }
  const code = String(error?.code || '');
  if (code && code !== 'ABORT_ERR' && KNOWN_CODES.has(code)) {
    return new XhhClientError(code, {
      status: Number.isFinite(error?.status) ? error.status : 0,
    });
  }
  return new XhhClientError('XHH_NETWORK');
}

function policyError(error) {
  if (error instanceof XhhClientError) return error;
  const code = String(error?.code || '');
  if (code === 'REQUEST_CANCELLED' || error?.name === 'AbortError') {
    return new XhhClientError('XHH_CANCELLED');
  }
  if (code === 'REQUEST_COOLDOWN') {
    return new XhhClientError('XHH_COOLDOWN', {
      retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0,
      nextAllowedAt: Number.isFinite(error?.nextAllowedAt) ? error.nextAllowedAt : null,
      requestPolicyRecorded: true,
    });
  }
  if (code === 'REQUEST_BUDGET') {
    return new XhhClientError('XHH_BUDGET', {
      retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0,
      nextAllowedAt: Number.isFinite(error?.nextAllowedAt) ? error.nextAllowedAt : null,
      requestPolicyRecorded: true,
    });
  }
  if (code === 'REQUEST_DEADLINE') return new XhhClientError('XHH_TIMEOUT');
  if (code === 'REQUEST_POLICY_UNAVAILABLE' || code === 'REQUEST_POLICY_CLOSED') {
    return new XhhClientError('XHH_HTTP');
  }
  return new XhhClientError('XHH_RESPONSE');
}

export function defaultWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new XhhClientError('XHH_CANCELLED'));
      return;
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms) || 0));
    timer.unref?.();
    function onAbort() {
      clearTimeout(timer);
      cleanup();
      reject(new XhhClientError('XHH_CANCELLED'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createLocalScheduler({
  minIntervalMs = 5_000,
  windowMs = 60_000,
  maxPerWindow = 10,
  now = Date.now,
  wait = defaultWait,
} = {}) {
  const interval = Math.max(0, Number(minIntervalMs) || 0);
  const window = Math.max(1, Number(windowMs) || 60_000);
  const limit = Math.max(1, Math.trunc(Number(maxPerWindow) || 10));
  let stamps = [];
  let lastAt = Number.NEGATIVE_INFINITY;
  let tail = Promise.resolve();

  function prune(at) {
    stamps = stamps.filter((stamp) => at - stamp < window);
  }

  function nextAllowedAt(at = now()) {
    const current = Number(at);
    prune(current);
    let next = Number.isFinite(lastAt) ? lastAt + interval : current;
    if (stamps.length >= limit) next = Math.max(next, stamps[stamps.length - limit] + window);
    return Math.max(current, next);
  }

  async function run(task, { signal } = {}) {
    if (signal?.aborted) throw new XhhClientError('XHH_CANCELLED');
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    try {
      await previous.catch(() => {});
      while (true) {
        if (signal?.aborted) throw new XhhClientError('XHH_CANCELLED');
        const current = Number(now());
        const next = nextAllowedAt(current);
        if (current >= next) break;
        await wait(next - current, signal);
      }
      if (signal?.aborted) throw new XhhClientError('XHH_CANCELLED');
      const at = Number(now());
      prune(at);
      stamps.push(at);
      lastAt = at;
      return await task();
    } finally {
      release();
    }
  }

  return { run, nextAllowedAt };
}

export function createXiaoheiheRequestScope(settings, botKey = 'xiaoheihe') {
  if (!settings || typeof settings.getPrivateMessageProviderCredentials !== 'function') {
    throw new TypeError('createXiaoheiheRequestScope requires settings credential API');
  }
  const partition = String(botKey || 'xiaoheihe');

  function storedCredential() {
    try {
      const value = settings.getPrivateMessageProviderCredentials('xiaoheihe');
      return isObject(value) ? value : {};
    } catch {
      return {};
    }
  }

  return async function requestScope(context = {}) {
    const candidateId = normalizeAccountId(context.heyboxId)
      || normalizeAccountId(context.query?.heybox_id);
    const stored = storedCredential();
    const storedId = normalizeAccountId(stored.heyboxId);
    const cookie = typeof context.cookie === 'string' ? context.cookie : '';
    const storedCookie = typeof stored.cookie === 'string' ? stored.cookie : '';
    const accountSeed = candidateId || storedId
      || (cookie ? `cookie:${sha256(cookie)}` : '')
      || (storedCookie ? `cookie:${sha256(storedCookie)}` : 'anonymous');
    const credentialSeed = cookie || (candidateId ? `id:${candidateId}` : '') || storedCookie;
    return {
      providerId: 'xiaoheihe',
      accountKey: `xhh-${sha256(`${partition}:${accountSeed}`).slice(0, 32)}`,
      credentialVersion: credentialSeed
        ? sha256(`${partition}:${credentialSeed}`) : undefined,
      workflowId: context.workflowId,
    };
  };
}

export function normalizeXiaoheiheMessage(raw, { peerId = '', selfId = '' } = {}) {
  const empty = {
    messageId: '',
    seq: '',
    senderId: '',
    sentAt: 0,
    text: '',
    imageUrls: [],
    shareUrls: [],
    valid: false,
    reasonCode: 'INVALID_SHAPE',
  };
  if (!isObject(raw)) return empty;

  const peer = idString(peerId);
  const self = idString(selfId);
  if (!peer) return { ...empty, reasonCode: 'PEER_MISSING' };
  if (hasUnsafeNumberDeep(raw)) return { ...empty, reasonCode: 'UNSAFE_PRECISION' };

  const sender = firstObject(raw.sender, raw.sender_info, raw.user, raw.user_a);
  const senderId = idString(raw.sender_id)
    || idString(raw.from_user_id)
    || idString(raw.from_uid)
    || userIdOf(sender);
  if (!senderId) return { ...empty, reasonCode: 'SENDER_MISSING' };
  if (self && senderId === self) return { ...empty, senderId, reasonCode: 'SENDER_SELF' };
  if (senderId !== peer) return { ...empty, senderId, reasonCode: 'SENDER_MISMATCH' };

  const seq = opaqueIdString(raw.seq) || opaqueIdString(raw.msg_seq)
    || opaqueIdString(raw.sequence);
  const explicitId = opaqueIdString(raw.msg_id)
    || opaqueIdString(raw.message_id)
    || opaqueIdString(raw.id)
    || opaqueIdString(raw._id);
  const messageId = explicitId || seq;
  if (!messageId) {
    return { ...empty, senderId, seq, reasonCode: 'MISSING_STABLE_ID' };
  }

  const sentAt = serverTimeOf(raw);
  if (sentAt === null) {
    return {
      ...empty, messageId, seq, senderId, reasonCode: 'INVALID_SERVER_TIME',
    };
  }

  const text = textFieldOf(raw);
  const imageUrls = collectImageUrls(raw);
  const shareUrls = collectShareUrls(raw);
  const valid = Boolean(text || imageUrls.length || shareUrls.length);
  return {
    messageId,
    seq,
    senderId,
    sentAt,
    text,
    imageUrls,
    shareUrls,
    valid,
    reasonCode: valid ? '' : 'EMPTY_CONTENT',
  };
}

function textFieldOf(message) {
  for (const name of ['content', 'msg', 'text', 'message']) {
    if (typeof message[name] === 'string') return message[name];
  }
  return '';
}

function serverTimeValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^-?\d{1,16}$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function serverTimeOf(message) {
  for (const name of ['send_time', 'timestamp', 'time', 'update_time', 'created_at', 'create_time']) {
    const value = serverTimeValue(message[name]);
    if (value === null) continue;
    if (value >= MIN_SERVER_MS && value <= MAX_SERVER_MS) return value;
    if (value >= MIN_SERVER_SECONDS && value <= MAX_SERVER_SECONDS) return value * 1000;
  }
  return null;
}

function hasUnsafeNumberDeep(value, depth = 0) {
  if (depth > 8) return false;
  if (typeof value === 'number') return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (!isObject(value) && !Array.isArray(value)) return false;
  if (Array.isArray(value)) return value.some((item) => hasUnsafeNumberDeep(item, depth + 1));
  return Object.values(value).some((item) => hasUnsafeNumberDeep(item, depth + 1));
}

function pushUrl(out, seen, value) {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (!text || text.length > 2048 || /[\u0000-\u001f\u007f]/.test(text)) return;
  let parsed;
  try { parsed = new URL(text); } catch { return; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
  if (parsed.username || parsed.password) return;
  const href = parsed.href;
  if (seen.has(href)) return;
  seen.add(href);
  out.push(href);
}

function collectUrls(value, out, seen, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    pushUrl(out, seen, value);
    for (const match of value.matchAll(/https?:\/\/[^\s,;|"'<>()]+/gi)) {
      pushUrl(out, seen, match[0].replace(/[，。,.；;]+$/, ''));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out, seen, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  for (const key of ['url', 'src', 'href', 'image', 'img', 'origin_url', 'share_url']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectUrls(value[key], out, seen, depth + 1);
    }
  }
}

function uniqueUrls(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) collectUrls(value, out, seen);
  return out;
}

function collectImageUrls(message) {
  return uniqueUrls([
    message.img, message.imgs, message.image, message.images, message.content,
  ]);
}

function collectShareUrls(message) {
  return uniqueUrls([
    message.share_url, message.link_url, message.url,
    message.link, message.share, message.card,
  ]);
}

export function createXiaoheiheClient({
  requestPolicy = null,
  requestScope = null,
  now = Date.now,
  random = Math.random,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requestImpl = null,
  transport = null,
  onDiagnostic = null,
  deviceId = randomUUID().replace(/-/g, ''),
  requestMinIntervalMs = 5_000,
  requestWindowMs = 60_000,
  requestMaxPerWindow = 10,
  wait = defaultWait,
  scheduler = null,
} = {}) {
  const injected = typeof requestImpl === 'function';
  if (requestPolicy !== null && typeof requestPolicy?.run !== 'function') {
    throw new TypeError('requestPolicy must expose run');
  }
  if (requestPolicy !== null && requestScope === null) {
    throw new TypeError('requestScope is required when requestPolicy is supplied');
  }
  if (requestPolicy === null && !injected) {
    throw new TypeError('production createXiaoheiheClient requires requestPolicy');
  }
  if (requestPolicy === null && scheduler === null && !injected) {
    throw new TypeError('local scheduler is only available with an injected requestImpl');
  }

  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? Math.floor(value) : Date.now();
  };
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const nativeTransport = injected ? null
    : (transport && typeof transport.request === 'function'
      ? transport : createXiaoheiheTransport({ maxBodyBytes: MAX_BODY_BYTES }));
  const performRequest = injected ? requestImpl : nativeTransport.request;
  const observer = typeof onDiagnostic === 'function' ? onDiagnostic : null;
  const DIAGNOSTIC_OPERATIONS = new Set(['request', 'headers', 'complete', 'error']);
  const DIAGNOSTIC_TRANSPORTS = new Set(['node', 'electron']);
  const DIAGNOSTIC_STAGES = new Set([
    'select', 'headers', 'body', 'complete', 'timeout', 'cancel', 'error',
  ]);

  function emitDiagnostic(fields) {
    if (!observer) return;
    try {
      const event = {};
      if (DIAGNOSTIC_OPERATIONS.has(fields?.operation)) {
        event.operation = fields.operation;
      } else {
        return;
      }
      if (DIAGNOSTIC_TRANSPORTS.has(fields?.transport)) {
        event.transport = fields.transport;
      } else {
        return;
      }
      if (DIAGNOSTIC_STAGES.has(fields?.networkStage)) {
        event.networkStage = fields.networkStage;
      } else {
        return;
      }
      if (Number.isFinite(fields.elapsedMs)) {
        event.elapsedMs = Math.max(0, Math.floor(fields.elapsedMs));
      }
      if (Number.isFinite(fields.bytes)) {
        event.bytes = Math.max(0, Math.floor(fields.bytes));
      }
      if (Number.isFinite(fields.status)) {
        event.status = Math.floor(fields.status);
      }
      if (typeof fields.errorCode === 'string' && KNOWN_CODES.has(fields.errorCode)) {
        event.errorCode = fields.errorCode;
      }
      const result = observer({ ...event });
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch { /* diagnostics never change HTTP behavior */ }
  }

  const localScheduler = scheduler || createLocalScheduler({
    minIntervalMs: requestMinIntervalMs,
    windowMs: requestWindowMs,
    maxPerWindow: requestMaxPerWindow,
    now: clock,
    wait,
  });

  async function resolveScope(context) {
    let scope = requestScope;
    if (typeof scope === 'function') {
      try { scope = await scope(context); } catch { fail('XHH_RESPONSE'); }
    }
    if (!isObject(scope) || scope.providerId !== 'xiaoheihe'
      || typeof scope.accountKey !== 'string' || !scope.accountKey) {
      fail('XHH_RESPONSE');
    }
    return scope;
  }

  function requestKeyFor(path, params) {
    const stable = Object.entries(params)
      .filter(([key, value]) => !['hkey', '_time', 'nonce'].includes(key)
        && value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [String(key), String(value)])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `${path}#${sha256(stable.map(([key, value]) => `${key}=${value}`).join('&')).slice(0, 32)}`;
  }

  async function requestWithDeadline(url, {
    path, cookie, signal, expiresAt,
  }) {
    const current = clock();
    let remaining = timeout;
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
      const untilExpiry = expiresAt - current;
      if (untilExpiry <= 0) fail('XHH_TIMEOUT');
      remaining = Math.min(remaining, untilExpiry);
    }
    const controller = new AbortController();
    if (signal?.aborted) fail('XHH_CANCELLED');
    let timedOut = false;
    let cleanup = () => {};
    const fence = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new XhhClientError('XHH_TIMEOUT'));
      }, Math.max(1, Math.floor(remaining)));
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        controller.abort();
        reject(new XhhClientError('XHH_CANCELLED'));
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
    });
    const headers = {
      Accept: 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Referer: 'https://www.xiaoheihe.cn/',
      Origin: 'https://www.xiaoheihe.cn',
    };
    if (cookie) headers.Cookie = cookie;
    const startedAt = clock();
    let activeTransport = 'node';
    let startEmitted = false;
    let diagnosticsOpen = true;
    const emitStart = (kind) => {
      if (!diagnosticsOpen || startEmitted) return;
      startEmitted = true;
      activeTransport = DIAGNOSTIC_TRANSPORTS.has(kind) ? kind : 'node';
      emitDiagnostic({
        operation: 'request',
        transport: activeTransport,
        networkStage: 'select',
        elapsedMs: clock() - startedAt,
      });
    };
    if (injected) emitStart('node');
    const requestOptions = {
      method: 'GET', headers, signal: controller.signal, path, timeoutMs: timeout,
    };
    if (!injected) {
      requestOptions.onTransport = emitStart;
      requestOptions.onHeaders = (info) => {
        if (!diagnosticsOpen) return;
        emitStart(activeTransport);
        emitDiagnostic({
          operation: 'headers',
          transport: activeTransport,
          networkStage: 'headers',
          elapsedMs: clock() - startedAt,
          status: Number(info?.statusCode),
        });
      };
    }
    const pending = Promise.resolve().then(() => performRequest(url, requestOptions));
    pending.catch(() => {});
    try {
      const raw = await Promise.race([pending, fence]);
      emitStart(activeTransport);
      emitDiagnostic({
        operation: 'complete',
        transport: activeTransport,
        networkStage: 'complete',
        elapsedMs: clock() - startedAt,
        bytes: Buffer.byteLength(typeof raw?.text === 'string' ? raw.text : '', 'utf8'),
        status: Number(raw?.statusCode),
      });
      diagnosticsOpen = false;
      return raw;
    } catch (error) {
      const mapped = requestError(error, path, {
        timedOut, aborted: signal?.aborted === true,
      });
      emitDiagnostic({
        operation: 'error',
        transport: activeTransport,
        networkStage: mapped.code === 'XHH_TIMEOUT' ? 'timeout'
          : mapped.code === 'XHH_CANCELLED' ? 'cancel' : 'error',
        elapsedMs: clock() - startedAt,
        status: Number(mapped.status),
        errorCode: mapped.code,
      });
      diagnosticsOpen = false;
      throw mapped;
    } finally {
      diagnosticsOpen = false;
      cleanup();
    }
  }

  async function localDeadlineError(error, {
    scope, kind, expiresAt,
  }) {
    const mapped = policyError(error);
    if (String(error?.code || '') !== 'REQUEST_DEADLINE') return mapped;
    if (mapped.code !== 'XHH_TIMEOUT') return mapped;
    if (!Number.isFinite(expiresAt) || expiresAt <= clock()) return mapped;
    if (!requestPolicy || typeof requestPolicy.status !== 'function') return mapped;
    let status;
    try {
      status = await requestPolicy.status({
        providerId: 'xiaoheihe',
        accountKey: scope.accountKey,
        ...(scope.credentialVersion === undefined || scope.credentialVersion === null
          ? {} : { credentialVersion: scope.credentialVersion }),
        ...(scope.workflowId === undefined || scope.workflowId === null
          ? {} : { workflowId: scope.workflowId }),
        kind,
        expiresAt,
      });
    } catch {
      return mapped;
    }
    if (!isObject(status)) return mapped;
    const nextAllowedAt = Number.isFinite(status.nextAllowedAt)
      ? Math.floor(status.nextAllowedAt)
      : Number.isFinite(status.serverNextAllowedAt)
        ? Math.floor(status.serverNextAllowedAt) : null;
    const retryAfterMs = nextAllowedAt === null
      ? 0 : Math.max(0, nextAllowedAt - clock());
    const cooldownProven = status.paused === true && (
      Boolean(status.cooldownReason)
      || status.requiresManualRecovery === true
      || Number.isFinite(status.serverNextAllowedAt)
    );
    if (cooldownProven) {
      return new XhhClientError('XHH_COOLDOWN', {
        retryAfterMs,
        nextAllowedAt,
        requestPolicyRecorded: true,
      });
    }
    const budget = isObject(status.budget) ? status.budget : null;
    const totalExhausted = budget !== null
      && Number.isFinite(budget.totalUsed) && Number.isFinite(budget.totalLimit)
      && budget.totalLimit > 0 && budget.totalUsed >= budget.totalLimit;
    const dataExhausted = budget !== null && kind === 'data'
      && Number.isFinite(budget.dataUsed) && Number.isFinite(budget.dataLimit)
      && budget.dataLimit > 0 && budget.dataUsed >= budget.dataLimit;
    if (totalExhausted || dataExhausted) {
      return new XhhClientError('XHH_BUDGET', {
        retryAfterMs,
        nextAllowedAt,
        requestPolicyRecorded: true,
      });
    }
    return mapped;
  }

  async function perform(path, {
    params = {}, cookie = '', signal, expiresAt, workflowId, kind = 'data', validate = null,
  }, handler) {
    if (!ALLOWED_PATHS.has(path)) fail('XHH_RESPONSE');
    const makeParams = typeof params === 'function' ? params : () => params;
    const effective = makeParams();
    const requestKey = requestKeyFor(path, effective);
    const task = async (requestSignal) => {
      if (typeof validate === 'function') validate();
      const finalParams = makeParams();
      const url = buildUrl(path, finalParams);
      const raw = await requestWithDeadline(url, {
        path, cookie, signal: requestSignal, expiresAt,
      });
      return handler(decodeRawResponse(raw, path));
    };

    if (requestPolicy !== null) {
      const scope = await resolveScope({
        path,
        cookie,
        query: effective,
        kind,
        requestKey,
        workflowId,
        heyboxId: effective.heybox_id,
      });
      const credentialVersion = scope.credentialVersion !== undefined
        && scope.credentialVersion !== null
        ? scope.credentialVersion : cookie ? sha256(cookie) : undefined;
      try {
        return await requestPolicy.run({
          providerId: 'xiaoheihe',
          accountKey: scope.accountKey,
          credentialVersion,
          workflowId: workflowId !== undefined && workflowId !== null
            ? workflowId : scope.workflowId,
          requestKey,
          kind,
          signal,
          expiresAt,
        }, async (policySignal) => task(policySignal || signal));
      } catch (error) {
        throw await localDeadlineError(error, { scope, kind, expiresAt });
      }
    }

    try {
      return await localScheduler.run(() => task(signal), { signal });
    } catch (error) {
      throw policyError(error);
    }
  }

  function signParams(path) {
    return createSignedParams(path, {
      nowSeconds: Math.floor(clock() / 1000),
      random,
    });
  }

  return {
    async requestQr({ signal, expiresAt, workflowId } = {}) {
      return perform(PATHS.qrRequest, {
        params: { app: 'web', _notip: 'true' },
        signal,
        expiresAt,
        workflowId,
        kind: 'control',
      }, ({ payload, statusCode, serverTime, setCookies }) => {
        requireOkPayload(payload, statusCode);
        const result = asObject(payload.result);
        const qrContent = typeof result.qr_url === 'string' ? result.qr_url.trim() : '';
        if (!qrContent) fail('XHH_QR', { status: statusCode, apiCode: apiCodeOf(payload) });
        let parsed;
        try { parsed = new URL(qrContent); } catch { fail('XHH_QR', { status: statusCode }); }
        const hostname = parsed.hostname.toLowerCase();
        const allowedHost = hostname === 'xiaoheihe.cn' || hostname.endsWith('.xiaoheihe.cn');
        const allowedPort = !parsed.port || parsed.port === '443';
        if (parsed.protocol !== 'https:' || !allowedHost || !allowedPort
          || parsed.username || parsed.password) {
          fail('XHH_QR', { status: statusCode });
        }
        const qrId = parsed.searchParams.get('qr') || '';
        if (!tokenString(qrId)) fail('XHH_QR', { status: statusCode });
        const rawExpiry = Number(result.expire ?? result.expires_in ?? 120);
        let ttl = Number.isFinite(rawExpiry) ? rawExpiry : 120;
        if (ttl > 10_000_000_000) ttl = (ttl - clock()) / 1000;
        ttl = Math.max(10, Math.min(ttl, 600));
        return {
          qrContent,
          qrId,
          pollParams: { qr: qrId, app: 'web' },
          expiresAt: clock() + ttl * 1000,
          cookies: parseSetCookie({ getSetCookie: () => setCookies }),
          serverTime,
        };
      });
    },

    async pollQr(session, { signal, expiresAt, workflowId } = {}) {
      if (!isObject(session) || !isObject(session.pollParams)
        || !tokenString(session.pollParams.qr)) {
        fail('XHH_QR');
      }
      const current = clock();
      const sessionExpiry = Number.isFinite(session.expiresAt) ? session.expiresAt : Infinity;
      const deadline = Number.isFinite(expiresAt) ? Math.min(sessionExpiry, expiresAt) : sessionExpiry;
      if (Number.isFinite(deadline) && current >= deadline) {
        return { state: 'expired', cookies: { ...(session.cookies || {}) }, serverTime: null };
      }
      return perform(PATHS.qrPoll, {
        params: { qr: String(session.pollParams.qr), app: 'web' },
        cookie: cookieHeader(session.cookies || {}),
        signal,
        expiresAt: Number.isFinite(deadline) ? deadline : expiresAt,
        workflowId,
        kind: 'control',
      }, ({ payload, statusCode, serverTime, setCookies }) => {
        const merged = { ...(session.cookies || {}), ...parseSetCookie({ getSetCookie: () => setCookies }) };
        session.cookies = merged;
        requireOkPayload(payload, statusCode);
        const result = asObject(payload.result);
        const rawState = String(result.error || 'wait').trim().toLowerCase();
        if (rawState === 'wait') return { state: 'waiting', cookies: merged, serverTime };
        if (rawState === 'ready') return { state: 'scanned', cookies: merged, serverTime };
        if (['cancel', 'canceled', 'denied'].includes(rawState)) {
          return { state: 'denied', cookies: merged, serverTime };
        }
        if (['timeout', 'expired'].includes(rawState)) {
          return { state: 'expired', cookies: merged, serverTime };
        }
        if (rawState !== 'ok') {
          return { state: 'failed', cookies: merged, serverTime };
        }
        const login = loginCookies(merged);
        if (!hasPrimaryCredential(login)) {
          return { state: 'failed', reasonCode: 'qr_credential_missing', cookies: merged, serverTime };
        }
        const heyboxId = resolveAccountId(result, login);
        if (!heyboxId) {
          return { state: 'failed', reasonCode: 'qr_account_missing', cookies: merged, serverTime };
        }
        const accountDetail = asObject(result.account_detail);
        const levelInfo = asObject(accountDetail.level_info);
        return {
          state: 'success',
          cookie: loginCookieString(login),
          heyboxId,
          nickname: safeText(result.nickname),
          level: safeText(result.level || levelInfo.level, 16),
          cookies: merged,
          serverTime,
        };
      });
    },

    async checkAuthEndpoint({ cookie, heyboxId, signal, expiresAt, workflowId } = {}) {
      const required = sanitizeCookieValue(cookie);
      const id = normalizeAccountId(heyboxId);
      return perform(PATHS.authCheck, {
        params: () => ({
          ...commonParams(id, deviceId),
          ...signParams(PATHS.authCheck),
          list_type: '0',
          offset: '0',
          limit: '1',
          message_type: '16',
          heybox_id: id,
        }),
        cookie: required,
        signal,
        expiresAt,
        workflowId,
        kind: 'control',
        validate: () => {
          if (!required || !/(?:^|;\s*)user_pkey=/.test(required)) fail('XHH_AUTH');
          if (!id) fail('XHH_AUTH');
        },
      }, ({ payload, statusCode, serverTime, convertedIntegerCount, precisionSafe }) => {
        requireOkPayload(payload, statusCode);
        const result = payload.result;
        if (!isObject(result)) fail('XHH_RESPONSE', { status: statusCode });
        const messages = Array.isArray(result.messages)
          ? result.messages
          : Array.isArray(result.message) ? result.message : null;
        if (!messages) {
          if (isAuthExpired(result)) fail('XHH_AUTH', { status: statusCode });
          fail('XHH_API', { status: statusCode, apiCode: apiCodeOf(payload) });
        }
        return {
          authEndpointAccepted: true,
          messageCount: messages.length,
          serverTime,
          ...precisionOf({ convertedIntegerCount, precisionSafe }),
        };
      });
    },

    async listConversations(kind, {
      cookie, heyboxId, offset = '0', limit = 20, signal, expiresAt, workflowId,
    } = {}) {
      if (kind !== 'normal' && kind !== 'stranger') fail('XHH_RESPONSE');
      const required = sanitizeCookieValue(cookie);
      const id = normalizeAccountId(heyboxId);
      const path = kind === 'stranger' ? PATHS.strangerConversations : PATHS.normalConversations;
      const boundedOffset = normalizeOffset(offset);
      const bounded = boundedLimit(limit, 20);
      const params = () => {
        const base = {
          ...commonParams(id, deviceId),
          ...signParams(path),
          offset: boundedOffset,
          limit: String(bounded),
          heybox_id: id,
        };
        if (kind === 'normal') base.list_type = '2';
        return base;
      };
      return perform(path, {
        params,
        cookie: required,
        signal,
        expiresAt,
        workflowId,
        kind: 'data',
        validate: () => {
          if (!required || !/(?:^|;\s*)user_pkey=/.test(required)) fail('XHH_AUTH');
          if (!id) fail('XHH_AUTH');
        },
      }, ({ payload, statusCode, serverTime, convertedIntegerCount, precisionSafe }) => {
        requireOkPayload(payload, statusCode);
        const result = asObject(payload.result);
        return {
          entries: extractConversationEntries(payload, kind),
          shape: conversationPayloadShape(payload, kind),
          serverTime,
          page: pageOf(result),
          ...precisionOf({ convertedIntegerCount, precisionSafe }),
        };
      });
    },

    async fetchDirectMessages(peerId, {
      cookie, heyboxId, offset = '0', seq = null, limit = 30, signal, expiresAt, workflowId,
    } = {}) {
      const required = sanitizeCookieValue(cookie);
      const id = normalizeAccountId(heyboxId);
      const target = idString(peerId);
      if (!target) fail('XHH_RESPONSE');
      const boundedOffset = normalizeOffset(offset);
      const bounded = boundedLimit(limit, 30);
      const seqValue = tokenString(seq);
      const params = () => {
        const base = {
          ...commonParams(id, deviceId),
          ...signParams(PATHS.directMessages),
          to_user_id: target,
          offset: boundedOffset,
          limit: String(bounded),
          heybox_id: id,
        };
        if (seqValue) base.seq = seqValue;
        return base;
      };
      return perform(PATHS.directMessages, {
        params,
        cookie: required,
        signal,
        expiresAt,
        workflowId,
        kind: 'data',
        validate: () => {
          if (!required || !/(?:^|;\s*)user_pkey=/.test(required)) fail('XHH_AUTH');
          if (!id) fail('XHH_AUTH');
          if (!target) fail('XHH_RESPONSE');
        },
      }, ({ payload, statusCode, serverTime, convertedIntegerCount, precisionSafe }) => {
        requireOkPayload(payload, statusCode);
        const result = payload.result;
        if (!isObject(result) || !Array.isArray(result.list)) {
          fail('XHH_RESPONSE', { status: statusCode });
        }
        return {
          messages: result.list,
          shape: directPayloadShape(payload),
          serverTime,
          page: pageOf(result),
          ...precisionOf({ convertedIntegerCount, precisionSafe }),
        };
      });
    },
  };
}
