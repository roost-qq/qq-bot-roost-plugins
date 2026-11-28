import {
  XhhDmStoreError, makeXhhRequestId, makeXhhSegmentKey, normalizeTargetKind,
  shortXhhMessageId,
} from './xiaoheihe-dm-store.js';

export const XHH_TEXT_LIMIT = 1500;
export const XHH_VIEW_PAGE_SIZE = 3;
export const XHH_FAILED_BACKOFF_MS = 60_000;
export const XHH_MAX_MESSAGES_PER_PUMP = 20;
export const XHH_CLAIM_LIMIT = 4;

const BLOCK_STATES = new Set(['sending', 'pending', 'unknown']);
const SAFE_CODES = new Set([
  'XHH_STATE_CORRUPT', 'XHH_STATE_UNSUPPORTED', 'XHH_STATE_READ_FAILED',
  'XHH_STATE_NOT_READY', 'XHH_WRITE_FAILED', 'XHH_CAPACITY', 'XHH_STALE',
  'XHH_ACCOUNT_INVALID', 'XHH_BINDING_REQUIRED', 'XHH_OWNER_REQUIRED',
  'XHH_RATE_LIMIT', 'XHH_AUTH', 'XHH_NETWORK', 'XHH_MODULE_UNAVAILABLE',
  'XHH_CONFIG', 'XHH_MESSAGE_ID_INVALID', 'XHH_BINDING_INVALID', 'XHH_GROUP_INVALID',
  'XHH_GROUP_UNAVAILABLE', 'XHH_TIMEOUT', 'XHH_HTTP', 'XHH_RESPONSE', 'XHH_API',
  'XHH_CANCELLED', 'XHH_BUDGET', 'XHH_GAP', 'XHH_NO_SERVER_TIME',
  'XHH_CREDENTIAL_CHANGED', 'XHH_NO_COOKIE', 'XHH_NO_OWNER', 'XHH_DISABLED',
  'XHH_PAUSED', 'XHH_LOGOUT', 'XHH_RECOVERED', 'XHH_CONTENT_INVALID',
  'XHH_BASELINE', 'XHH_CATCHUP', 'XHH_ERROR', 'DM_RATE_LIMIT', 'DM_STALE',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeCode(value) {
  const code = String(value ?? '');
  return SAFE_CODES.has(code) ? code : 'XHH_ERROR';
}

function maskTarget(target) {
  const value = String(target || '');
  if (!value) return '';
  return value.length <= 4 ? '***' : `***${value.slice(-4)}`;
}

function safeGroupId(value) {
  const text = String(value ?? '');
  if (!text || text.length > 512 || /[\u0000-\u001f]/.test(text)) return '';
  return text;
}

function safeGroupName(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 128);
}

function gateAllows(value) {
  if (value === undefined || value === null) return true;
  if (value === false) return false;
  if (typeof value === 'string') {
    return !['no', 'false', 'blocked', 'denied', 'forbidden', 'disabled']
      .includes(value.toLowerCase());
  }
  if (isObject(value)) {
    if (value.ok === false || value.allowed === false || value.enabled === false) return false;
  }
  return true;
}

function fallbackChunks(text, limit) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let end = limit;
    const last = rest.charCodeAt(end - 1);
    const next = rest.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    if (end <= 0) end = limit;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function graphemesOf(text) {
  if (typeof Intl?.Segmenter !== 'function') return null;
  try {
    return [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)]
      .map((item) => item.segment);
  } catch {
    return null;
  }
}

export function splitOriginalText(text, size = XHH_TEXT_LIMIT) {
  const value = String(text ?? '');
  const limit = Math.max(1, Math.floor(Number(size) || XHH_TEXT_LIMIT));
  if (!value) return [''];
  const graphemes = graphemesOf(value);
  if (!graphemes) return fallbackChunks(value, limit);
  const chunks = [];
  let current = '';
  for (const grapheme of graphemes) {
    if (grapheme.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...fallbackChunks(grapheme, limit));
      continue;
    }
    if (current && current.length + grapheme.length > limit) {
      chunks.push(current);
      current = '';
    }
    current += grapheme;
  }
  if (current) chunks.push(current);
  if (!chunks.length) chunks.push('');
  return chunks;
}

export function formatXhhTime(timestampMs) {
  const value = Number(timestampMs);
  const ms = Number.isFinite(value) && value > 0 ? value : 0;
  const date = new Date(ms + 8 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function senderLine(record) {
  const name = String(record.senderName || '');
  return name ? `来自：${name}` : '来自：对方';
}

export function buildXhhSegmentBodies(record, {
  limit = XHH_TEXT_LIMIT, label = '【小黑盒私信】',
} = {}) {
  const header = `${label}\n${senderLine(record)}\n时间：${formatXhhTime(record.sentAtMs)}\n`
    + `编号：XHH-${shortXhhMessageId(record.key || record.messageId || record.seq)}\n\n`;
  const text = String(record.text ?? '');
  const markerRoom = 16;
  let chunks = splitOriginalText(text, Math.max(1, Math.floor(limit) - header.length - markerRoom));
  if (chunks.length > 1) {
    const markerMax = `[${chunks.length}/${chunks.length}]\n`.length;
    chunks = splitOriginalText(text, Math.max(1, Math.floor(limit) - header.length - markerMax));
  }
  return chunks.map((chunk, index) => {
    const marker = chunks.length > 1 ? `[${index + 1}/${chunks.length}]\n` : '';
    return `${header}${marker}${chunk}`;
  });
}

function destinationOf(binding) {
  const kind = binding?.targetKind === 'group' ? 'group' : 'c2c';
  return {
    ownerTarget: String(binding?.ownerTarget || ''),
    kind,
    target: String(binding?.target || ''),
    version: Number(binding?.version) || 0,
  };
}

function sameDestination(left, right) {
  return !!(left && right)
    && left.ownerTarget === right.ownerTarget
    && left.kind === right.kind
    && left.target === right.target
    && Number(left.version) === Number(right.version);
}

function messageSegments(account, messageKey) {
  return Object.values(account.segments || {})
    .filter((segment) => segment.messageKey === messageKey)
    .sort((left, right) => left.index - right.index);
}

function recomputeMessage(draft, account, messageKey, now) {
  const message = account?.messages?.[messageKey];
  if (!message || message.status === 'sent' || message.status === 'suppressed'
    || message.status === 'cancelled') return;
  const segments = messageSegments(account, messageKey)
    .filter((segment) => segment.state !== 'superseded');
  if (!segments.length) return;
  const states = new Set(segments.map((segment) => segment.state));
  if (segments.every((segment) => segment.state === 'sent')) {
    message.status = 'sent';
    message.deliveryState = 'sent';
    message.completedAt ||= now;
    return;
  }
  message.status = 'unfinished';
  if (states.has('unknown')) message.deliveryState = 'unknown';
  else if (states.has('pending')) message.deliveryState = 'pending';
  else if (states.has('sending')) message.deliveryState = 'sending';
  else if (states.has('failed')) message.deliveryState = 'failed';
  else message.deliveryState = 'queued';
}

function retryAt(attempts, now) {
  const level = Math.max(0, Math.min(5, Number(attempts) - 1));
  return now + Math.min(30 * 60_000, XHH_FAILED_BACKOFF_MS * (2 ** level));
}

function ledgerState(row) {
  if (typeof row === 'string') {
    const text = row.toLowerCase();
    if (text === 'success') return 'sent';
    if (['sent', 'pending', 'unknown', 'failed', 'fail'].includes(text)) {
      return text === 'fail' ? 'failed' : text;
    }
    return '';
  }
  if (!isObject(row)) return '';
  const state = String(row.state || row.status || '').toLowerCase();
  if (state === 'sent' || state === 'success') return 'sent';
  if (state === 'pending' || state === 'audited') return 'pending';
  if (state === 'unknown') return 'unknown';
  if (state === 'failed' || state === 'fail') return 'failed';
  if (row.sent === true) return 'sent';
  return '';
}

async function readLedger(ctx, requestId) {
  try {
    const value = ctx?.delivery?.get?.(requestId);
    return value && typeof value.then === 'function' ? await value : (value ?? null);
  } catch {
    return null;
  }
}

function classifyReturned(returned) {
  if (typeof returned === 'string' && returned.trim()) return 'sent';
  if (typeof returned === 'number' && Number.isFinite(returned)) return 'sent';
  if (!isObject(returned)) return 'unknown';
  if (returned.dry === true) return 'failed';
  if (returned.pending === true) return 'pending';
  if (returned.ok === false || returned.success === false) return 'failed';
  const state = String(returned.state ?? returned.status ?? '').toLowerCase();
  if (state === 'sent' || state === 'success' || state === 'succeeded') return 'sent';
  if (state === 'pending' || state === 'audited' || state === 'audit') return 'pending';
  if (state === 'unknown') return 'unknown';
  if (state === 'failed' || state === 'fail') return 'failed';
  const id = returned.id ?? returned.msgId ?? returned.messageId;
  return (typeof id === 'string' && id.trim())
    || (typeof id === 'number' && Number.isFinite(id)) ? 'sent' : 'unknown';
}

function classifyError(error) {
  if (!error) return 'unknown';
  const combined = `${String(error.code || error.name || '')} ${String(error.message || '')}`
    .toLowerCase();
  if (/(pending|audited|audit|review)/.test(combined)) return 'pending';
  if (/(dry|offline|expired|quota|limit|rate|reach|unreachable|blocked|permission|forbidden|denied|cancel)/.test(combined)) {
    return 'failed';
  }
  return 'unknown';
}

async function classify(ctx, requestId, returned, error) {
  const fromLedger = ledgerState(await readLedger(ctx, requestId));
  if (fromLedger) return fromLedger;
  if (error) return classifyError(error);
  return classifyReturned(returned);
}

function storedErrorCode(state, returned) {
  if (state === 'sent') return '';
  if (returned?.dry === true) return 'dry';
  if (state === 'pending') return 'pending';
  if (state === 'unknown') return 'unknown';
  if (state === 'failed') return 'failed';
  return 'unknown';
}

function normalizeReach(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (typeof value === 'string') {
    const text = value.toLowerCase();
    if (['yes', 'ok', 'true', 'reachable', 'available', 'allowed'].includes(text)) return 'yes';
    if (['no', 'false', 'blocked', 'unreachable', 'forbidden', 'denied'].includes(text)) return 'no';
    return 'unknown';
  }
  if (isObject(value)) {
    return normalizeReach(value.verdict ?? value.state ?? value.status ?? value.reachable
      ?? value.canC2C ?? value.allowed ?? value.ok);
  }
  return 'unknown';
}

function normalizeQuota(value) {
  if (value === true) return null;
  if (value === false) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.max(0, Math.floor(Number(value)));
  }
  if (isObject(value)) {
    const candidate = value.left ?? value.remaining ?? value.quota ?? value.value ?? value.count;
    return candidate === undefined ? null : normalizeQuota(candidate);
  }
  return null;
}

export function createXiaoheiheDmDelivery({
  store, ctx, reserveSend, rateInfo = null, now = () => Date.now(),
  maxMessages = XHH_MAX_MESSAGES_PER_PUMP, isActive = () => true, onEvent = null,
} = {}) {
  if (!store || typeof store.transaction !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('createXiaoheiheDmDelivery requires a Xhh DM store');
  }
  if (!ctx || typeof ctx.push !== 'function' || typeof ctx.isOwner !== 'function') {
    throw new TypeError('createXiaoheiheDmDelivery requires the native host context');
  }

  let tail = Promise.resolve();
  let disposed = false;

  function withLock(fn) {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  }

  function guardOk(guard) {
    if (disposed || !isActive()) return false;
    if (guard === undefined) return true;
    try { return typeof guard === 'function' && guard() === true; } catch { return false; }
  }

  function emit(event, fields) {
    if (typeof onEvent !== 'function') return;
    try {
      const result = onEvent(event, fields);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch { /* diagnostics never break delivery */ }
  }

  function eventAction(state) {
    if (state === 'sent') return 'sent';
    if (state === 'pending') return 'pending';
    if (state === 'unknown') return 'unknown';
    if (state === 'failed') return 'failed';
    return 'unavailable';
  }

  async function ownerOk(target) {
    try { return await Promise.resolve(ctx.isOwner(target)) === true; } catch { return false; }
  }

  function snapshot() {
    return store.read((state) => {
      const account = state.currentAccountKey ? state.accounts[state.currentAccountKey] : null;
      return {
        robotKey: state.robotKey,
        destination: destinationOf(state.binding),
        account: account ? { partition: account.partition, scope: account.partition } : null,
      };
    });
  }

  async function groupReady(target) {
    const groupId = safeGroupId(target);
    if (!groupId || typeof ctx.getGroup !== 'function') return null;
    let profile;
    try { profile = await Promise.resolve(ctx.getGroup(groupId)); } catch { return null; }
    if (!profile || typeof profile !== 'object' || profile.enabled === false) return null;
    const owned = profile.groupOpenid ?? profile.groupId ?? profile.chatId;
    if (owned === undefined || safeGroupId(owned) !== groupId) return null;
    if (typeof ctx.gate?.check === 'function') {
      let allowed;
      try {
        allowed = await Promise.resolve(ctx.gate.check(groupId, { kind: 'group', target: groupId }));
      } catch {
        return null;
      }
      if (!gateAllows(allowed)) return null;
    }
    return { id: groupId, name: safeGroupName(profile.name ?? profile.note ?? '') };
  }

  async function reachReady(destination) {
    if (!destination?.target) return { ok: false, reason: 'unreachable' };
    if (destination.kind === 'group') {
      if (!(await groupReady(destination.target))) return { ok: false, reason: 'unreachable' };
      if (typeof ctx.reach?.canGroupPush !== 'function') return { ok: false, reason: 'unavailable' };
      const reach = normalizeReach(await Promise.resolve(ctx.reach.canGroupPush(destination.target))
        .catch(() => 'unknown'));
      if (reach === 'no') return { ok: false, reason: 'unreachable' };
      let quota = null;
      try {
        quota = normalizeQuota(await Promise.resolve(ctx.quotaLeft?.(destination.target, 'group')));
      } catch { quota = null; }
      if (quota === 0) return { ok: false, reason: 'quota' };
      return { ok: true, reach, quota };
    }
    const reach = normalizeReach(await Promise.resolve(ctx.reach?.canC2C?.(destination.target))
      .catch(() => 'unknown'));
    if (reach === 'no') return { ok: false, reason: 'unreachable' };
    let quota = null;
    try {
      quota = normalizeQuota(await Promise.resolve(ctx.quotaLeft?.(destination.target, 'c2c')));
    } catch { quota = null; }
    if (quota === 0) return { ok: false, reason: 'quota' };
    return { ok: true, reach, quota };
  }

  async function fenceReady({ guard, partition, destination } = {}) {
    if (!guardOk(guard) || !destination?.target) return false;
    let current;
    try { current = snapshot(); } catch { return false; }
    if (!current.account || current.account.partition !== partition) return false;
    if (!sameDestination(current.destination, destination)) return false;
    if (!(await ownerOk(destination.ownerTarget))) return false;
    if (destination.kind === 'group' && !(await groupReady(destination.target))) return false;
    if (!guardOk(guard)) return false;
    try { current = snapshot(); } catch { return false; }
    if (!current.account || current.account.partition !== partition) return false;
    return sameDestination(current.destination, destination);
  }

  async function reserveBudget({ guard, at }) {
    if (typeof reserveSend !== 'function') {
      throw new XhhDmStoreError('XHH_BUDGET', '共享发送预算不可用');
    }
    let result;
    try {
      result = await Promise.resolve(reserveSend({ guard, at }));
    } catch (error) {
      if (error?.code === 'DM_RATE_LIMIT' || error?.code === 'XHH_RATE_LIMIT') {
        throw new XhhDmStoreError('XHH_RATE_LIMIT', '发送频率已达上限', {
          retryAfterMs: error.retryAfterMs,
        });
      }
      throw error;
    }
    if (result === false || result?.ok === false || result?.unavailable === true) {
      throw new XhhDmStoreError('XHH_BUDGET', '共享发送预算不可用');
    }
    return result;
  }

  async function revertUnsent(partition, segmentKey, at) {
    try {
      await store.transaction((draft) => {
        const account = draft.accounts[partition];
        const segment = account?.segments?.[segmentKey];
        if (!segment || segment.state !== 'sending' || segment.attempts <= 0) return false;
        segment.state = 'planned';
        segment.attempts -= 1;
        segment.updatedAt = at;
        segment.nextRetryAt = 0;
        segment.lastErrorCode = '';
        recomputeMessage(draft, account, segment.messageKey, at);
        return true;
      });
      return true;
    } catch {
      return false;
    }
  }

  function createSegments(draft, account, message, destination, at) {
    const bodies = buildXhhSegmentBodies(message);
    const created = [];
    for (let index = 0; index < bodies.length; index += 1) {
      const key = makeXhhSegmentKey({
        messageKey: message.key,
        bindingVersion: destination.version,
        target: destination.target,
        index,
        targetKind: destination.kind,
      });
      let segment = account.segments[key];
      if (!segment) {
        segment = {
          key,
          messageKey: message.key,
          accountScope: account.partition,
          target: destination.target,
          targetKind: destination.kind,
          bindingVersion: destination.version,
          index,
          total: bodies.length,
          body: bodies[index],
          requestId: makeXhhRequestId({
            robotKey: draft.robotKey,
            accountScope: account.partition,
            target: destination.target,
            bindingVersion: destination.version,
            messageKey: message.key,
            index,
            targetKind: destination.kind,
          }),
          state: 'planned',
          attempts: 0,
          createdAt: at,
          updatedAt: at,
          nextRetryAt: 0,
          lastErrorCode: '',
          sentAt: null,
        };
        account.segments[key] = segment;
      }
      created.push(segment);
    }
    return created;
  }

  async function ensureMessageSegments(partition, messageKey, { guard } = {}) {
    const at = now();
    return store.transaction((draft) => {
      const account = draft.accounts[partition];
      const message = account?.messages?.[messageKey];
      if (!account || !message || message.status !== 'unfinished') return { segments: [] };
      if (draft.currentAccountKey !== partition) {
        throw new XhhDmStoreError('XHH_STALE', '账号已变化');
      }
      const destination = destinationOf(draft.binding);
      if (!destination.target) {
        throw new XhhDmStoreError('XHH_BINDING_REQUIRED', '尚未绑定通知目标');
      }
      const existing = messageSegments(account, messageKey)
        .filter((segment) => segment.state !== 'superseded');
      if (existing.length) return { segments: existing.map((segment) => segment.key) };
      const created = createSegments(draft, account, message, destination, at);
      return { segments: created.map((segment) => segment.key) };
    }, { guard });
  }

  async function materializeBacklog({ guard } = {}) {
    const at = now();
    return store.transaction((draft) => {
      const account = draft.currentAccountKey ? draft.accounts[draft.currentAccountKey] : null;
      if (!account) return { created: 0 };
      const destination = destinationOf(draft.binding);
      if (!destination.target) return { created: 0 };
      let created = 0;
      for (const message of Object.values(account.messages || {})) {
        if (message.status !== 'unfinished') continue;
        if (messageSegments(account, message.key).length) continue;
        created += createSegments(draft, account, message, destination, at).length;
      }
      return { created };
    }, { guard });
  }

  async function sendActiveSegment(partition, segmentKey, { guard } = {}) {
    const snap = snapshot();
    const segment = store.read((state) => {
      const account = state.accounts[partition];
      const value = account?.segments?.[segmentKey];
      return value ? JSON.parse(JSON.stringify(value)) : null;
    });
    const destination = snap.destination;
    if (!segment || !destination.target) return { state: 'skipped' };
    if (snap.account?.partition !== partition
      || segment.target !== destination.target
      || segment.bindingVersion !== destination.version
      || segment.targetKind !== destination.kind) {
      return { state: 'frozen' };
    }
    if (!['planned', 'failed'].includes(segment.state)) return { state: segment.state };
    if (segment.state === 'failed' && Number(segment.nextRetryAt) > now()) {
      return { state: 'backoff' };
    }
    if (!guardOk(guard)) return { state: 'stale' };
    if (!(await ownerOk(destination.ownerTarget))) return { state: 'waiting_owner' };
    let reach = 'unknown';
    let quota = null;
    if (destination.kind === 'group') {
      if (!(await groupReady(destination.target))) return { state: 'unreachable' };
      if (typeof ctx.reach?.canGroupPush !== 'function') return { state: 'unavailable' };
      reach = normalizeReach(await Promise.resolve(ctx.reach.canGroupPush(destination.target))
        .catch(() => 'unknown'));
      if (reach === 'no') return { state: 'unreachable' };
      try {
        quota = normalizeQuota(await Promise.resolve(ctx.quotaLeft?.(destination.target, 'group')));
      } catch { quota = null; }
    } else {
      reach = normalizeReach(await Promise.resolve(ctx.reach?.canC2C?.(destination.target))
        .catch(() => 'unknown'));
      if (reach === 'no') return { state: 'unreachable' };
      try {
        quota = normalizeQuota(await Promise.resolve(ctx.quotaLeft?.(destination.target, 'c2c')));
      } catch { quota = null; }
    }
    if (quota === 0) return { state: 'quota' };
    if ((reach === 'unknown' || quota === null) && Number(segment.attempts) > 0) {
      return { state: 'unknown_hold' };
    }
    if (!(await fenceReady({ guard, partition, destination }))) {
      return { state: disposed ? 'stale' : 'frozen' };
    }
    const at = now();
    try {
      await reserveBudget({ guard, at });
    } catch (error) {
      emit('delivery', {
        phase: 'send',
        action: 'failed',
        errorCode: safeCode(error?.code),
        targetKind: destination.kind,
        bools: { hostSent: false, userConfirmed: false },
      });
      if (error?.code === 'XHH_RATE_LIMIT') return { state: 'rate' };
      return { state: error?.code === 'XHH_STALE' ? 'stale' : 'unavailable' };
    }
    let prepared;
    try {
      prepared = await store.transaction((draft) => {
        const account = draft.accounts[partition];
        const current = account?.segments?.[segmentKey];
        if (!current || current.state !== segment.state) {
          throw new XhhDmStoreError('XHH_STALE', '投递分段状态已变化');
        }
        if (!sameDestination(destinationOf(draft.binding), destination)
          || draft.currentAccountKey !== partition) {
          throw new XhhDmStoreError('XHH_STALE', '投递目标已变化');
        }
        current.state = 'sending';
        current.attempts = Number(current.attempts || 0) + 1;
        current.updatedAt = at;
        current.lastErrorCode = '';
        return { body: current.body, requestId: current.requestId };
      }, { guard });
    } catch (error) {
      return { state: error?.code === 'XHH_STALE' ? 'stale' : 'stale' };
    }
    if (!(await fenceReady({ guard, partition, destination }))) {
      await revertUnsent(partition, segmentKey, at);
      return { state: 'aborted' };
    }
    let returned;
    let thrown = null;
    try {
      returned = await ctx.push(destination.target, prepared.body, {
        kind: destination.kind,
        requestId: prepared.requestId,
      });
    } catch (error) {
      thrown = error;
    }
    const state = await classify(ctx, prepared.requestId, returned, thrown);
    const updatedAt = now();
    const commit = (draft) => {
      const account = draft.accounts[partition];
      const current = account?.segments?.[segmentKey];
      if (!current || current.state !== 'sending') return false;
      current.state = state;
      current.updatedAt = updatedAt;
      current.lastErrorCode = storedErrorCode(state, returned);
      if (state === 'sent') current.sentAt = updatedAt;
      if (state === 'failed') current.nextRetryAt = retryAt(current.attempts, updatedAt);
      recomputeMessage(draft, account, current.messageKey, updatedAt);
      return true;
    };
    try {
      await store.transaction(commit, { guard });
    } catch (error) {
      if (disposed || error?.code === 'XHH_STALE') {
        try { await store.transaction(commit); } catch { return { state: 'stale' }; }
      } else {
        return { state: 'stale' };
      }
    }
    emit('delivery', {
      phase: 'send',
      action: eventAction(state),
      targetKind: destination.kind,
      bools: { hostSent: state === 'sent', userConfirmed: false },
      counts: { sent: state === 'sent' ? 1 : 0 },
    });
    return { state };
  }

  async function reconcileUnlocked({ guard } = {}) {
    if (disposed) return { checked: 0, changed: 0 };
    const targets = store.read((state) => {
      const rows = [];
      for (const account of Object.values(state.accounts || {})) {
        for (const segment of Object.values(account.segments || {})) {
          if (['sending', 'pending', 'unknown'].includes(segment.state)) {
            rows.push({ partition: account.partition, key: segment.key, requestId: segment.requestId, state: segment.state });
          }
        }
      }
      return rows;
    });
    const resolved = [];
    for (const target of targets) {
      const state = ledgerState(await readLedger(ctx, target.requestId));
      let next = '';
      if (state === 'sent') next = 'sent';
      else if (state === 'pending') next = 'pending';
      else if (state === 'failed') next = 'failed';
      else if (state === 'unknown') next = 'unknown';
      else if (target.state === 'sending') next = 'unknown';
      else next = target.state;
      if (next !== target.state) resolved.push({ ...target, next });
    }
    if (!resolved.length) return { checked: targets.length, changed: 0 };
    const at = now();
    await store.transaction((draft) => {
      for (const item of resolved) {
        const account = draft.accounts[item.partition];
        const segment = account?.segments?.[item.key];
        if (!segment || segment.state !== item.state) continue;
        segment.state = item.next;
        segment.updatedAt = at;
        if (item.next === 'sent') segment.sentAt ||= at;
        if (item.next === 'unknown') segment.lastErrorCode = 'ledger_unknown';
        if (item.next === 'failed') {
          segment.lastErrorCode = 'ledger_failed';
          segment.nextRetryAt = retryAt(segment.attempts, at);
        }
        recomputeMessage(draft, account, segment.messageKey, at);
      }
      return { changed: resolved.length };
    }, { guard });
    emit('delivery', {
      phase: 'result',
      action: 'completed',
      bools: {
        fromLedger: true,
        hostSent: resolved.some((item) => item.next === 'sent'),
        userConfirmed: false,
      },
      counts: {
        sent: resolved.filter((item) => item.next === 'sent').length,
        pending: resolved.filter((item) => item.next === 'pending').length,
        unknown: resolved.filter((item) => item.next === 'unknown').length,
        failed: resolved.filter((item) => item.next === 'failed').length,
      },
    });
    return { checked: targets.length, changed: resolved.length };
  }

  async function pumpUnlocked({ guard } = {}) {
    if (disposed) return { attempted: 0 };
    if (store.loadError?.()) return { attempted: 0, errorCode: 'XHH_STATE_CORRUPT' };
    await reconcileUnlocked({ guard });
    if (disposed || !guardOk(guard)) return { attempted: 0 };
    const snap = store.read((state) => {
      const account = state.currentAccountKey ? state.accounts[state.currentAccountKey] : null;
      return {
        partition: account?.partition || '',
        destination: destinationOf(state.binding),
        messages: account ? Object.values(account.messages || {})
          .filter((message) => message.status === 'unfinished')
          .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
          .map((message) => ({ key: message.key, conversation: message.conversationKey })) : [],
      };
    });
    if (!snap.partition || !snap.destination?.target) return { attempted: 0 };
    const blocked = new Set();
    let attempted = 0;
    for (const item of snap.messages) {
      if (disposed || attempted >= maxMessages || blocked.has(item.conversation)) continue;
      if (!guardOk(guard)) break;
      let prepared;
      try {
        prepared = await ensureMessageSegments(snap.partition, item.key, { guard });
      } catch {
        blocked.add(item.conversation);
        continue;
      }
      for (const key of prepared.segments || []) {
        const result = await sendActiveSegment(snap.partition, key, { guard });
        if (['sent', 'failed', 'pending', 'unknown'].includes(result.state)) attempted += 1;
        if (result.state !== 'sent') {
          blocked.add(item.conversation);
          break;
        }
      }
      if (blocked.has(item.conversation)) continue;
    }
    return { attempted };
  }

  async function pump(options) {
    return withLock(() => pumpUnlocked(options));
  }

  async function reconcile(options) {
    return withLock(() => reconcileUnlocked(options));
  }

  async function sendClaimSegment(partition, item, msg, { guard } = {}) {
    const snap = snapshot();
    const destination = snap.destination;
    if (snap.account?.partition !== partition || destination.kind !== 'c2c'
      || item.target !== destination.target || item.version !== destination.version) {
      return 'frozen';
    }
    if (!(await fenceReady({ guard, partition, destination }))) {
      return disposed || !guardOk(guard) ? 'stale' : 'waiting_owner';
    }
    const access = await reachReady(destination);
    if (!access.ok) return access.reason;
    const at = now();
    try {
      await reserveBudget({ guard, at });
    } catch (error) {
      return error?.code === 'XHH_RATE_LIMIT' ? 'rate' : 'unavailable';
    }
    let prepared;
    try {
      prepared = await store.transaction((draft) => {
        const account = draft.accounts[partition];
        const segment = account?.segments?.[item.segmentKey];
        if (!segment || !['planned', 'failed'].includes(segment.state)) {
          throw new XhhDmStoreError('XHH_STALE', '投递分段状态已变化');
        }
        const binding = destinationOf(draft.binding);
        if (!sameDestination(binding, destination) || draft.currentAccountKey !== partition) {
          throw new XhhDmStoreError('XHH_STALE', '投递目标已变化');
        }
        segment.state = 'sending';
        segment.attempts = Number(segment.attempts || 0) + 1;
        segment.updatedAt = at;
        segment.lastErrorCode = '';
        return { body: segment.body, requestId: segment.requestId };
      }, { guard });
    } catch {
      return 'stale';
    }
    if (!(await fenceReady({ guard, partition, destination }))) {
      await revertUnsent(partition, item.segmentKey, at);
      return 'aborted';
    }
    const errors = [];
    let returned;
    try {
      returned = await msg.replyNow(prepared.body, {
        requestId: prepared.requestId,
        onError: (error) => errors.push(error),
      });
    } catch (error) {
      errors.push(error);
    }
    const state = await classify(ctx, prepared.requestId, returned, errors[0] || null);
    const updatedAt = now();
    const commit = (draft) => {
      const account = draft.accounts[partition];
      const segment = account?.segments?.[item.segmentKey];
      if (!segment || segment.state !== 'sending') return false;
      segment.state = state;
      segment.updatedAt = updatedAt;
      segment.lastErrorCode = storedErrorCode(state, returned);
      if (state === 'sent') segment.sentAt = updatedAt;
      if (state === 'failed') segment.nextRetryAt = retryAt(segment.attempts, updatedAt);
      recomputeMessage(draft, account, segment.messageKey, updatedAt);
      return true;
    };
    try {
      await store.transaction(commit, { guard });
    } catch (error) {
      if (disposed || error?.code === 'XHH_STALE') {
        try { await store.transaction(commit); } catch { return 'stale'; }
      } else {
        return 'stale';
      }
    }
    return state;
  }

  async function claim(msg, { limit = XHH_CLAIM_LIMIT, guard } = {}) {
    return withLock(async () => {
      if (disposed) return { sent: 0, remaining: 0 };
      if (!msg || msg.kind !== 'c2c') {
        throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '请在主人 QQ 私聊中领取');
      }
      const target = String(msg.userId || '');
      if (!target || (msg.chatId && String(msg.chatId) !== target)) {
        throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '当前会话不是标准 C2C 私聊');
      }
      if (!(await ownerOk(target))) {
        throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '当前用户不是机器人主人');
      }
      const binding = store.binding();
      if (!binding?.ownerTarget || binding.ownerTarget !== target
        || binding.targetKind !== 'c2c' || binding.target !== target) {
        throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '当前私聊尚未绑定为接收目标');
      }
      await reconcileUnlocked({ guard });
      if (disposed || !guardOk(guard)) return { sent: 0, remaining: 0 };
      const snap = store.read((state) => {
        const account = state.currentAccountKey ? state.accounts[state.currentAccountKey] : null;
        return {
          partition: account?.partition || '',
          messages: account ? Object.values(account.messages || {})
            .filter((message) => message.status === 'unfinished')
            .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
            .map((message) => ({ key: message.key })) : [],
        };
      });
      if (!snap.partition) return { sent: 0, remaining: 0 };
      const destination = destinationOf(binding);
      for (const item of snap.messages) {
        try {
          await ensureMessageSegments(snap.partition, item.key, { guard });
        } catch { /* surfaced in state */ }
      }
      const plans = store.read((state) => {
        const account = state.accounts[snap.partition];
        if (!account) return [];
        return snap.messages.map((item) => {
          const segments = messageSegments(account, item.key).filter((segment) => (
            segment.state !== 'superseded'
            && segment.target === destination.target
            && segment.bindingVersion === destination.version
            && segment.targetKind === 'c2c'
          ));
          return {
            key: item.key,
            blocked: segments.some((segment) => BLOCK_STATES.has(segment.state))
              || segments.some((segment) => segment.state === 'failed'
                && Number(segment.nextRetryAt) > now()),
            sendable: segments.filter((segment) => segment.state === 'planned'
              || (segment.state === 'failed' && Number(segment.nextRetryAt) <= now()))
              .map((segment) => ({
                segmentKey: segment.key,
                requestId: segment.requestId,
                target: segment.target,
                version: segment.bindingVersion,
              })),
          };
        });
      });
      const sendable = plans.reduce((sum, plan) => sum + (plan.blocked ? 0 : plan.sendable.length), 0);
      const blocked = plans.filter((plan) => plan.blocked).length;
      let slots = Math.max(0, Math.min(limit, sendable));
      let sent = 0;
      for (const plan of plans) {
        if (slots <= 0 || disposed) break;
        if (plan.blocked) continue;
        for (const item of plan.sendable) {
          if (slots <= 0) break;
          const state = await sendClaimSegment(snap.partition, item, msg, { guard });
          if (state === 'sent') {
            sent += 1;
            slots -= 1;
            continue;
          }
          if (['rate', 'stale', 'aborted', 'waiting_owner'].includes(state)) {
            return { sent, remaining: Math.max(0, sendable - sent), blocked };
          }
          break;
        }
      }
      return { sent, remaining: Math.max(0, sendable - sent), blocked };
    });
  }

  async function view(msg, { shortId, page = 1, guard } = {}) {
    return withLock(async () => {
      if (!msg || msg.kind !== 'c2c') {
        throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '请在主人 QQ 私聊中查看');
      }
      const target = String(msg.userId || '');
      if (msg.chatId && String(msg.chatId) !== target) {
        throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '当前会话不是标准 C2C 私聊');
      }
      if (!(await ownerOk(target))) {
        throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '当前用户不是机器人主人');
      }
      const binding = store.binding();
      if (!binding?.ownerTarget || binding.ownerTarget !== target) {
        throw new XhhDmStoreError('XHH_BINDING_REQUIRED', '当前私聊尚未绑定为接收目标');
      }
      if (!guardOk(guard)) throw new XhhDmStoreError('XHH_STALE', '私信任务已失效');
      const raw = String(shortId || '').trim().toUpperCase();
      const lookup = raw.startsWith('XHH-') ? raw.slice(4) : raw;
      if (!/^[0-9A-F]{12}$/.test(lookup)) {
        return { ok: false, reasonCode: 'XHH_NOT_FOUND', sent: 0, remaining: 0 };
      }
      const found = store.read((state) => {
        const account = state.currentAccountKey ? state.accounts[state.currentAccountKey] : null;
        if (!account) return { record: null, partition: '' };
        const matches = Object.values(account.messages || {})
          .filter((message) => shortXhhMessageId(message.key) === lookup);
        return {
          record: matches.length === 1 ? JSON.parse(JSON.stringify(matches[0])) : null,
          partition: account.partition,
        };
      });
      if (!found.record) {
        return { ok: false, reasonCode: 'XHH_NOT_FOUND', sent: 0, remaining: 0 };
      }
      const bodies = buildXhhSegmentBodies(found.record, { label: '【小黑盒私信·重复查看】' });
      const totalPages = Math.max(1, Math.ceil(bodies.length / XHH_VIEW_PAGE_SIZE));
      const pageNumber = Math.max(1, Math.floor(Number(page) || 1));
      if (pageNumber > totalPages) {
        return { ok: false, reasonCode: 'XHH_PAGE_OUT_OF_RANGE', sent: 0, remaining: 0, totalPages };
      }
      const start = (pageNumber - 1) * XHH_VIEW_PAGE_SIZE;
      const selected = bodies.slice(start, start + XHH_VIEW_PAGE_SIZE);
      const destination = destinationOf(binding);
      const access = await reachReady(destination);
      if (!access.ok) {
        return { ok: false, reasonCode: access.reason, sent: 0, remaining: bodies.length - start };
      }
      let sent = 0;
      for (let index = 0; index < selected.length; index += 1) {
        if (disposed || !guardOk(guard)) break;
        if (!(await fenceReady({ guard, partition: found.partition, destination }))) break;
        const requestId = makeXhhRequestId({
          robotKey: store.read((state) => state.robotKey),
          accountScope: found.partition,
          target: destination.target,
          bindingVersion: destination.version,
          messageKey: `view:${found.record.key}:${pageNumber}:${String(msg.id || msg.receivedAt || '')}`,
          index: start + index,
          purpose: 'dm-view',
        });
        if (ledgerState(await readLedger(ctx, requestId)) === 'sent') {
          sent += 1;
          continue;
        }
        try {
          await reserveBudget({ guard, at: now() });
        } catch {
          break;
        }
        let returned;
        let error = null;
        try {
          returned = await msg.replyNow(selected[index], {
            requestId, onError: (value) => { error = value; },
          });
        } catch (value) {
          error = value;
        }
        if ((await classify(ctx, requestId, returned, error)) === 'sent') sent += 1;
        else break;
      }
      const shown = start + sent;
      const remaining = Math.max(0, bodies.length - shown);
      return {
        ok: true,
        sent,
        remaining,
        page: pageNumber,
        totalPages,
        nextPage: remaining > 0 ? Math.floor(shown / XHH_VIEW_PAGE_SIZE) + 1 : null,
        shortId: lookup,
      };
    });
  }

  async function sendTest(msg, { guard } = {}) {
    return withLock(async () => {
      if (disposed) throw new XhhDmStoreError('XHH_STALE', '私信服务已停用');
      const binding = store.binding();
      const destination = destinationOf(binding);
      if (!destination.ownerTarget) throw new XhhDmStoreError('XHH_BINDING_REQUIRED', '尚未绑定主人私聊');
      if (!destination.target) throw new XhhDmStoreError('XHH_BINDING_REQUIRED', '尚未配置通知目标');
      if (msg !== undefined && msg !== null) {
        if (msg.kind !== 'c2c') throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '请在主人 QQ 私聊中发送测试');
        const target = String(msg.userId || '');
        if (!target || (msg.chatId && String(msg.chatId) !== target)
          || target !== destination.ownerTarget) {
          throw new XhhDmStoreError('XHH_BINDING_REQUIRED', '当前私聊尚未绑定为接收目标');
        }
      }
      if (!(await ownerOk(destination.ownerTarget))) {
        throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '当前用户不是机器人主人');
      }
      if (destination.kind === 'group' && !(await groupReady(destination.target))) {
        throw new XhhDmStoreError('XHH_GROUP_INVALID', '所选群当前不可用');
      }
      const access = await reachReady(destination);
      if (!access.ok) {
        return { ok: false, sent: 0, state: access.reason, dm: status() };
      }
      const snap = snapshot();
      if (!snap.account) throw new XhhDmStoreError('XHH_ACCOUNT_INVALID', '账号状态尚未建立');
      if (!(await fenceReady({ guard, partition: snap.account.partition, destination }))) {
        throw new XhhDmStoreError(disposed ? 'XHH_STALE' : 'XHH_OWNER_REQUIRED', '主人校验已失效');
      }
      const trigger = msg?.id || msg?.receivedAt ? `msg:${String(msg.id || msg.receivedAt)}` : 'panel';
      const requestId = makeXhhRequestId({
        robotKey: snap.robotKey,
        accountScope: snap.account.partition,
        target: destination.target,
        bindingVersion: destination.version,
        messageKey: `test|${destination.kind}|${destination.version}|${destination.target}|${trigger}`,
        index: 0,
        purpose: 'dm-test',
        targetKind: destination.kind,
      });
      const prior = ledgerState(await readLedger(ctx, requestId));
      if (prior) return { ok: prior === 'sent', sent: prior === 'sent' ? 1 : 0, state: prior, dm: status() };
      try {
        await reserveBudget({ guard, at: now() });
      } catch (error) {
        throw new XhhDmStoreError('XHH_RATE_LIMIT', '发送频率已达上限', {
          retryAfterMs: error?.retryAfterMs,
        });
      }
      const body = '【小黑盒私信·测试】\n主人通知通道测试成功。\n'
        + `编号：XHH-TEST-${shortXhhMessageId(requestId)}\n这条测试不会读取或转发任何真实私信内容。`;
      let returned;
      let thrown = null;
      try {
        returned = await ctx.push(destination.target, body, {
          kind: destination.kind, requestId,
        });
      } catch (error) {
        thrown = error;
      }
      const state = await classify(ctx, requestId, returned, thrown);
      return { ok: state === 'sent', sent: state === 'sent' ? 1 : 0, state, dm: status() };
    });
  }

  async function cancel(msg, { shortId, guard } = {}) {
    return withLock(async () => {
      if (!msg || msg.kind !== 'c2c') {
        throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '请在主人 QQ 私聊中取消');
      }
      const target = String(msg.userId || '');
      if (!(await ownerOk(target))) {
        throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '当前用户不是机器人主人');
      }
      const lookup = String(shortId || '').trim().toUpperCase().replace(/^XHH-/, '');
      if (!/^[0-9A-F]{12}$/.test(lookup)) {
        return { ok: false, reasonCode: 'XHH_NOT_FOUND', cancelled: false };
      }
      const key = store.read((state) => {
        const account = state.currentAccountKey ? state.accounts[state.currentAccountKey] : null;
        const match = Object.keys(account?.messages || {})
          .find((value) => shortXhhMessageId(value) === lookup);
        return match || '';
      });
      if (!key) return { ok: false, reasonCode: 'XHH_NOT_FOUND', cancelled: false };
      const result = await store.cancelMessage(key, { guard });
      return { ok: result.cancelled, ...result, shortId: lookup };
    });
  }

  function pendingSummary({ limit = 20 } = {}) {
    try {
      const data = store.read((state) => {
        const account = state.currentAccountKey ? state.accounts[state.currentAccountKey] : null;
        const max = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
        const messages = account ? Object.values(account.messages || {})
          .filter((message) => message.status === 'unfinished')
          .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
          .slice(0, max)
          .map((message) => {
            const segments = messageSegments(account, message.key)
              .filter((segment) => segment.state !== 'superseded');
            const states = segments.map((segment) => segment.state);
            return {
              shortId: shortXhhMessageId(message.key),
              at: message.createdAt,
              segments: segments.length,
              state: states.includes('unknown') ? 'unknown'
                : states.includes('pending') ? 'pending'
                  : states.includes('sending') ? 'sending'
                    : states.includes('failed') ? 'failed'
                      : states.includes('sent') ? 'sent' : 'planned',
            };
          }) : [];
        return {
          count: account ? Object.values(account.messages || {})
            .filter((message) => message.status === 'unfinished').length : 0,
          messages,
          binding: destinationOf(state.binding),
        };
      });
      return {
        ok: true,
        count: data.count,
        messages: data.messages,
        targetKind: data.binding.kind,
        mask: maskTarget(data.binding.target),
      };
    } catch (error) {
      return { ok: false, reasonCode: safeCode(error?.code), count: 0, messages: [] };
    }
  }

  function status() {
    if (disposed) return { state: 'disabled', binding: { bound: false, mask: '' }, queue: {} };
    try {
      const state = store.read((value) => value);
      const binding = state.binding || {};
      const counters = store.statusCounters();
      let rate = null;
      if (typeof rateInfo === 'function') {
        try { rate = rateInfo(); } catch { rate = null; }
      }
      return {
        state: binding.target ? 'bound' : 'unbound',
        binding: {
          bound: !!(binding.target),
          mask: maskTarget(binding.target),
          version: Number(binding.version) || 0,
        },
        destination: {
          kind: binding.targetKind === 'group' ? 'group' : 'c2c',
          label: binding.targetKind === 'group' ? (binding.groupName || '群聊') : '主人私聊',
        },
        queue: {
          messages: counters.messages,
          unfinished: counters.unfinished,
          planned: counters.planned,
          sending: counters.sending,
          pending: counters.pending,
          unknown: counters.unknown,
          failed: counters.failed,
          sent: counters.sent,
          suppressed: counters.suppressed,
          cancelled: counters.cancelled,
        },
        rate: rate ? {
          used: Number(rate.used) || 0,
          remaining: Number(rate.remaining) || 0,
          nextAt: rate.nextAt ?? null,
        } : null,
      };
    } catch (error) {
      return {
        state: 'error',
        reasonCode: safeCode(error?.code),
        binding: { bound: false, mask: '' },
        queue: {},
      };
    }
  }

  function deactivate() {
    disposed = true;
    return status();
  }

  return {
    pump,
    reconcile,
    sendTest,
    claim,
    view,
    cancel,
    materializeBacklog,
    pendingSummary,
    status,
    deactivate,
    flush: () => Promise.all([store.flush(), tail]),
  };
}

export { classifyError, classifyReturned, maskTarget, normalizeQuota, normalizeReach };
