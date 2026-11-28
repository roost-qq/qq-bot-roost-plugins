/**
 * User-triggered Bilibili QR login and shared-credential validation.
 *
 * One in-memory session at a time; polls every 3 seconds for at most 180
 * seconds from the initial start deadline. The QR is rendered locally as a PNG
 * data URL and no file is written to the plugin or credential directories.
 * Public status exposes only state, absolute expiry, PNG, and safe fixed error
 * metadata; QR keys, callback URLs, headers, account UID and Cookies never
 * leave this module except through the shared settings API.
 */

import { createHash } from 'node:crypto';
import { qrToPngDataUrl } from './bili-qr.js';
import { SAFE_MESSAGES } from './bili-client.js';
import { committedCredentialRevision } from './settings.js';

const ACTIVE_STATES = new Set(['starting', 'waiting', 'scanned']);
const TERMINAL_POLL_CODES = new Set(['BILI_AUTH', 'BILI_RESPONSE', 'BILI_COOKIE', 'BILI_API']);
const KNOWN_ERROR_CODES = new Set(Object.keys(SAFE_MESSAGES).filter((code) => code !== 'BILI_CANCELLED'));
const INSPECT_CACHE_MS = 10 * 60_000;

function defaultQr(text) {
  return qrToPngDataUrl(text, { ec: 'L', scale: 8, margin: 4 });
}

function cookieHash(cookie) {
  return createHash('sha256').update(String(cookie)).digest('hex');
}

function errorFields(code, retryAfterMs = 0) {
  let safe = code;
  if (code === 'REQUEST_COOLDOWN' || code === 'REQUEST_BUDGET') safe = 'BILI_RATE_LIMIT';
  else if (code === 'REQUEST_DEADLINE') safe = 'BILI_TIMEOUT';
  else if (code === 'REQUEST_POLICY_UNAVAILABLE' || code === 'REQUEST_POLICY_CLOSED') safe = 'BILI_HTTP';
  if (!KNOWN_ERROR_CODES.has(safe)) safe = 'BILI_RESPONSE';
  const retry = Number(retryAfterMs);
  const allowRetry = safe === 'BILI_RATE_LIMIT' || safe === 'BILI_HTTP';
  return {
    errorCode: safe,
    errorSummary: SAFE_MESSAGES[safe],
    retryAfterMs: allowRetry && Number.isFinite(retry) && retry > 0
      ? Math.floor(retry) : 0,
  };
}

/**
 * @param {object} options
 * @param {object} options.settings createSettings() instance or compatible fake
 * @param {object} options.client createBiliClient() instance or compatible fake
 * @param {Function} [options.qrEncode] text -> PNG data URL
 * @param {Function} [options.now] injectable clock
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.ttlMs]
 */
export function createBiliLogin({
  settings, client, qrEncode = defaultQr, now = () => Date.now(),
  pollIntervalMs = 5000, ttlMs = 180_000, inspectCacheMs = INSPECT_CACHE_MS,
} = {}) {
  if (!settings || typeof settings.setBiliCookie !== 'function' || typeof settings.getBiliCookie !== 'function') {
    throw new TypeError('createBiliLogin requires the shared settings API');
  }
  if (!client || typeof client.generateQr !== 'function' || typeof client.pollQr !== 'function'
    || typeof client.nav !== 'function') {
    throw new TypeError('createBiliLogin requires a Bili client');
  }

  let session = null;
  let generation = 0;
  let manualGeneration = 0;
  let inspectGeneration = 0;
  const operations = new Set();
  let disposed = false;
  let internalChange = false;
  let state = 'idle';
  let expiresAt = null;
  let pngDataUrl = null;
  let errorCode = null;
  let errorSummary = null;
  let retryAfterMs = 0;
  let inspectCache = null;

  function clearInspectCache() {
    inspectCache = null;
  }

  function cachedInspection(cookie) {
    if (!inspectCache) return null;
    if (inspectCache.hash !== cookieHash(cookie)) return null;
    if (now() >= inspectCache.expiresAt) {
      inspectCache = null;
      return null;
    }
    return inspectCache.nav;
  }

  function rememberInspection(cookie, nav) {
    if (!cookie || !nav || !nav.mid) return;
    const ttl = Math.max(0, Number(inspectCacheMs) || 0);
    if (ttl <= 0) return;
    inspectCache = {
      hash: cookieHash(cookie),
      expiresAt: now() + ttl,
      nav: { mid: String(nav.mid), uname: typeof nav.uname === 'string' ? nav.uname : '' },
    };
  }

  const cookieRevision = () => (typeof settings.getBiliCookieRevision === 'function'
    ? settings.getBiliCookieRevision() : 0);

  const unsubscribe = typeof settings.subscribeBiliCookie === 'function'
    ? settings.subscribeBiliCookie(() => {
      if (internalChange || disposed) return;
      clearInspectCache();
      invalidateOperations();
      if (session) {
        generation += 1;
        clearSession();
        state = 'cancelled';
        clearError();
      }
    })
    : () => {};

  function status() {
    const base = {
      state, expiresAt, pngDataUrl, errorCode, errorSummary, retryAfterMs,
    };
    // Active/terminal QR session states always win over the cached nav check.
    if (session || state !== 'idle') return base;
    let cookie = '';
    try { cookie = String(settings.getBiliCookie() || ''); } catch { cookie = ''; }
    if (!cookie) return base;
    const nav = cachedInspection(cookie);
    if (!nav) return base;
    // Read-only cached validation. Account identity stays private and the
    // cache expiry is explicit so the page cannot claim valid indefinitely.
    return {
      ...base,
      state: 'valid',
      expiresAt: inspectCache?.expiresAt ?? null,
    };
  }

  function clearError() {
    errorCode = null;
    errorSummary = null;
    retryAfterMs = 0;
  }

  function settleExplicitSuccess() {
    // An explicit successful check supersedes a stale terminal QR error, but
    // must never disturb an in-flight QR session. This path stays local.
    if (session || ACTIVE_STATES.has(state)) return;
    state = 'idle';
    expiresAt = null;
    pngDataUrl = null;
    clearError();
  }

  function applyError(code, retry = 0) {
    const fields = errorFields(code, retry);
    errorCode = fields.errorCode;
    errorSummary = fields.errorSummary;
    retryAfterMs = fields.retryAfterMs;
    return fields;
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
    const revision = cookieRevision();
    if (kind === 'manual') {
      manualGeneration += 1;
      inspectGeneration += 1;
      abortOperations(() => true);
    } else {
      inspectGeneration += 1;
      abortOperations((op) => op.kind === 'inspect');
    }
    const op = {
      kind,
      generation: kind === 'manual' ? manualGeneration : inspectGeneration,
      revision,
      controller: new AbortController(),
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
      && !op.controller.signal.aborted && cookieRevision() === op.revision;
  }

  // The operation's own credential commit legitimately advances the revision.
  // A post-commit metadata failure must therefore validate the exact commit
  // this operation produced instead of reusing the pre-commit revision guard.
  // Any later external or newer-generation commit fails this check.
  function ownsCommittedRevision(op, committedRevision, expectedCookie) {
    if (disposed || op.generation !== manualGeneration) return false;
    if (op.controller.signal.aborted) return false;
    if (cookieRevision() !== committedRevision) return false;
    try {
      return String(settings.getBiliCookie?.() ?? '') === expectedCookie;
    } catch {
      return false;
    }
  }

  function armExpiry(current) {
    if (!isCurrent(current) || current.expiryTimer) return;
    const remaining = current.expiresAt - now();
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
    const remaining = current.expiresAt - now();
    if (remaining <= 0) {
      expire(current);
      return;
    }
    const requested = Number(minimumDelay);
    const wait = Number.isFinite(requested) && requested > 0 ? requested : pollIntervalMs;
    const delay = Math.max(1, Math.min(Math.max(1, Math.floor(wait)), remaining));
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

  function waitOutlivesQr(current, error, retryAfterMs) {
    const code = String(error?.code || '');
    if (code === 'REQUEST_DEADLINE') return true;
    if (code !== 'REQUEST_COOLDOWN' && code !== 'REQUEST_BUDGET') return false;
    const next = Number.isFinite(error?.nextAllowedAt)
      ? error.nextAllowedAt : (retryAfterMs > 0 ? now() + retryAfterMs : 0);
    return next > 0 && next >= current.expiresAt;
  }

  async function completeLogin(current, cookie) {
    if (!isCurrent(current) || now() >= current.expiresAt) {
      if (isCurrent(current)) expire(current);
      return;
    }
    let nav;
    try {
      nav = await client.nav(cookie, {
        signal: current.controller.signal,
        expiresAt: current.expiresAt,
        workflowId: current.workflowId,
      });
    } catch (error) {
      if (!isCurrent(current)) return;
      if (error?.code === 'BILI_CANCELLED') return;
      const fields = applyError(error?.code, error?.retryAfterMs);
      finish(current, 'error');
      applyError(fields.errorCode, fields.retryAfterMs);
      return;
    }
    if (!isCurrent(current)) return;
    if (now() >= current.expiresAt) {
      expire(current);
      return;
    }
    if (!nav || !nav.mid) {
      finish(current, 'error');
      applyError('BILI_RESPONSE');
      return;
    }
    internalChange = true;
    try {
      await settings.setBiliCookie(cookie, {
        guard: () => !disposed && isCurrent(current) && now() < current.expiresAt
          && !current.controller.signal.aborted
          && cookieRevision() === current.cookieRevision,
      });
    } catch {
      internalChange = false;
      if (!isCurrent(current)) return;
      finish(current, 'error');
      applyError('BILI_STORAGE');
      return;
    } finally {
      internalChange = false;
    }
    if (!isCurrent(current)) return;
    clearSession();
    clearInspectCache();
    state = 'success';
    clearError();
  }

  async function poll(current) {
    if (!isCurrent(current)) return;
    if (now() >= current.expiresAt) {
      expire(current);
      return;
    }

    let result;
    try {
      result = await client.pollQr(current.key, {
        signal: current.controller.signal,
        expiresAt: current.expiresAt,
      });
    } catch (error) {
      if (!isCurrent(current)) return;
      if (error?.code === 'BILI_CANCELLED') return;
      if (waitOutlivesQr(current, error, Number(error?.retryAfterMs) || 0)) {
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
    if (now() >= current.expiresAt) {
      expire(current);
      return;
    }

    if (result?.state === 'waiting' || result?.state === 'scanned') {
      state = result.state;
      clearError();
      schedule(current);
      return;
    }
    if (result?.state === 'expired') {
      expire(current);
      return;
    }
    if (result?.state === 'success') {
      await completeLogin(current, result.cookie);
      return;
    }
    applyError('BILI_RESPONSE');
    schedule(current);
  }

  async function start() {
    if (disposed) return status();
    if (session && ACTIVE_STATES.has(state)) return status();

    generation += 1;
    const startedAt = now();
    const current = {
      generation,
      controller: new AbortController(),
      timer: null,
      expiryTimer: null,
      key: '',
      workflowId: `qr-${generation}`,
      startedAt,
      expiresAt: startedAt + Math.max(1, ttlMs),
      cookieRevision: cookieRevision(),
    };
    session = current;
    state = 'starting';
    expiresAt = current.expiresAt;
    pngDataUrl = null;
    clearError();
    armExpiry(current);

    let generated;
    try {
      generated = await client.generateQr({
        signal: current.controller.signal,
        expiresAt: current.expiresAt,
      });
    } catch (error) {
      if (!isCurrent(current)) return status();
      if (error?.code === 'BILI_CANCELLED') {
        finish(current, 'idle');
        clearError();
        return status();
      }
      if (waitOutlivesQr(current, error, Number(error?.retryAfterMs) || 0)) {
        expire(current);
        return status();
      }
      const fields = applyError(error?.code, error?.retryAfterMs);
      finish(current, 'error');
      applyError(fields.errorCode, fields.retryAfterMs);
      return status();
    }
    if (!isCurrent(current)) return status();
    if (now() >= current.expiresAt) {
      expire(current);
      return status();
    }

    let png;
    try {
      png = qrEncode(generated.url);
    } catch {
      finish(current, 'error');
      applyError('BILI_RESPONSE');
      return status();
    }
    if (!isCurrent(current)) return status();
    if (now() >= current.expiresAt) {
      expire(current);
      return status();
    }

    current.key = String(generated.key);
    current.pngDataUrl = png;
    state = 'waiting';
    expiresAt = current.expiresAt;
    pngDataUrl = png;
    clearError();
    schedule(current);
    return status();
  }

  function cancel() {
    generation += 1;
    invalidateOperations();
    clearSession();
    clearError();
    state = 'cancelled';
    return status();
  }

  async function inspectCurrent({ withAccount }) {
    const cookie = String(settings.getBiliCookie?.() || '');
    if (!cookie) return { state: 'missing' };
    const cached = cachedInspection(cookie);
    if (cached) {
      if (!withAccount) settleExplicitSuccess();
      return withAccount
        ? { state: 'valid', mid: cached.mid, uname: cached.uname }
        : { state: 'valid' };
    }
    const op = beginOperation('inspect');
    let nav;
    try {
      nav = await client.nav(cookie, { signal: op.controller.signal });
    } catch (error) {
      const current = isOperationCurrent(op);
      finishOperation(op);
      if (!current || error?.code === 'BILI_CANCELLED') return { state: 'cancelled' };
      const fields = errorFields(error?.code, error?.retryAfterMs);
      if (fields.errorCode === 'BILI_AUTH') {
        clearInspectCache();
        return { state: 'invalid', ...fields };
      }
      return { state: 'error', ...fields };
    }
    const current = isOperationCurrent(op);
    finishOperation(op);
    if (!current) return { state: 'cancelled' };
    if (!nav || !nav.mid) return { state: 'error', ...errorFields('BILI_RESPONSE') };
    rememberInspection(cookie, nav);
    if (!withAccount) settleExplicitSuccess();
    if (!withAccount) return { state: 'valid' };
    return { state: 'valid', mid: nav.mid, uname: nav.uname || '' };
  }

  /**
   * Public-safe validation summary. Deliberately omits account UID/uname; panel
   * integration must only consume this whitelist.
   */
  function inspect() {
    return inspectCurrent({ withAccount: false });
  }

  /**
   * INTERNAL ONLY: service account-isolation verification. Never forward the
   * returned mid/uname to the panel or public status.
   */
  function inspectAccount() {
    return inspectCurrent({ withAccount: true });
  }

  async function manual(cookie) {
    const value = String(cookie ?? '').trim();
    const op = beginOperation('manual');
    if (!value) {
      finishOperation(op);
      return { ok: false, state: 'invalid', ...errorFields('BILI_AUTH') };
    }

    generation += 1;
    clearSession();
    state = 'idle';
    clearError();
    pngDataUrl = null;
    expiresAt = null;

    let nav;
    try {
      nav = await client.nav(value, { signal: op.controller.signal });
    } catch (error) {
      const current = isOperationCurrent(op);
      finishOperation(op);
      if (!current || error?.code === 'BILI_CANCELLED') return { ok: false, state: 'cancelled' };
      const fields = errorFields(error?.code, error?.retryAfterMs);
      applyError(fields.errorCode, fields.retryAfterMs);
      return {
        ok: false,
        state: fields.errorCode === 'BILI_AUTH' ? 'invalid' : 'error',
        ...fields,
      };
    }
    if (!isOperationCurrent(op)) {
      finishOperation(op);
      return { ok: false, state: 'cancelled' };
    }
    if (!nav || !nav.mid) {
      finishOperation(op);
      const fields = errorFields('BILI_RESPONSE');
      applyError(fields.errorCode);
      return { ok: false, state: 'error', ...fields };
    }

    internalChange = true;
    try {
      await settings.setBiliCookie(value, {
        guard: () => !disposed && isOperationCurrent(op),
      });
    } catch (error) {
      internalChange = false;
      const committedRevision = committedCredentialRevision(error);
      const current = committedRevision === null
        ? isOperationCurrent(op)
        : ownsCommittedRevision(op, committedRevision, value);
      finishOperation(op);
      if (!current) return { ok: false, state: 'cancelled' };
      const fields = errorFields('BILI_STORAGE');
      applyError(fields.errorCode);
      return { ok: false, state: 'error', ...fields };
    } finally {
      internalChange = false;
    }

    if (disposed || op.generation !== manualGeneration) {
      finishOperation(op);
      return { ok: false, state: 'cancelled' };
    }
    finishOperation(op);
    clearInspectCache();
    state = 'success';
    pngDataUrl = null;
    expiresAt = null;
    clearError();
    return { ok: true, state: 'valid' };
  }

  async function logout() {
    generation += 1;
    invalidateOperations();
    clearSession();
    clearInspectCache();
    clearError();
    try {
      await settings.clearBiliCookie({ guard: () => !disposed });
    } catch {
      if (disposed) return { ok: false, state: 'cancelled' };
      const fields = errorFields('BILI_STORAGE');
      applyError(fields.errorCode);
      state = 'error';
      return { ok: false, state: 'error', ...fields };
    }
    state = 'idle';
    pngDataUrl = null;
    expiresAt = null;
    clearError();
    return { ok: true, state: 'idle' };
  }

  function deactivate() {
    if (disposed) return status();
    disposed = true;
    generation += 1;
    invalidateOperations();
    clearSession();
    clearError();
    state = 'idle';
    try { unsubscribe(); } catch { /* ignore */ }
    return status();
  }

  return {
    start,
    status,
    cancel,
    inspect,
    inspectAccount,
    manual,
    logout,
    deactivate,
    flush: () => (typeof settings.flush === 'function' ? settings.flush() : Promise.resolve()),
    hasSession: () => Boolean(session),
  };
}

export { ACTIVE_STATES, defaultQr };
