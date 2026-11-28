import fsDefault from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { XHH_DIAGNOSTIC_VALUES } from './xiaoheihe-transport.js';

export const ACCEPTANCE_FILE = 'dm-acceptance.json';
export const ACCEPTANCE_MAX_EVENTS = 500;
export const ACCEPTANCE_MAX_BYTES = 1024 * 1024;
export const ACCEPTANCE_SCHEMA_VERSION = 1;

export const ACCEPTANCE_EVENTS = Object.freeze([
  'request', 'response', 'auth', 'config', 'baseline', 'sync', 'conversation',
  'message', 'dedupe', 'enqueue', 'delivery', 'claim', 'view', 'recovery',
  'reload', 'error', 'diagnostic',
]);

export const ACCEPTANCE_PHASES = Object.freeze([
  'start', 'check', 'list', 'history', 'baseline', 'watching', 'limited',
  'recover', 'restart', 'login', 'manual', 'target', 'send', 'result', 'stop',
]);

export const ACCEPTANCE_ACTIONS = Object.freeze([
  'requested', 'completed', 'failed', 'skipped', 'accepted', 'saved', 'deduped',
  'enqueued', 'sent', 'pending', 'unknown', 'confirmed', 'cooling', 'drained',
  'unavailable',
]);

const EVENT_SET = new Set(ACCEPTANCE_EVENTS);
const PHASE_SET = new Set(ACCEPTANCE_PHASES);
const ACTION_SET = new Set(ACCEPTANCE_ACTIONS);
const DIAGNOSTIC_OPERATION_SET = new Set(XHH_DIAGNOSTIC_VALUES.operations);
const DIAGNOSTIC_TRANSPORT_SET = new Set(XHH_DIAGNOSTIC_VALUES.transports);
const DIAGNOSTIC_STAGE_SET = new Set(XHH_DIAGNOSTIC_VALUES.networkStages);
const MAX_DIAGNOSTIC_ELAPSED_MS = 24 * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024 * 1024;
const COUNT_KEYS = new Set([
  'messages', 'conversations', 'pages', 'newMessages', 'duplicates', 'enqueued',
  'sent', 'pending', 'unknown', 'failed', 'segments', 'events', 'bytes',
]);
const BOOL_KEYS = new Set([
  'ok', 'limited', 'baselineComplete', 'recorded', 'fromLedger', 'hostSent',
  'userConfirmed', 'deduped', 'recovered',
]);
const BUSINESS_STATUSES = new Set([
  'ok', 'auth', 'challenge', 'rate_limit', 'limited', 'gap', 'unknown',
  'not_found', 'timeout', 'network', 'response', 'api', 'rejected', 'cancelled',
]);
const FORBIDDEN_KEYS = new Set([
  'cookie', 'cookies', 'url', 'urls', 'uid', 'accountuid', 'messageid', 'msgid',
  'seq', 'seqno', 'text', 'content', 'body', 'qr', 'qrcode', 'qrkey',
  'raw', 'error', 'response', 'payload', 'token', 'credential', 'secret',
]);
const FIELDS = new Set([
  'providerId', 'phase', 'action', 'errorCode', 'httpStatus', 'apiCode',
  'knownBusinessStatus', 'counts', 'bools', 'at', 'serverTime', 'messageHash',
  'conversationHash', 'targetKind', 'maskedTarget', 'attempts', 'sessionVersion',
  'operation', 'transport', 'networkStage', 'elapsedMs', 'bytes', 'status',
]);
const HASH_RE = /^[a-f0-9]{16,64}$/;
const KNOWN_ERROR_CODES = new Set([
  'XHH_CANCELLED', 'XHH_NETWORK', 'XHH_TIMEOUT', 'XHH_HTTP', 'XHH_RATE_LIMIT',
  'XHH_BUDGET', 'XHH_COOLDOWN', 'XHH_AUTH', 'XHH_CHALLENGE', 'XHH_API',
  'XHH_RESPONSE', 'XHH_PRECISION', 'XHH_QR', 'XHH_QR_CREDENTIAL', 'XHH_STORAGE',
  'XHH_NO_COOKIE', 'XHH_NO_OWNER', 'XHH_OWNER_REQUIRED', 'XHH_BINDING_REQUIRED',
  'XHH_CREDENTIAL_CHANGED', 'XHH_GAP', 'XHH_WATCHING_LIMITED', 'XHH_NO_SERVER_TIME',
  'XHH_MESSAGE_INVALID', 'XHH_MESSAGE_ID_INVALID', 'XHH_STATE_CORRUPT',
  'XHH_STATE_UNSUPPORTED', 'XHH_STATE_READ_FAILED', 'XHH_STATE_NOT_READY',
  'XHH_WRITE_FAILED', 'XHH_CAPACITY', 'XHH_DISABLED', 'XHH_MODULE_UNAVAILABLE',
  'XHH_POLICY_UNAVAILABLE', 'XHH_CATCHUP', 'XHH_BASELINE', 'XHH_PAUSED',
  'XHH_LOGOUT', 'XHH_RECOVERED', 'XHH_CONFIG', 'XHH_STALE', 'XHH_ACCOUNT_INVALID',
  'XHH_CONTENT_INVALID', 'XHH_GROUP_INVALID', 'XHH_GROUP_UNAVAILABLE',
  'XHH_BINDING_INVALID', 'XHH_NOT_FOUND', 'XHH_PAGE_OUT_OF_RANGE', 'XHH_ERROR',
  'DM_RATE_LIMIT', 'DM_STALE',
]);
const MASK_RE = /^(?:\*{3,}|\*{3}[A-Za-z0-9_-]{1,8})$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeCounts(value) {
  if (!isObject(value)) return null;
  const out = {};
  for (const [key, count] of Object.entries(value)) {
    if (!COUNT_KEYS.has(key)) continue;
    if (count === undefined || count === null) continue;
    if (!nonNegativeInt(count)) return null;
    out[key] = count;
  }
  return out;
}

function safeBools(value) {
  if (!isObject(value)) return null;
  const out = {};
  for (const [key, flag] of Object.entries(value)) {
    if (!BOOL_KEYS.has(key)) continue;
    if (flag === undefined || flag === null) continue;
    if (typeof flag !== 'boolean') return null;
    out[key] = flag;
  }
  return out;
}

function sanitize(event, fields) {
  if (!EVENT_SET.has(event)) return null;
  if (!isObject(fields)) return null;
  for (const key of Object.keys(fields)) {
    if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) return null;
  }
  const out = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELDS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (key === 'providerId') {
      if (value !== 'xiaoheihe') return null;
      out.providerId = 'xiaoheihe';
    } else if (key === 'phase') {
      if (!PHASE_SET.has(value)) return null;
      out.phase = value;
    } else if (key === 'action') {
      if (!ACTION_SET.has(value)) return null;
      out.action = value;
    } else if (key === 'errorCode') {
      if (typeof value !== 'string' || !KNOWN_ERROR_CODES.has(value)) return null;
      out.errorCode = value;
    } else if (key === 'httpStatus') {
      if (!nonNegativeInt(value) || value > 599) return null;
      out.httpStatus = value;
    } else if (key === 'apiCode') {
      if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000) return null;
      out.apiCode = value;
    } else if (key === 'knownBusinessStatus') {
      if (!BUSINESS_STATUSES.has(value)) return null;
      out.knownBusinessStatus = value;
    } else if (key === 'counts') {
      const counts = safeCounts(value);
      if (!counts) return null;
      out.counts = counts;
    } else if (key === 'bools') {
      const bools = safeBools(value);
      if (!bools) return null;
      out.bools = bools;
    } else if (key === 'at' || key === 'serverTime') {
      if (!finite(value)) return null;
      out[key] = Math.floor(value);
    } else if (key === 'messageHash' || key === 'conversationHash') {
      if (typeof value !== 'string' || !HASH_RE.test(value)) return null;
      out[key] = value;
    } else if (key === 'targetKind') {
      if (value !== 'c2c' && value !== 'group') return null;
      out.targetKind = value;
    } else if (key === 'maskedTarget') {
      if (typeof value !== 'string' || !MASK_RE.test(value)) return null;
      out.maskedTarget = value;
    } else if (key === 'attempts') {
      if (!nonNegativeInt(value)) return null;
      out.attempts = value;
    } else if (key === 'sessionVersion') {
      if (!nonNegativeInt(value)) return null;
      out.sessionVersion = value;
    } else if (key === 'operation') {
      if (!DIAGNOSTIC_OPERATION_SET.has(value)) return null;
      out.operation = value;
    } else if (key === 'transport') {
      if (!DIAGNOSTIC_TRANSPORT_SET.has(value)) return null;
      out.transport = value;
    } else if (key === 'networkStage') {
      if (!DIAGNOSTIC_STAGE_SET.has(value)) return null;
      out.networkStage = value;
    } else if (key === 'elapsedMs') {
      if (!nonNegativeInt(value) || value > MAX_DIAGNOSTIC_ELAPSED_MS) return null;
      out.elapsedMs = value;
    } else if (key === 'bytes') {
      if (!nonNegativeInt(value) || value > MAX_DIAGNOSTIC_BYTES) return null;
      out.bytes = value;
    } else if (key === 'status') {
      if (!nonNegativeInt(value) || value > 599) return null;
      out.status = value;
    }
  }
  return out;
}

function emptyState() {
  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    events: [],
    updatedAt: null,
    dropped: 0,
  };
}

function validateState(value) {
  if (!isObject(value) || value.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION
    || !Array.isArray(value.events)) {
    throw new Error('invalid acceptance state');
  }
  if (value.events.length > ACCEPTANCE_MAX_EVENTS) throw new Error('too many acceptance events');
  const events = [];
  for (const row of value.events) {
    if (!isObject(row) || typeof row.event !== 'string') throw new Error('invalid acceptance event');
    const fields = {};
    for (const [key, field] of Object.entries(row)) {
      if (key !== 'event') fields[key] = field;
    }
    const safe = sanitize(row.event, fields);
    if (!safe || !finite(safe.at || 0)) throw new Error('invalid acceptance event fields');
    events.push(safe);
  }
  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    events,
    updatedAt: value.updatedAt === null ? null : Math.floor(Number(value.updatedAt) || 0),
    dropped: nonNegativeInt(value.dropped) ? value.dropped : 0,
  };
}

function defaultIo(io) {
  const custom = isObject(io) && Object.keys(io).length > 0;
  return {
    readFile: io?.readFile?.bind(io) || fsDefault.readFile,
    writeFile: io?.writeFile?.bind(io) || fsDefault.writeFile,
    rename: io?.rename?.bind(io) || fsDefault.rename,
    unlink: io?.unlink?.bind(io) || fsDefault.unlink,
    mkdir: io?.mkdir?.bind(io) || fsDefault.mkdir,
    stat: io?.stat?.bind(io) || (custom ? null : fsDefault.stat),
  };
}

export function createDmAcceptanceLog({
  dataDir, isActive = () => true, initialBarrier, now = () => Date.now(),
  fs = {}, file = ACCEPTANCE_FILE,
  maxEvents = ACCEPTANCE_MAX_EVENTS, maxBytes = ACCEPTANCE_MAX_BYTES,
} = {}) {
  if (!dataDir) throw new TypeError('createDmAcceptanceLog requires dataDir');
  const filePath = path.join(dataDir, file);
  const io = defaultIo(fs);
  const limitEvents = Math.max(1, Math.min(ACCEPTANCE_MAX_EVENTS, Number(maxEvents) || ACCEPTANCE_MAX_EVENTS));
  const limitBytes = Math.max(1024, Math.min(ACCEPTANCE_MAX_BYTES, Number(maxBytes) || ACCEPTANCE_MAX_BYTES));

  let state = emptyState();
  let diagnostic = 'ok';
  let tail = Promise.resolve();
  let tempSeq = 0;
  let disposed = false;

  const active = () => {
    if (disposed || !isActive()) return false;
    return true;
  };

  function enqueue(fn) {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  }

  function textOf(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  async function persist(draft) {
    let text = textOf(draft);
    if (Buffer.byteLength(text) > limitBytes) {
      while (draft.events.length > 0 && Buffer.byteLength(text) > limitBytes) {
        draft.events.shift();
        draft.dropped = Math.min(1_000_000, Number(draft.dropped || 0) + 1);
        text = textOf(draft);
      }
    }
    if (Buffer.byteLength(text) > limitBytes) throw new Error('acceptance file limit');
    let temp = '';
    try {
      await io.mkdir(path.dirname(filePath), { recursive: true });
      temp = `${filePath}.${process.pid}.${now()}.${tempSeq += 1}.${randomUUID()}.tmp`;
      await io.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
      await io.rename(temp, filePath);
      temp = '';
    } finally {
      if (temp) {
        try { await io.unlink(temp); } catch { /* best effort */ }
      }
    }
  }

  const ready = (async () => {
    if (initialBarrier) await initialBarrier;
    if (disposed || !isActive()) return api;
    let text;
    try {
      if (io.stat) {
        let info = null;
        try {
          info = await io.stat(filePath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (info && Number.isFinite(info.size) && info.size > limitBytes) {
          diagnostic = 'file_too_large';
          return api;
        }
      }
      const raw = await io.readFile(filePath, 'utf8');
      text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') return api;
      diagnostic = error?.code === 'EACCES' ? 'read_unavailable' : 'read_failed';
      return api;
    }
    try {
      if (Buffer.byteLength(text, 'utf8') > limitBytes) throw new Error('too large');
      state = validateState(JSON.parse(text));
      diagnostic = 'ok';
    } catch {
      diagnostic = 'corrupt';
      state = emptyState();
    }
    return api;
  })().catch(() => {
    diagnostic = 'read_failed';
    state = emptyState();
    return api;
  });

  function record(event, fields = {}) {
    if (disposed || !active()) return { ok: false, accepted: false, diagnostic: 'inactive' };
    const safe = sanitize(event, fields);
    if (!safe) return { ok: false, accepted: false, diagnostic: 'rejected' };
    if (!Object.prototype.hasOwnProperty.call(safe, 'at')) safe.at = Math.floor(now());
    return enqueue(async () => {
      await ready;
      if (disposed || !active()) return { ok: false, accepted: false, diagnostic: 'inactive' };
      if (diagnostic === 'corrupt' || diagnostic === 'file_too_large') {
        return { ok: false, accepted: false, diagnostic: 'unavailable' };
      }
      const draft = clone(state);
      draft.events.push(safe);
      while (draft.events.length > limitEvents) {
        draft.events.shift();
        draft.dropped = Math.min(1_000_000, Number(draft.dropped || 0) + 1);
      }
      draft.updatedAt = Math.floor(now());
      try {
        await persist(draft);
        state = draft;
        diagnostic = 'ok';
        return { ok: true, accepted: true, diagnostic: 'ok' };
      } catch (error) {
        diagnostic = error?.code === 'ENOSPC' ? 'write_full' : 'write_failed';
        state = draft;
        return { ok: false, accepted: false, diagnostic: 'unavailable' };
      }
    });
  }

  function snapshot({ limit = 200 } = {}) {
    const max = Math.max(1, Math.min(limitEvents, Math.floor(Number(limit) || 200)));
    if (diagnostic !== 'ok') {
      return {
        available: false,
        diagnostic: diagnostic === 'corrupt' ? 'diagnostic_unavailable' : diagnostic,
        events: [],
        count: 0,
        dropped: 0,
        maxEvents: limitEvents,
        maxBytes: limitBytes,
      };
    }
    const events = state.events.slice(-max).map((row) => clone(row));
    return {
      available: true,
      diagnostic: 'ok',
      events,
      count: state.events.length,
      dropped: state.dropped,
      maxEvents: limitEvents,
      maxBytes: limitBytes,
      updatedAt: state.updatedAt,
    };
  }

  function deactivate() {
    disposed = true;
    return { ok: true, diagnostic };
  }

  const api = {
    ready,
    filePath,
    record,
    snapshot,
    flush: () => tail,
    deactivate,
    diagnostic: () => diagnostic,
    limits: { maxEvents: limitEvents, maxBytes: limitBytes },
  };
  return api;
}
