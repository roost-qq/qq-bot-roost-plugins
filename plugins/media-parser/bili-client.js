/**
 * Minimal, allowlisted Bilibili web client for QR login and private messages.
 *
 * Only fixed HTTPS endpoints are constructed here. No read/ack/send mutation
 * calls and no `new_sessions` shortcut are implemented until live protocol
 * completeness is proven. Server text, URLs, cookies and QR keys never appear
 * in errors or logs; callers receive finite error categories and safe Chinese
 * summaries only.
 */

import { createHash } from 'node:crypto';
import { parseRetryAfter as parseRetryAfterHeader } from './private-message-request-policy.js';

const ENDPOINTS = Object.freeze({
  qrGenerate: ['passport.bilibili.com', '/x/passport-login/web/qrcode/generate'],
  qrPoll: ['passport.bilibili.com', '/x/passport-login/web/qrcode/poll'],
  nav: ['api.bilibili.com', '/x/web-interface/nav'],
  sessions: ['api.vc.bilibili.com', '/session_svr/v1/session_svr/get_sessions'],
  messages: ['api.vc.bilibili.com', '/svr_sync/v1/svr_sync/fetch_session_msgs'],
});

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const COOKIE_KEYS = Object.freeze(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']);
const COOKIE_KEY_SET = new Set(COOKIE_KEYS);
const COOKIE_MAX = 8192;
const COOKIE_VALUE_MAX = 4096;
const CONTROL_OR_SEMICOLON = /[\u0000-\u001f\u007f;]/;
const QR_URL_MAX = 2048;
const QR_LOGIN_PATHS = Object.freeze([
  ['passport.bilibili.com', '/h5-app/passport/login/scan'],
  ['account.bilibili.com', '/h5/account-h5/auth/scan-web'],
]);
const ID_RE = /^(0|[1-9]\d{0,39})$/;
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const VOLATILE_QUERY_KEYS = new Set(['sign', 'signature', 'ts', 'timestamp', 'nonce', 'w_rid', 'wts']);

export const SAFE_MESSAGES = Object.freeze({
  BILI_CANCELLED: '请求已取消',
  BILI_NETWORK: '无法连接 B 站',
  BILI_TIMEOUT: '请求 B 站超时',
  BILI_HTTP: 'B 站服务暂时不可用',
  BILI_RATE_LIMIT: '请求过于频繁，请稍后重试',
  BILI_RESPONSE: 'B 站返回了无法识别的数据',
  BILI_AUTH: 'B 站账号未登录或登录已失效',
  BILI_COOKIE: '登录成功但未取得有效 Cookie',
  BILI_STORAGE: '登录成功但 Cookie 保存失败，请稍后重试',
  BILI_API: 'B 站拒绝了请求',
  BILI_RISK: 'B 站拒绝了请求，请稍后再试',
});

export class BiliClientError extends Error {
  constructor(code = 'BILI_RESPONSE', message = SAFE_MESSAGES.BILI_RESPONSE, options = {}) {
    super(message || SAFE_MESSAGES[code] || SAFE_MESSAGES.BILI_RESPONSE);
    this.name = 'BiliClientError';
    this.code = code;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? Math.max(0, options.retryAfterMs) : 0;
    this.status = Number.isFinite(options.status) ? options.status : 0;
    this.apiCode = Number.isFinite(options.apiCode) ? options.apiCode : 0;
  }
}

function fail(code, options) {
  throw new BiliClientError(code, SAFE_MESSAGES[code], options);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cookieFingerprint(cookie) {
  return createHash('sha256').update(String(cookie)).digest('hex');
}

/**
 * Parse JSON without losing integer precision. Integer literals outside the
 * JavaScript safe range become canonical decimal strings. Fraction/exponent
 * literals that evaluate to an integer are preserved as their raw token so ID
 * consumers fail closed instead of receiving a rounded safe integer. Other
 * fractional numbers stay numbers.
 */
export function parseLosslessJson(text, {
  maxDepth = 64, maxNodes = 20000, maxChars = 2 * 1024 * 1024, maxBytes,
} = {}) {
  const byteLimit = Math.max(0, Math.floor(Number.isFinite(maxBytes) ? maxBytes : maxChars));
  const source = String(text);
  if (Buffer.byteLength(source, 'utf8') > byteLimit) fail('BILI_RESPONSE');
  let index = 0;
  let nodes = 0;

  const bad = () => fail('BILI_RESPONSE');

  const skip = () => {
    while (index < source.length) {
      const code = source.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index += 1;
      else break;
    }
  };

  const parseString = () => {
    if (source[index] !== '"') bad();
    index += 1;
    let out = '';
    while (index < source.length) {
      const ch = source[index];
      index += 1;
      if (ch === '"') return out;
      if (ch === '\\') {
        if (index >= source.length) bad();
        const esc = source[index];
        index += 1;
        if (esc === '"' || esc === '\\' || esc === '/') out += esc;
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else if (esc === 'u') {
          if (index + 4 > source.length) bad();
          const hex = source.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad();
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else bad();
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) bad();
      out += ch;
    }
    return bad();
  };

  const parseNumber = () => {
    NUMBER_RE.lastIndex = index;
    const match = NUMBER_RE.exec(source);
    if (!match) bad();
    const token = match[0];
    index += token.length;
    if (!token.includes('.') && !/[eE]/.test(token)) {
      if (token.replace('-', '').length > 128) bad();
      const big = BigInt(token);
      if (big >= MIN_SAFE && big <= MAX_SAFE) return Number(token);
      return token;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) bad();
    // Any fraction/exponent lexical form that lands on an integer is kept as
    // its raw token. Returning the rounded Number would let
    // 10000000000000001e-16 masquerade as canonical ID 1.
    if (Number.isInteger(value)) return token;
    return value;
  };

  const parseValue = (depth) => {
    nodes += 1;
    if (depth > maxDepth || nodes > maxNodes) bad();
    skip();
    const ch = source[index];
    if (ch === '"') return parseString();
    if (ch === '{') {
      index += 1;
      const out = {};
      const seen = new Set();
      skip();
      if (source[index] === '}') { index += 1; return out; }
      while (index < source.length) {
        skip();
        const key = parseString();
        if (UNSAFE_KEYS.has(key) || seen.has(key)) bad();
        seen.add(key);
        skip();
        if (source[index] !== ':') bad();
        index += 1;
        out[key] = parseValue(depth + 1);
        skip();
        if (source[index] === ',') { index += 1; continue; }
        if (source[index] === '}') { index += 1; return out; }
        bad();
      }
      return bad();
    }
    if (ch === '[') {
      index += 1;
      const out = [];
      skip();
      if (source[index] === ']') { index += 1; return out; }
      while (index < source.length) {
        out.push(parseValue(depth + 1));
        skip();
        if (source[index] === ',') { index += 1; continue; }
        if (source[index] === ']') { index += 1; return out; }
        bad();
      }
      return bad();
    }
    if (source.startsWith('true', index)) { index += 4; return true; }
    if (source.startsWith('false', index)) { index += 5; return false; }
    if (source.startsWith('null', index)) { index += 4; return null; }
    return parseNumber();
  };

  const value = parseValue(0);
  skip();
  if (index !== source.length) bad();
  return value;
}

/** Normalize a Bilibili numeric identifier into a canonical decimal string. */
export function canonicalId(value) {
  if (typeof value === 'string') {
    if (!ID_RE.test(value)) fail('BILI_RESPONSE');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('BILI_RESPONSE');
    return String(value);
  }
  return fail('BILI_RESPONSE');
}

function canonicalCounter(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('BILI_RESPONSE');
    return String(value);
  }
  if (typeof value === 'string') {
    if (!/^(0|[1-9]\d{0,39})$/.test(value)) fail('BILI_RESPONSE');
    return value;
  }
  return fail('BILI_RESPONSE');
}

/**
 * `has_more` must be an explicit 0/1 or boolean. Missing/unknown values would
 * otherwise silently complete a baseline or stop cursor advancement.
 */
function pageHasMore(value) {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return fail('BILI_RESPONSE');
}

/** Only a documented explicit null (empty page) or an array is a valid list. */
function pageList(value) {
  if (value === null) return null;
  if (!Array.isArray(value)) fail('BILI_RESPONSE');
  return value;
}

function optionalList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('BILI_RESPONSE');
  return value;
}

function qrLoginUrl(raw, key) {
  if (typeof raw !== 'string' || !raw || raw.length > QR_URL_MAX) fail('BILI_RESPONSE');
  let parsed;
  try { parsed = new URL(raw); } catch { fail('BILI_RESPONSE'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.port || parsed.hash) fail('BILI_RESPONSE');
  const allowed = QR_LOGIN_PATHS.some(([host, path]) => parsed.hostname === host && parsed.pathname === path);
  if (!allowed) fail('BILI_RESPONSE');
  const linkedKey = parsed.searchParams.get('qrcode_key');
  if (linkedKey !== null && linkedKey !== key) fail('BILI_RESPONSE');
  return raw;
}

function cookieHeader(cookie) {
  const value = String(cookie ?? '').trim();
  if (!value || value.length > COOKIE_MAX || /[\0\r\n]/.test(value) || !/(?:^|;\s*)SESSDATA=/.test(value)) {
    fail('BILI_AUTH');
  }
  return value;
}

function headerValue(headers, name) {
  try {
    const value = headers?.get?.(name);
    return value === undefined || value === null ? '' : String(value);
  } catch {
    return '';
  }
}

function serverTime(headers) {
  const at = Date.parse(headerValue(headers, 'date'));
  return Number.isFinite(at) ? at : null;
}

function cancelBody(response) {
  try { response?.body?.cancel?.()?.catch?.(() => {}); } catch { /* ignore */ }
}

function cookieValueOk(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= COOKIE_VALUE_MAX && !CONTROL_OR_SEMICOLON.test(value);
}

function setCookieLines(headers) {
  try {
    if (typeof headers?.getSetCookie === 'function') {
      const lines = headers.getSetCookie();
      return Array.isArray(lines) ? lines : [];
    }
    return headerValue(headers, 'set-cookie').split(/,(?=[^;]+=)/);
  } catch {
    return [];
  }
}

function extractCookies(headers, callbackUrl) {
  const found = new Map();
  const lines = setCookieLines(headers);
  for (const line of lines) {
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (COOKIE_KEY_SET.has(name) && cookieValueOk(value)) found.set(name, value);
  }

  // Some runtimes combine repeated Set-Cookie headers into one string. Pull the
  // allowlisted primary cookies out of that combined value without touching
  // attributes or unrelated cookies.
  const combined = lines.map((line) => String(line)).join('\n');
  const pattern = /(?:^|[;,\n]\s*)(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|sid)=([^;,\r\n]+)/g;
  for (const match of combined.matchAll(pattern)) {
    const value = match[2].trim();
    if (cookieValueOk(value) && !found.has(match[1])) found.set(match[1], value);
  }

  if (callbackUrl) {
    try {
      const url = new URL(callbackUrl);
      const fixed = url.protocol === 'https:' && !url.username && !url.password && !url.port
        && !url.hash && url.hostname === 'passport.biligame.com' && url.pathname === '/crossDomain';
      if (fixed) {
        for (const [key, value] of url.searchParams) {
          if (COOKIE_KEY_SET.has(key) && cookieValueOk(value) && !found.has(key)) found.set(key, value);
        }
      }
    } catch { /* the callback URL is an optional fallback */ }
  }

  if (!found.get('SESSDATA')) return '';
  const cookie = COOKIE_KEYS.filter((key) => found.has(key)).map((key) => `${key}=${found.get(key)}`).join('; ');
  return cookie.length <= COOKIE_MAX ? cookie : '';
}

function apiFailure(payload) {
  const code = Number(payload?.code);
  if (code === -101) fail('BILI_AUTH', { apiCode: code });
  if (code === -412) fail('BILI_RISK', { apiCode: code });
  fail('BILI_API', { apiCode: Number.isFinite(code) ? code : 0 });
}

function expectPayload(value) {
  if (!isObject(value) || typeof value.code !== 'number' || !Number.isInteger(value.code)) fail('BILI_RESPONSE');
  return value;
}

function requestKeyFor(endpoint, query) {
  const [, requestPath] = endpoint;
  const parts = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (VOLATILE_QUERY_KEYS.has(String(key))) continue;
    parts.push([String(key), String(value)]);
  }
  parts.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `${requestPath}?${parts
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')}`;
}

export function createBiliClient({
  fetchImpl = fetch, timeoutMs = 10_000, maxBytes = 2 * 1024 * 1024,
  requestPolicy = null, requestScope = null,
} = {}) {
  const timeout = Math.max(1, Number(timeoutMs) || 10_000);
  const limit = Math.max(1, Number(maxBytes) || 2 * 1024 * 1024);
  if (typeof fetchImpl !== 'function') throw new TypeError('createBiliClient requires fetch');
  if (requestPolicy !== null && typeof requestPolicy?.run !== 'function') {
    throw new TypeError('requestPolicy must expose run');
  }
  if (requestPolicy !== null && requestScope === null) {
    throw new TypeError('requestScope is required when requestPolicy is supplied');
  }

  function raceFence(promise, { deadline, signal, controller }) {
    let timer;
    let abort;
    const fence = new Promise((_, reject) => {
      const remaining = deadline - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        controller.abort();
        reject(new BiliClientError('BILI_TIMEOUT', SAFE_MESSAGES.BILI_TIMEOUT));
        return;
      }
      timer = setTimeout(() => {
        controller.abort();
        reject(new BiliClientError('BILI_TIMEOUT', SAFE_MESSAGES.BILI_TIMEOUT));
      }, remaining);
      if (signal) {
        abort = () => reject(new BiliClientError('BILI_CANCELLED', SAFE_MESSAGES.BILI_CANCELLED));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
    });
    promise.catch(() => {});
    return Promise.race([promise, fence]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  }

  async function requestDirect(endpoint, { query = {}, cookie = '', signal } = {}) {
    const [host, path] = endpoint;
    const url = new URL(`https://${host}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    if (signal?.aborted) fail('BILI_CANCELLED');

    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    const deadline = Date.now() + timeout;
    const headers = {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      referer: 'https://www.bilibili.com/',
      origin: 'https://www.bilibili.com',
    };
    if (cookie) headers.cookie = cookieHeader(cookie);

    let response;
    try {
      const pending = Promise.resolve().then(() => fetchImpl(url.href, {
        method: 'GET', redirect: 'error', signal: controller.signal, headers,
      }));
      response = await raceFence(pending, { deadline, signal, controller });
    } catch (error) {
      signal?.removeEventListener('abort', abort);
      if (error instanceof BiliClientError) throw error;
      if (signal?.aborted) fail('BILI_CANCELLED');
      fail('BILI_NETWORK');
    }

    let responseHeaders = null;
    try { responseHeaders = response.headers; } catch { /* header accessors are untrusted */ }
    const retryAfterMs = responseHeaders
      ? parseRetryAfterHeader(headerValue(responseHeaders, 'retry-after'), { now: Date.now() })
      : 0;
    let status = 0;
    try { status = Number(response.status) || 0; } catch { /* keep zero */ }
    let ok = false;
    try { ok = response.ok === true; } catch { /* keep false */ }
    if (status === 429) {
      signal?.removeEventListener('abort', abort);
      cancelBody(response);
      throw new BiliClientError('BILI_RATE_LIMIT', SAFE_MESSAGES.BILI_RATE_LIMIT, { retryAfterMs, status });
    }
    if (!ok) {
      signal?.removeEventListener('abort', abort);
      cancelBody(response);
      throw new BiliClientError('BILI_HTTP', SAFE_MESSAGES.BILI_HTTP, { retryAfterMs, status });
    }

    let reader;
    try { reader = response.body?.getReader?.(); } catch { reader = null; }
    if (!reader) {
      signal?.removeEventListener('abort', abort);
      fail('BILI_RESPONSE');
    }
    const chunks = [];
    let total = 0;
    let complete = false;
    try {
      while (true) {
        const { value, done } = await raceFence(reader.read(), { deadline, signal, controller });
        if (done) { complete = true; break; }
        total += value?.byteLength || 0;
        if (total > limit) {
          controller.abort();
          fail('BILI_RESPONSE');
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof BiliClientError) throw error;
      if (signal?.aborted) fail('BILI_CANCELLED');
      fail(Date.now() >= deadline ? 'BILI_TIMEOUT' : 'BILI_RESPONSE');
    } finally {
      if (!complete) {
        try { reader.cancel?.()?.catch?.(() => {}); } catch { /* ignore */ }
      }
      try { reader.releaseLock(); } catch { /* ignore */ }
      signal?.removeEventListener('abort', abort);
    }

    let payload;
    try {
      payload = parseLosslessJson(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof BiliClientError) throw error;
      fail('BILI_RESPONSE');
    }
    return { payload: expectPayload(payload), headers: responseHeaders, serverTime: serverTime(responseHeaders) };
  }

  async function resolveScope({ endpoint, cookie, query, kind, requestKey }) {
    let scope = requestScope;
    if (typeof scope === 'function') {
      try {
        scope = await scope({
          endpoint: [...endpoint], cookie, query: { ...query }, kind, requestKey,
        });
      } catch {
        fail('BILI_RESPONSE');
      }
    }
    if (!isObject(scope)
      || typeof scope.providerId !== 'string' || !scope.providerId
      || typeof scope.accountKey !== 'string' || !scope.accountKey) {
      fail('BILI_RESPONSE');
    }
    return scope;
  }

  async function perform(endpoint, options, handler) {
    if (requestPolicy === null) return handler(await requestDirect(endpoint, options));
    const { query = {}, cookie = '' } = options;
    const kind = endpoint === ENDPOINTS.sessions || endpoint === ENDPOINTS.messages
      ? 'data' : 'control';
    const requestKey = requestKeyFor(endpoint, query);
    const scope = await resolveScope({
      endpoint, cookie, query, kind, requestKey,
    });
    const credentialVersion = scope.credentialVersion !== undefined && scope.credentialVersion !== null
      ? scope.credentialVersion
      : cookie ? cookieFingerprint(cookie) : undefined;
    return requestPolicy.run({
      providerId: scope.providerId,
      accountKey: scope.accountKey,
      credentialVersion,
      workflowId: options.workflowId !== undefined && options.workflowId !== null
        ? options.workflowId : scope.workflowId,
      requestKey,
      kind,
      signal: options.signal,
      expiresAt: options.expiresAt,
    }, async (policySignal) => handler(await requestDirect(endpoint, {
      ...options,
      signal: policySignal || options.signal,
    })));
  }

  return {
    async nav(cookie, { signal, expiresAt, workflowId } = {}) {
      const required = cookieHeader(cookie);
      return perform(ENDPOINTS.nav, {
        cookie: required, signal, expiresAt, workflowId,
      }, ({ payload, serverTime: time }) => {
        if (payload.code !== 0) apiFailure(payload);
        const data = payload.data;
        if (!isObject(data)) fail('BILI_RESPONSE');
        if (data.isLogin !== true) fail('BILI_AUTH');
        const mid = canonicalId(data.mid);
        if (mid === '0') fail('BILI_AUTH');
        return {
          mid,
          uname: typeof data.uname === 'string' ? data.uname.slice(0, 200) : '',
          serverTime: time,
        };
      });
    },

    async generateQr({ signal, expiresAt } = {}) {
      return perform(ENDPOINTS.qrGenerate, { signal, expiresAt }, ({ payload, serverTime: time }) => {
        if (payload.code !== 0) apiFailure(payload);
        const data = payload.data;
        if (!isObject(data)) fail('BILI_RESPONSE');
        const url = typeof data.url === 'string' ? data.url : '';
        const key = typeof data.qrcode_key === 'string' ? data.qrcode_key : '';
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) fail('BILI_RESPONSE');
        qrLoginUrl(url, key);
        return { url, key, serverTime: time };
      });
    },

    async pollQr(key, { signal, expiresAt } = {}) {
      const value = String(key ?? '');
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) fail('BILI_RESPONSE');
      return perform(ENDPOINTS.qrPoll, {
        query: { qrcode_key: value }, signal, expiresAt,
      }, ({ payload, headers, serverTime: time }) => {
        if (payload.code !== 0) apiFailure(payload);
        const data = payload.data;
        if (!isObject(data) || typeof data.code !== 'number' || !Number.isInteger(data.code)) fail('BILI_RESPONSE');
        const code = data.code;
        if (code === 86101) return { state: 'waiting', code, serverTime: time };
        if (code === 86090) return { state: 'scanned', code, serverTime: time };
        if (code === 86038) return { state: 'expired', code, serverTime: time };
        if (code !== 0) return { state: 'unknown', code, serverTime: time };
        const cookie = extractCookies(headers, typeof data.url === 'string' ? data.url : '');
        if (!cookie) fail('BILI_COOKIE');
        return { state: 'success', code, cookie, serverTime: time };
      });
    },

    async sessions(cookie, {
      endTs, size = 100, signal, expiresAt, workflowId,
    } = {}) {
      const required = cookieHeader(cookie);
      const bounded = Math.max(1, Math.min(100, Math.floor(Number(size) || 100)));
      const query = {
        session_type: 1, group_fold: 0, unfollow_fold: 0, sort_rule: 2, size: bounded,
        build: 0, mobi_app: 'web',
      };
      if (endTs !== undefined && endTs !== null && endTs !== '') query.end_ts = canonicalCounter(endTs);
      return perform(ENDPOINTS.sessions, {
        query, cookie: required, signal, expiresAt, workflowId,
      }, ({ payload, serverTime: time }) => {
        if (payload.code !== 0) apiFailure(payload);
        const data = payload.data;
        if (!isObject(data)) fail('BILI_RESPONSE');
        const hasMore = pageHasMore(data.has_more);
        const list = pageList(data.session_list);
        if (list === null && hasMore) fail('BILI_RESPONSE');
        if (data.system_msg !== undefined && data.system_msg !== null && !isObject(data.system_msg)) fail('BILI_RESPONSE');
        return {
          sessions: list || [],
          hasMore,
          systemMsg: isObject(data.system_msg) ? data.system_msg : null,
          serverTime: time,
        };
      });
    },

    async messages(cookie, {
      talkerId, sessionType = 1, beginSeqno, endSeqno, size = 100, signal,
      expiresAt, workflowId,
    } = {}) {
      const required = cookieHeader(cookie);
      const talker = canonicalId(talkerId);
      const type = Number(sessionType);
      if (![1, 2].includes(type)) fail('BILI_RESPONSE');
      const bounded = Math.max(1, Math.min(100, Math.floor(Number(size) || 100)));
      const query = {
        talker_id: talker, session_type: type, size: bounded,
        sender_device_id: 1, build: 0, mobi_app: 'web',
      };
      if (beginSeqno !== undefined && beginSeqno !== null && beginSeqno !== '') query.begin_seqno = canonicalCounter(beginSeqno);
      if (endSeqno !== undefined && endSeqno !== null && endSeqno !== '') query.end_seqno = canonicalCounter(endSeqno);
      return perform(ENDPOINTS.messages, {
        query, cookie: required, signal, expiresAt, workflowId,
      }, ({ payload, serverTime: time }) => {
        if (payload.code !== 0) apiFailure(payload);
        const data = payload.data;
        if (!isObject(data)) fail('BILI_RESPONSE');
        const hasMore = pageHasMore(data.has_more);
        const list = pageList(data.messages);
        if (list === null && hasMore) fail('BILI_RESPONSE');
        return {
          messages: list || [],
          hasMore,
          minSeqno: data.min_seqno === undefined || data.min_seqno === null ? null : canonicalCounter(data.min_seqno),
          maxSeqno: data.max_seqno === undefined || data.max_seqno === null ? null : canonicalCounter(data.max_seqno),
          eInfos: optionalList(data.e_infos),
          serverTime: time,
        };
      });
    },
  };
}

export { ENDPOINTS, COOKIE_KEYS };
