/**
 * User-triggered XiaoHeiHe QR/manual login.
 *
 * Credentials live only in the independent settings partition
 * `privateMessageProviders.xiaoheihe`; Bilibili fields are never read or
 * written here. Nothing contacts the network until the user calls start() or
 * manual(), and a failed new login never removes an older working credential.
 * Public status exposes only fixed states plus a masked account label. QR
 * content, cookies, full IDs, URLs and raw server errors stay inside this
 * module and the shared settings file.
 */

import { createHash, randomUUID } from 'node:crypto';
import { qrToPngDataUrl } from './bili-qr.js';
import { XHH_SAFE_MESSAGES } from './xiaoheihe-client.js';

const PROVIDER_ID = 'xiaoheihe';
const ACTIVE_STATES = new Set(['starting', 'waiting', 'scanned']);
const KNOWN_CODES = new Set(Object.keys(XHH_SAFE_MESSAGES));
const TERMINAL_POLL_CODES = new Set([
  'XHH_AUTH', 'XHH_CHALLENGE', 'XHH_API', 'XHH_RESPONSE',
  'XHH_PRECISION', 'XHH_QR', 'XHH_QR_CREDENTIAL',
]);
const INSPECT_CACHE_MS = 10 * 60_000;
const MIN_QR_TTL_MS = 5_000;
const UNSAFE_COOKIE_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

function defaultQr(text) {
  return qrToPngDataUrl(text, { ec: 'L', scale: 8, margin: 4 });
}

function cookieFingerprint(cookie) {
  return createHash('sha256').update(String(cookie), 'utf8').digest('hex');
}

function safeText(value, max = 64) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
}

function normalizeAccountId(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^\d{1,32}$/.test(text) && /[1-9]/.test(text) ? text : '';
}

function maskAccountId(value) {
  const id = normalizeAccountId(value);
  if (!id) return '';
  if (id.length <= 4) return '****';
  return `${id.slice(0, 2)}****${id.slice(-2)}`;
}

function cookieMap(cookie) {
  const out = Object.create(null);
  for (const part of String(cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name || UNSAFE_COOKIE_NAMES.has(name)) continue;
    if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

function hasPrimaryCookie(cookie) {
  const map = cookieMap(cookie);
  return typeof map.user_pkey === 'string' && map.user_pkey.length > 0;
}

function accountIdFromCookie(cookie) {
  const map = cookieMap(cookie);
  return normalizeAccountId(map.heybox_id) || normalizeAccountId(map.user_heybox_id);
}

function nicknameFromCookie(cookie) {
  const raw = cookieMap(cookie).nickname;
  if (!raw) return '';
  try {
    return safeText(decodeURIComponent(raw));
  } catch {
    return safeText(raw);
  }
}

function readCredential(settings) {
  let raw = {};
  try {
    const value = settings.getPrivateMessageProviderCredentials(PROVIDER_ID);
    if (value && typeof value === 'object' && !Array.isArray(value)) raw = value;
  } catch { /* missing settings are treated as no credential */ }
  const cookie = typeof raw.cookie === 'string'
    && raw.cookie.length <= 8192 && !/[\0\r\n]/.test(raw.cookie) ? raw.cookie : '';
  const heyboxId = normalizeAccountId(raw.heyboxId);
  const nickname = safeText(raw.nickname);
  const sessionVersion = Number.isInteger(raw.sessionVersion) && raw.sessionVersion >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, raw.sessionVersion) : 0;
  const accountEpoch = typeof raw.accountEpoch === 'string'
    && /^[A-Za-z0-9-]{8,64}$/.test(raw.accountEpoch) ? raw.accountEpoch : '';
  return { cookie, heyboxId, nickname, sessionVersion, accountEpoch };
}

function sameStored(left, right) {
  return left.cookie === right.cookie
    && left.heyboxId === right.heyboxId
    && left.sessionVersion === right.sessionVersion
    && left.accountEpoch === right.accountEpoch;
}

function errorFields(code, retryAfterMs = 0) {
  let safe = String(code || '');
  if (safe === 'REQUEST_COOLDOWN') safe = 'XHH_COOLDOWN';
  else if (safe === 'REQUEST_BUDGET') safe = 'XHH_BUDGET';
  else if (safe === 'REQUEST_DEADLINE') safe = 'XHH_TIMEOUT';
  else if (safe === 'REQUEST_POLICY_UNAVAILABLE' || safe === 'REQUEST_POLICY_CLOSED') safe = 'XHH_HTTP';
  if (!KNOWN_CODES.has(safe)) safe = 'XHH_RESPONSE';
  const retry = Number(retryAfterMs);
  const allowRetry = safe === 'XHH_RATE_LIMIT' || safe === 'XHH_HTTP'
    || safe === 'XHH_BUDGET' || safe === 'XHH_COOLDOWN';
  return {
    errorCode: safe,
    errorSummary: XHH_SAFE_MESSAGES[safe],
    retryAfterMs: allowRetry && Number.isFinite(retry) && retry > 0 ? Math.floor(retry) : 0,
  };
}

/**
 * @param {object} options
 * @param {object} options.settings createSettings() instance or compatible fake
 * @param {object} options.client createXiaoheiheClient() instance or compatible fake
 * @param {Function} [options.isActive]
 * @param {Function} [options.onCredentialChange]
 * @param {Function} [options.now]
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.ttlMs]
 * @param {Function} [options.qrEncode]
 */
export function createXiaoheiheLogin({
  settings,
  client,
  isActive = () => true,
  onCredentialChange = async () => {},
  now = () => Date.now(),
  pollIntervalMs = 5000,
  ttlMs = 180_000,
  qrEncode = defaultQr,
} = {}) {
  if (!settings || typeof settings.getPrivateMessageProviderCredentials !== 'function'
    || typeof settings.setPrivateMessageProviderCredentials !== 'function'
    || typeof settings.clearPrivateMessageProviderCredentials !== 'function') {
    throw new TypeError('createXiaoheiheLogin requires the private-message credential API');
  }
  if (!client || typeof client.requestQr !== 'function' || typeof client.pollQr !== 'function'
    || typeof client.checkAuthEndpoint !== 'function') {
    throw new TypeError('createXiaoheiheLogin requires a XiaoHeiHe client');
  }

  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? Math.floor(value) : Date.now();
  };
  const safeActive = () => {
    try { return isActive() === true; } catch { return false; }
  };

  let session = null;
  let generation = 0;
  let manualGeneration = 0;
  let inspectGeneration = 0;
  const operations = new Set();
  let disposed = false;
  let state = 'idle';
  let expiresAt = null;
  let pngDataUrl = null;
  let errorCode = null;
  let errorSummary = null;
  let retryAfterMs = 0;
  let inspectCache = null;

  function clearError() {
    errorCode = null;
    errorSummary = null;
    retryAfterMs = 0;
  }

  function applyError(code, retry = 0) {
    const fields = errorFields(code, retry);
    errorCode = fields.errorCode;
    errorSummary = fields.errorSummary;
    retryAfterMs = fields.retryAfterMs;
    return fields;
  }

  function clearInspectCache() {
    inspectCache = null;
  }

  function cachedAccount(credential) {
    if (!inspectCache || !credential.cookie || !credential.heyboxId) return null;
    if (inspectCache.hash !== cookieFingerprint(credential.cookie)
      || inspectCache.heyboxId !== credential.heyboxId
      || inspectCache.sessionVersion !== credential.sessionVersion
      || inspectCache.accountEpoch !== credential.accountEpoch) {
      return null;
    }
    if (clock() >= inspectCache.expiresAt) {
      inspectCache = null;
      return null;
    }
    return inspectCache;
  }

  function rememberInspection(credential) {
    if (!credential.cookie || !credential.heyboxId) return;
    inspectCache = {
      hash: cookieFingerprint(credential.cookie),
      heyboxId: credential.heyboxId,
      sessionVersion: credential.sessionVersion,
      accountEpoch: credential.accountEpoch,
      expiresAt: clock() + Math.max(0, Number(INSPECT_CACHE_MS) || 0),
      nickname: safeText(credential.nickname),
    };
  }

  function accountLabel(credential) {
    const mask = maskAccountId(credential.heyboxId);
    if (!mask) return '';
    return `${credential.nickname || '小黑盒账号'}（${mask}）`;
  }

  function status() {
    const credential = readCredential(settings);
    if (!session && state === 'valid' && !cachedAccount(credential)) state = 'idle';
    const base = {
      state,
      expiresAt: session ? expiresAt : null,
      pngDataUrl: session ? pngDataUrl : null,
      errorCode,
      errorSummary,
      retryAfterMs,
      sessionVersion: credential.sessionVersion,
      accountEpoch: credential.accountEpoch,
      accountLabel: accountLabel(credential),
    };
    if (!session && state === 'idle' && cachedAccount(credential)) {
      return { ...base, state: 'valid' };
    }
    return base;
  }

  function settleExplicitSuccess() {
    if (session || ACTIVE_STATES.has(state)) return;
    state = 'valid';
    expiresAt = null;
    pngDataUrl = null;
    clearError();
  }

  function isCurrent(candidate) {
    return !disposed && session === candidate && candidate.generation === generation;
  }

  function clearSession() {
    if (!session) return;
    const current = session;
    session = null;
    if (current.timer) {
      clearTimeout(current.timer);
      current.timer = null;
    }
    if (current.expiryTimer) {
      clearTimeout(current.expiryTimer);
      current.expiryTimer = null;
    }
    try { current.controller.abort(); } catch { /* ignore */ }
    pngDataUrl = null;
    expiresAt = null;
  }

  function abortOperations(predicate) {
    for (const op of [...operations]) {
      if (!predicate(op)) continue;
      try { op.controller.abort(); } catch { /* ignore */ }
      operations.delete(op);
    }
  }

  function invalidateOperations() {
    manualGeneration += 1;
    inspectGeneration += 1;
    abortOperations(() => true);
  }

  function beginOperation(kind) {
    let opGeneration;
    if (kind === 'manual') {
      manualGeneration += 1;
      inspectGeneration += 1;
      opGeneration = manualGeneration;
      abortOperations(() => true);
    } else {
      inspectGeneration += 1;
      opGeneration = inspectGeneration;
      abortOperations((op) => op.kind === 'inspect');
    }
    const op = {
      kind,
      generation: opGeneration,
      controller: new AbortController(),
      baseline: readCredential(settings),
    };
    operations.add(op);
    return op;
  }

  function finishOperation(op) {
    operations.delete(op);
  }

  function isOperationCurrent(op) {
    const current = op.kind === 'manual' ? manualGeneration : inspectGeneration;
    return !disposed && op.generation === current
      && !op.controller.signal.aborted && safeActive();
  }

  function armExpiry(current) {
    if (!isCurrent(current) || current.expiryTimer) return;
    const remaining = current.expiresAt - clock();
    if (remaining <= 0) {
      expire(current);
      return;
    }
    current.expiryTimer = setTimeout(() => {
      current.expiryTimer = null;
      expire(current);
    }, remaining);
    current.expiryTimer.unref?.();
  }

  function schedule(current, minimumDelay = 0) {
    if (!isCurrent(current) || current.timer) return;
    const remaining = current.expiresAt - clock();
    if (remaining <= 0) {
      expire(current);
      return;
    }
    const requested = Number(minimumDelay);
    const waitMs = Number.isFinite(requested) && requested > 0 ? requested : pollIntervalMs;
    const delay = Math.max(1, Math.min(Math.max(1, Math.floor(waitMs)), remaining));
    current.timer = setTimeout(() => {
      current.timer = null;
      Promise.resolve().then(() => poll(current)).catch(() => {});
    }, delay);
    current.timer.unref?.();
  }

  function finish(current, nextState) {
    if (!isCurrent(current)) return false;
    clearSession();
    state = nextState;
    return true;
  }

  function expire(current) {
    if (!isCurrent(current)) return;
    clearError();
    finish(current, 'expired');
  }

  function waitOutlivesQr(current, error) {
    const code = String(error?.code || '');
    const retry = Number(error?.retryAfterMs);
    const next = Number.isFinite(error?.nextAllowedAt)
      ? error.nextAllowedAt
      : Number.isFinite(retry) && retry > 0 ? clock() + retry : 0;
    if (code === 'XHH_RATE_LIMIT' || code === 'XHH_HTTP'
      || code === 'XHH_BUDGET' || code === 'XHH_COOLDOWN') {
      return next > 0 && next >= current.expiresAt;
    }
    return code === 'REQUEST_DEADLINE';
  }

  async function notifyCredentialChange() {
    try { await onCredentialChange(); } catch { /* UI refresh cannot undo a committed save */ }
  }

  async function saveCredential(cookie, heyboxId, nickname, { guard }) {
    const current = readCredential(settings);
    const changed = current.cookie !== cookie || current.heyboxId !== heyboxId;
    const nextSessionVersion = changed
      ? Math.max(0, current.sessionVersion) + 1
      : Math.max(1, current.sessionVersion);
    const accountEpoch = changed || !current.accountEpoch
      ? randomUUID() : current.accountEpoch;
    const cleanNickname = safeText(nickname) || (changed ? '' : current.nickname);
    const record = {
      cookie,
      heyboxId,
      nickname: cleanNickname,
      sessionVersion: nextSessionVersion,
      accountEpoch,
    };
    await settings.setPrivateMessageProviderCredentials(PROVIDER_ID, record, {
      guard,
      replace: true,
    });
    clearInspectCache();
    return record;
  }

  function sessionGuard(current) {
    return () => !disposed && isCurrent(current) && safeActive()
      && clock() < current.expiresAt
      && !current.controller.signal.aborted
      && sameStored(current.baseline, readCredential(settings));
  }

  async function completeLogin(current, result) {
    if (!isCurrent(current) || clock() >= current.expiresAt) {
      if (isCurrent(current)) expire(current);
      return;
    }
    if (!sameStored(current.baseline, readCredential(settings))) {
      finish(current, 'cancelled');
      clearError();
      return;
    }
    const cookie = typeof result?.cookie === 'string' ? result.cookie : '';
    const heyboxId = normalizeAccountId(result?.heyboxId);
    if (!cookie || !hasPrimaryCookie(cookie) || !heyboxId) {
      finish(current, 'error');
      applyError('XHH_QR_CREDENTIAL');
      return;
    }

    let check;
    try {
      check = await client.checkAuthEndpoint({
        cookie,
        heyboxId,
        signal: current.controller.signal,
        expiresAt: current.expiresAt,
        workflowId: current.workflowId,
      });
    } catch (error) {
      if (!isCurrent(current)) return;
      if (error?.code === 'XHH_CANCELLED') return;
      const fields = applyError(error?.code, error?.retryAfterMs);
      finish(current, 'error');
      applyError(fields.errorCode, fields.retryAfterMs);
      return;
    }
    if (!isCurrent(current)) return;
    if (clock() >= current.expiresAt) {
      expire(current);
      return;
    }
    if (check?.authEndpointAccepted !== true) {
      finish(current, 'error');
      applyError('XHH_AUTH');
      return;
    }

    let saved;
    try {
      saved = await saveCredential(cookie, heyboxId, result?.nickname || '', {
        guard: sessionGuard(current),
      });
    } catch {
      if (!isCurrent(current)) return;
      if (!safeActive() || !sameStored(current.baseline, readCredential(settings))) {
        finish(current, 'cancelled');
        return;
      }
      finish(current, 'error');
      applyError('XHH_STORAGE');
      return;
    }
    if (!isCurrent(current)) return;
    rememberInspection(saved);
    clearSession();
    state = 'success';
    clearError();
    await notifyCredentialChange();
  }

  async function poll(current) {
    if (!isCurrent(current)) return;
    if (clock() >= current.expiresAt) {
      expire(current);
      return;
    }
    if (!sameStored(current.baseline, readCredential(settings))) {
      finish(current, 'cancelled');
      clearError();
      return;
    }

    let result;
    try {
      result = await client.pollQr(current.qrSession, {
        signal: current.controller.signal,
        expiresAt: current.expiresAt,
        workflowId: current.workflowId,
      });
    } catch (error) {
      if (!isCurrent(current)) return;
      if (error?.code === 'XHH_CANCELLED') return;
      if (waitOutlivesQr(current, error)) {
        expire(current);
        return;
      }
      const fields = applyError(error?.code, error?.retryAfterMs);
      if (TERMINAL_POLL_CODES.has(fields.errorCode)) {
        finish(current, 'error');
        applyError(fields.errorCode, fields.retryAfterMs);
        return;
      }
      schedule(current, fields.retryAfterMs);
      return;
    }
    if (!isCurrent(current)) return;
    if (clock() >= current.expiresAt) {
      expire(current);
      return;
    }
    if (!sameStored(current.baseline, readCredential(settings))) {
      finish(current, 'cancelled');
      clearError();
      return;
    }

    if (result?.state === 'waiting' || result?.state === 'scanned') {
      state = result.state;
      clearError();
      schedule(current);
      return;
    }
    if (result?.state === 'denied' || result?.state === 'cancelled') {
      finish(current, 'cancelled');
      clearError();
      return;
    }
    if (result?.state === 'expired') {
      expire(current);
      return;
    }
    if (result?.state === 'success') {
      await completeLogin(current, result);
      return;
    }
    finish(current, 'error');
    applyError(result?.reasonCode === 'qr_credential_missing'
      || result?.reasonCode === 'qr_account_missing'
      ? 'XHH_QR_CREDENTIAL' : 'XHH_RESPONSE');
  }

  async function start() {
    if (disposed || !safeActive()) return status();
    if (session && ACTIVE_STATES.has(state)) return status();

    generation += 1;
    const startedAt = clock();
    const ttl = Math.max(MIN_QR_TTL_MS, Number(ttlMs) || 180_000);
    const current = {
      generation,
      controller: new AbortController(),
      timer: null,
      expiryTimer: null,
      workflowId: `xhh-qr-${generation}`,
      startedAt,
      expiresAt: startedAt + ttl,
      baseline: readCredential(settings),
      qrSession: null,
    };
    session = current;
    state = 'starting';
    expiresAt = current.expiresAt;
    pngDataUrl = null;
    clearError();
    armExpiry(current);

    let qr;
    try {
      qr = await client.requestQr({
        signal: current.controller.signal,
        expiresAt: current.expiresAt,
        workflowId: current.workflowId,
      });
    } catch (error) {
      if (!isCurrent(current)) return status();
      if (error?.code === 'XHH_CANCELLED') {
        finish(current, 'idle');
        clearError();
        return status();
      }
      if (error?.code === 'XHH_COOLDOWN' || error?.code === 'XHH_BUDGET') {
        const fields = applyError(error.code, error.retryAfterMs);
        finish(current, 'error');
        applyError(fields.errorCode, fields.retryAfterMs);
        return status();
      }
      if (waitOutlivesQr(current, error)) {
        expire(current);
        return status();
      }
      const fields = applyError(error?.code, error?.retryAfterMs);
      finish(current, 'error');
      applyError(fields.errorCode, fields.retryAfterMs);
      return status();
    }
    if (!isCurrent(current)) return status();
    if (clock() >= current.expiresAt) {
      expire(current);
      return status();
    }
    if (!sameStored(current.baseline, readCredential(settings))) {
      finish(current, 'cancelled');
      clearError();
      return status();
    }

    const qrContent = typeof qr?.qrContent === 'string' ? qr.qrContent : '';
    const qrId = typeof qr?.pollParams?.qr === 'string'
      ? qr.pollParams.qr : typeof qr?.qrId === 'string' ? qr.qrId : '';
    if (!qrContent || !qrId) {
      finish(current, 'error');
      applyError('XHH_QR');
      return status();
    }

    let png;
    try {
      png = qrEncode(qrContent);
    } catch {
      finish(current, 'error');
      applyError('XHH_QR');
      return status();
    }
    if (!isCurrent(current)) return status();
    if (clock() >= current.expiresAt) {
      expire(current);
      return status();
    }

    const remoteExpiry = Number.isFinite(qr?.expiresAt) ? qr.expiresAt : current.expiresAt;
    current.qrSession = {
      cookies: qr?.cookies && typeof qr.cookies === 'object' ? { ...qr.cookies } : {},
      pollParams: { qr: qrId, app: 'web' },
      expiresAt: Math.min(current.expiresAt, remoteExpiry),
    };
    state = 'waiting';
    pngDataUrl = png;
    expiresAt = current.expiresAt;
    clearError();
    schedule(current);
    return status();
  }

  function cancel() {
    if (disposed) return status();
    generation += 1;
    invalidateOperations();
    clearSession();
    clearError();
    state = 'cancelled';
    return status();
  }

  async function inspectCurrent({ withAccount, explicit = false }) {
    const credential = readCredential(settings);
    if (!credential.cookie || !credential.heyboxId) return { state: 'missing' };
    const cached = cachedAccount(credential);
    if (cached) {
      if (explicit) settleExplicitSuccess();
      return withAccount
        ? {
          state: 'valid',
          heyboxId: credential.heyboxId,
          accountId: credential.heyboxId,
          nickname: cached.nickname,
        }
        : { state: 'valid' };
    }
    if (disposed || !safeActive()) return { state: 'cancelled' };

    const op = beginOperation('inspect');
    if (!op.baseline.cookie || !op.baseline.heyboxId
      || !sameStored(op.baseline, credential)) {
      finishOperation(op);
      return { state: 'cancelled' };
    }
    let check;
    try {
      check = await client.checkAuthEndpoint({
        cookie: credential.cookie,
        heyboxId: credential.heyboxId,
        signal: op.controller.signal,
      });
    } catch (error) {
      const current = isOperationCurrent(op)
        && sameStored(op.baseline, readCredential(settings));
      finishOperation(op);
      if (!current || error?.code === 'XHH_CANCELLED') return { state: 'cancelled' };
      const fields = errorFields(error?.code, error?.retryAfterMs);
      if (fields.errorCode === 'XHH_AUTH') {
        clearInspectCache();
        return { state: 'invalid', ...fields };
      }
      return { state: 'error', ...fields };
    }
    const current = isOperationCurrent(op)
      && sameStored(op.baseline, readCredential(settings));
    finishOperation(op);
    if (!current) return { state: 'cancelled' };
    if (check?.authEndpointAccepted !== true) {
      return { state: 'error', ...errorFields('XHH_RESPONSE') };
    }
    rememberInspection(op.baseline);
    if (explicit) settleExplicitSuccess();
    if (!withAccount) return { state: 'valid' };
    return {
      state: 'valid',
      heyboxId: credential.heyboxId,
      accountId: credential.heyboxId,
      nickname: credential.nickname,
    };
  }

  function inspect() {
    return inspectCurrent({ withAccount: false, explicit: true });
  }

  function inspectAccount() {
    return inspectCurrent({ withAccount: true, explicit: false });
  }

  async function manual(cookieString) {
    if (disposed || !safeActive()) return { ok: false, state: 'cancelled' };
    const value = String(cookieString ?? '').trim();
    if (!value || value.length > 8192 || /[\0\r\n]/.test(value) || !hasPrimaryCookie(value)) {
      const fields = applyError('XHH_AUTH');
      return { ok: false, state: 'invalid', ...fields };
    }
    const heyboxId = accountIdFromCookie(value);
    if (!heyboxId) {
      const fields = applyError('XHH_AUTH');
      return { ok: false, state: 'invalid', ...fields };
    }

    const op = beginOperation('manual');
    generation += 1;
    clearSession();
    state = 'idle';
    clearError();
    pngDataUrl = null;
    expiresAt = null;

    let check;
    try {
      check = await client.checkAuthEndpoint({
        cookie: value,
        heyboxId,
        signal: op.controller.signal,
      });
    } catch (error) {
      const current = isOperationCurrent(op);
      finishOperation(op);
      if (!current || error?.code === 'XHH_CANCELLED') {
        return { ok: false, state: 'cancelled' };
      }
      const fields = applyError(error?.code, error?.retryAfterMs);
      return {
        ok: false,
        state: fields.errorCode === 'XHH_AUTH' ? 'invalid' : 'error',
        ...fields,
      };
    }
    if (!isOperationCurrent(op)) {
      finishOperation(op);
      return { ok: false, state: 'cancelled' };
    }
    if (check?.authEndpointAccepted !== true) {
      finishOperation(op);
      const fields = applyError('XHH_AUTH');
      return { ok: false, state: 'invalid', ...fields };
    }

    let saved;
    try {
      saved = await saveCredential(value, heyboxId, nicknameFromCookie(value), {
        guard: () => isOperationCurrent(op) && sameStored(op.baseline, readCredential(settings)),
      });
    } catch {
      const current = isOperationCurrent(op);
      finishOperation(op);
      if (!current || !sameStored(op.baseline, readCredential(settings))) {
        return { ok: false, state: 'cancelled' };
      }
      const fields = applyError('XHH_STORAGE');
      return { ok: false, state: 'error', ...fields };
    }
    if (disposed || op.generation !== manualGeneration || op.controller.signal.aborted) {
      finishOperation(op);
      return { ok: false, state: 'cancelled' };
    }
    finishOperation(op);
    rememberInspection(saved);
    state = 'success';
    pngDataUrl = null;
    expiresAt = null;
    clearError();
    await notifyCredentialChange();
    return { ok: true, state: 'valid' };
  }

  async function logout() {
    generation += 1;
    invalidateOperations();
    clearSession();
    clearInspectCache();
    clearError();
    const current = readCredential(settings);
    const tombstone = {
      cookie: '',
      heyboxId: '',
      nickname: '',
      sessionVersion: Math.min(Number.MAX_SAFE_INTEGER, current.sessionVersion + 1),
      accountEpoch: randomUUID(),
    };
    try {
      await settings.setPrivateMessageProviderCredentials(PROVIDER_ID, tombstone, {
        guard: () => !disposed && safeActive(),
        replace: true,
      });
    } catch {
      if (disposed) return { ok: false, state: 'cancelled' };
      const fields = applyError('XHH_STORAGE');
      state = 'error';
      return { ok: false, state: 'error', ...fields };
    }
    state = 'idle';
    pngDataUrl = null;
    expiresAt = null;
    clearError();
    await notifyCredentialChange();
    return { ok: true, state: 'idle' };
  }

  function credentialState() {
    const credential = readCredential(settings);
    return {
      cookie: credential.cookie,
      heyboxId: credential.heyboxId,
      sessionVersion: credential.sessionVersion,
      accountEpoch: credential.accountEpoch,
    };
  }

  function deactivate() {
    if (disposed) return status();
    disposed = true;
    generation += 1;
    invalidateOperations();
    clearSession();
    clearError();
    state = 'idle';
    return status();
  }

  const ready = Promise.resolve().then(async () => {
    try {
      if (settings.ready && typeof settings.ready.then === 'function') await settings.ready;
      return status();
    } catch {
      if (!session) {
        state = 'error';
        applyError('XHH_STORAGE');
      }
      return status();
    }
  });

  return {
    ready,
    status,
    start,
    cancel,
    inspect,
    inspectAccount,
    manual,
    logout,
    credentialState,
    deactivate,
    flush: () => (typeof settings.flush === 'function' ? settings.flush() : Promise.resolve()),
    hasSession: () => Boolean(session),
  };
}

export { ACTIVE_STATES, defaultQr };
