import { createHash, randomUUID } from 'node:crypto';
import { BiliDmStoreError, compareSeq, ensureConversation, makeMessageKey } from './bili-dm-store.js';
import { normalizeMessage, shortMessageId } from './bili-dm-content.js';
import { DM_POLL_LIMITS } from './private-message-request-policy.js';

export const REQUEST_BUDGET = 6;
export const DEFAULT_POLL_SECONDS = DM_POLL_LIMITS.defaultSeconds;
export const MIN_POLL_SECONDS = DM_POLL_LIMITS.minSeconds;
export const MAX_POLL_SECONDS = DM_POLL_LIMITS.maxSeconds;
export const MIN_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;
const DISCOVERY_PAGE_SIZE = 100;
const MESSAGE_PAGE_SIZE = 100;
const ROUND_DEADLINE_MS = 120_000;
const CATCHUP_MIN_DELAY_MS = 60_000;
const CATCHUP_JITTER_RATIO = 0.2;
const SUPPORTED_SYSTEM_TYPES = new Set([1, 5, 7, 8, 9]);
const RECALLED_TEXT = '该消息已被撤回，仅显示状态。';
const RECALLED_TARGET_MAX = 512;
const SAFE_CODES = new Set([
  'DM_AUTH', 'DM_NETWORK', 'DM_TIMEOUT', 'DM_HTTP', 'DM_RATE_LIMIT', 'DM_RESPONSE',
  'DM_API', 'DM_CANCELLED', 'DM_CAPACITY', 'DM_GAP', 'DM_AMBIGUOUS_CURSOR',
  'DM_NO_SERVER_TIME', 'DM_STATE_CORRUPT', 'DM_STATE_UNSUPPORTED', 'DM_WRITE_FAILED',
  'DM_BUDGET', 'DM_CREDENTIAL_CHANGED', 'DM_NO_COOKIE', 'DM_NO_OWNER', 'DM_DISABLED',
  'DM_PAUSED', 'DM_LOGOUT', 'DM_RECOVERED', 'DM_CONTENT_INVALID', 'DM_MESSAGE_ID_INVALID',
  'DM_STATE_READ_FAILED', 'DM_BASELINE', 'DM_CATCHUP', 'DM_GAP', 'DM_ERROR',
  'DM_ACCOUNT_INVALID', 'DM_BINDING_REQUIRED', 'DM_OWNER_REQUIRED', 'DM_STATE_NOT_READY',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeCode(code) {
  return SAFE_CODES.has(code) ? code : 'DM_ERROR';
}

function counter(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(0|[1-9]\d{0,39})$/.test(value)) return value;
  return '';
}

function addOne(value) {
  const text = String(value || '0');
  if (!/^\d+$/.test(text)) return '';
  return (BigInt(text) + 1n).toString();
}

function clampPoll(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_POLL_SECONDS;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, number));
}

function maskTarget(target) {
  const value = String(target || '');
  if (!value) return '';
  return value.length <= 4 ? '***' : `***${value.slice(-4)}`;
}

function credentialFingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function createBudget(limit = REQUEST_BUDGET) {
  let used = 0;
  return {
    get used() { return used; },
    get remaining() { return Math.max(0, limit - used); },
    take() {
      if (used >= limit) throw new BiliDmStoreError('DM_BUDGET', '本轮请求预算已用完');
      used += 1;
    },
  };
}

function sessionTimestamp(session) {
  const value = counter(session?.session_ts) || '';
  return value === '0' ? '' : value;
}

function sessionHigh(session) {
  const max = counter(session?.max_seqno) || '0';
  const last = counter(session?.last_msg?.msg_seqno) || '0';
  return compareSeq(max, last) >= 0 ? max : last;
}

function supportedSession(session, includeSystem) {
  if (!isObject(session)) return false;
  if (session.session_type !== 1 && session.session_type !== '1') return false;
  if (session.is_intercept === 1 || session.is_intercept === true || session.is_intercept === '1') return false;
  const systemType = Number(session.system_msg_type);
  if (!Number.isFinite(systemType) || systemType === 0) return true;
  return includeSystem === true && SUPPORTED_SYSTEM_TYPES.has(systemType);
}

function sessionConversation(session) {
  const talkerId = counter(session?.talker_id);
  if (!talkerId || talkerId === '0') return null;
  return { talkerId, sessionType: 1 };
}

function normalizeStatusError(error) {
  const code = String(error?.code || '');
  if (code === 'BILI_AUTH') return 'DM_AUTH';
  if (code === 'BILI_NETWORK') return 'DM_NETWORK';
  if (code === 'BILI_TIMEOUT') return 'DM_TIMEOUT';
  if (code === 'BILI_RATE_LIMIT') return 'DM_RATE_LIMIT';
  if (code === 'BILI_HTTP') return 'DM_HTTP';
  if (code === 'BILI_RESPONSE') return 'DM_RESPONSE';
  if (code === 'BILI_API' || code === 'BILI_RISK') return 'DM_API';
  if (code === 'BILI_CANCELLED') return 'DM_CANCELLED';
  if (code === 'REQUEST_BUDGET') return 'DM_BUDGET';
  if (code === 'REQUEST_DEADLINE') return 'DM_BUDGET';
  if (code === 'REQUEST_COOLDOWN') return 'DM_RATE_LIMIT';
  if (code === 'REQUEST_POLICY_UNAVAILABLE' || code === 'REQUEST_POLICY_CLOSED') return 'DM_STATE_CORRUPT';
  if (code === 'REQUEST_CANCELLED') return 'DM_CANCELLED';
  if (code.startsWith('DM_')) return safeCode(code);
  return 'DM_ERROR';
}

function recordKey(messageKey) {
  return String(messageKey || '');
}

function recallTargetOfRecord(record) {
  const value = typeof record?.recallTarget === 'string' ? record.recallTarget : '';
  if (!value || value.length > RECALLED_TARGET_MAX) return '';
  return /^(0|[1-9]\d{0,39})$/.test(value) ? value : '';
}

function recordMatchesRecallTarget(record, target) {
  if (!target || !record) return false;
  return String(record.msgKey || '') === target || String(record.messageId || '') === target;
}

function suppressRecordResidual(record, target = '', { terminal = false, at = 0 } = {}) {
  if (!record || record.status === 'sent') return;
  record.text = RECALLED_TEXT;
  record.type = 'state';
  record.imageUrls = [];
  record.shareUrls = [];
  record.sourceStatus = 'recalled';
  record.deliveryState = 'suppressed';
  if (terminal && record.status !== 'suppressed') {
    record.status = 'suppressed';
    record.suppressedAt = Number(at) || 0;
    record.completedAt = null;
  }
  if (target) record.recallTarget = target;
}

function applyStateRecordUpdate(draftRecord, record) {
  if (!draftRecord || !record || draftRecord.status === 'sent'
    || draftRecord.status === 'suppressed') return;
  draftRecord.text = record.text;
  draftRecord.type = 'state';
  draftRecord.imageUrls = [];
  draftRecord.shareUrls = [];
  draftRecord.sourceStatus = record.sourceStatus || 'state_only';
  draftRecord.deliveryState = 'suppressed';
  const target = recallTargetOfRecord(record);
  if (target) draftRecord.recallTarget = target;
}

function messageHasAttempt(account, messageKey) {
  const message = account?.messages?.[messageKey];
  if (message?.status === 'sent') return true;
  for (const segment of Object.values(account?.segments || {})) {
    if (!segment || segment.messageKey !== messageKey || segment.state === 'superseded') continue;
    if (Number(segment.attempts || 0) > 0) return true;
    if (['sent', 'sending', 'pending', 'unknown'].includes(segment.state)) return true;
  }
  return false;
}

function suppressUnattemptedSegments(account, messageKey, at) {
  if (!account?.segments) return;
  for (const key of Object.keys(account.segments)) {
    const segment = account.segments[key];
    if (!segment || segment.messageKey !== messageKey) continue;
    if (segment.state === 'planned' && Number(segment.attempts || 0) === 0) {
      delete account.segments[key];
      continue;
    }
    if (segment.state === 'failed' && Number(segment.attempts || 0) === 0) {
      delete account.segments[key];
      continue;
    }
    if (segment.state === 'failed' || segment.state === 'planned') {
      segment.state = 'superseded';
      segment.updatedAt = at;
    }
  }
}

function suppressMessageInDraft(account, messageKey, at, target = '') {
  const message = account?.messages?.[messageKey];
  if (!message) return false;
  const terminal = !messageHasAttempt(account, messageKey);
  suppressRecordResidual(message, target, { terminal, at });
  suppressUnattemptedSegments(account, messageKey, at);
  return true;
}

function suppressConversationQueue(account, conversationKeyValue, at) {
  if (!account?.messages) return 0;
  let suppressed = 0;
  for (const [key, message] of Object.entries(account.messages)) {
    if (!message || message.conversationKey !== conversationKeyValue || message.status === 'sent') continue;
    suppressRecordResidual(message);
    suppressUnattemptedSegments(account, key, at);
    message.deliveryState = 'suppressed';
    suppressed += 1;
  }
  const conversation = account.conversations?.[conversationKeyValue];
  if (Array.isArray(conversation?.pending?.gathered)) {
    for (const record of conversation.pending.gathered) suppressRecordResidual(record);
  }
  return suppressed;
}

export function createBiliDmService({
  settings, client, store, delivery = null, now = () => Date.now(), random = Math.random,
  setTimeout: setTimeoutImpl = globalThis.setTimeout, clearTimeout: clearTimeoutImpl = globalThis.clearTimeout,
  isActive = () => true, logger = null, autoSchedule = true, pollSeconds,
  requestPolicy = null, requestScope = null, onSyncSuccess = null,
} = {}) {
  if (!settings || typeof settings.current !== 'function' || typeof settings.getBiliCookie !== 'function') {
    throw new TypeError('createBiliDmService requires the shared settings API');
  }
  if (!client || typeof client.nav !== 'function') {
    throw new TypeError('createBiliDmService requires a Bili client');
  }
  if (!store || typeof store.transaction !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('createBiliDmService requires a Bili DM store');
  }
  if (requestPolicy !== null && (typeof requestPolicy?.status !== 'function'
    || typeof requestPolicy?.recordSyncSuccess !== 'function'
    || typeof requestPolicy?.recordFailure !== 'function')) {
    throw new TypeError('requestPolicy must expose status, recordSyncSuccess and recordFailure');
  }
  if (requestPolicy !== null && requestScope === null) {
    throw new TypeError('requestScope is required when requestPolicy is supplied');
  }

  let disposed = false;
  let running = false;
  let generation = 0;
  let timer = null;
  let roundPromise = null;
  let activeRound = null;
  let verifiedRevision = null;
  let verifiedUid = '';
  let knownServerTime = null;
  let stateName = 'disabled';
  let reasonCode = '';
  let nextRetryAt = 0;
  let catchupAt = 0;
  let backoffLevel = 0;
  let lastCheckAt = 0;
  let lastSuccessAt = null;
  let faultCycle = '';
  let pendingNotice = null;
  let authBlockedRevision = null;
  let lastPruneAt = 0;
  let poll = clampPoll(pollSeconds ?? DEFAULT_POLL_SECONDS);
  let policySnapshot = null;
  let roundWorkflowId = '';
  let roundDeadline = null;

  const readiness = Promise.all([
    settings.ready ? settings.ready : Promise.resolve(),
    store.ready ? store.ready : Promise.resolve(),
  ]).then(async () => {
    await refreshPolicyStatus();
    return api;
  }).catch((error) => {
    stateName = 'error';
    reasonCode = safeCode(normalizeStatusError(error) === 'DM_ERROR' ? 'DM_STATE_CORRUPT' : normalizeStatusError(error));
    throw error;
  });
  readiness.catch(() => {});

  function readConfig() {
    let config = {};
    try { config = settings.current?.() || {}; } catch { config = {}; }
    return {
      enabled: config.biliDmEnabled === true,
      includeSystem: config.biliDmIncludeSystem === true,
      pollSeconds: clampPoll(config.biliDmPollSeconds ?? poll),
    };
  }

  function readRevision() {
    try {
      const value = settings.getBiliCookieRevision?.();
      return Number.isFinite(value) ? value : 0;
    } catch { return 0; }
  }

  function cookieValue() {
    try { return String(settings.getBiliCookie?.() || ''); } catch { return ''; }
  }

  function requestContextCookie() {
    return cookieValue();
  }

  async function policyScope() {
    let scope = requestScope;
    if (typeof scope === 'function') {
      try {
        const context = {
          providerId: 'bilibili',
          endpoint: null,
          query: {},
          kind: 'control',
        };
        context['cookie'] = requestContextCookie();
        scope = await scope(context);
      } catch {
        scope = null;
      }
    }
    if (scope && typeof scope.providerId === 'string' && scope.providerId
      && typeof scope.accountKey === 'string' && scope.accountKey) {
      return {
        providerId: scope.providerId,
        accountKey: scope.accountKey,
        credentialVersion: scope.credentialVersion,
        workflowId: scope.workflowId,
      };
    }
    const cookie = cookieValue();
    if (!cookie) return null;
    const fingerprint = credentialFingerprint(cookie);
    return {
      providerId: 'bilibili',
      accountKey: `credential:${fingerprint.slice(0, 32)}`,
      credentialVersion: fingerprint,
    };
  }

  async function refreshPolicyStatus() {
    if (!requestPolicy) {
      policySnapshot = null;
      return;
    }
    try {
      const scope = await policyScope();
      if (!scope) {
        policySnapshot = null;
        return;
      }
      policySnapshot = await requestPolicy.status({
        ...scope,
        pollSeconds: readConfig().pollSeconds,
      });
    } catch {
      policySnapshot = null;
    }
  }

  function syncCycleMap(state) {
    return isObject(state?.syncCycles) ? state.syncCycles : {};
  }

  function workflowIdFor(robotKey, fingerprint) {
    return `bili-sync:${credentialFingerprint(`${robotKey}:${fingerprint}:${randomUUID()}`)}`;
  }

  function syncCycleKey(robotKey, fingerprint) {
    return credentialFingerprint(`${robotKey}:${fingerprint}`);
  }

  function pruneSyncCycles(draft) {
    const entries = Object.entries(draft.syncCycles);
    if (entries.length <= 8) return;
    entries.sort((left, right) => Number(left[1]?.createdAt || 0) - Number(right[1]?.createdAt || 0));
    for (const [key] of entries.slice(0, entries.length - 8)) delete draft.syncCycles[key];
  }

  async function ensureSyncWorkflow(fingerprint, run) {
    if (!fingerprint) return '';
    const robotKey = store.read((state) => state.robotKey);
    const cycleKey = syncCycleKey(robotKey, fingerprint);
    const existing = store.read((state) => {
      const value = syncCycleMap(state)[cycleKey]?.workflowId;
      return typeof value === 'string' && value ? value : '';
    });
    if (existing) return existing;
    const workflowId = workflowIdFor(robotKey, fingerprint);
    await store.transaction((draft) => {
      if (!isObject(draft.syncCycles)) draft.syncCycles = {};
      const current = draft.syncCycles[cycleKey]?.workflowId;
      if (typeof current !== 'string' || !current) {
        draft.syncCycles[cycleKey] = { workflowId, createdAt: now() };
      }
      pruneSyncCycles(draft);
      draft.updatedAt = now();
    }, { guard: () => isCurrent(run) });
    return store.read((state) => {
      const value = syncCycleMap(state)[cycleKey]?.workflowId;
      return typeof value === 'string' && value ? value : workflowId;
    });
  }

  async function rotateSyncWorkflow(fingerprint, run) {
    if (!fingerprint) return '';
    const robotKey = store.read((state) => state.robotKey);
    const cycleKey = syncCycleKey(robotKey, fingerprint);
    const workflowId = workflowIdFor(robotKey, fingerprint);
    await store.transaction((draft) => {
      if (!isObject(draft.syncCycles)) draft.syncCycles = {};
      draft.syncCycles[cycleKey] = { workflowId, createdAt: now() };
      pruneSyncCycles(draft);
      draft.updatedAt = now();
    }, { guard: () => isCurrent(run) });
    return workflowId;
  }

  async function recordPolicySuccess(run, workflowId = '') {
    if (!run || !workflowId || !isCurrent(run)) return { recorded: false, stale: true };
    const scope = run.policyScope || null;
    if (!scope) return { recorded: false, stale: true };
    let result = { recorded: true };
    try {
      if (typeof onSyncSuccess === 'function') {
        await onSyncSuccess({ workflowId, scope: { ...scope } });
      } else if (requestPolicy) {
        if (!isCurrent(run)) return { recorded: false, stale: true };
        result = await requestPolicy.recordSyncSuccess({ ...scope, workflowId });
      }
    } catch { /* policy state failures are surfaced through its own status */ }
    await refreshPolicyStatus();
    return result || { recorded: false };
  }

  async function recordPolicyFailure(error) {
    if (!requestPolicy || !error || typeof error !== 'object') return;
    const code = String(error.code || '');
    if (code.startsWith('REQUEST_') || error.requestPolicyRecorded === true) return;
    try {
      const scope = await policyScope();
      if (!scope) return;
      await requestPolicy.recordFailure({
        ...scope,
        retryAfterMs: Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0,
        status: Number.isFinite(error.status) ? error.status : 0,
        apiCode: Number.isFinite(error.apiCode) ? error.apiCode : 0,
      });
    } catch { /* policy state failures are surfaced through its own status */ }
  }

  function isCurrent(run) {
    return running && !disposed && run && generation === run.generation
      && readRevision() === run.revision && isActive() !== false;
  }

  function noteFault(code) {
    const safe = safeCode(code);
    if (faultCycle === safe) return;
    faultCycle = safe;
    pendingNotice = { code: safe, at: now() };
  }

  function noteRecovery() {
    if (!faultCycle) return;
    faultCycle = '';
    pendingNotice = { code: 'DM_RECOVERED', at: now() };
  }

  async function deliverNotice(run) {
    if (!delivery || !isCurrent(run)) return;
    if (pendingNotice && typeof delivery.notifyStatus === 'function') {
      const notice = { code: pendingNotice.code, at: pendingNotice.at };
      try {
        const result = await delivery.notifyStatus(notice, {
          guard: () => isCurrent(run),
          uid: verifiedUid || '',
          revision: run.revision,
        });
        if (result?.accepted === true && pendingNotice
          && pendingNotice.code === notice.code && pendingNotice.at === notice.at) {
          pendingNotice = null;
        }
      } catch { /* notification failures never break media work */ }
    }
    if (typeof delivery.pumpNotices === 'function' && isCurrent(run)) {
      try {
        await delivery.pumpNotices({ guard: () => isCurrent(run) });
      } catch { /* notification failures never break media work */ }
    }
  }

  function clearTimer() {
    if (timer === null) return;
    try { clearTimeoutImpl(timer); } catch { /* ignore */ }
    timer = null;
  }

  function schedule(delay) {
    if (!autoSchedule || disposed || !running) return;
    clearTimer();
    const wait = Math.max(1, Math.floor(Number(delay) || 1));
    timer = setTimeoutImpl(() => {
      timer = null;
      if (running && !disposed) runCheck(false).catch(() => {});
    }, wait);
    timer?.unref?.();
  }

  function effectivePollSeconds() {
    const configured = readConfig().pollSeconds;
    const adaptive = Number(policySnapshot?.effectiveIntervalSeconds);
    return Math.max(configured, Number.isFinite(adaptive) ? adaptive : 0);
  }

  function catchupDelay(at) {
    const jitter = Math.round(CATCHUP_MIN_DELAY_MS
      * Math.max(0, Math.min(1, Number(random()) || 0))
      * CATCHUP_JITTER_RATIO);
    const earliest = at + CATCHUP_MIN_DELAY_MS + jitter;
    const policyAt = Number.isFinite(policySnapshot?.nextAllowedAt)
      ? policySnapshot.nextAllowedAt : 0;
    const retryAt = nextRetryAt > at ? nextRetryAt : 0;
    const scheduledAt = Math.max(earliest, policyAt, retryAt);
    catchupAt = scheduledAt;
    return Math.max(1, Math.round(scheduledAt - at));
  }

  function scheduleNext() {
    if (!running || disposed) return;
    const at = now();
    if (stateName === 'catching_up') {
      schedule(catchupDelay(at));
      return;
    }
    catchupAt = 0;
    const delay = nextRetryAt > at
      ? Math.max(1, nextRetryAt - at)
      : Math.round(effectivePollSeconds() * 1000
        * (1 + Math.max(0, Math.min(1, Number(random()) || 0)) * 0.2));
    schedule(delay);
  }

  function setState(name, code = '') {
    stateName = name;
    reasonCode = code ? safeCode(code) : '';
    if (name === 'watching') {
      lastSuccessAt = now();
      nextRetryAt = 0;
      backoffLevel = 0;
      noteRecovery();
    }
    if (name !== 'catching_up') catchupAt = 0;
  }

  async function handleFailure(run, error) {
    if (!isCurrent(run)) return;
    catchupAt = 0;
    const code = normalizeStatusError(error);
    if (code === 'DM_CANCELLED' || code === 'DM_STALE') return;
    if (code === 'DM_BUDGET') {
      setState('catching_up', 'DM_BUDGET');
      return;
    }
    await recordPolicyFailure(error);
    if (code === 'DM_AUTH') {
      authBlockedRevision = run ? run.revision : readRevision();
      setState('waiting_login', 'DM_AUTH');
      noteFault('DM_AUTH');
      return;
    }
    if (code === 'DM_CAPACITY') {
      setState('paused_capacity', 'DM_CAPACITY');
      noteFault('DM_CAPACITY');
      return;
    }
    if (['DM_STATE_CORRUPT', 'DM_STATE_UNSUPPORTED', 'DM_WRITE_FAILED', 'DM_STATE_READ_FAILED'].includes(code)) {
      setState('error', code);
      noteFault(code);
      return;
    }
    backoffLevel += 1;
    const exponential = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * (2 ** Math.min(backoffLevel - 1, 6)));
    const retry = Number(error?.retryAfterMs) || 0;
    const nextAllowedAt = Number.isFinite(error?.nextAllowedAt) ? error.nextAllowedAt : 0;
    const policyDelay = nextAllowedAt > now() ? nextAllowedAt - now() : 0;
    const delay = Math.max(MIN_BACKOFF_MS, exponential, retry, policyDelay);
    nextRetryAt = now() + delay;
    setState('backoff', code);
    noteFault(code);
  }

  function accountSnapshot(uid) {
    return store.read((state) => (uid ? state.accounts[uid] || null : null));
  }

  function bindingSnapshot() {
    try { return store.binding(); } catch { return { target: '', version: 0 }; }
  }

  async function startDiscovery(run) {
    const account = accountSnapshot(verifiedUid);
    if (!account) throw new BiliDmStoreError('DM_ACCOUNT_INVALID', '账号状态尚未建立');
    if (account.discovery.baselineComplete && !account.discovery.scanActive) {
      await store.transaction((draft) => {
        const current = draft.accounts[verifiedUid];
        if (!current) return;
        current.discovery.scanActive = true;
        current.discovery.phase = 'rescan';
        current.discovery.endTs = null;
        current.discovery.gap = null;
        current.discovery.pages = 0;
        current.discovery.updatedAt = now();
      }, { guard: () => isCurrent(run) });
    } else if (!account.discovery.baselineComplete && !account.discovery.scanActive) {
      await store.transaction((draft) => {
        const current = draft.accounts[verifiedUid];
        if (!current) return;
        current.discovery.scanActive = true;
        current.discovery.phase = 'baseline';
        current.discovery.baselineStartedAt ||= now();
        current.discovery.endTs = null;
        current.discovery.gap = null;
        current.discovery.pages = 0;
      }, { guard: () => isCurrent(run) });
    }
  }

  async function processDiscovery(run, budget, cookie, config) {
    const includeSystem = config.includeSystem === true;
    while (budget.remaining > 0) {
      const account = accountSnapshot(verifiedUid);
      if (!account) return { done: false, gap: 'DM_ACCOUNT_INVALID' };
      const discovery = account.discovery;
      if (discovery.gap) return { done: false, gap: discovery.gap.code };
      if (!discovery.scanActive) return { done: true, gap: '' };
      budget.take();
      let result;
      try {
        result = await client.sessions(cookie, {
          endTs: discovery.endTs || undefined,
          size: DISCOVERY_PAGE_SIZE,
          signal: run.controller.signal,
          expiresAt: roundDeadline,
          workflowId: roundWorkflowId,
        });
      } catch (error) {
        throw error;
      }
      if (!isCurrent(run)) return { done: false, gap: '' };
      if (!result || (result.sessions !== null && !Array.isArray(result.sessions))
        || typeof result.hasMore !== 'boolean') {
        throw new BiliDmStoreError('DM_RESPONSE', '会话列表响应不完整');
      }
      if (Number.isFinite(result.serverTime)) knownServerTime = result.serverTime;
      const serverTime = Number.isFinite(result.serverTime) ? result.serverTime : knownServerTime;
      const page = result.sessions === null ? [] : result.sessions;
      if (!Array.isArray(page)) throw new BiliDmStoreError('DM_RESPONSE', '会话列表响应不完整');
      const timestamps = page.map(sessionTimestamp).filter(Boolean);
      const nextEndTs = timestamps.length
        ? timestamps.reduce((min, value) => (compareSeq(value, min) < 0 ? value : min))
        : '';
      const oldEndTs = discovery.endTs || '';
      const noProgress = result.hasMore && (!nextEndTs || (oldEndTs && compareSeq(nextEndTs, oldEndTs) >= 0));
      const equalBoundary = result.hasMore && page.length >= DISCOVERY_PAGE_SIZE && nextEndTs
        && page.filter((session) => sessionTimestamp(session) === nextEndTs).length > 1;
      const ambiguous = noProgress || equalBoundary;
      const monitored = account.discovery.monitorStartTs || serverTime;
      if (!account.discovery.monitorStartTs && !Number.isFinite(monitored)) {
        await store.transaction((draft) => {
          const current = draft.accounts[verifiedUid];
          if (!current) return;
          current.discovery.gap = { code: 'DM_NO_SERVER_TIME', at: now() };
          current.discovery.scanActive = false;
        }, { guard: () => isCurrent(run) });
        return { done: false, gap: 'DM_NO_SERVER_TIME' };
      }
      const at = now();
      try {
        await store.transaction((draft) => {
          const accountDraft = draft.accounts[verifiedUid];
          if (!accountDraft) return;
          const discoveryDraft = accountDraft.discovery;
          if (!discoveryDraft.monitorStartTs) discoveryDraft.monitorStartTs = serverTime;
          discoveryDraft.lastServerTime = serverTime;
          const storedScope = discoveryDraft.scopeIncludeSystem;
          const scopeKnown = storedScope === true || storedScope === false;
          const scopeChanged = scopeKnown && storedScope !== includeSystem;
          if (!scopeKnown) {
            discoveryDraft.scopeIncludeSystem = includeSystem;
          } else if (scopeChanged) {
            discoveryDraft.scopeIncludeSystem = includeSystem;
            discoveryDraft.scopeBaselineAt = includeSystem
              ? (Number.isFinite(serverTime) ? serverTime : at)
              : null;
          }
          if (ambiguous) {
            discoveryDraft.gap = {
              code: noProgress ? 'DM_GAP' : 'DM_AMBIGUOUS_CURSOR',
              at,
              endTs: nextEndTs || discoveryDraft.endTs || null,
            };
            if (nextEndTs) discoveryDraft.endTs = nextEndTs;
            discoveryDraft.scanActive = true;
            return;
          }
          for (const session of page) {
            if (!supportedSession(session, includeSystem)) continue;
            const identity = sessionConversation(session);
            if (!identity) continue;
            const high = sessionHigh(session);
            const duplex = ensureConversation(accountDraft, {
              talkerId: identity.talkerId,
              sessionType: identity.sessionType,
              high,
              baseline: !discoveryDraft.baselineComplete,
              now: at,
            });
            const systemType = Number(session.system_msg_type);
            const isSystem = Number.isFinite(systemType) && systemType !== 0;
            const scopeBaselineAt = discoveryDraft.scopeBaselineAt;
            if (includeSystem && isSystem && discoveryDraft.baselineComplete
              && Number.isFinite(scopeBaselineAt) && duplex.scopeBaselineAt !== scopeBaselineAt) {
              if (!duplex.firstHigh) duplex.firstHigh = high;
              if (!duplex.lastHigh || compareSeq(high, duplex.lastHigh) > 0) duplex.lastHigh = high;
              if (compareSeq(high, duplex.committed || '0') > 0) duplex.committed = high;
              if (compareSeq(high, duplex.dedupeThrough || '0') > 0) duplex.dedupeThrough = high;
              duplex.pending = null;
              duplex.gap = null;
              duplex.newAfterBaseline = false;
              duplex.scopeBaselineAt = scopeBaselineAt;
              duplex.updatedAt = at;
              duplex.lastSeenAt = at;
              continue;
            }
            if (duplex.baseline) {
              if (!duplex.firstHigh) duplex.firstHigh = high;
              duplex.lastHigh = !duplex.lastHigh || compareSeq(high, duplex.lastHigh) > 0 ? high : duplex.lastHigh;
            } else {
              duplex.lastHigh = !duplex.lastHigh || compareSeq(high, duplex.lastHigh) > 0 ? high : duplex.lastHigh;
            }
            duplex.updatedAt = at;
            duplex.lastSeenAt = at;
          }
          discoveryDraft.endTs = nextEndTs || null;
          discoveryDraft.pages = Number(discoveryDraft.pages || 0) + 1;
          discoveryDraft.sessionCount = Object.keys(accountDraft.conversations || {}).length;
          discoveryDraft.lastServerTime = serverTime;
          discoveryDraft.lastScanAt = at;
          if (!result.hasMore) {
            discoveryDraft.scanActive = false;
            discoveryDraft.endTs = null;
            discoveryDraft.phase = 'complete';
            discoveryDraft.baselineComplete = true;
            discoveryDraft.gap = null;
          } else {
            discoveryDraft.phase = discoveryDraft.baselineComplete ? 'rescan' : 'baseline';
          }
        }, { guard: () => isCurrent(run) });
      } catch (error) {
        if (error instanceof BiliDmStoreError && error.code === 'DM_CAPACITY') {
          setState('paused_capacity', 'DM_CAPACITY');
          noteFault('DM_CAPACITY');
          return { done: false, gap: 'DM_CAPACITY', capacity: true };
        }
        throw error;
      }
      if (ambiguous) return { done: false, gap: noProgress ? 'DM_GAP' : 'DM_AMBIGUOUS_CURSOR' };
      if (!result.hasMore) return { done: true, gap: '' };
    }
    return { done: false, gap: '', budget: true };
  }

  async function beginPending(run, conversation) {
    const at = now();
    const account = accountSnapshot(verifiedUid);
    if (!account) return null;
    const discovery = account.discovery;
    let pending = conversation.pending;
    if (!pending) {
      const targetHigh = conversation.lastHigh || '0';
      if (compareSeq(targetHigh, conversation.committed || '0') <= 0) return null;
      const mode = conversation.newAfterBaseline ? 'new' : 'range';
      if (mode === 'new' && !Number.isFinite(discovery.monitorStartTs)) {
        throw new BiliDmStoreError('DM_NO_SERVER_TIME', '缺少服务器时间，无法确认新会话历史范围');
      }
      const endSeqno = addOne(targetHigh);
      if (!endSeqno) throw new BiliDmStoreError('DM_RESPONSE', '消息水位不合法');
      pending = {
        mode,
        targetHigh,
        endSeqno,
        pageMin: null,
        pageCount: 0,
        highSeen: false,
        gathered: [],
        recallTargets: [],
        filterFromTs: mode === 'new' ? discovery.monitorStartTs : null,
        startedAt: at,
        gap: null,
      };
      await store.transaction((draft) => {
        const accountDraft = draft.accounts[verifiedUid];
        const conversationDraft = accountDraft?.conversations[conversation.key];
        if (!conversationDraft || conversationDraft.pending) return;
        conversationDraft.pending = pending;
        conversationDraft.updatedAt = at;
      }, { guard: () => isCurrent(run) });
    }
    return pending;
  }

  function normalizePageMessages(rawMessages, conversation) {
    const out = [];
    for (const raw of rawMessages) {
      const seqno = counter(raw?.msg_seqno);
      const record = normalizeMessage({
        raw,
        robotKey: store.read((state) => state.robotKey),
        accountUid: verifiedUid,
        sessionType: conversation.sessionType,
        talkerId: conversation.talkerId,
        fallbackSeqno: seqno,
      });
      out.push(record);
    }
    return out;
  }

  async function markConversationGap(run, conversationKeyValue, code) {
    await store.transaction((draft) => {
      const accountDraft = draft.accounts[verifiedUid];
      const conversationDraft = accountDraft?.conversations[conversationKeyValue];
      if (!conversationDraft) return;
      conversationDraft.gap = { code, at: now() };
      if (conversationDraft.pending) conversationDraft.pending.gap = code;
      conversationDraft.updatedAt = now();
    }, { guard: () => isCurrent(run) });
  }

  async function processConversation(run, budget, cookie, conversation) {
    const account = accountSnapshot(verifiedUid);
    if (!account) return { done: true, gap: '' };
    if (conversation.gap) return { done: false, gap: conversation.gap.code };
    const pending = await beginPending(run, conversation);
    if (!pending) return { done: true, gap: '' };
    if (pending.gap) return { done: false, gap: pending.gap };
    while (budget.remaining > 0) {
      const latest = accountSnapshot(verifiedUid);
      const currentConversation = latest?.conversations[conversation.key];
      if (!currentConversation) return { done: true, gap: '' };
      const job = currentConversation.pending;
      if (!job) return { done: true, gap: '' };
      if (job.gap) return { done: false, gap: job.gap };
      budget.take();
      let result;
      try {
        result = await client.messages(cookie, {
          talkerId: currentConversation.talkerId,
          sessionType: currentConversation.sessionType,
          beginSeqno: currentConversation.committed || '0',
          endSeqno: job.endSeqno,
          size: MESSAGE_PAGE_SIZE,
          signal: run.controller.signal,
          expiresAt: roundDeadline,
          workflowId: roundWorkflowId,
        });
      } catch (error) {
        if (error?.code === 'BILI_API') {
          await markConversationGap(run, conversation.key, 'DM_GAP');
          return { done: false, gap: 'DM_GAP' };
        }
        throw error;
      }
      if (!isCurrent(run)) return { done: false, gap: '' };
      if (!result || (result.messages !== null && !Array.isArray(result.messages))
        || typeof result.hasMore !== 'boolean') {
        throw new BiliDmStoreError('DM_RESPONSE', '消息响应不完整');
      }
      const raws = result.messages === null ? [] : result.messages;
      const messageList = normalizePageMessages(raws, currentConversation);
      for (const record of messageList) {
        if (record.fatal) {
          await markConversationGap(run, conversation.key, safeCode(
            record.sourceStatus === 'content_too_large' ? 'DM_CONTENT_INVALID' : 'DM_MESSAGE_ID_INVALID',
          ));
          return { done: false, gap: record.sourceStatus };
        }
        if (record.parseFailure) record.sourceStatus = 'content_parse_failed';
      }
      const ambiguousWithdrawal = messageList.some((record) => record.sourceStatus === 'state_only'
        && !recallTargetOfRecord(record)
        && (record.rawType === 5 || record.rawType === 8));
      if (ambiguousWithdrawal) {
        await store.transaction((draft) => {
          const accountDraft = draft.accounts[verifiedUid];
          const conversationDraft = accountDraft?.conversations[conversation.key];
          if (!conversationDraft) return;
          const at = now();
          suppressConversationQueue(accountDraft, conversation.key, at);
          conversationDraft.gap = { code: 'DM_GAP', at };
          if (conversationDraft.pending) conversationDraft.pending.gap = 'DM_GAP';
          conversationDraft.updatedAt = at;
        }, { guard: () => isCurrent(run) });
        return { done: false, gap: 'DM_GAP' };
      }
      const endBoundary = BigInt(job.endSeqno || '0');
      const beginBoundary = BigInt(currentConversation.committed || '0');
      if (messageList.length > 1
        && compareSeq(messageList[0].seqno, messageList[messageList.length - 1].seqno) < 0) {
        await markConversationGap(run, conversation.key, 'DM_GAP');
        return { done: false, gap: 'DM_GAP' };
      }
      let pageMin = '';
      let pageMax = '';
      let progress = false;
      for (const record of messageList) {
        const value = BigInt(record.seqno || '0');
        if (value >= endBoundary) {
          await markConversationGap(run, conversation.key, 'DM_GAP');
          return { done: false, gap: 'DM_GAP' };
        }
        if (!pageMax || compareSeq(record.seqno, pageMax) > 0) pageMax = record.seqno;
        if (value <= beginBoundary) continue;
        if (job.mode === 'new' && !(record.sentAt > 0)) {
          await markConversationGap(run, conversation.key, 'DM_GAP');
          return { done: false, gap: 'DM_GAP' };
        }
        if (!pageMin || compareSeq(record.seqno, pageMin) < 0) pageMin = record.seqno;
        progress = true;
      }
      if (Number(job.pageCount || 0) === 0 && pageMax && compareSeq(pageMax, job.targetHigh) < 0) {
        await markConversationGap(run, conversation.key, 'DM_GAP');
        return { done: false, gap: 'DM_GAP' };
      }
      if (job.pageMin && pageMin && compareSeq(pageMin, job.pageMin) >= 0) {
        await markConversationGap(run, conversation.key, 'DM_GAP');
        return { done: false, gap: 'DM_GAP' };
      }
      if (!pageMin) {
        if (result.hasMore || compareSeq(job.targetHigh, currentConversation.committed || '0') > 0) {
          await markConversationGap(run, conversation.key, 'DM_GAP');
          return { done: false, gap: 'DM_GAP' };
        }
        break;
      }
      let sawOlder = false;
      const pageRecallTargets = new Set();
      for (const record of messageList) {
        const target = recallTargetOfRecord(record);
        if (target) pageRecallTargets.add(target);
      }
      if (pageRecallTargets.size) {
        for (const record of messageList) {
          for (const target of pageRecallTargets) {
            if (recordMatchesRecallTarget(record, target)) {
              suppressRecordResidual(record, target);
              break;
            }
          }
        }
      }
      const gathered = [];
      const seen = new Set((job.gathered || []).map((record) => record.messageId || record.seqno));
      for (const record of messageList) {
        if (BigInt(record.seqno || '0') <= beginBoundary) continue;
        if (job.mode === 'new' && job.filterFromTs) {
          if (record.sentAt > 0 && record.sentAt * 1000 < job.filterFromTs) {
            sawOlder = true;
            continue;
          }
        }
        if (record.senderUid && record.senderUid === verifiedUid) continue;
        const identity = record.messageId || record.seqno;
        if (seen.has(identity)) continue;
        seen.add(identity);
        gathered.push(record);
      }
      const done = job.mode === 'new'
        ? (sawOlder || !result.hasMore)
        : (!result.hasMore || compareSeq(pageMin, currentConversation.committed || '0') <= 0);
      const at = now();
      try {
        await store.transaction((draft) => {
          const accountDraft = draft.accounts[verifiedUid];
          const conversationDraft = accountDraft?.conversations[conversation.key];
          if (!conversationDraft || !conversationDraft.pending) return;
          const pendingDraft = conversationDraft.pending;
          const recallTargets = new Set();
          for (const target of Array.isArray(pendingDraft.recallTargets) ? pendingDraft.recallTargets : []) {
            if (typeof target === 'string' && target) recallTargets.add(target);
          }
          for (const target of pageRecallTargets) recallTargets.add(target);
          pendingDraft.recallTargets = [...recallTargets];
          for (const record of gathered) {
            for (const target of recallTargets) {
              if (recordMatchesRecallTarget(record, target)) {
                suppressRecordResidual(record, target);
                break;
              }
            }
            pendingDraft.gathered.push(record);
          }
          pendingDraft.pageMin = pageMin;
          pendingDraft.endSeqno = pageMin;
          pendingDraft.pageCount = Number(pendingDraft.pageCount || 0) + 1;
          pendingDraft.highSeen = pendingDraft.highSeen === true
            || messageList.some((record) => compareSeq(record.seqno, pendingDraft.targetHigh) === 0);
          conversationDraft.updatedAt = at;
          const nowMs = at;
          for (const [existingKey, existing] of Object.entries(accountDraft.messages || {})) {
            let matched = '';
            for (const target of recallTargets) {
              if (recordMatchesRecallTarget(existing, target)) { matched = target; break; }
            }
            if (!matched) continue;
            suppressMessageInDraft(accountDraft, existingKey, nowMs, matched);
          }
          if (!progress) {
            conversationDraft.gap = { code: 'DM_GAP', at };
            pendingDraft.gap = 'DM_GAP';
            return;
          }
          if (!done) return;
          if (pendingDraft.highSeen !== true) {
            conversationDraft.gap = { code: 'DM_GAP', at };
            pendingDraft.gap = 'DM_GAP';
            return;
          }
          for (const record of pendingDraft.gathered) {
            for (const target of recallTargets) {
              if (recordMatchesRecallTarget(record, target)) {
                suppressRecordResidual(record, target);
                break;
              }
            }
          }
          pendingDraft.gathered.sort((left, right) => compareSeq(left.seqno, right.seqno));
          for (const record of pendingDraft.gathered) {
            const key = makeMessageKey({
              robotKey: draft.robotKey,
              accountUid: verifiedUid,
              sessionType: conversationDraft.sessionType,
              talkerId: conversationDraft.talkerId,
              msgKey: record.msgKey,
              seqno: record.seqno,
            });
            const existing = accountDraft.messages[key];
            if (existing) {
              if (record.type === 'state' || record.sourceStatus === 'state_only'
                || record.sourceStatus === 'recalled') {
                applyStateRecordUpdate(existing, record);
                suppressUnattemptedSegments(accountDraft, key, nowMs);
              }
              continue;
            }
            if (compareSeq(record.seqno, conversationDraft.dedupeThrough || '0') <= 0
              && compareSeq(record.seqno, pendingDraft.targetHigh) <= 0
              && pendingDraft.mode !== 'new') continue;
            accountDraft.messages[key] = {
              ...record,
              key,
              conversationKey: conversationDraft.key,
              status: record.deliveryState === 'suppressed' ? 'suppressed' : 'unfinished',
              deliveryState: record.deliveryState === 'suppressed' ? 'suppressed' : 'queued',
              suppressedAt: record.deliveryState === 'suppressed' ? nowMs : undefined,
              createdAt: nowMs,
              completedAt: null,
            };
          }
          conversationDraft.committed = pendingDraft.targetHigh;
          conversationDraft.dedupeThrough = compareSeq(
            pendingDraft.targetHigh, conversationDraft.dedupeThrough || '0',
          ) > 0 ? pendingDraft.targetHigh : conversationDraft.dedupeThrough;
          conversationDraft.lastHigh = compareSeq(
            pendingDraft.targetHigh, conversationDraft.lastHigh || '0',
          ) > 0 ? pendingDraft.targetHigh : conversationDraft.lastHigh;
          conversationDraft.pending = null;
          conversationDraft.newAfterBaseline = false;
          conversationDraft.gap = null;
          conversationDraft.updatedAt = nowMs;
        }, { guard: () => isCurrent(run) });
      } catch (error) {
        if (error instanceof BiliDmStoreError && error.code === 'DM_CAPACITY') {
          setState('paused_capacity', 'DM_CAPACITY');
          noteFault('DM_CAPACITY');
          return { done: false, gap: 'DM_CAPACITY', capacity: true };
        }
        throw error;
      }
      if (done) return { done: true, gap: '' };
    }
    return { done: false, gap: '', budget: true };
  }

  async function runRound(run) {
    await readiness;
    if (!isCurrent(run)) return;
    stateName = stateName === 'disabled' ? 'waiting_login' : stateName;
    lastCheckAt = now();
    const config = readConfig();
    poll = config.pollSeconds;
    if (!config.enabled) {
      setState('disabled', 'DM_DISABLED');
      return;
    }
    if (nextRetryAt > now()) {
      stateName = 'backoff';
      reasonCode = safeCode(reasonCode || 'DM_NETWORK');
      return;
    }
    const cookie = cookieValue();
    if (!cookie) {
      setState('waiting_login', 'DM_NO_COOKIE');
      return;
    }
    run.credentialFingerprint = credentialFingerprint(cookie);
    run.workflowId = await ensureSyncWorkflow(run.credentialFingerprint, run);
    if (!isCurrent(run)) return;
    run.policyScope = await policyScope();
    if (!isCurrent(run)) return;
    roundWorkflowId = run.workflowId;
    roundDeadline = now() + ROUND_DEADLINE_MS;
    const binding = bindingSnapshot();
    if (!binding.target) {
      setState('waiting_owner', 'DM_NO_OWNER');
      return;
    }
    const pruneAt = now();
    if (lastPruneAt === 0 || pruneAt - lastPruneAt >= 60 * 60_000) {
      lastPruneAt = pruneAt;
      if (typeof store.prune === 'function') {
        await store.prune(pruneAt, { guard: () => isCurrent(run) });
      }
    }
    if (authBlockedRevision !== null && authBlockedRevision === run.revision && run.manual !== true) {
      setState('waiting_login', 'DM_AUTH');
      return;
    }
    const budget = createBudget(REQUEST_BUDGET);
    const needsNav = verifiedRevision !== run.revision || !verifiedUid || authBlockedRevision !== null;
    if (needsNav) {
      budget.take();
      let nav;
      try {
        nav = await client.nav(cookie, {
          signal: run.controller.signal,
          expiresAt: roundDeadline,
          workflowId: roundWorkflowId,
        });
      } catch (error) {
        throw error;
      }
      if (!isCurrent(run)) return;
      const mid = counter(nav?.mid);
      if (!mid || mid === '0') throw new BiliDmStoreError('DM_AUTH', '账号未登录');
      if (Number.isFinite(nav?.serverTime)) knownServerTime = nav.serverTime;
      const previousUid = store.read((state) => state.currentUid || '');
      if (previousUid !== mid || !previousUid) {
        await store.setCurrentUid(mid, { guard: () => isCurrent(run) });
      }
      if (!isCurrent(run)) return;
      verifiedRevision = run.revision;
      verifiedUid = mid;
      authBlockedRevision = null;
    }
    if (!isCurrent(run)) return;
    let account = accountSnapshot(verifiedUid);
    if (!account) {
      await store.ensureAccount(verifiedUid, { guard: () => isCurrent(run) });
      account = accountSnapshot(verifiedUid);
    }
    if (!account) throw new BiliDmStoreError('DM_ACCOUNT_INVALID', '账号状态尚未建立');
    await startDiscovery(run);
    const discoveryResult = await processDiscovery(run, budget, cookie, config);
    if (discoveryResult.gap) {
      if (!discoveryResult.capacity && stateName !== 'paused_capacity') {
        setState('error', discoveryResult.gap);
        noteFault(discoveryResult.gap);
      }
      return;
    }
    const latest = accountSnapshot(verifiedUid);
    if (discoveryResult.budget) {
      setState('catching_up', 'DM_BUDGET');
      return;
    }
    if (!latest?.discovery?.baselineComplete) {
      setState('initializing', 'DM_BASELINE');
      return;
    }
    let gap = '';
    let pendingWork = false;
    let capacity = false;
    if (!latest.discovery.scanActive) {
      const conversations = Object.values(latest.conversations || {})
        .sort((left, right) => compareSeq(left.lastHigh || '0', right.lastHigh || '0'));
      for (const conversation of conversations) {
        const result = await processConversation(run, budget, cookie, conversation);
        if (result.capacity) { capacity = true; break; }
        if (result.gap && !gap) gap = result.gap;
        if (result.budget) pendingWork = true;
        if (!isCurrent(run)) return;
      }
    } else {
      pendingWork = true;
    }
    if (capacity || stateName === 'paused_capacity') {
      if (stateName !== 'paused_capacity') setState('paused_capacity', 'DM_CAPACITY');
      return;
    }
    if (gap) {
      setState('error', gap);
      noteFault(gap);
      return;
    }
    const after = accountSnapshot(verifiedUid);
    const hasPending = Object.values(after?.conversations || {}).some((conversation) => conversation.pending);
    if (pendingWork || hasPending) {
      setState('catching_up', budget.remaining === 0 ? 'DM_BUDGET' : 'DM_CATCHUP');
      return;
    }
    if (!after?.discovery?.scanActive) {
      setState('watching', '');
      const outcome = await recordPolicySuccess(run, run.workflowId);
      if (isCurrent(run) && outcome?.recorded !== false) {
        try {
          await rotateSyncWorkflow(run.credentialFingerprint, run);
        } catch { /* keep the previous durable cycle if rotation cannot commit */ }
      }
    } else {
      setState('catching_up', budget.remaining === 0 ? 'DM_BUDGET' : 'DM_CATCHUP');
      return;
    }
    if (delivery && typeof delivery.pump === 'function') {
      try {
        await delivery.pump({ guard: () => isCurrent(run) });
      } catch { /* delivery exposes its own queue state */ }
    }
  }

  function check(options = {}) {
    return runCheck(options?.manual !== false);
  }

  function runCheck(manual) {
    if (disposed || !running) return Promise.resolve(status());
    if (roundPromise) return roundPromise;
    const run = {
      generation, revision: readRevision(), controller: new AbortController(), manual: manual === true,
    };
    activeRound = run;
    let promise;
    promise = (async () => {
      try {
        await runRound(run);
      } catch (error) {
        await handleFailure(run, error);
      } finally {
        await refreshPolicyStatus();
        await deliverNotice(run);
        if (activeRound === run) activeRound = null;
        if (roundPromise === promise) roundPromise = null;
        if (running && !disposed) scheduleNext();
      }
      return status();
    })();
    roundPromise = promise;
    return promise;
  }

  function start() {
    if (disposed) return status();
    const config = readConfig();
    running = true;
    poll = config.pollSeconds;
    if (!config.enabled) {
      setState('disabled', 'DM_DISABLED');
      return status();
    }
    if (!cookieValue()) setState('waiting_login', 'DM_NO_COOKIE');
    else if (!bindingSnapshot().target) setState('waiting_owner', 'DM_NO_OWNER');
    else setState('initializing', 'DM_BASELINE');
    refreshPolicyStatus().catch(() => {});
    if (autoSchedule) schedule(1);
    return status();
  }

  function pause(code = 'DM_PAUSED') {
    running = false;
    generation += 1;
    clearTimer();
    try { activeRound?.controller?.abort(); } catch { /* ignore */ }
    activeRound = null;
    setState('disabled', code);
    return status();
  }

  async function logout() {
    pause('DM_LOGOUT');
    if (typeof settings.clearBiliCookie === 'function') {
      try {
        await settings.clearBiliCookie({ guard: () => !disposed });
      } catch { /* keep the visible logout state */ }
    }
    setState('waiting_login', 'DM_LOGOUT');
    return status();
  }

  function deactivate() {
    if (disposed) return status();
    disposed = true;
    generation += 1;
    clearTimer();
    try { activeRound?.controller?.abort(); } catch { /* ignore */ }
    activeRound = null;
    running = false;
    try { unsubscribe?.(); } catch { /* ignore */ }
    try { delivery?.deactivate?.(); } catch { /* ignore */ }
    setState('disabled', 'DM_PAUSED');
    return status();
  }

  async function flush() {
    await Promise.allSettled([
      settings.flush?.(),
      store.flush?.(),
      delivery?.flush?.(),
    ]);
  }

  function configChanged() {
    const config = readConfig();
    poll = config.pollSeconds;
    if (!config.enabled && running) {
      pause('DM_DISABLED');
      refreshPolicyStatus().catch(() => {});
      return status();
    }
    if (config.enabled && !running && !disposed) start();
    if (running && autoSchedule) {
      refreshPolicyStatus().catch(() => {}).then(() => {
        if (running && !disposed) scheduleNext();
      });
    } else {
      refreshPolicyStatus().catch(() => {});
    }
    return status();
  }

  function status() {
    const config = readConfig();
    let binding = { target: '', version: 0 };
    let discovery = null;
    let counters = null;
    try {
      const current = store.read((value) => value);
      binding = current.binding || binding;
      counters = store.statusCounters();
      const account = current.currentUid ? current.accounts[current.currentUid] : null;
      if (account) {
        discovery = {
          phase: account.discovery?.phase || 'idle',
          baselineComplete: account.discovery?.baselineComplete === true,
          pages: Number(account.discovery?.pages || 0),
          sessionCount: Number(account.discovery?.sessionCount || 0),
          gap: Boolean(account.discovery?.gap),
        };
      }
    } catch (error) {
      counters = null;
    }
    const policy = policySnapshot ? {
      paused: policySnapshot.paused === true,
      pauseReason: policySnapshot.pauseReason || null,
      cooldownReason: policySnapshot.cooldownReason || null,
      cooldownScope: policySnapshot.cooldownScope || null,
      nextAllowedAt: policySnapshot.nextAllowedAt ?? null,
      requiresManualRecovery: policySnapshot.requiresManualRecovery === true,
      recoveryProbePending: policySnapshot.recoveryProbePending === true,
      recoveryProbeExpiresAt: policySnapshot.recoveryProbeExpiresAt ?? null,
      configuredIntervalSeconds: Number(policySnapshot.configuredIntervalSeconds) || config.pollSeconds,
      effectiveIntervalSeconds: Number(policySnapshot.effectiveIntervalSeconds) || config.pollSeconds,
      adaptiveMultiplier: Number(policySnapshot.adaptiveMultiplier) || 1,
      budget: policySnapshot.budget || null,
      lastEffectiveSyncAt: policySnapshot.lastEffectiveSyncAt ?? null,
    } : null;
    return {
      state: stateName,
      reasonCode: reasonCode ? safeCode(reasonCode) : '',
      nextRetryAt: (stateName === 'catching_up' && catchupAt ? catchupAt : nextRetryAt) || null,
      lastCheckAt: lastCheckAt || null,
      lastSuccessAt,
      account: { loggedIn: Boolean(cookieValue()), verified: Boolean(verifiedUid) },
      binding: { bound: Boolean(binding.target), mask: maskTarget(binding.target), version: Number(binding.version) || 0 },
      discovery,
      queue: counters ? {
        unfinished: counters.unfinished,
        pending: counters.pending,
        unknown: counters.unknown,
        failed: counters.failed,
        sent: counters.sent,
        suppressed: counters.suppressed,
        pendingConversations: counters.pendingConversations,
        gapConversations: counters.gapConversations,
      } : {},
      polling: {
        seconds: config.pollSeconds,
        effectiveSeconds: policy?.effectiveIntervalSeconds || config.pollSeconds,
        requestBudget: REQUEST_BUDGET,
      },
      requestPolicy: policy,
      noticePending: Boolean(pendingNotice),
      notice: pendingNotice
        ? { code: safeCode(pendingNotice.code), at: Number(pendingNotice.at) || null }
        : null,
    };
  }

  function consumeNotice() {
    const notice = pendingNotice;
    pendingNotice = null;
    return notice;
  }

  let unsubscribe = null;
  if (typeof settings.subscribeBiliCookie === 'function') {
    try {
      unsubscribe = settings.subscribeBiliCookie(() => {
        if (disposed) return;
        generation += 1;
        try { activeRound?.controller?.abort(); } catch { /* ignore */ }
        activeRound = null;
        verifiedRevision = null;
        verifiedUid = '';
        authBlockedRevision = null;
        if (!cookieValue()) {
          setState('waiting_login', 'DM_AUTH');
          noteFault('DM_AUTH');
        } else if (running) {
          reasonCode = 'DM_CREDENTIAL_CHANGED';
          if (autoSchedule) schedule(1);
        }
      });
    } catch { unsubscribe = null; }
  }

  const api = {
    ready: readiness,
    start,
    check,
    pause,
    logout,
    deactivate,
    configChanged,
    flush,
    status,
    consumeNotice,
    get running() { return running; },
    get state() { return stateName; },
    delivery,
  };
  return api;
}
