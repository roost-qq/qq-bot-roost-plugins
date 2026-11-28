import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const DM_POLL_LIMITS = Object.freeze({
  defaultSeconds: 300,
  minSeconds: 180,
  maxSeconds: 3600,
});

const STATE_VERSION = 1;
const STATE_MAX_BYTES = 512 * 1024;
const WINDOW_MS = 60_000;
const TOTAL_WINDOW_LIMIT = 10;
const DATA_WINDOW_LIMIT = 6;
const MIN_SPACING_MS = 5_000;
const JITTER_MS = 2_000;
const RATE_LIMIT_WAITS_MS = Object.freeze([15 * 60_000, 30 * 60_000, 60 * 60_000]);
const TRANSIENT_WAIT_MS = 60_000;
const TRANSIENT_MAX_WAIT_MS = 15 * 60_000;
const MAX_ADAPTIVE_MULTIPLIER = 8;
const ADAPTIVE_SUCCESS_STEP = 5;
const RECOVERY_PROBE_TTL_MS = 15 * 60_000;
const RECOVERY_FAILURE_LIMIT = 3;
const PERSISTENT_REJECTION_LEVEL = 5;
const PROVIDERS = Object.freeze(['bilibili', 'xiaoheihe']);
const PROVIDER_SET = new Set(PROVIDERS);
const ACCOUNT_REF_RE = /^[a-f0-9]{32}$/;
const CREDENTIAL_REF_RE = /^[a-f0-9]{32,64}$/;
const WORKFLOW_REF_RE = /^[a-f0-9]{32,64}$/;
const REQUEST_KINDS = new Set(['data', 'control']);
const FAILURE_KINDS = new Set([
  'rate_limit', 'challenge', 'auth', 'timeout', 'network',
  'transient', 'response', 'api', 'rejected', 'cancelled',
]);
const SAFE_TEXT = Object.freeze({
  REQUEST_COOLDOWN: '请求仍在冷却，尚未允许访问平台。',
  REQUEST_BUDGET: '本轮请求预算已用完，稍后继续。',
  REQUEST_CANCELLED: '请求等待已取消。',
  REQUEST_DEADLINE: '请求已超过允许时限，未发送。',
  REQUEST_POLICY_UNAVAILABLE: '请求调度状态不可用，已安全暂停。',
  REQUEST_POLICY_CLOSED: '请求调度器已关闭。',
});
const STATE_REGISTRY_KEY = Symbol.for('roost.media-parser.request-policy.state.v2');
const ARBITER_REGISTRY_KEY = Symbol.for('roost.media-parser.request-policy.arbiter.v2');
const NOW_REGISTRY_KEY = Symbol.for('roost.media-parser.request-policy.now.v2');

export class RequestPolicyError extends Error {
  constructor(code, options = {}) {
    super(SAFE_TEXT[code] || SAFE_TEXT.REQUEST_POLICY_UNAVAILABLE);
    this.name = 'RequestPolicyError';
    this.code = code;
    this.nextAllowedAt = Number.isFinite(options.nextAllowedAt) ? options.nextAllowedAt : null;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : 0;
    this.releasedWorkflow = options.releasedWorkflow === true;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteTime(value, fallback = null) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boundedInteger(value, min, max, fallback = min) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function opaqueRef(value, length = 32) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function requireProvider(providerId) {
  const value = String(providerId ?? '');
  if (!PROVIDER_SET.has(value)) throw new TypeError('providerId is invalid');
  return value;
}

function requireAccount(accountKey) {
  const value = String(accountKey ?? '');
  if (!value || value.length > 512) throw new TypeError('accountKey is invalid');
  return value;
}

function requireRequestKey(requestKey) {
  const value = String(requestKey ?? '');
  if (!value || value.length > 1024) throw new TypeError('requestKey is invalid');
  return value;
}

function requireKind(kind) {
  const value = String(kind || 'data');
  if (!REQUEST_KINDS.has(value)) throw new TypeError('request kind is invalid');
  return value;
}

function stateRegistry() {
  if (!(globalThis[STATE_REGISTRY_KEY] instanceof Map)) {
    globalThis[STATE_REGISTRY_KEY] = new Map();
  }
  return globalThis[STATE_REGISTRY_KEY];
}

function arbiterRegistry() {
  if (!(globalThis[ARBITER_REGISTRY_KEY] instanceof Map)) {
    globalThis[ARBITER_REGISTRY_KEY] = new Map();
  }
  return globalThis[ARBITER_REGISTRY_KEY];
}

function nowIdentity(now) {
  if (now === Date.now) return 'default-date-now';
  if (!globalThis[NOW_REGISTRY_KEY] || typeof globalThis[NOW_REGISTRY_KEY] !== 'object') {
    globalThis[NOW_REGISTRY_KEY] = { ids: new WeakMap(), next: 1 };
  }
  const registry = globalThis[NOW_REGISTRY_KEY];
  let entry = registry.ids.get(now);
  if (!entry) {
    entry = `clock-${registry.next}`;
    registry.next += 1;
    registry.ids.set(now, entry);
  }
  return entry;
}

function emptyState() {
  return { schemaVersion: STATE_VERSION, providers: {} };
}

function emptyAccount() {
  return {
    credentialRef: null,
    hold: null,
    adaptiveMultiplier: 1,
    completeSuccesses: 0,
    consecutiveSyncSuccesses: 0,
    lastEffectiveSyncAt: null,
  };
}

function emptyProvider() {
  return {
    cooldown: null,
    rateLimitStreak: 0,
    failureLevel: 0,
    recoveryProbePending: false,
    recovery: null,
    recoveryFailures: 0,
    updatedAt: null,
    lastRequestAt: null,
    requestTimes: [],
    accounts: {},
  };
}

function normalizeHold(value) {
  if (value === null || value === undefined) return null;
  if (!isObject(value) || !['challenge', 'auth'].includes(value.reason)) {
    throw new Error('invalid account hold');
  }
  return {
    reason: value.reason,
    since: finiteTime(value.since, 0),
  };
}

function normalizeCooldown(value) {
  if (value === null || value === undefined) return null;
  if (!isObject(value) || !FAILURE_KINDS.has(value.reason)) throw new Error('invalid cooldown');
  return {
    reason: value.reason,
    until: value.until === null ? null : finiteTime(value.until),
    since: finiteTime(value.since, 0),
    manual: value.manual === true,
    serverUntil: value.serverUntil === undefined || value.serverUntil === null
      ? null : finiteTime(value.serverUntil),
  };
}

function normalizeRecovery(value) {
  if (value === null || value === undefined) return null;
  if (!isObject(value) || typeof value.workflowRef !== 'string' || !value.workflowRef) {
    throw new Error('invalid recovery probe');
  }
  const accountRef = value.accountRef === null || value.accountRef === undefined
    ? null : String(value.accountRef);
  if (accountRef !== null && !ACCOUNT_REF_RE.test(accountRef)) {
    throw new Error('invalid recovery account');
  }
  const credentialRef = value.credentialRef === null || value.credentialRef === undefined
    ? null : String(value.credentialRef);
  if (credentialRef !== null && !CREDENTIAL_REF_RE.test(credentialRef)) {
    throw new Error('invalid recovery credential');
  }
  return {
    workflowRef: String(value.workflowRef).slice(0, 64),
    accountRef,
    credentialRef,
    since: finiteTime(value.since, 0),
    expiresAt: finiteTime(value.expiresAt, 0),
  };
}

function normalizeRequestTimes(value) {
  if (!Array.isArray(value)) throw new Error('invalid request budget');
  if (value.length > 256) throw new Error('request budget is too large');
  return value.map((entry) => {
    if (!isObject(entry) || !Number.isFinite(entry.at) || !REQUEST_KINDS.has(entry.kind)) {
      throw new Error('invalid request entry');
    }
    return { at: Math.floor(entry.at), kind: entry.kind };
  });
}

function normalizeAccount(value) {
  if (!isObject(value)) throw new Error('invalid account state');
  const credentialRef = value.credentialRef === null || value.credentialRef === undefined
    ? null : String(value.credentialRef);
  if (credentialRef !== null && !CREDENTIAL_REF_RE.test(credentialRef)) {
    throw new Error('invalid credential reference');
  }
  return {
    credentialRef,
    hold: normalizeHold(value.hold),
    adaptiveMultiplier: boundedInteger(
      value.adaptiveMultiplier, 1, MAX_ADAPTIVE_MULTIPLIER, 1,
    ),
    completeSuccesses: boundedInteger(value.completeSuccesses, 0, 1_000_000, 0),
    consecutiveSyncSuccesses: boundedInteger(
      value.consecutiveSyncSuccesses, 0, ADAPTIVE_SUCCESS_STEP, 0,
    ),
    lastEffectiveSyncAt: finiteTime(value.lastEffectiveSyncAt),
  };
}

function normalizeProvider(value) {
  if (!isObject(value) || !isObject(value.accounts)) throw new Error('invalid provider state');
  const accounts = {};
  const entries = Object.entries(value.accounts);
  if (entries.length > 32) throw new Error('too many account scopes');
  for (const [ref, account] of entries) {
    if (!ACCOUNT_REF_RE.test(ref)) throw new Error('invalid account reference');
    accounts[ref] = normalizeAccount(account);
  }
  return {
    cooldown: normalizeCooldown(value.cooldown),
    rateLimitStreak: boundedInteger(value.rateLimitStreak, 0, 3, 0),
    failureLevel: boundedInteger(value.failureLevel, 0, 20, 0),
    recoveryProbePending: value.recoveryProbePending === true,
    recovery: normalizeRecovery(value.recovery),
    recoveryFailures: boundedInteger(value.recoveryFailures, 0, 100, 0),
    updatedAt: finiteTime(value.updatedAt),
    lastRequestAt: finiteTime(value.lastRequestAt),
    requestTimes: normalizeRequestTimes(value.requestTimes || []),
    accounts,
  };
}

function normalizeState(value) {
  if (!isObject(value) || value.schemaVersion !== STATE_VERSION || !isObject(value.providers)) {
    throw new Error('unsupported state');
  }
  const providers = {};
  const entries = Object.entries(value.providers);
  if (entries.length > PROVIDERS.length) throw new Error('too many providers');
  for (const [providerId, provider] of entries) {
    if (!PROVIDER_SET.has(providerId)) throw new Error('invalid provider');
    providers[providerId] = normalizeProvider(provider);
  }
  return { schemaVersion: STATE_VERSION, providers };
}

function getProvider(state, providerId, create = false) {
  if (!state.providers[providerId] && create) {
    state.providers[providerId] = emptyProvider();
  }
  return state.providers[providerId] || null;
}

function getAccount(provider, accountRef, create = false) {
  if (!provider.accounts[accountRef] && create) {
    if (Object.keys(provider.accounts).length >= 32) {
      throw new RequestPolicyError('REQUEST_POLICY_UNAVAILABLE');
    }
    provider.accounts[accountRef] = emptyAccount();
  }
  return provider.accounts[accountRef] || null;
}

function blockState(arbiter, account, now) {
  const cooldown = arbiter.cooldown;
  if (cooldown && (cooldown.until === null || now < cooldown.until)) {
    return {
      reason: cooldown.reason,
      since: cooldown.since,
      until: cooldown.until,
      manual: cooldown.manual,
      scope: 'provider',
    };
  }
  const hold = account?.hold || null;
  if (hold) {
    return {
      reason: hold.reason,
      since: hold.since,
      until: null,
      manual: false,
      scope: 'account',
    };
  }
  return null;
}

function errorFromBlock(block, now) {
  const until = block.until;
  return new RequestPolicyError('REQUEST_COOLDOWN', {
    nextAllowedAt: until,
    retryAfterMs: until === null ? 0 : Math.max(0, until - now),
  });
}

function errorFromBudget(nextAllowedAt, now) {
  return new RequestPolicyError('REQUEST_BUDGET', {
    nextAllowedAt,
    retryAfterMs: Math.max(0, nextAllowedAt - now),
  });
}

function errorFromDeadline(deadline) {
  return new RequestPolicyError('REQUEST_DEADLINE', {
    nextAllowedAt: deadline,
    retryAfterMs: 0,
  });
}

function parseRetryAfterValue(value, now) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value * 1000) : 0;
  }
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds)) return Number.MAX_SAFE_INTEGER;
    return seconds * 1000;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

export function parseRetryAfter(value, { now = Date.now() } = {}) {
  return parseRetryAfterValue(value, Number.isFinite(now) ? now : Date.now());
}

export function migratePollSeconds(value, {
  previousMinSeconds = 60,
  previousMaxSeconds = 1800,
} = {}) {
  const original = Number(value);
  if (!Number.isFinite(original) || original <= 0) {
    return {
      seconds: DM_POLL_LIMITS.defaultSeconds,
      migrated: value !== undefined && value !== null,
      originalSeconds: Number.isFinite(original) ? original : null,
      previousRange: [previousMinSeconds, previousMaxSeconds],
    };
  }
  const rounded = Math.floor(original);
  let seconds = rounded;
  if (seconds < DM_POLL_LIMITS.minSeconds) seconds = DM_POLL_LIMITS.defaultSeconds;
  else if (seconds > DM_POLL_LIMITS.maxSeconds) seconds = DM_POLL_LIMITS.maxSeconds;
  return {
    seconds,
    migrated: seconds !== original,
    originalSeconds: original,
    previousRange: [previousMinSeconds, previousMaxSeconds],
  };
}

export function classifyRequestFailure(error, {
  now = Date.now(),
  providerId = '',
  challengeStatuses = [],
  rateLimitStatuses = [429],
} = {}) {
  const value = error && typeof error === 'object' ? error : {};
  const code = String(value.code || '');
  const status = Number.isFinite(value.status) ? value.status : 0;
  const apiCode = Number.isFinite(value.apiCode) ? value.apiCode : 0;
  const retryAfterMs = Number.isFinite(value.retryAfterMs)
    ? Math.max(0, value.retryAfterMs) : 0;
  let kind = 'rejected';
  if (code === 'BILI_CANCELLED' || code === 'XHH_CANCELLED'
    || value.name === 'AbortError' || code === 'REQUEST_CANCELLED') kind = 'cancelled';
  else if (code === 'BILI_RATE_LIMIT' || code === 'XHH_RATE_LIMIT'
    || rateLimitStatuses.includes(status)) kind = 'rate_limit';
  else if (code === 'BILI_AUTH' || code === 'XHH_AUTH') kind = 'auth';
  else if (code === 'BILI_RISK' || code === 'XHH_RISK'
    || (providerId === 'bilibili' && apiCode === -412)) kind = 'rejected';
  else if (code === 'BILI_TIMEOUT' || code === 'XHH_TIMEOUT') kind = 'timeout';
  else if (code === 'BILI_NETWORK' || code === 'XHH_NETWORK') kind = 'network';
  else if (code === 'BILI_CHALLENGE' || code === 'XHH_CHALLENGE'
    || challengeStatuses.includes(status)) kind = 'challenge';
  else if ((code === 'BILI_HTTP' || code === 'XHH_HTTP') && status >= 500) kind = 'transient';
  else if (code === 'BILI_RESPONSE' || code === 'XHH_RESPONSE') kind = 'response';
  else if (code === 'BILI_API' || code === 'XHH_API') kind = 'api';
  return { kind, retryAfterMs, status, apiCode, at: finiteTime(now) ?? Date.now() };
}

function normalizeFailureKind(value, error) {
  if (value) {
    if (!FAILURE_KINDS.has(value)) throw new TypeError('failure kind is invalid');
    return value;
  }
  return classifyRequestFailure(error).kind;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestPolicyError('REQUEST_CANCELLED'));
      return;
    }
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new RequestPolicyError('REQUEST_CANCELLED'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RequestPolicyError('REQUEST_CANCELLED'));
      return;
    }
    const abort = () => reject(new RequestPolicyError('REQUEST_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function coordinatorFor(stateFile) {
  const registry = stateRegistry();
  let coordinator = registry.get(stateFile);
  if (!coordinator) {
    coordinator = {
      stateFile,
      state: emptyState(),
      loadPromise: null,
      loadFailure: null,
      commitTail: Promise.resolve(),
      hydratedArbiters: new Set(),
    };
    registry.set(stateFile, coordinator);
  }
  if (!(coordinator.hydratedArbiters instanceof Set)) coordinator.hydratedArbiters = new Set();
  return coordinator;
}

function arbiterFor(scopeKey, providerId) {
  const registry = arbiterRegistry();
  const key = `${scopeKey}:${providerId}`;
  let arbiter = registry.get(key);
  if (!arbiter) {
    arbiter = {
      key,
      requestTimes: [],
      lastRequestAt: null,
      cooldown: null,
      rateLimitStreak: 0,
      failureLevel: 0,
      recoveryProbePending: false,
      recovery: null,
      recoveryFailures: 0,
      updatedAt: 0,
      tail: Promise.resolve(),
      inFlight: new Map(),
    };
    registry.set(key, arbiter);
  }
  return arbiter;
}

function sortTimes(times) {
  return times.sort((left, right) => left.at - right.at);
}

function cooldownScore(value) {
  if (!value) return -1;
  if (value.manual) return Number.MAX_SAFE_INTEGER;
  return value.until === null ? Number.MAX_SAFE_INTEGER : value.until;
}

function mergeCooldown(existing, next) {
  if (!next) return existing;
  if (!existing) return { ...next };
  const existingScore = cooldownScore(existing);
  const nextScore = cooldownScore(next);
  const base = nextScore > existingScore ? next : existing;
  const serverUntil = [existing.serverUntil, next.serverUntil]
    .filter((value) => value !== null && value !== undefined)
    .reduce((left, right) => Math.max(left, right), 0) || null;
  return { ...base, serverUntil };
}

function mergeRecovery(existing, next) {
  if (!next) return existing;
  if (!existing) return { ...next };
  return next.expiresAt > existing.expiresAt ? { ...next } : existing;
}

function enqueueArbiter(arbiter, task) {
  const result = arbiter.tail.then(task);
  arbiter.tail = result.catch(() => {});
  return result;
}

export function createPrivateMessageRequestPolicy({
  statePath,
  now = Date.now,
  random = Math.random,
  sleep = defaultSleep,
  concurrency = 1,
  originKey = '',
} = {}) {
  if (typeof statePath !== 'string' || !statePath.trim()) {
    throw new TypeError('statePath is required');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof random !== 'function') throw new TypeError('random must be a function');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  if (concurrency !== 1) throw new RangeError('concurrency must be 1');

  const stateFile = path.resolve(statePath);
  const coordinator = coordinatorFor(stateFile);
  const scopeKey = String(originKey || nowIdentity(now));
  const instanceId = {};
  const instanceWaiters = new Set();
  const instanceEntries = new Set();
  const instancePromises = new Set();
  let closed = false;
  let draining = false;

  function clock() {
    const value = Number(now());
    return Number.isFinite(value) ? Math.floor(value) : Date.now();
  }

  async function load() {
    if (coordinator.loadPromise) return coordinator.loadPromise;
    coordinator.loadPromise = (async () => {
      try {
        const text = await fs.readFile(stateFile, 'utf8');
        if (Buffer.byteLength(text, 'utf8') > STATE_MAX_BYTES) throw new Error('state too large');
        const parsed = JSON.parse(text);
        if (isObject(parsed) && Number.isInteger(parsed.schemaVersion)
          && parsed.schemaVersion > STATE_VERSION) {
          coordinator.loadFailure = 'unsupported';
          return;
        }
        coordinator.state = normalizeState(parsed);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          coordinator.state = emptyState();
          return;
        }
        coordinator.loadFailure = error instanceof SyntaxError || !error?.code
          ? 'corrupt' : 'read_failed';
        coordinator.state = emptyState();
      }
    })();
    return coordinator.loadPromise;
  }

  async function persist() {
    if (coordinator.loadFailure) throw new RequestPolicyError('REQUEST_POLICY_UNAVAILABLE');
    const dir = path.dirname(stateFile);
    const temp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(temp, `${JSON.stringify(coordinator.state, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600,
      });
      await fs.rename(temp, stateFile);
    } catch {
      coordinator.loadFailure = 'write_failed';
      throw new RequestPolicyError('REQUEST_POLICY_UNAVAILABLE');
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  function hydrateArbiter(arbiter, providerId, at) {
    const hydrationKey = arbiter.key;
    if (coordinator.hydratedArbiters.has(hydrationKey)) return;
    coordinator.hydratedArbiters.add(hydrationKey);
    const provider = coordinator.state.providers[providerId] || null;
    if (!provider) return;
    const merged = new Map();
    for (const entry of arbiter.requestTimes) merged.set(`${entry.at}:${entry.kind}`, entry);
    for (const entry of provider.requestTimes) {
      if (entry.at > at - WINDOW_MS) merged.set(`${entry.at}:${entry.kind}`, entry);
    }
    arbiter.requestTimes = sortTimes([...merged.values()]);
    const storedLast = finiteTime(provider.lastRequestAt);
    if (storedLast !== null
      && (arbiter.lastRequestAt === null || storedLast > arbiter.lastRequestAt)) {
      arbiter.lastRequestAt = storedLast;
    }
    const storedUpdated = finiteTime(provider.updatedAt, 0);
    if (storedUpdated > arbiter.updatedAt) {
      arbiter.cooldown = provider.cooldown ? { ...provider.cooldown } : null;
      arbiter.recovery = provider.recovery ? { ...provider.recovery } : null;
      arbiter.recoveryProbePending = provider.recoveryProbePending === true;
      arbiter.recoveryFailures = provider.recoveryFailures || 0;
      arbiter.rateLimitStreak = provider.rateLimitStreak || 0;
      arbiter.failureLevel = provider.failureLevel || 0;
      arbiter.updatedAt = storedUpdated;
      return;
    }
    arbiter.cooldown = mergeCooldown(arbiter.cooldown, provider.cooldown);
    arbiter.recovery = mergeRecovery(arbiter.recovery, provider.recovery);
    arbiter.recoveryProbePending = arbiter.recoveryProbePending
      || provider.recoveryProbePending === true;
    arbiter.recoveryFailures = Math.max(arbiter.recoveryFailures, provider.recoveryFailures || 0);
    arbiter.rateLimitStreak = Math.max(arbiter.rateLimitStreak, provider.rateLimitStreak || 0);
    arbiter.failureLevel = Math.max(arbiter.failureLevel, provider.failureLevel || 0);
  }

  function syncArbiterToProvider(provider, arbiter, at) {
    const stamp = Math.max(at, arbiter.updatedAt + 1);
    arbiter.updatedAt = stamp;
    provider.cooldown = arbiter.cooldown ? { ...arbiter.cooldown } : null;
    provider.rateLimitStreak = arbiter.rateLimitStreak;
    provider.failureLevel = arbiter.failureLevel;
    provider.recoveryProbePending = arbiter.recoveryProbePending;
    provider.recovery = arbiter.recovery ? { ...arbiter.recovery } : null;
    provider.recoveryFailures = arbiter.recoveryFailures;
    provider.updatedAt = stamp;
    provider.lastRequestAt = arbiter.lastRequestAt;
    provider.requestTimes = arbiter.requestTimes.map((entry) => ({ ...entry }));
  }

  function commit(providerId, arbiter, mutator) {
    const result = coordinator.commitTail.then(async () => {
      await load();
      if (coordinator.loadFailure) throw new RequestPolicyError('REQUEST_POLICY_UNAVAILABLE');
      const at = clock();
      hydrateArbiter(arbiter, providerId, at);
      const provider = getProvider(coordinator.state, providerId, true);
      const value = mutator(coordinator.state, at);
      syncArbiterToProvider(provider, arbiter, at);
      await persist();
      return value;
    });
    coordinator.commitTail = result.catch(() => {});
    return result;
  }

  async function ensureReady() {
    await load();
    if (coordinator.loadFailure) throw new RequestPolicyError('REQUEST_POLICY_UNAVAILABLE');
    if (closed || draining) throw new RequestPolicyError('REQUEST_POLICY_CLOSED');
  }

  function credentialRefOf(value) {
    return value === undefined || value === null || value === ''
      ? null : opaqueRef(value);
  }

  function accountRefOf(accountKey) {
    return opaqueRef(requireAccount(accountKey));
  }

  function workflowRefOf(value) {
    if (value === undefined || value === null || value === '') return null;
    return opaqueRef(value);
  }

  function applyCredentialChange(account, credentialRef) {
    if (!account || !credentialRef) return;
    if (account.credentialRef && account.credentialRef !== credentialRef) account.hold = null;
    account.credentialRef = credentialRef;
  }

  function setArbiterCooldown(arbiter, reason, until, at, { manual = false, serverUntil = null } = {}) {
    arbiter.cooldown = {
      reason,
      until,
      since: at,
      manual,
      serverUntil: serverUntil === null ? null : finiteTime(serverUntil),
    };
    arbiter.recoveryProbePending = false;
    arbiter.recovery = null;
  }

  function existingServerUntil(arbiter) {
    return finiteTime(arbiter.cooldown?.serverUntil);
  }

  function planReservation(state, arbiter, scope, input, kind, jitterMs, at) {
    const providerId = requireProvider(scope.providerId);
    const accountKey = requireAccount(scope.accountKey);
    const accountRef = accountRefOf(accountKey);
    const credentialRef = credentialRefOf(scope.credentialVersion);
    const provider = getProvider(state, providerId, true);
    const account = getAccount(provider, accountRef, true);
    applyCredentialChange(account, credentialRef);

    const deadline = finiteTime(input?.expiresAt);
    if (deadline !== null && at >= deadline) return { deadline };

    arbiter.requestTimes = sortTimes(arbiter.requestTimes
      .filter((entry) => entry.at > at - WINDOW_MS));
    const block = blockState(arbiter, account, at);
    if (block) {
      if (deadline !== null && block.until !== null && block.until >= deadline) {
        return { deadline };
      }
      return { blocked: block };
    }

    const last = finiteTime(arbiter.lastRequestAt);
    if (last !== null && at < last + MIN_SPACING_MS + jitterMs) {
      const readyAt = last + MIN_SPACING_MS + jitterMs;
      if (deadline !== null && readyAt >= deadline) return { deadline };
      return { waitMs: readyAt - at };
    }

    if (arbiter.requestTimes.length >= TOTAL_WINDOW_LIMIT) {
      const budgetAt = arbiter.requestTimes[0].at + WINDOW_MS;
      if (deadline !== null && budgetAt >= deadline) return { deadline };
      return { budgetAt };
    }
    const dataTimes = arbiter.requestTimes.filter((entry) => entry.kind === 'data');
    if (kind === 'data' && dataTimes.length >= DATA_WINDOW_LIMIT) {
      const budgetAt = dataTimes[0].at + WINDOW_MS;
      if (deadline !== null && budgetAt >= deadline) return { deadline };
      return { budgetAt };
    }

    let recoveryAttempt = false;
    const cooldownExpired = arbiter.cooldown && arbiter.cooldown.until !== null
      && at >= arbiter.cooldown.until;
    if (cooldownExpired) {
      const workflowRef = workflowRefOf(input?.workflowId);
      const recovery = arbiter.recovery;
      const active = recovery && at < recovery.expiresAt;
      if (kind === 'data') {
        if (!workflowRef) {
          return {
            blocked: {
              reason: 'recovery_required',
              since: arbiter.cooldown.since,
              until: null,
              manual: false,
              scope: 'provider',
            },
          };
        }
        if (recovery && recovery.workflowRef === workflowRef) {
          const sameAccount = !recovery.accountRef || recovery.accountRef === accountRef;
          if (!sameAccount) {
            if (deadline !== null && recovery.expiresAt >= deadline) return { deadline };
            return {
              blocked: {
                reason: 'recovery_probe',
                since: recovery.since,
                until: recovery.expiresAt,
                manual: false,
                scope: 'provider',
              },
            };
          }
          recovery.expiresAt = at + RECOVERY_PROBE_TTL_MS;
          recoveryAttempt = true;
        } else if (active) {
          if (deadline !== null && recovery.expiresAt >= deadline) return { deadline };
          return {
            blocked: {
              reason: 'recovery_probe',
              since: recovery.since,
              until: recovery.expiresAt,
              manual: false,
              scope: 'provider',
            },
          };
        } else {
          arbiter.recovery = {
            workflowRef,
            accountRef,
            credentialRef,
            since: at,
            expiresAt: at + RECOVERY_PROBE_TTL_MS,
          };
          arbiter.recoveryProbePending = true;
          recoveryAttempt = true;
        }
      } else if (recovery) {
        if (workflowRef && recovery.workflowRef === workflowRef) {
          const sameAccount = !recovery.accountRef || recovery.accountRef === accountRef;
          if (sameAccount) {
            recovery.expiresAt = at + RECOVERY_PROBE_TTL_MS;
            recoveryAttempt = true;
          } else if (active) {
            if (deadline !== null && recovery.expiresAt >= deadline) return { deadline };
            return {
              blocked: {
                reason: 'recovery_probe',
                since: recovery.since,
                until: recovery.expiresAt,
                manual: false,
                scope: 'provider',
              },
            };
          }
        } else if (active) {
          if (deadline !== null && recovery.expiresAt >= deadline) return { deadline };
          return {
            blocked: {
              reason: 'recovery_probe',
              since: recovery.since,
              until: recovery.expiresAt,
              manual: false,
              scope: 'provider',
            },
          };
        }
      }
    }

    arbiter.lastRequestAt = at;
    arbiter.requestTimes.push({ at, kind });
    return {
      reserved: true,
      at,
      recoveryAttempt,
      accountRef,
      credentialRef,
      workflowRef: workflowRefOf(input?.workflowId),
    };
  }

  async function wait(ms, signal, deadline) {
    if (!(ms > 0)) return;
    if (signal?.aborted) throw new RequestPolicyError('REQUEST_CANCELLED');
    if (deadline !== null && clock() + ms >= deadline) throw errorFromDeadline(deadline);
    await sleep(ms, signal);
    if (signal?.aborted) throw new RequestPolicyError('REQUEST_CANCELLED');
    if (deadline !== null && clock() >= deadline) throw errorFromDeadline(deadline);
  }

  function attachWaiter(entry, signal) {
    if (signal?.aborted) return null;
    const waiter = { owner: instanceId, signal, abort: null };
    waiter.abort = () => {
      entry.waiters.delete(waiter);
      instanceWaiters.delete(waiter);
      signal?.removeEventListener('abort', waiter.abort);
      if (entry.waiters.size === 0) {
        try { entry.controller.abort(); } catch { /* ignore */ }
      }
    };
    if (signal) signal.addEventListener('abort', waiter.abort, { once: true });
    entry.waiters.add(waiter);
    instanceWaiters.add(waiter);
    return waiter;
  }

  function detachWaiter(entry, waiter) {
    if (!waiter) return;
    entry.waiters.delete(waiter);
    instanceWaiters.delete(waiter);
    waiter.signal?.removeEventListener('abort', waiter.abort);
  }

  function trackInstance(promise) {
    instancePromises.add(promise);
    promise.finally(() => instancePromises.delete(promise)).catch(() => {});
    return promise;
  }

  function reserve(arbiter, scope, input, kind, signal) {
    const jitter = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * (JITTER_MS + 1));
    const deadline = finiteTime(input?.expiresAt);
    return (async () => {
      while (true) {
        if (signal?.aborted) throw new RequestPolicyError('REQUEST_CANCELLED');
        if (deadline !== null && clock() >= deadline) throw errorFromDeadline(deadline);
        const plan = await commit(scope.providerId, arbiter, (state, at) => (
          planReservation(state, arbiter, scope, input, kind, jitter, at)
        ));
        if (plan.reserved) return plan;
        if (plan.deadline !== undefined) throw errorFromDeadline(plan.deadline);
        if (plan.blocked) throw errorFromBlock(plan.blocked, clock());
        if (plan.budgetAt !== undefined) throw errorFromBudget(plan.budgetAt, clock());
        await wait(plan.waitMs, signal, deadline);
      }
    })();
  }

  function applyFailure(state, arbiter, input, error, at, recoveryAttempt) {
    const providerId = requireProvider(input?.providerId);
    const accountKey = requireAccount(input?.accountKey);
    const accountRef = accountRefOf(accountKey);
    const credentialRef = credentialRefOf(input?.credentialVersion);
    const kind = normalizeFailureKind(input?.kind, error);
    if (kind === 'cancelled') return { kind, recorded: false };
    const retryAfterMs = Number.isFinite(input?.retryAfterMs)
      ? Math.max(0, input.retryAfterMs)
      : Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
    const provider = getProvider(state, providerId, true);
    const account = getAccount(provider, accountRef, true);
    if (credentialRef && account.credentialRef !== credentialRef) {
      account.hold = null;
    }
    account.consecutiveSyncSuccesses = 0;

    if (recoveryAttempt) {
      arbiter.recoveryFailures = Math.min(100, arbiter.recoveryFailures + 1);
    } else if (kind === 'rate_limit') {
      arbiter.recoveryFailures = 0;
    }
    const recoveryManual = arbiter.recoveryFailures >= RECOVERY_FAILURE_LIMIT;
    const previousServerUntil = existingServerUntil(arbiter);

    if (kind === 'rate_limit') {
      arbiter.rateLimitStreak = Math.min(3, arbiter.rateLimitStreak + 1);
      arbiter.failureLevel = Math.min(MAX_ADAPTIVE_MULTIPLIER, arbiter.failureLevel + 1);
      account.adaptiveMultiplier = Math.min(
        MAX_ADAPTIVE_MULTIPLIER, Math.max(2, account.adaptiveMultiplier * 2),
      );
      const local = RATE_LIMIT_WAITS_MS[Math.min(arbiter.rateLimitStreak - 1, 2)];
      const waitMs = Math.max(local, retryAfterMs);
      const manual = recoveryManual;
      const serverUntil = [previousServerUntil, retryAfterMs > 0 ? at + retryAfterMs : null]
        .filter((value) => value !== null)
        .reduce((left, right) => Math.max(left, right), 0) || null;
      setArbiterCooldown(
        arbiter, kind, manual ? null : at + waitMs, at,
        { manual, serverUntil },
      );
    } else if (kind === 'challenge' || kind === 'auth') {
      account.hold = { reason: kind, since: at };
      arbiter.recoveryProbePending = false;
      arbiter.recovery = null;
    } else {
      arbiter.failureLevel = Math.min(
        MAX_ADAPTIVE_MULTIPLIER, arbiter.failureLevel + 1,
      );
      account.adaptiveMultiplier = Math.min(
        MAX_ADAPTIVE_MULTIPLIER, Math.max(2, account.adaptiveMultiplier * 2),
      );
      let local;
      if (kind === 'timeout' || kind === 'network' || kind === 'transient') {
        local = Math.min(
          TRANSIENT_MAX_WAIT_MS,
          TRANSIENT_WAIT_MS * (2 ** Math.max(0, arbiter.failureLevel - 1)),
        );
      } else {
        local = RATE_LIMIT_WAITS_MS[0];
      }
      const persistent = ['response', 'rejected', 'api'].includes(kind)
        && arbiter.failureLevel >= PERSISTENT_REJECTION_LEVEL;
      const manual = recoveryManual || persistent;
      const serverUntil = [previousServerUntil, retryAfterMs > 0 ? at + retryAfterMs : null]
        .filter((value) => value !== null)
        .reduce((left, right) => Math.max(left, right), 0) || null;
      setArbiterCooldown(
        arbiter, kind, manual ? null : at + Math.max(local, retryAfterMs), at,
        { manual, serverUntil },
      );
    }
    const nextAllowedAt = arbiter.cooldown && !arbiter.cooldown.manual
      ? arbiter.cooldown.until : null;
    return {
      kind,
      recorded: true,
      at,
      retryAfterMs,
      nextAllowedAt,
      recoveryAttempt,
      recoveryFailures: arbiter.recoveryFailures,
      requiresManualRecovery: arbiter.cooldown?.manual === true,
    };
  }

  async function recordFailure(input = {}) {
    await ensureReady();
    const providerId = requireProvider(input?.providerId);
    const arbiter = arbiterFor(scopeKey, providerId);
    return commit(providerId, arbiter, (state, at) => (
      applyFailure(state, arbiter, input, null, at, input.recoveryAttempt === true)
    ));
  }

  function scopeOf(state, input, create = false) {
    const providerId = requireProvider(input?.providerId);
    const accountKey = requireAccount(input?.accountKey);
    const accountRef = accountRefOf(accountKey);
    const credentialRef = credentialRefOf(input?.credentialVersion);
    const provider = getProvider(state, providerId, create);
    const account = provider ? getAccount(provider, accountRef, create) : null;
    return { providerId, accountKey, accountRef, credentialRef, provider, account };
  }

  async function recordSyncSuccess(input = {}) {
    await ensureReady();
    const providerId = requireProvider(input?.providerId);
    const arbiter = arbiterFor(scopeKey, providerId);
    return commit(providerId, arbiter, (state, at) => {
      const scope = scopeOf(state, input, true);
      const { provider, account } = scope;
      if (input.credentialVersion === undefined || input.credentialVersion === null
        || input.credentialVersion === '') {
        // A complete sync without a credential fingerprint cannot clear rejection history.
      } else if (account.credentialRef !== null
        && account.credentialRef !== scope.credentialRef) {
        return { recorded: false, staleCredential: true };
      }
      if (arbiter.cooldown) {
        if (arbiter.cooldown.manual) return { recorded: false, manual: true };
        if (arbiter.cooldown.until !== null && at < arbiter.cooldown.until) {
          return { recorded: false, cooling: true };
        }
        if (!scope.credentialRef) return { recorded: false, staleCredential: true };
        if (account.credentialRef !== null
          && account.credentialRef !== scope.credentialRef) {
          return { recorded: false, staleCredential: true };
        }
        const workflowRef = workflowRefOf(input.workflowId);
        if (!workflowRef) return { recorded: false, workflowRequired: true };
        const recovery = arbiter.recovery;
        if (!recovery
          || recovery.workflowRef !== workflowRef
          || (recovery.accountRef && recovery.accountRef !== scope.accountRef)
          || (recovery.credentialRef && recovery.credentialRef !== scope.credentialRef)
          || at > recovery.expiresAt) {
          return { recorded: false, staleWorkflow: true };
        }
      }
      if (scope.credentialRef) applyCredentialChange(account, scope.credentialRef);
      arbiter.cooldown = null;
      arbiter.recovery = null;
      arbiter.recoveryProbePending = false;
      arbiter.recoveryFailures = 0;
      arbiter.rateLimitStreak = 0;
      arbiter.failureLevel = 0;
      account.hold = null;
      account.completeSuccesses += 1;
      account.lastEffectiveSyncAt = at;
      account.consecutiveSyncSuccesses = Math.min(
        ADAPTIVE_SUCCESS_STEP, account.consecutiveSyncSuccesses + 1,
      );
      if (account.consecutiveSyncSuccesses >= ADAPTIVE_SUCCESS_STEP) {
        account.adaptiveMultiplier = Math.max(1, Math.floor(account.adaptiveMultiplier / 2));
        account.consecutiveSyncSuccesses = 0;
      }
      return {
        recorded: true,
        at,
        adaptiveMultiplier: account.adaptiveMultiplier,
      };
    });
  }

  async function recordCredentialChange(input = {}) {
    await ensureReady();
    const providerId = requireProvider(input.providerId);
    const arbiter = arbiterFor(scopeKey, providerId);
    return commit(providerId, arbiter, (state) => {
      const accountRef = accountRefOf(requireAccount(input.accountKey));
      const provider = getProvider(state, providerId, true);
      const account = getAccount(provider, accountRef, true);
      const nextRef = input.credentialVersionHash
        ? opaqueRef(input.credentialVersionHash)
        : input.credentialVersion !== undefined && input.credentialVersion !== null
          ? opaqueRef(input.credentialVersion)
          : null;
      const changed = account.credentialRef !== null
        && nextRef !== null && account.credentialRef !== nextRef;
      const hadHold = account.hold !== null;
      if (nextRef !== null) account.credentialRef = nextRef;
      if (changed) {
        account.hold = null;
        account.consecutiveSyncSuccesses = 0;
        if (arbiter.recovery && arbiter.recovery.credentialRef
          && arbiter.recovery.credentialRef !== nextRef) {
          arbiter.recovery = null;
          arbiter.recoveryProbePending = false;
        }
      }
      return { changed, holdCleared: changed && hadHold };
    });
  }

  async function clearManualRecovery(input = {}) {
    await ensureReady();
    const providerId = requireProvider(input.providerId);
    const arbiter = arbiterFor(scopeKey, providerId);
    return commit(providerId, arbiter, (state, at) => {
      if (!arbiter.cooldown || !arbiter.cooldown.manual) return { cleared: false };
      const serverUntil = finiteTime(arbiter.cooldown.serverUntil);
      const nextAllowedAt = serverUntil !== null && serverUntil > at ? serverUntil : at;
      const reason = arbiter.cooldown.reason;
      arbiter.cooldown = {
        reason,
        until: nextAllowedAt,
        since: at,
        manual: false,
        serverUntil,
      };
      arbiter.recovery = null;
      arbiter.recoveryProbePending = false;
      arbiter.recoveryFailures = 0;
      arbiter.rateLimitStreak = 0;
      arbiter.failureLevel = 0;
      return {
        cleared: true,
        released: 'one-recovery-workflow',
        nextAllowedAt,
        serverUntil,
      };
    });
  }

  async function run(input, task) {
    if (typeof task !== 'function') throw new TypeError('task must be a function');
    await ensureReady();
    if (closed) throw new RequestPolicyError('REQUEST_POLICY_CLOSED');
    const providerId = requireProvider(input?.providerId);
    const accountKey = requireAccount(input?.accountKey);
    const requestKey = requireRequestKey(input?.requestKey);
    const kind = requireKind(input?.kind);
    const signal = input?.signal;
    const deadline = finiteTime(input?.expiresAt);
    if (signal?.aborted) throw new RequestPolicyError('REQUEST_CANCELLED');
    if (deadline !== null && clock() >= deadline) throw errorFromDeadline(deadline);

    const arbiter = arbiterFor(scopeKey, providerId);
    hydrateArbiter(arbiter, providerId, clock());
    const scope = {
      providerId,
      accountKey,
      credentialVersion: input.credentialVersion,
      workflowId: input.workflowId,
    };
    const workflowRef = workflowRefOf(input.workflowId);
    const recoverySensitive = arbiter.cooldown !== null;
    const duplicateKey = JSON.stringify([
      providerId,
      accountRefOf(accountKey),
      credentialRefOf(input.credentialVersion),
      recoverySensitive ? workflowRef : null,
      requestKey,
      kind,
    ]);
    const existing = arbiter.inFlight.get(duplicateKey);
    if (existing) {
      const waiter = attachWaiter(existing, signal);
      if (!waiter) throw new RequestPolicyError('REQUEST_CANCELLED');
      return trackInstance(abortable(existing.promise, signal).finally(() => {
        detachWaiter(existing, waiter);
      }));
    }

    const entry = {
      controller: new AbortController(),
      waiters: new Set(),
      promise: null,
      owner: instanceId,
    };
    const waiter = attachWaiter(entry, signal);
    if (!waiter) throw new RequestPolicyError('REQUEST_CANCELLED');
    instanceEntries.add(entry);
    const promise = enqueueArbiter(arbiter, async () => {
      const plan = await reserve(arbiter, scope, input, kind, entry.controller.signal);
      if (entry.controller.signal.aborted) throw new RequestPolicyError('REQUEST_CANCELLED');
      if (deadline !== null && clock() >= deadline) throw errorFromDeadline(deadline);
      const dispatchAt = clock();
      if (plan.reserved && dispatchAt > plan.at) {
        for (let index = arbiter.requestTimes.length - 1; index >= 0; index -= 1) {
          const recorded = arbiter.requestTimes[index];
          if (recorded.at === plan.at && recorded.kind === kind) {
            recorded.at = dispatchAt;
            break;
          }
        }
        arbiter.lastRequestAt = dispatchAt;
        plan.at = dispatchAt;
      }
      try {
        return await task(entry.controller.signal, plan);
      } catch (error) {
        const classified = classifyRequestFailure(error, {
          now: clock(),
          providerId,
          rateLimitStatuses: input.rateLimitStatuses || [429],
          challengeStatuses: input.challengeStatuses || [],
        });
        if (classified.kind !== 'cancelled') {
          try {
            await recordFailure({
              providerId,
              accountKey,
              credentialVersion: input.credentialVersion,
              kind: classified.kind,
              retryAfterMs: classified.retryAfterMs,
              status: classified.status,
              apiCode: classified.apiCode,
              recoveryAttempt: plan.recoveryAttempt === true,
            });
            if (error && typeof error === 'object') {
              Object.defineProperty(error, 'requestPolicyRecorded', {
                value: true, enumerable: false, configurable: true,
              });
            }
          } catch { /* state is already paused when persistence fails */ }
        }
        throw error;
      }
    });
    entry.promise = promise;
    arbiter.inFlight.set(duplicateKey, entry);
    promise.finally(() => {
      instanceEntries.delete(entry);
      if (arbiter.inFlight.get(duplicateKey) === entry) arbiter.inFlight.delete(duplicateKey);
    }).catch(() => {});
    return trackInstance(abortable(promise, signal).finally(() => {
      detachWaiter(entry, waiter);
    }));
  }

  async function status(input = {}) {
    await load();
    const providerId = requireProvider(input.providerId);
    const accountKey = requireAccount(input.accountKey);
    const accountRef = accountRefOf(accountKey);
    const arbiter = arbiterFor(scopeKey, providerId);
    const at = clock();
    if (!coordinator.loadFailure) hydrateArbiter(arbiter, providerId, at);
    const poll = migratePollSeconds(input.pollSeconds).seconds;
    const provider = coordinator.state.providers[providerId] || null;
    const account = provider?.accounts?.[accountRef] || null;
    const block = blockState(arbiter, account, at);
    const multiplier = account?.adaptiveMultiplier || 1;
    arbiter.requestTimes = sortTimes(arbiter.requestTimes
      .filter((entry) => entry.at > at - WINDOW_MS));
    const recent = arbiter.requestTimes;
    const dataRecent = recent.filter((entry) => entry.kind === 'data');
    const cooldownRemaining = block?.until === null || block === null || block.until === undefined
      ? 0 : Math.max(0, Math.ceil((block.until - at) / 1000));
    const candidates = [];
    if (block) {
      if (block.until !== null) candidates.push(block.until);
      else if (arbiter.cooldown?.serverUntil) candidates.push(arbiter.cooldown.serverUntil);
    }
    if (arbiter.lastRequestAt !== null) candidates.push(arbiter.lastRequestAt + MIN_SPACING_MS);
    if (recent.length >= TOTAL_WINDOW_LIMIT) candidates.push(recent[0].at + WINDOW_MS);
    if (dataRecent.length >= DATA_WINDOW_LIMIT) candidates.push(dataRecent[0].at + WINDOW_MS);
    const nextAllowedAt = candidates.length ? Math.max(...candidates) : null;
    return {
      providerId,
      paused: Boolean(coordinator.loadFailure || block),
      pauseReason: coordinator.loadFailure || block?.reason || null,
      cooldownReason: block?.reason || null,
      cooldownScope: block?.scope || null,
      nextAllowedAt,
      serverNextAllowedAt: arbiter.cooldown?.serverUntil ?? null,
      requiresManualRecovery: arbiter.cooldown?.manual === true,
      recoveryProbePending: arbiter.recoveryProbePending === true,
      recoveryProbeExpiresAt: arbiter.recovery?.expiresAt ?? null,
      recoveryFailures: arbiter.recoveryFailures,
      configuredIntervalSeconds: poll,
      effectiveIntervalSeconds: Math.max(
        poll,
        Math.ceil(poll * multiplier),
        cooldownRemaining,
      ),
      adaptiveMultiplier: multiplier,
      budget: {
        totalUsed: recent.length,
        totalLimit: TOTAL_WINDOW_LIMIT,
        dataUsed: dataRecent.length,
        dataLimit: DATA_WINDOW_LIMIT,
        windowSeconds: WINDOW_MS / 1000,
      },
      lastRequestAt: arbiter.lastRequestAt,
      lastEffectiveSyncAt: account?.lastEffectiveSyncAt ?? null,
      completeSuccesses: account?.completeSuccesses || 0,
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const waiter of [...instanceWaiters]) {
      waiter.abort?.();
    }
    const owns = [...instanceEntries];
    await Promise.allSettled(owns.map((entry) => entry.promise));
    await Promise.allSettled([...instancePromises]);
    await coordinator.commitTail.catch(() => {});
  }

  async function drain() {
    draining = true;
    await Promise.allSettled([...instancePromises]);
    await Promise.allSettled([...instanceEntries].map((entry) => entry.promise));
    await coordinator.commitTail.catch(() => {});
  }

  async function flush() {
    await drain();
  }

  return {
    run,
    recordFailure,
    recordSyncSuccess,
    recordCredentialChange,
    clearManualRecovery,
    status,
    drain,
    close,
    flush,
  };
}
