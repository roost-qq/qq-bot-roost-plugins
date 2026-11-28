import { createHash, randomUUID } from 'node:crypto';
import {
  XhhDmStoreError, accountScopeKey, createXhhDmStore, ensureXhhConversation,
  makeXhhConversationKey, makeXhhMessageKey,
} from './xiaoheihe-dm-store.js';
import { createXiaoheiheDmDelivery } from './xiaoheihe-dm-delivery.js';
import { createDmAcceptanceLog } from './dm-acceptance.js';
import { createBiliDmGroupCatalog } from './bili-dm-groups.js';

export const XHH_REQUEST_BUDGET = 6;
export const XHH_DEFAULT_POLL_SECONDS = 300;
export const XHH_MIN_POLL_SECONDS = 180;
export const XHH_MAX_POLL_SECONDS = 3600;
export const XHH_CATCHUP_MIN_MS = 60_000;
export const XHH_CATCHUP_JITTER_MS = 12_000;
export const XHH_ROUND_DEADLINE_MS = 120_000;

const PROVIDER_ID = 'xiaoheihe';
const MIN_SERVER_MS = Date.UTC(2000, 0, 1);
const MAX_SERVER_MS = Date.UTC(2101, 0, 1);
const REASON_TEXT = Object.freeze({
  XHH_NO_COOKIE: '尚未配置小黑盒登录信息。',
  XHH_NO_OWNER: '尚未绑定接收通知的主人。',
  XHH_OWNER_REQUIRED: '当前用户不是机器人主人，已暂停通知。',
  XHH_BINDING_REQUIRED: '尚未配置接收通知的目标。',
  XHH_AUTH: '小黑盒登录状态已失效，请重新登录。',
  XHH_CREDENTIAL_CHANGED: '小黑盒账号已变化，等待重新检查。',
  XHH_NETWORK: '暂时无法连接小黑盒，稍后会自动重试。',
  XHH_RATE_LIMIT: '请求频率已达上限，稍后会自动重试。',
  XHH_GAP: '历史边界不完整，仅处理可确认窗口内的新消息。',
  XHH_WATCHING_LIMITED: '历史窗口有限，已保留缺口，不声称完整同步。',
  XHH_NO_SERVER_TIME: '缺少可信服务器时间，未建立完整基线。',
  XHH_MESSAGE_INVALID: '存在无法可靠识别的消息，已保留缺口。',
  XHH_STATE_CORRUPT: '本地私信状态异常，需要检查状态文件。',
  XHH_STATE_UNSUPPORTED: '本地私信状态版本过高，需要更新插件。',
  XHH_STATE_READ_FAILED: '本地私信状态读取失败，需要检查文件权限。',
  XHH_WRITE_FAILED: '本地私信状态写入失败，需要检查磁盘空间。',
  XHH_PRECISION: '小黑盒返回的标识精度不安全，已暂停同步。',
  XHH_RESPONSE: '小黑盒返回了无法识别的数据，已暂停同步。',
  XHH_CAPACITY: '待处理私信数量已达上限，已暂停继续拉取。',
  XHH_BUDGET: '本轮请求预算已用完，稍后继续。',
  XHH_DISABLED: '小黑盒私信提醒未开启。',
  XHH_MODULE_UNAVAILABLE: '小黑盒客户端或登录模块不可用。',
  XHH_POLICY_UNAVAILABLE: '请求调度状态不可用，已安全暂停。',
  XHH_CATCHUP: '正在继续读取未完成的历史窗口。',
  XHH_BASELINE: '正在建立首次历史基线。',
  XHH_ERROR: '小黑盒私信处理发生错误。',
  XHH_RECOVERED: '小黑盒私信读取已恢复。',
});
const LOGIN_STATES = new Set([
  'idle', 'starting', 'waiting', 'scanned', 'success', 'valid', 'invalid',
  'missing', 'expired', 'error', 'cancelled', 'unavailable',
]);
const LOGIN_FIELDS = new Set([
  'state', 'expiresAt', 'pngDataUrl', 'errorCode', 'errorSummary', 'retryAfterMs',
  'sessionVersion', 'accountEpoch', 'accountLabel',
]);
const SAFE_CODES = new Set([
  ...Object.keys(REASON_TEXT),
  'XHH_GROUP_INVALID', 'XHH_GROUP_UNAVAILABLE', 'XHH_BINDING_INVALID',
  'XHH_CONFIG', 'XHH_STALE', 'XHH_ACCOUNT_INVALID', 'XHH_MESSAGE_ID_INVALID',
  'XHH_STATE_NOT_READY', 'XHH_CONTENT_INVALID', 'XHH_RESPONSE', 'XHH_TIMEOUT',
  'XHH_HTTP', 'XHH_API', 'XHH_CANCELLED', 'XHH_LOGOUT', 'XHH_PAUSED',
  'XHH_NOT_FOUND', 'XHH_PAGE_OUT_OF_RANGE', 'XHH_CHALLENGE', 'XHH_QR',
  'XHH_QR_CREDENTIAL', 'XHH_STORAGE', 'XHH_COOLDOWN', 'XHH_ERROR',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeCode(value) {
  const code = String(value ?? '');
  return SAFE_CODES.has(code) ? code : 'XHH_ERROR';
}

function numericSessionVersion(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : null;
}

function reasonText(code) {
  return REASON_TEXT[code] || '小黑盒私信状态已更新，请稍后在插件面板查看。';
}

function maskTarget(target) {
  const value = String(target || '');
  if (!value) return '';
  return value.length <= 4 ? '***' : `***${value.slice(-4)}`;
}

function hash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function opaqueHash(value, length = 32) {
  return hash(value).slice(0, length);
}

function clampPoll(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return XHH_DEFAULT_POLL_SECONDS;
  return Math.min(XHH_MAX_POLL_SECONDS, Math.max(XHH_MIN_POLL_SECONDS, number));
}

function toServerMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const ms = number >= 1e12 ? number : number * 1000;
  if (ms < MIN_SERVER_MS || ms > MAX_SERVER_MS) return null;
  return Math.floor(ms);
}

function toMessageMs(value) {
  const ms = toServerMs(value);
  return ms;
}

function createBudget(limit = XHH_REQUEST_BUDGET) {
  let used = 0;
  return {
    get used() { return used; },
    get remaining() { return Math.max(0, limit - used); },
    take() {
      if (used >= limit) throw new XhhDmStoreError('XHH_BUDGET', '本轮请求预算已用完');
      used += 1;
    },
  };
}

function normalizeEntry(value) {
  if (!isObject(value)) return null;
  const peerId = String(value.userId ?? value.peerId ?? '');
  if (!peerId || peerId.length > 512 || /[\u0000-\u001f]/.test(peerId)) return null;
  return {
    peerId,
    nickname: String(value.nickname ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 128),
  };
}

function normalizePage(page) {
  if (!isObject(page)) return { complete: false, hasMore: null, nextOffset: null, nextCursor: null };
  return {
    complete: page.complete === true,
    hasMore: typeof page.hasMore === 'boolean' ? page.hasMore : null,
    nextOffset: page.nextOffset === undefined ? null : page.nextOffset,
    nextCursor: page.nextCursor === undefined ? null : page.nextCursor,
  };
}

export function createXiaoheiheRuntime({
  ctx, settings, requestPolicy = null, isActive = () => true, ownerBinding = null,
  reserveSend = null, rateInfo = null, initialBarrier = null,
  clientFactory = null, loginFactory = null, now = () => Date.now(),
  autoSchedule = true, dataDir = '', robotKey = '', acceptanceLog = null,
  client = null, login = null, normalizeMessage = null, requestScope = null,
  setTimeout: setTimeoutImpl = globalThis.setTimeout,
  clearTimeout: clearTimeoutImpl = globalThis.clearTimeout,
  random = Math.random, createAcceptance = true,
} = {}) {
  if (!ctx || typeof ctx.push !== 'function' || typeof ctx.isOwner !== 'function') {
    throw new TypeError('createXiaoheiheRuntime requires the native host context');
  }
  if (!settings || typeof settings.current !== 'function') {
    throw new TypeError('createXiaoheiheRuntime requires the shared settings API');
  }
  const directory = String(dataDir || ctx.dataDir || ctx.dataDirPath || '');
  if (!directory) {
    throw new TypeError('createXiaoheiheRuntime requires dataDir');
  }
  const robot = String(robotKey || ctx.robotKey || ctx.botKey || 'local');
  const store = createXhhDmStore({
    dataDir: directory, robotKey: robot, now, isActive, initialBarrier,
  });
  const delivery = createXiaoheiheDmDelivery({
    store, ctx, reserveSend, rateInfo, now, isActive,
    onEvent: (event, fields) => log(event, fields),
  });
  const groupCatalog = createBiliDmGroupCatalog({ ctx, store: null, isActive });
  let acceptance = acceptanceLog;
  let acceptanceUnavailable = acceptanceLog === null && createAcceptance === false;
  if (!acceptance && createAcceptance !== false) {
    try {
      acceptance = createDmAcceptanceLog({
        dataDir: directory, isActive, initialBarrier, now,
      });
    } catch {
      acceptance = null;
      acceptanceUnavailable = true;
    }
  }

  let disposed = false;
  let running = false;
  let generation = 0;
  let timer = null;
  let roundPromise = null;
  let activeRound = null;
  let credentialRevision = 0;
  let clientInstance = client;
  let clientError = '';
  let requestScopeValue = requestScope;
  let normalizer = normalizeMessage;
  let loginInstance = login;
  let loginError = '';
  let loginPromise = null;
  let currentPartition = '';
  let verifiedPeer = '';
  let knownServerTime = null;
  let lastCredential = null;
  let verifiedCredential = null;
  let lastLoginStatus = null;
  let stateName = 'disabled';
  let reasonCode = '';
  let nextRetryAt = 0;
  let catchupAt = 0;
  let lastCheckAt = 0;
  let lastSuccessAt = null;
  let backoffLevel = 0;
  let faultCycle = '';
  let pollSeconds = XHH_DEFAULT_POLL_SECONDS;
  let policySnapshot = null;
  let roundDeadline = null;
  let roundWorkflowId = '';
  let lastDiscoveryGap = '';
  let lastLimited = false;
  let lastPruneAt = 0;

  const ready = (async () => {
    if (initialBarrier) await initialBarrier;
    if (settings.ready) await settings.ready;
    if (store.ready) await store.ready;
    if (acceptance?.ready) await acceptance.ready.catch(() => {});
    return api;
  })();
  ready.catch(() => {});

  function log(event, fields = {}) {
    if (!acceptance) return;
    try {
      const result = acceptance.record(event, { providerId: PROVIDER_ID, ...fields });
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch { /* diagnostics never break delivery */ }
  }

  function transportDiagnostic(event) {
    try {
      if (!isObject(event)) return;
      const action = event.operation === 'error' ? 'failed'
        : event.operation === 'complete' ? 'completed'
          : event.operation === 'headers' ? 'pending' : 'requested';
      log('diagnostic', {
        phase: 'check',
        action,
        errorCode: event.errorCode,
        operation: event.operation,
        transport: event.transport,
        networkStage: event.networkStage,
        elapsedMs: event.elapsedMs,
        bytes: event.bytes,
        status: event.status,
      });
    } catch { /* observer failures never affect the client */ }
  }

  function setState(name, code = '') {
    stateName = name;
    reasonCode = code ? safeCode(code) : '';
    if (name === 'watching') {
      lastSuccessAt = now();
      nextRetryAt = 0;
      backoffLevel = 0;
      if (faultCycle) {
        faultCycle = '';
        log('recovery', { phase: 'watching', action: 'accepted' });
      }
    }
    if (name !== 'catching_up') catchupAt = 0;
  }

  function isCurrent(run) {
    if (disposed || !running || !run) return false;
    if (generation !== run.generation) return false;
    if (isActive() === false) return false;
    if (run.credentialRevision !== credentialRevision) return false;
    if (run.partition && currentPartition && run.partition !== currentPartition) return false;
    return true;
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
    const adaptive = Number(policySnapshot?.effectiveIntervalSeconds);
    return Math.max(pollSeconds, Number.isFinite(adaptive) ? adaptive : 0);
  }

  function catchupDelay(at) {
    const jitter = Math.round(XHH_CATCHUP_JITTER_MS * Math.max(0, Math.min(1, Number(random()) || 0)));
    const earliest = at + XHH_CATCHUP_MIN_MS + jitter;
    const policyAt = Number.isFinite(policySnapshot?.nextAllowedAt) ? policySnapshot.nextAllowedAt : 0;
    const retryAt = nextRetryAt > at ? nextRetryAt : 0;
    catchupAt = Math.max(earliest, policyAt, retryAt);
    return Math.max(1, Math.round(catchupAt - at));
  }

  function scheduleNext() {
    if (!running || disposed) return;
    const at = now();
    if (stateName === 'catching_up' || stateName === 'watching_limited') {
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

  function readSettingsConfig() {
    try { return settings.current?.() || {}; } catch { return {}; }
  }

  function storedConfig() {
    try { return store.config(); } catch { return null; }
  }

  function readConfig() {
    const stored = storedConfig() || {
      enabled: false, pollSeconds: XHH_DEFAULT_POLL_SECONDS, targetKind: 'c2c', groupId: '',
    };
    const shared = readSettingsConfig();
    const explicitEnabled = typeof shared.xiaoheiheDmEnabled === 'boolean';
    return {
      enabled: explicitEnabled ? shared.xiaoheiheDmEnabled : stored.enabled === true,
      pollSeconds: clampPoll(
        typeof shared.xiaoheiheDmPollSeconds === 'number'
          ? shared.xiaoheiheDmPollSeconds : stored.pollSeconds,
      ),
      targetKind: shared.xiaoheiheDmTargetKind === 'group' || shared.xiaoheiheDmTargetKind === 'c2c'
        ? shared.xiaoheiheDmTargetKind : stored.targetKind,
      groupId: String(shared.xiaoheiheDmGroupId ?? stored.groupId ?? ''),
    };
  }

  async function ensureRequestScope() {
    if (requestScopeValue) return requestScopeValue;
    try {
      const module = await import('./xiaoheihe-client.js');
      if (typeof module.createXiaoheiheRequestScope === 'function') {
        requestScopeValue = await module.createXiaoheiheRequestScope(settings, robot);
      }
    } catch {
      requestScopeValue = null;
    }
    return requestScopeValue;
  }

  async function resolveRequestScope(context = {}) {
    const resolver = await ensureRequestScope();
    if (!resolver) return null;
    let scope = resolver;
    if (typeof resolver === 'function') {
      try { scope = await resolver(context); } catch { return null; }
    }
    if (!isObject(scope) || scope.providerId !== PROVIDER_ID
      || typeof scope.accountKey !== 'string' || !scope.accountKey) {
      return null;
    }
    return {
      providerId: PROVIDER_ID,
      accountKey: scope.accountKey,
      ...(scope.credentialVersion === undefined || scope.credentialVersion === null
        ? {} : { credentialVersion: scope.credentialVersion }),
    };
  }

  async function ensureClient() {
    if (clientInstance) return clientInstance;
    if (clientError) throw new XhhDmStoreError('XHH_MODULE_UNAVAILABLE', clientError);
    try {
      const scope = await ensureRequestScope();
      if (typeof clientFactory === 'function') {
        clientInstance = await clientFactory({
          settings, requestPolicy, requestScope: scope, robotKey: robot, now,
          onDiagnostic: transportDiagnostic,
        });
      } else {
        const module = await import('./xiaoheihe-client.js');
        if (typeof module.createXiaoheiheClient !== 'function') {
          throw new Error('createXiaoheiheClient missing');
        }
        clientInstance = await module.createXiaoheiheClient({
          settings, requestPolicy, requestScope: scope, robotKey: robot, now,
          onDiagnostic: transportDiagnostic,
        });
        if (!normalizer && typeof module.normalizeXiaoheiheMessage === 'function') {
          normalizer = module.normalizeXiaoheiheMessage;
        }
      }
      if (!clientInstance || typeof clientInstance.listConversations !== 'function'
        || typeof clientInstance.fetchDirectMessages !== 'function') {
        throw new Error('Xhh client interface missing');
      }
      return clientInstance;
    } catch (error) {
      clientError = String(error?.message || error || 'client unavailable');
      log('error', { phase: 'check', action: 'unavailable', errorCode: 'XHH_MODULE_UNAVAILABLE' });
      throw new XhhDmStoreError('XHH_MODULE_UNAVAILABLE', '小黑盒客户端不可用');
    }
  }

  async function ensureLogin() {
    if (loginInstance) return loginInstance;
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      if (loginError) throw new XhhDmStoreError('XHH_MODULE_UNAVAILABLE', loginError);
      const activeClient = await ensureClient();
      try {
        if (typeof loginFactory === 'function') {
          loginInstance = await loginFactory({
            settings, client: activeClient, isActive, now,
            onCredentialChange: handleCredentialChange,
          });
        } else {
          const module = await import('./xiaoheihe-login.js');
          if (typeof module.createXiaoheiheLogin !== 'function') {
            throw new Error('createXiaoheiheLogin missing');
          }
          loginInstance = await module.createXiaoheiheLogin({
            settings, client: activeClient, isActive, now,
            onCredentialChange: handleCredentialChange,
          });
        }
        if (!loginInstance || typeof loginInstance.credentialState !== 'function') {
          throw new Error('Xhh login interface missing');
        }
        return loginInstance;
      } catch (error) {
        loginError = String(error?.message || error || 'login unavailable');
        log('error', { phase: 'login', action: 'unavailable', errorCode: 'XHH_MODULE_UNAVAILABLE' });
        throw new XhhDmStoreError('XHH_MODULE_UNAVAILABLE', '小黑盒登录模块不可用');
      }
    })();
    loginPromise.catch(() => {});
    return loginPromise;
  }

  async function handleCredentialChange() {
    credentialRevision += 1;
    generation += 1;
    verifiedPeer = '';
    verifiedCredential = null;
    currentPartition = '';
    try { activeRound?.controller?.abort(); } catch { /* ignore */ }
    activeRound = null;
    log('auth', { phase: 'login', action: 'saved' });
    let credential = null;
    try { credential = await readCredential(); } catch { credential = null; }
    if (credential && requestPolicy && typeof requestPolicy.recordCredentialChange === 'function') {
      const scope = policyScope(credential);
      if (scope) {
        try { await requestPolicy.recordCredentialChange({ ...scope }); } catch { /* policy owns state */ }
      }
    }
    if (running && !disposed) schedule(1);
  }

  async function readCredential() {
    let raw = null;
    try {
      const instance = await ensureLogin();
      raw = await Promise.resolve(instance.credentialState());
    } catch {
      const shared = settings.getPrivateMessageProviderCredentials?.('xiaoheihe');
      raw = isObject(shared) && shared.cookie && shared.heyboxId ? shared : null;
    }
    if (!isObject(raw)) return null;
    const cookie = String(raw.cookie ?? '');
    const heyboxId = String(raw.heyboxId ?? '');
    if (!cookie || !heyboxId || heyboxId.length > 512 || /[\u0000-\u001f]/.test(heyboxId)) {
      return null;
    }
    const epoch = String(raw.accountEpoch ?? '0');
    const session = numericSessionVersion(raw.sessionVersion);
    const scope = await resolveRequestScope({ cookie, heyboxId });
    const accountKey = scope?.accountKey || `xhh:${opaqueHash(heyboxId, 24)}`;
    return {
      cookie,
      heyboxId,
      accountKey,
      accountEpoch: epoch,
      sessionVersion: session,
      scope,
    };
  }

  function policyScope(credential) {
    const scope = credential?.scope;
    if (!scope) return null;
    return {
      providerId: PROVIDER_ID,
      accountKey: scope.accountKey,
      ...(scope.credentialVersion === undefined || scope.credentialVersion === null
        ? {} : { credentialVersion: scope.credentialVersion }),
    };
  }

  async function refreshPolicy(credential) {
    if (!requestPolicy) {
      policySnapshot = null;
      return null;
    }
    try {
      const scope = policyScope(credential);
      if (!scope) {
        policySnapshot = null;
        return null;
      }
      policySnapshot = await requestPolicy.status({
        ...scope,
        pollSeconds: readConfig().pollSeconds,
      });
      return policySnapshot;
    } catch {
      policySnapshot = null;
      return null;
    }
  }

  async function ensureWorkflow(partition, credential, run) {
    const existing = store.read((state) => state.accounts[partition]?.syncWorkflowId || '');
    if (existing) return existing;
    const workflowId = `xhh-sync:${opaqueHash(`${robot}:${credential.accountKey}:${randomUUID()}`, 40)}`;
    await store.transaction((draft) => {
      const account = draft.accounts[partition];
      if (!account) return;
      if (!account.syncWorkflowId) account.syncWorkflowId = workflowId;
      account.updatedAt = now();
    }, { guard: () => isCurrent(run) });
    return store.read((state) => state.accounts[partition]?.syncWorkflowId || workflowId);
  }

  async function rotateWorkflow(partition, credential, run) {
    const workflowId = `xhh-sync:${opaqueHash(`${robot}:${credential.accountKey}:${randomUUID()}`, 40)}`;
    await store.transaction((draft) => {
      const account = draft.accounts[partition];
      if (!account) return;
      account.syncWorkflowId = workflowId;
      account.updatedAt = now();
    }, { guard: () => isCurrent(run) });
    return workflowId;
  }

  async function recordPolicySuccess(run, credential, workflowId) {
    if (!requestPolicy || !isCurrent(run)) return { recorded: false };
    const scope = policyScope(credential);
    if (!scope) return { recorded: false };
    try {
      return await requestPolicy.recordSyncSuccess({ ...scope, workflowId });
    } catch {
      return { recorded: false };
    } finally {
      await refreshPolicy(credential);
    }
  }

  const LOCAL_RECORD_SKIP = new Set([
    'XHH_BUDGET', 'XHH_COOLDOWN', 'XHH_PAUSED', 'XHH_STALE', 'XHH_CANCELLED',
    'XHH_CONFIG', 'XHH_STATE_NOT_READY', 'XHH_STATE_CORRUPT',
    'XHH_STATE_UNSUPPORTED', 'XHH_STATE_READ_FAILED', 'XHH_WRITE_FAILED',
    'XHH_BINDING_INVALID', 'XHH_BINDING_REQUIRED', 'XHH_GROUP_INVALID',
    'XHH_GROUP_UNAVAILABLE', 'XHH_MODULE_UNAVAILABLE', 'XHH_POLICY_UNAVAILABLE',
    'XHH_REFRESH', 'XHH_STORAGE',
  ]);

  async function recordPolicyFailure(credential, error) {
    if (!requestPolicy || !credential || !error) return;
    if (error.requestPolicyRecorded === true) return;
    const rawCode = String(error.code || '');
    if (rawCode.startsWith('REQUEST_') || LOCAL_RECORD_SKIP.has(rawCode)) return;
    const scope = policyScope(credential);
    if (!scope) return;
    try {
      await requestPolicy.recordFailure({
        ...scope,
        retryAfterMs: Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0,
        status: Number.isFinite(error.status) ? error.status : 0,
        apiCode: Number.isFinite(error.apiCode) ? error.apiCode : 0,
      });
    } catch { /* policy surfaces its own state */ }
  }

  function ownerTarget() {
    if (typeof ownerBinding !== 'function') return '';
    try {
      const value = ownerBinding();
      if (typeof value === 'string') return value;
      if (isObject(value)) return String(value.ownerTarget ?? value.target ?? '');
    } catch { /* no binding */ }
    return '';
  }

  async function ownerOk(target) {
    try { return await Promise.resolve(ctx.isOwner(target)) === true; } catch { return false; }
  }

  async function verifyGroup(groupId) {
    const id = String(groupId || '');
    if (!id || id.length > 512 || /[\u0000-\u001f]/.test(id)) {
      throw new XhhDmStoreError('XHH_GROUP_INVALID', '群目标格式不合法');
    }
    if (typeof ctx.getGroup !== 'function') {
      throw new XhhDmStoreError('XHH_GROUP_UNAVAILABLE', '宿主不支持群信息');
    }
    let profile;
    try { profile = await Promise.resolve(ctx.getGroup(id)); } catch {
      throw new XhhDmStoreError('XHH_GROUP_INVALID', '所选群不存在或已停用');
    }
    if (!profile || typeof profile !== 'object' || profile.enabled === false) {
      throw new XhhDmStoreError('XHH_GROUP_INVALID', '所选群不存在或已停用');
    }
    const owned = profile.groupOpenid ?? profile.groupId ?? profile.chatId;
    if (String(owned ?? '') !== id) {
      throw new XhhDmStoreError('XHH_GROUP_INVALID', '群目标校验失败');
    }
    if (typeof ctx.gate?.check === 'function') {
      let allowed;
      try {
        allowed = await Promise.resolve(ctx.gate.check(id, { kind: 'group', target: id }));
      } catch {
        throw new XhhDmStoreError('XHH_GROUP_INVALID', '群权限校验失败');
      }
      if (allowed === false || (isObject(allowed) && allowed.allowed === false)) {
        throw new XhhDmStoreError('XHH_GROUP_INVALID', '群权限不允许发送');
      }
    }
    return {
      id,
      name: String(profile.name ?? profile.note ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
        .slice(0, 128),
    };
  }

  async function ensureTarget(run, config, credential) {
    const owner = ownerTarget();
    if (!owner) {
      setState('waiting_owner', 'XHH_NO_OWNER');
      return false;
    }
    if (!(await ownerOk(owner))) {
      setState('waiting_owner', 'XHH_OWNER_REQUIRED');
      return false;
    }
    await store.bindOwner(owner, { guard: () => isCurrent(run) });
    if (!isCurrent(run)) return false;
    if (config.targetKind === 'group') {
      if (!config.groupId) {
        setState('waiting_owner', 'XHH_BINDING_REQUIRED');
        return false;
      }
      let group;
      try {
        group = await verifyGroup(config.groupId);
      } catch (error) {
        setState('error', error?.code || 'XHH_GROUP_INVALID');
        return false;
      }
      if (!isCurrent(run)) return false;
      await store.setTarget({
        targetKind: 'group', target: group.id, groupName: group.name,
      }, { guard: () => isCurrent(run) });
    } else {
      await store.setTarget({ targetKind: 'c2c', target: owner }, { guard: () => isCurrent(run) });
    }
    return true;
  }

  function normalizeRawMessage(raw, peerId, selfId, credential) {
    if (normalizer) {
      return Promise.resolve()
        .then(() => normalizer(raw, { peerId, selfId }))
        .catch(() => null);
    }
    if (isObject(raw) && typeof raw.valid === 'boolean') return Promise.resolve(raw);
    void credential;
    return null;
  }

  function safeMessage(record, peerId, selfId) {
    if (!isObject(record) || record.valid !== true) {
      return { ok: false, reasonCode: String(record?.reasonCode || 'XHH_CONTENT_INVALID') };
    }
    const senderId = String(record.senderId ?? '');
    if (!senderId || senderId !== peerId || (selfId && senderId === selfId)) {
      return { ok: false, reasonCode: 'XHH_MESSAGE_INVALID' };
    }
    const messageId = record.messageId === undefined || record.messageId === null
      ? '' : String(record.messageId);
    const seq = record.seq === undefined || record.seq === null ? '' : String(record.seq);
    if ((!messageId && !seq)
      || (messageId && /[\u0000-\u001f]/.test(messageId))
      || (seq && /[\u0000-\u001f]/.test(seq))) {
      return { ok: false, reasonCode: 'XHH_MESSAGE_INVALID' };
    }
    const sentAtMs = toMessageMs(record.sentAt);
    if (!sentAtMs) return { ok: false, reasonCode: 'XHH_MESSAGE_INVALID' };
    const text = typeof record.text === 'string' ? record.text : '';
    const imageUrls = Array.isArray(record.imageUrls)
      ? record.imageUrls.filter((value) => typeof value === 'string').slice(0, 20) : [];
    const shareUrls = Array.isArray(record.shareUrls)
      ? record.shareUrls.filter((value) => typeof value === 'string').slice(0, 20) : [];
    return {
      ok: true,
      messageId,
      seq,
      senderId,
      senderName: String(record.senderName ?? '').slice(0, 128),
      sentAtMs,
      text,
      imageUrls,
      shareUrls,
      type: text ? 'text' : (imageUrls.length ? 'image' : 'state'),
    };
  }

  function addSeen(conversation, identity) {
    if (!identity || conversation.seenIds.includes(identity)) return;
    conversation.seenIds.push(identity);
    while (conversation.seenIds.length > 2000) conversation.seenIds.shift();
  }

  function identityOf(record) {
    return record.messageId || `seq:${record.seq}`;
  }

  function storeIncomingMessage(account, conversation, partition, record, at) {
    const key = makeXhhMessageKey({
      robotKey: account.robotKey || robot,
      accountScope: partition,
      peerId: conversation.peerId,
      messageId: record.messageId,
      seq: record.seq,
    });
    if (account.messages[key]) return false;
    account.messages[key] = {
      key,
      accountScope: partition,
      peerId: conversation.peerId,
      conversationKey: conversation.key,
      messageId: record.messageId,
      seq: record.seq,
      senderId: record.senderId,
      senderName: record.senderName,
      text: record.text,
      imageUrls: record.imageUrls,
      shareUrls: record.shareUrls,
      sentAtMs: record.sentAtMs,
      type: record.type,
      status: 'unfinished',
      deliveryState: 'queued',
      createdAt: at,
      completedAt: null,
    };
    if (!conversation.lastMessageAt || record.sentAtMs > conversation.lastMessageAt) {
      conversation.lastMessageAt = record.sentAtMs;
    }
    return true;
  }

  function conversationPending(page, offset, cursor, previous) {
    const nextOffset = page.nextOffset === undefined || page.nextOffset === null
      ? offset : String(page.nextOffset);
    const nextCursor = page.nextCursor === undefined || page.nextCursor === null
      ? (cursor ?? null) : String(page.nextCursor);
    const remember = !page.complete && (page.hasMore === true || nextOffset !== offset
      || (nextCursor !== null && nextCursor !== cursor));
    return {
      remember,
      nextOffset,
      nextCursor,
      value: remember ? {
        offset: nextOffset,
        cursor: nextCursor,
        pageCount: Number(previous?.pageCount || 0) + 1,
        startedAt: previous?.startedAt || now(),
        gap: 'XHH_WATCHING_LIMITED',
      } : null,
    };
  }

  async function syncConversation(run, {
    partition, conversationKey, credential, budget, workflowId, signal,
  }) {
    const authCookie = credential['cookie'];
    const accountSnapshot = store.read((state) => {
      const account = state.accounts[partition];
      const conversation = account?.conversations?.[conversationKey];
      return {
        peerId: conversation?.peerId || '',
        knownWindowInitialized: conversation?.knownWindowInitialized === true
          || conversation?.baselineComplete === true,
        baselineComplete: conversation?.baselineComplete === true,
        adoptedAfterBaseline: conversation?.adoptedAfterBaseline === true,
        baselineCutoffMs: conversation?.baselineCutoffMs ?? null,
        seenIds: Array.isArray(conversation?.seenIds) ? [...conversation.seenIds] : [],
        pending: conversation?.pending ? JSON.parse(JSON.stringify(conversation.pending)) : null,
      };
    });
    if (!accountSnapshot.peerId) return { gap: '', limited: false };
    const pending = accountSnapshot.pending || {};
    const offset = pending.offset ?? '0';
    const cursor = pending.cursor ?? undefined;
    budget.take();
    let result;
    try {
      result = await clientInstance.fetchDirectMessages(accountSnapshot.peerId, {
        cookie: authCookie,
        heyboxId: credential.heyboxId,
        offset,
        ...(cursor ? { seq: cursor } : {}),
        limit: 30,
        signal,
        expiresAt: roundDeadline,
        workflowId,
      });
    } catch (error) {
      throw error;
    }
    if (!isCurrent(run)) return { gap: '', limited: false, stale: true };
    if (!result || !Array.isArray(result.messages)) {
      throw new XhhDmStoreError('XHH_RESPONSE', '私信历史响应不完整');
    }
    if (result.precisionSafe === false) {
      throw new XhhDmStoreError('XHH_PRECISION', '私信历史标识精度不安全');
    }
    if (isObject(result.shape) && result.shape.recognized !== true) {
      throw new XhhDmStoreError('XHH_RESPONSE', '私信历史结构无法识别');
    }
    const page = normalizePage(result.page);
    const serverTimeMs = toServerMs(result.serverTime);
    const normalized = [];
    let invalid = 0;
    let unsupported = 0;
    for (const raw of result.messages) {
      const record = await normalizeRawMessage(raw, accountSnapshot.peerId, credential.heyboxId, credential);
      if (!isCurrent(run)) return { gap: '', limited: false, stale: true };
      const safe = safeMessage(record, accountSnapshot.peerId, credential.heyboxId);
      if (!safe.ok) {
        invalid += 1;
        continue;
      }
      if (!safe.text) unsupported += 1;
      normalized.push(safe);
    }
    const identities = normalized.map(identityOf).filter(Boolean);
    const at = now();
    const baselineMode = !accountSnapshot.knownWindowInitialized;
    let cutoffMs = accountSnapshot.baselineCutoffMs
      ?? store.read((state) => state.accounts[partition]?.discovery?.baselineCutoffMs ?? null);
    let gap = '';
    let limited = false;
    let enqueued = 0;
    let duplicates = 0;

    if (baselineMode) {
      if (!serverTimeMs) {
        gap = 'XHH_NO_SERVER_TIME';
      } else if (!cutoffMs) {
        cutoffMs = serverTimeMs;
      }
      if (!page.complete && !gap) {
        gap = 'XHH_WATCHING_LIMITED';
        limited = true;
      }
      if (invalid > 0 && !gap) gap = 'XHH_MESSAGE_INVALID';
      const resume = conversationPending(page, offset, cursor, pending);
      const additions = cutoffMs
        ? normalized.filter((record) => record.text && record.sentAtMs > cutoffMs) : [];
      try {
        await store.transaction((draft) => {
          const account = draft.accounts[partition];
          const conversation = account?.conversations?.[conversationKey];
          if (!account || !conversation) return;
          for (const identity of identities) addSeen(conversation, identity);
          conversation.lastServerTime = serverTimeMs || conversation.lastServerTime;
          if (serverTimeMs) account.discovery.lastServerTime = serverTimeMs;
          if (cutoffMs) {
            if (!conversation.baselineCutoffMs) conversation.baselineCutoffMs = cutoffMs;
            if (!account.discovery.baselineCutoffMs) account.discovery.baselineCutoffMs = cutoffMs;
            conversation.knownWindowInitialized = true;
          }
          for (const record of additions) {
            if (storeIncomingMessage(account, conversation, partition, record, at)) {
              enqueued += 1;
            } else {
              duplicates += 1;
            }
          }
          if (gap) {
            conversation.gap = { code: gap, at };
            conversation.pending = resume.value;
            conversation.baselineComplete = false;
            account.discovery.gap = { code: gap, at };
            account.discovery.phase = 'baseline';
          } else {
            conversation.baselineComplete = true;
            conversation.knownWindowInitialized = true;
            conversation.pending = null;
            conversation.gap = null;
            account.discovery.phase = 'complete';
          }
          conversation.updatedAt = at;
        }, { guard: () => isCurrent(run) });
      } catch (error) {
        if (error?.code === 'XHH_CAPACITY') throw error;
        if (error?.code === 'XHH_STALE') return { gap: '', limited: false, stale: true };
        throw error;
      }
      log('baseline', {
        phase: 'baseline',
        action: gap ? 'failed' : 'completed',
        errorCode: gap || undefined,
        conversationHash: opaqueHash(accountSnapshot.peerId),
        bools: { baselineComplete: !gap, limited: limited === true },
        counts: { messages: normalized.length, duplicates, enqueued },
        serverTime: serverTimeMs || undefined,
      });
      return { gap, limited, enqueued, duplicates, invalid, unsupported };
    }

    const cutoff = accountSnapshot.baselineCutoffMs ?? cutoffMs ?? 0;
    const seen = new Set(accountSnapshot.seenIds);
    const additions = [];
    for (const record of normalized) {
      const identity = identityOf(record);
      if (!identity) continue;
      if (seen.has(identity)) {
        duplicates += 1;
        continue;
      }
      if (record.sentAtMs <= cutoff) {
        duplicates += 1;
        continue;
      }
      if (!record.text) continue;
      additions.push(record);
    }
    if (!page.complete) {
      limited = true;
      gap = 'XHH_WATCHING_LIMITED';
    }
    if (invalid > 0 && !gap) gap = 'XHH_MESSAGE_INVALID';
    const resume = conversationPending(page, offset, cursor, pending);
    try {
      await store.transaction((draft) => {
        const account = draft.accounts[partition];
        const conversation = account?.conversations?.[conversationKey];
        if (!account || !conversation) return;
        for (const record of additions) {
          if (storeIncomingMessage(account, conversation, partition, record, at)) {
            enqueued += 1;
          } else {
            duplicates += 1;
          }
        }
        for (const identity of identities) addSeen(conversation, identity);
        if (serverTimeMs) {
          conversation.lastServerTime = serverTimeMs;
          account.discovery.lastServerTime = serverTimeMs;
        }
        conversation.knownWindowInitialized = true;
        if (gap) {
          conversation.baselineComplete = false;
          conversation.gap = { code: gap, at };
          conversation.pending = resume.value;
          account.discovery.gap = { code: gap, at };
        } else {
          conversation.baselineComplete = true;
          conversation.gap = null;
          conversation.pending = null;
        }
        conversation.updatedAt = at;
      }, { guard: () => isCurrent(run) });
    } catch (error) {
      if (error?.code === 'XHH_CAPACITY') throw error;
      if (error?.code === 'XHH_STALE') return { gap: '', limited: false, stale: true };
      throw error;
    }
    if (enqueued > 0) {
      log('enqueue', {
        phase: 'history',
        action: 'enqueued',
        conversationHash: opaqueHash(accountSnapshot.peerId),
        counts: { newMessages: enqueued, duplicates },
        serverTime: serverTimeMs || undefined,
      });
    }
    if (duplicates > 0) {
      log('dedupe', {
        phase: 'history',
        action: 'deduped',
        conversationHash: opaqueHash(accountSnapshot.peerId),
        bools: { deduped: true },
        counts: { duplicates },
        serverTime: serverTimeMs || undefined,
      });
    }
    return { gap, limited, enqueued, duplicates, invalid, unsupported };
  }

  async function listKind(run, kind, credential, budget, workflowId, listState) {
    budget.take();
    const list = await clientInstance.listConversations(kind, {
      cookie: credential['cookie'],
      heyboxId: credential.heyboxId,
      offset: listState?.nextOffset ?? '0',
      limit: 20,
      signal: run.controller.signal,
      expiresAt: roundDeadline,
      workflowId,
    });
    if (!isCurrent(run)) return { stale: true };
    if (!list || !Array.isArray(list.entries)) {
      throw new XhhDmStoreError('XHH_RESPONSE', '会话列表响应不完整');
    }
    if (list.precisionSafe === false) {
      throw new XhhDmStoreError('XHH_PRECISION', '会话列表标识精度不安全');
    }
    if (isObject(list.shape) && list.shape.recognized !== true) {
      throw new XhhDmStoreError('XHH_RESPONSE', '会话列表结构无法识别');
    }
    const page = normalizePage(list.page);
    return {
      kind,
      page,
      serverTimeMs: toServerMs(list.serverTime),
      entries: list.entries.map(normalizeEntry).filter(Boolean),
    };
  }

  async function syncRound(run, credential, account, workflowId) {
    const budget = createBudget(XHH_REQUEST_BUDGET);
    const stateBefore = store.read((state) => {
      const acc = state.accounts[account.partition];
      return {
        discovery: JSON.parse(JSON.stringify(acc.discovery)),
        conversations: Object.keys(acc.conversations || {}),
      };
    });
    const beforeLists = isObject(stateBefore.discovery.lists) ? stateBefore.discovery.lists : {};
    const lists = [];
    let budgetExhausted = false;
    for (const kind of ['normal', 'stranger']) {
      if (budget.remaining <= 0) {
        budgetExhausted = true;
        break;
      }
      const result = await listKind(run, kind, credential, budget, workflowId, beforeLists[kind]);
      if (result.stale) return { gap: '', limited: false, stale: true };
      lists.push(result);
    }
    const listPagesComplete = lists.length === 2 && lists.every((item) => item.page.complete);
    const listGap = !listPagesComplete ? 'XHH_WATCHING_LIMITED' : '';
    const serverTimeMs = lists.reduce(
      (max, item) => (item.serverTimeMs && item.serverTimeMs > max ? item.serverTimeMs : max), 0,
    ) || null;
    if (serverTimeMs) knownServerTime = serverTimeMs;
    const entryMap = new Map();
    for (const item of lists) {
      for (const entry of item.entries) entryMap.set(entry.peerId, entry);
    }
    const entries = [...entryMap.values()];
    const at = now();
    try {
      await store.transaction((draft) => {
        const acc = draft.accounts[account.partition];
        if (!acc) return;
        const adopting = acc.discovery.baselineComplete === true;
        const globalCutoff = acc.discovery.baselineCutoffMs ?? serverTimeMs;
        for (const entry of entries) {
          const conversation = ensureXhhConversation(acc, {
            peerId: entry.peerId,
            nickname: entry.nickname,
            baselineCutoffMs: globalCutoff,
            adopted: adopting,
            now: at,
          });
          conversation.lastServerTime = serverTimeMs || conversation.lastServerTime;
        }
        acc.discovery.pages = Number(acc.discovery.pages || 0) + 1;
        acc.discovery.sessionCount = Object.keys(acc.conversations || {}).length;
        acc.discovery.lastServerTime = serverTimeMs || acc.discovery.lastServerTime;
        acc.discovery.lastScanAt = at;
        if (serverTimeMs && !acc.discovery.baselineCutoffMs) {
          acc.discovery.baselineCutoffMs = serverTimeMs;
        }
        const nextLists = {};
        for (const item of lists) {
          nextLists[item.kind] = {
            complete: item.page.complete,
            hasMore: item.page.hasMore,
            nextOffset: item.page.nextOffset ?? null,
            nextCursor: item.page.nextCursor ?? null,
            at,
          };
        }
        acc.discovery.lists = nextLists;
        if (listGap) {
          acc.discovery.gap = { code: listGap, at };
          acc.discovery.phase = acc.discovery.baselineComplete ? 'rescan' : 'baseline';
          acc.discovery.scanActive = true;
        } else if (!budgetExhausted) {
          acc.discovery.scanActive = false;
          acc.discovery.phase = 'complete';
        }
      }, { guard: () => isCurrent(run) });
    } catch (error) {
      if (error?.code === 'XHH_STALE') return { gap: '', limited: false, stale: true };
      throw error;
    }
    if (!serverTimeMs && !stateBefore.discovery.baselineCutoffMs) {
      const gap = 'XHH_NO_SERVER_TIME';
      await store.transaction((draft) => {
        const acc = draft.accounts[account.partition];
        if (!acc) return;
        acc.discovery.gap = { code: gap, at };
        acc.discovery.phase = 'baseline';
      }, { guard: () => isCurrent(run) });
      return { gap, limited: true, budgetExhausted: false };
    }
    const afterList = store.read((state) => {
      const acc = state.accounts[account.partition];
      const keys = Object.keys(acc.conversations || {});
      const sorted = keys.sort((left, right) => {
        const a = acc.conversations[left];
        const b = acc.conversations[right];
        const pa = a.pending ? 0 : a.baselineComplete ? 1 : 2;
        const pb = b.pending ? 0 : b.baselineComplete ? 1 : 2;
        if (pa !== pb) return pa - pb;
        return Number(a.updatedAt || 0) - Number(b.updatedAt || 0);
      });
      return { keys: sorted, discovery: JSON.parse(JSON.stringify(acc.discovery)) };
    });
    let gap = listGap;
    let limited = listGap !== '';
    let anyIncomplete = false;
    for (const conversationKey of afterList.keys) {
      if (!isCurrent(run)) return { gap: '', limited: false, stale: true };
      if (budget.remaining <= 0) {
        budgetExhausted = true;
        break;
      }
      try {
        const result = await syncConversation(run, {
          partition: account.partition,
          conversationKey,
          credential,
          budget,
          workflowId,
          signal: run.controller.signal,
        });
        if (result.stale) return { gap: '', limited: false, stale: true };
        if (result.gap && !gap) gap = result.gap;
        if (result.limited) limited = true;
        if (result.gap || result.limited) anyIncomplete = true;
      } catch (error) {
        if (error?.code === 'XHH_BUDGET') {
          budgetExhausted = true;
          break;
        }
        if (error?.code === 'XHH_CAPACITY') throw error;
        throw error;
      }
    }
    const completion = store.read((state) => {
      const acc = state.accounts[account.partition];
      const conversationGap = afterList.keys
        .map((key) => acc.conversations[key]?.gap?.code || '')
        .find(Boolean) || '';
      const conversations = Object.values(acc.conversations || {});
      return {
        conversationGap,
        allKnownWindows: conversations.every(
          (conversation) => conversation.knownWindowInitialized === true
            || conversation.baselineComplete === true,
        ),
        allComplete: conversations.every((conversation) => conversation.baselineComplete === true),
      };
    });
    if (completion.conversationGap && !gap) gap = completion.conversationGap;
    if (anyIncomplete || gap) limited = true;
    if (!completion.allKnownWindows) limited = true;
    const complete = !limited && !budgetExhausted && completion.allComplete;
    try {
      await store.transaction((draft) => {
        const acc = draft.accounts[account.partition];
        if (!acc) return;
        acc.discovery.baselineComplete = complete;
        if (complete) {
          acc.discovery.phase = 'complete';
          acc.discovery.gap = null;
        } else if (gap) {
          acc.discovery.gap = { code: gap, at };
        }
        acc.discovery.scanActive = !complete;
        if (!acc.discovery.baselineCutoffMs && serverTimeMs) {
          acc.discovery.baselineCutoffMs = serverTimeMs;
        }
      }, { guard: () => isCurrent(run) });
    } catch { /* state remains limited */ }
    if (!complete && !gap) gap = 'XHH_WATCHING_LIMITED';
    return { gap, limited: !complete, budgetExhausted };
  }

  async function handleFailure(run, credential, error) {
    if (!isCurrent(run)) return;
    const rawCode = String(error?.code || '');
    if (rawCode === 'REQUEST_CANCELLED' || rawCode === 'REQUEST_STALE') return;
    if (rawCode === 'REQUEST_BUDGET') {
      setState('catching_up', 'XHH_BUDGET');
      return;
    }
    const code = safeCode(rawCode);
    if (code === 'XHH_CANCELLED' || code === 'XHH_STALE') return;
    if (code === 'XHH_BUDGET') {
      setState('catching_up', 'XHH_BUDGET');
      return;
    }
    await recordPolicyFailure(credential, error);
    if (code === 'XHH_AUTH' || code === 'XHH_NO_COOKIE') {
      setState('waiting_login', code);
      faultCycle = code;
      return;
    }
    if (code === 'XHH_CAPACITY') {
      setState('paused_capacity', 'XHH_CAPACITY');
      faultCycle = code;
      return;
    }
    if (['XHH_STATE_CORRUPT', 'XHH_STATE_UNSUPPORTED', 'XHH_STATE_READ_FAILED',
      'XHH_WRITE_FAILED', 'XHH_MODULE_UNAVAILABLE', 'XHH_POLICY_UNAVAILABLE'].includes(code)) {
      setState('error', code);
      faultCycle = code;
      return;
    }
    backoffLevel += 1;
    const exponential = Math.min(30 * 60_000, 60_000 * (2 ** Math.min(backoffLevel - 1, 6)));
    const retry = Number(error?.retryAfterMs) || 0;
    const nextAllowed = Number.isFinite(error?.nextAllowedAt) ? error.nextAllowedAt : 0;
    const policyDelay = nextAllowed > now() ? nextAllowed - now() : 0;
    nextRetryAt = now() + Math.max(60_000, exponential, retry, policyDelay);
    setState('backoff', code);
    faultCycle = code;
    log('error', { phase: 'check', action: 'failed', errorCode: code, attempts: backoffLevel });
  }

  async function runRound(run) {
    await ready;
    if (!isCurrent(run)) return;
    if (store.loadError?.()) {
      setState('error', store.loadError().code || 'XHH_STATE_CORRUPT');
      return;
    }
    const config = readConfig();
    pollSeconds = config.pollSeconds;
    lastCheckAt = now();
    log('request', { phase: 'check', action: 'requested', at: lastCheckAt });
    if (!config.enabled) {
      setState('disabled', 'XHH_DISABLED');
      return;
    }
    const credential = await readCredential();
    if (!isCurrent(run)) return;
    lastCredential = credential;
    if (!credential) {
      setState('waiting_login', 'XHH_NO_COOKIE');
      return;
    }
    try {
      const loginState = loginInstance && typeof loginInstance.status === 'function'
        ? await Promise.resolve(loginInstance.status()) : null;
      if (isObject(loginState)) lastLoginStatus = clone(loginState);
    } catch { /* credential state still drives the round */ }
    if (!loginInstance || typeof loginInstance.inspectAccount !== 'function') {
      setState('error', 'XHH_MODULE_UNAVAILABLE');
      faultCycle = 'XHH_MODULE_UNAVAILABLE';
      return;
    }
    let inspection;
    try {
      inspection = await Promise.resolve(loginInstance.inspectAccount());
    } catch (error) {
      if (!isCurrent(run)) return;
      verifiedCredential = null;
      setState('waiting_login', safeCode(error?.code || 'XHH_AUTH'));
      faultCycle = 'XHH_AUTH';
      log('auth', { phase: 'login', action: 'failed', errorCode: 'XHH_AUTH' });
      return;
    }
    if (!isCurrent(run)) return;
    const inspectedId = String(inspection?.heyboxId ?? inspection?.accountId ?? '');
    if (inspection?.state !== 'valid' || !inspectedId || inspectedId !== credential.heyboxId) {
      verifiedCredential = null;
      setState('waiting_login', 'XHH_AUTH');
      faultCycle = 'XHH_AUTH';
      log('auth', { phase: 'login', action: 'failed', errorCode: 'XHH_AUTH' });
      return;
    }
    log('auth', {
      phase: 'login',
      action: 'accepted',
      sessionVersion: numericSessionVersion(credential.sessionVersion) ?? undefined,
    });
    if (credential.heyboxId !== verifiedPeer) {
      verifiedPeer = credential.heyboxId;
    }
    const account = await store.setAccount({
      accountKey: credential.accountKey,
      accountEpoch: credential.accountEpoch,
      sessionVersion: credential.sessionVersion,
    }, { guard: () => isCurrent(run) });
    if (!isCurrent(run)) return;
    currentPartition = account.partition;
    run.partition = account.partition;
    verifiedCredential = {
      heyboxId: credential.heyboxId,
      sessionVersion: credential.sessionVersion,
      accountEpoch: credential.accountEpoch,
    };
    if (!(await ensureTarget(run, config, credential))) {
      await delivery.pump({ guard: () => isCurrent(run) }).catch(() => {});
      return;
    }
    if (!isCurrent(run)) return;
    const pruneAt = now();
    if (lastPruneAt === 0 || pruneAt - lastPruneAt >= 60 * 60_000) {
      lastPruneAt = pruneAt;
      try {
        await store.prune(pruneAt, { guard: () => isCurrent(run) });
      } catch { /* capacity remains visible in state counters */ }
    }
    await refreshPolicy(credential);
    if (!isCurrent(run)) return;
    if (policySnapshot && Number.isFinite(policySnapshot.nextAllowedAt)) {
      nextRetryAt = Math.max(nextRetryAt, Number(policySnapshot.nextAllowedAt) || 0);
    }
    await ensureClient();
    if (!isCurrent(run)) return;
    const accountState = store.read((state) => state.accounts[account.partition]);
    if (!accountState) throw new XhhDmStoreError('XHH_ACCOUNT_INVALID', '账号状态尚未建立');
    roundWorkflowId = await ensureWorkflow(account.partition, credential, run);
    if (!isCurrent(run)) return;
    roundDeadline = now() + XHH_ROUND_DEADLINE_MS;
    const result = await syncRound(run, credential, account, roundWorkflowId);
    if (result.stale || !isCurrent(run)) return;
    lastDiscoveryGap = result.gap || '';
    lastLimited = result.limited === true;
    if (result.budgetExhausted) {
      setState('catching_up', 'XHH_BUDGET');
    } else if (result.gap || result.limited) {
      setState('watching_limited', result.gap || 'XHH_WATCHING_LIMITED');
      log('sync', {
        phase: 'limited',
        action: 'completed',
        errorCode: result.gap || 'XHH_WATCHING_LIMITED',
        bools: { limited: true },
        serverTime: knownServerTime || undefined,
      });
    } else {
      setState('watching', '');
      const recorded = await recordPolicySuccess(run, credential, roundWorkflowId);
      if (isCurrent(run) && recorded?.recorded !== false) {
        try {
          roundWorkflowId = await rotateWorkflow(account.partition, credential, run);
        } catch { /* keep prior durable cycle */ }
      }
      log('sync', {
        phase: 'watching',
        action: 'completed',
        bools: { ok: true, baselineComplete: true, recorded: recorded?.recorded === true },
        serverTime: knownServerTime || undefined,
      });
    }
    await delivery.pump({ guard: () => isCurrent(run) }).catch(() => {});
  }

  function runCheck(manual) {
    if (disposed) return Promise.resolve(getStatus());
    if (roundPromise) return roundPromise;
    running = true;
    const run = {
      generation,
      credentialRevision,
      controller: new AbortController(),
      manual: manual === true,
      partition: currentPartition,
    };
    activeRound = run;
    let promise;
    promise = (async () => {
      let credential = lastCredential;
      try {
        await runRound(run);
        credential = lastCredential || credential;
      } catch (error) {
        await handleFailure(run, credential, error);
      } finally {
        await refreshPolicy(credential);
        if (activeRound === run) activeRound = null;
        if (roundPromise === promise) roundPromise = null;
        if (running && !disposed) scheduleNext();
      }
      return getStatus();
    })();
    roundPromise = promise;
    return promise;
  }

  function check() {
    return runCheck(true);
  }

  function start() {
    if (disposed) return getStatus();
    running = true;
    const config = readConfig();
    pollSeconds = config.pollSeconds;
    if (!config.enabled) {
      setState('disabled', 'XHH_DISABLED');
      clearTimer();
      return getStatus();
    }
    if (!ownerTarget()) setState('waiting_owner', 'XHH_NO_OWNER');
    else setState('initializing', 'XHH_BASELINE');
    refreshPolicy(lastCredential).catch(() => {});
    if (autoSchedule) schedule(1);
    return getStatus();
  }

  function pause(code = 'XHH_PAUSED') {
    running = false;
    generation += 1;
    clearTimer();
    try { activeRound?.controller?.abort(); } catch { /* ignore */ }
    activeRound = null;
    setState('disabled', code);
    return getStatus();
  }

  async function drainActiveRound() {
    const active = roundPromise;
    if (!active) return;
    try { await active; } catch { /* failures are reflected in state */ }
  }

  async function saveConfig(body = {}) {
    if (disposed) throw new XhhDmStoreError('XHH_STALE', '私信服务已停用');
    const request = isObject(body) ? body : {};
    const patch = {};
    if (request.enabled !== undefined) patch.enabled = request.enabled === true;
    if (request.pollSeconds !== undefined) {
      const value = Math.floor(Number(request.pollSeconds));
      if (!Number.isFinite(value) || value < XHH_MIN_POLL_SECONDS || value > XHH_MAX_POLL_SECONDS) {
        throw new XhhDmStoreError('XHH_CONFIG', '轮询间隔需在 180-3600 秒之间');
      }
      patch.pollSeconds = value;
    }
    const requestedKind = request.targetKind !== undefined
      ? request.targetKind
      : (request.sendToGroup === true ? 'group' : (request.sendToGroup === false ? 'c2c' : undefined));
    if (requestedKind !== undefined) {
      if (requestedKind !== 'c2c' && requestedKind !== 'group') {
        throw new XhhDmStoreError('XHH_CONFIG', '通知目标类型不合法');
      }
      patch.targetKind = requestedKind;
    }
    if (request.groupId !== undefined) patch.groupId = String(request.groupId ?? '');
    const current = readConfig();
    const nextKind = patch.targetKind ?? current.targetKind;
    const nextGroupId = patch.groupId ?? current.groupId;
    if (nextKind === 'group' && !nextGroupId) {
      throw new XhhDmStoreError('XHH_CONFIG', '选择群通知时必须提供群目标');
    }
    if (nextKind === 'group') {
      await verifyGroup(nextGroupId);
    }
    if (typeof settings.saveConfig === 'function') {
      const sharedPatch = {};
      if (patch.enabled !== undefined) sharedPatch.xiaoheiheDmEnabled = patch.enabled;
      if (patch.pollSeconds !== undefined) sharedPatch.xiaoheiheDmPollSeconds = patch.pollSeconds;
      if (patch.targetKind !== undefined) sharedPatch.xiaoheiheDmTargetKind = patch.targetKind;
      if (patch.groupId !== undefined) sharedPatch.xiaoheiheDmGroupId = patch.groupId;
      if (Object.keys(sharedPatch).length) {
        try {
          await settings.saveConfig(sharedPatch, { guard: () => !disposed });
        } catch {
          throw new XhhDmStoreError('XHH_CONFIG', '共享配置保存失败');
        }
      }
    }
    await store.setConfig(patch, { guard: () => !disposed });
    log('config', {
      phase: 'target',
      action: 'saved',
      bools: { ok: true },
    });
    const target = readConfig();
    if (patch.targetKind !== undefined || patch.groupId !== undefined) {
      await applyTarget({ targetKind: target.targetKind, groupId: target.groupId });
    }
    if (patch.enabled !== undefined) {
      if (readConfig().enabled) {
        running = true;
        if (!ownerTarget()) setState('waiting_owner', 'XHH_NO_OWNER');
        else setState('initializing', 'XHH_BASELINE');
        if (autoSchedule) schedule(1);
      } else {
        pause('XHH_DISABLED');
        await drainActiveRound();
      }
    }
    return { ok: true, config: readConfig(), dm: getStatus() };
  }

  async function applyTarget({ targetKind, groupId }) {
    const owner = ownerTarget();
    if (!owner) throw new XhhDmStoreError('XHH_NO_OWNER', '尚未绑定主人私聊');
    if (!(await ownerOk(owner))) {
      throw new XhhDmStoreError('XHH_OWNER_REQUIRED', '当前用户不是机器人主人');
    }
    const kind = targetKind === 'group' ? 'group' : 'c2c';
    let name = '';
    if (kind === 'group') {
      const group = await verifyGroup(groupId);
      name = group.name;
    }
    await store.bindOwner(owner, { guard: () => !disposed });
    await delivery.materializeBacklog({ guard: () => !disposed });
    return store.setTarget({
      targetKind: kind,
      target: kind === 'group' ? groupId : owner,
      groupName: name,
    }, { guard: () => !disposed });
  }

  async function setTarget(body = {}) {
    if (disposed) throw new XhhDmStoreError('XHH_STALE', '私信服务已停用');
    const request = isObject(body) ? body : {};
    const kind = request.targetKind === 'group' || request.kind === 'group'
      || request.sendToGroup === true ? 'group' : 'c2c';
    const groupId = request.groupId ?? request.target ?? '';
    const binding = await applyTarget({ targetKind: kind, groupId });
    await store.setConfig({ targetKind: kind, groupId: kind === 'group' ? groupId : '' }, {
      guard: () => !disposed,
    });
    log('config', { phase: 'target', action: 'saved', targetKind: kind, bools: { ok: true } });
    return {
      ok: true,
      targetKind: kind,
      sendToGroup: kind === 'group',
      groupId: kind === 'group' ? String(groupId || '') : '',
      version: binding.version,
      dm: getStatus(),
    };
  }

  async function groups() {
    let listed = { groups: [], selected: { sendToGroup: false, groupId: '' } };
    try {
      listed = await groupCatalog.list();
    } catch { listed = { groups: [], selected: { sendToGroup: false, groupId: '' } }; }
    const normalized = (Array.isArray(listed.groups) ? listed.groups : []).map((row) => {
      if (!isObject(row)) return null;
      const id = String(row.id ?? row.groupOpenid ?? row.groupId ?? row.chatId ?? '');
      if (!id || id.length > 512) return null;
      return {
        id,
        name: String(row.name ?? row.note ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 128),
      };
    }).filter(Boolean).slice(0, 200);
    let binding = { targetKind: 'c2c', target: '', version: 0 };
    try { binding = store.binding(); } catch { /* no state */ }
    return {
      groups: normalized,
      selected: {
        sendToGroup: binding.targetKind === 'group',
        groupId: binding.targetKind === 'group' ? String(binding.target || '') : '',
      },
    };
  }

  async function clearRecovery() {
    if (!requestPolicy || typeof requestPolicy.clearManualRecovery !== 'function') {
      return { ok: false, errorCode: 'XHH_POLICY_UNAVAILABLE' };
    }
    const credential = lastCredential || await readCredential();
    if (!credential) return { ok: false, errorCode: 'XHH_NO_COOKIE' };
    const scope = policyScope(credential);
    if (!scope) return { ok: false, errorCode: 'XHH_NO_COOKIE' };
    try {
      const result = await requestPolicy.clearManualRecovery({ ...scope });
      await refreshPolicy(credential);
      return { ok: true, result };
    } catch {
      return { ok: false, errorCode: 'XHH_POLICY_UNAVAILABLE' };
    }
  }

  function safeLoginStatus(includePng = false) {
    const source = lastLoginStatus || {};
    const out = {};
    for (const [key, value] of Object.entries(source)) {
      if (!LOGIN_FIELDS.has(key)) continue;
      out[key] = value;
    }
    if (!LOGIN_STATES.has(out.state)) out.state = 'idle';
    if (!includePng) delete out.pngDataUrl;
    if (out.accountLabel !== undefined) {
      out.accountLabel = String(out.accountLabel).replace(/[\u0000-\u001f]/g, '').slice(0, 64);
    }
    if (out.sessionVersion !== undefined
      && numericSessionVersion(out.sessionVersion) === null) {
      delete out.sessionVersion;
    }
    if (out.accountEpoch !== undefined) {
      out.accountEpoch = String(out.accountEpoch).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
    }
    return out;
  }

  function refreshCachedLoginStatus() {
    if (!loginInstance || typeof loginInstance.status !== 'function') return;
    try {
      const status = loginInstance.status();
      if (isObject(status)) lastLoginStatus = clone(status);
    } catch { /* keep the last safe local view */ }
  }

  function liveCredentialSnapshot() {
    const fromLogin = (() => {
      if (!loginInstance || typeof loginInstance.credentialState !== 'function') return null;
      let raw;
      try { raw = loginInstance.credentialState(); } catch { return null; }
      if (!isObject(raw)) return null;
      const cookie = String(raw.cookie ?? '');
      const heyboxId = String(raw.heyboxId ?? '');
      if (!cookie && !heyboxId) return null;
      return {
        hasCredential: Boolean(cookie && heyboxId),
        heyboxId,
        sessionVersion: numericSessionVersion(raw.sessionVersion),
        accountEpoch: raw.accountEpoch === undefined || raw.accountEpoch === null
          ? null : String(raw.accountEpoch),
      };
    })();
    if (fromLogin) return fromLogin;
    let stored = null;
    try {
      stored = settings.getPrivateMessageProviderCredentials?.('xiaoheihe');
    } catch {
      stored = null;
    }
    if (!isObject(stored)) return null;
    const cookie = String(stored.cookie ?? '');
    const heyboxId = String(stored.heyboxId ?? '');
    if (!cookie && !heyboxId) return null;
    return {
      hasCredential: Boolean(cookie && heyboxId),
      heyboxId,
      sessionVersion: numericSessionVersion(stored.sessionVersion),
      accountEpoch: stored.accountEpoch === undefined || stored.accountEpoch === null
        ? null : String(stored.accountEpoch),
    };
  }

  function credentialMatchesVerified(live) {
    if (!verifiedCredential || !live || !live.hasCredential) return false;
    return verifiedCredential.heyboxId === live.heyboxId
      && verifiedCredential.sessionVersion === live.sessionVersion
      && String(verifiedCredential.accountEpoch ?? '') === String(live.accountEpoch ?? '');
  }

  async function refreshLoginStatus(includePng = false) {
    try {
      const instance = await ensureLogin();
      const status = await Promise.resolve(instance.status?.());
      if (isObject(status)) {
        const previous = lastLoginStatus?.state;
        lastLoginStatus = clone(status);
        if (['error', 'invalid', 'expired'].includes(status.state)) {
          if (previous !== status.state) {
            log('auth', {
              phase: 'login',
              action: 'failed',
              errorCode: safeCode(status.errorCode || 'XHH_ERROR'),
            });
          }
        } else if (status.state === 'scanned' && previous !== 'scanned') {
          log('auth', { phase: 'login', action: 'confirmed' });
        } else if (status.state === 'success' && previous !== 'success') {
          log('auth', { phase: 'login', action: 'saved' });
        } else if (status.state === 'valid' && previous !== 'valid') {
          log('auth', { phase: 'login', action: 'accepted' });
        }
      }
    } catch {
      lastLoginStatus = { state: 'unavailable', errorCode: 'XHH_MODULE_UNAVAILABLE' };
    }
    return safeLoginStatus(includePng);
  }

  async function loginStatus(includePng = false) {
    return refreshLoginStatus(includePng);
  }

  async function loginStart() {
    const instance = await ensureLogin();
    log('auth', { phase: 'login', action: 'requested' });
    await Promise.resolve(instance.start?.());
    return refreshLoginStatus(true);
  }

  async function loginCancel() {
    if (!loginInstance) return safeLoginStatus(false);
    await Promise.resolve(loginInstance.cancel?.());
    log('auth', { phase: 'login', action: 'skipped' });
    return refreshLoginStatus(false);
  }

  async function loginInspect() {
    const instance = await ensureLogin();
    const value = await Promise.resolve(instance.inspect?.());
    if (!isObject(value)) return { ok: false, state: 'error', errorCode: 'XHH_AUTH' };
    let credential = {};
    try { credential = instance.credentialState?.() || {}; } catch { credential = {}; }
    const heyboxId = String(credential.heyboxId ?? '');
    return {
      ok: value.state === 'valid',
      state: value.state === 'valid' ? 'valid' : (value.state === 'invalid' ? 'invalid' : 'error'),
      errorCode: value.state === 'valid' ? undefined : safeCode(value.errorCode || 'XHH_AUTH'),
      accountLabel: heyboxId ? `***${heyboxId.slice(-4)}` : '',
      sessionVersion: numericSessionVersion(credential.sessionVersion),
    };
  }

  async function loginManual(body) {
    const instance = await ensureLogin();
    const cookie = typeof body === 'string' ? body
      : String(isObject(body) ? (body.cookie ?? body.value ?? '') : '');
    if (!cookie || cookie.length > 64 * 1024 || /[\u0000\r\n]/.test(cookie)) {
      throw new XhhDmStoreError('XHH_CONFIG', '登录信息格式不合法');
    }
    const result = await Promise.resolve(instance.manual?.(cookie));
    log('auth', { phase: 'manual', action: 'saved', bools: { ok: result?.ok !== false } });
    await refreshLoginStatus(false);
    return { ok: result?.ok !== false, login: safeLoginStatus(false) };
  }

  async function loginLogout() {
    let instance = loginInstance;
    if (!instance) {
      try {
        instance = await ensureLogin();
      } catch (error) {
        const code = safeCode(error?.code || 'XHH_STORAGE');
        lastLoginStatus = { state: 'error', errorCode: code };
        log('auth', { phase: 'login', action: 'failed', errorCode: code });
        return { ok: false, login: safeLoginStatus(false), dm: getStatus() };
      }
    }
    if (instance) {
      let result;
      try {
        result = await Promise.resolve(instance.logout?.());
      } catch (error) {
        const code = safeCode(error?.code || 'XHH_STORAGE');
        lastLoginStatus = { state: 'error', errorCode: code };
        log('auth', { phase: 'login', action: 'failed', errorCode: code });
        return { ok: false, login: safeLoginStatus(false), dm: getStatus() };
      }
      if (isObject(result) && (result.ok === false || result.state === 'error')) {
        const code = safeCode(result.errorCode || 'XHH_STORAGE');
        lastLoginStatus = { state: 'error', errorCode: code };
        log('auth', { phase: 'login', action: 'failed', errorCode: code });
        return { ok: false, login: safeLoginStatus(false), dm: getStatus() };
      }
    }
    generation += 1;
    credentialRevision += 1;
    verifiedPeer = '';
    verifiedCredential = null;
    currentPartition = '';
    lastCredential = null;
    lastLoginStatus = { state: 'missing' };
    log('auth', { phase: 'login', action: 'completed' });
    if (running) schedule(1);
    return { ok: true, login: safeLoginStatus(false), dm: getStatus() };
  }

  function getStatus() {
    refreshCachedLoginStatus();
    const config = readConfig();
    let binding = { ownerTarget: null, target: null, targetKind: 'c2c', version: 0 };
    let discovery = null;
    let counters = null;
    let accountEpoch = null;
    let sessionVersion = null;
    try {
      const current = store.read((value) => value);
      binding = current.binding || binding;
      accountEpoch = current.accountEpoch ?? null;
      sessionVersion = numericSessionVersion(current.sessionVersion);
      counters = store.statusCounters();
      const account = current.currentAccountKey ? current.accounts[current.currentAccountKey] : null;
      if (account) {
        discovery = {
          phase: account.discovery?.phase || 'idle',
          baselineComplete: account.discovery?.baselineComplete === true,
          pages: Number(account.discovery?.pages || 0),
          sessionCount: Number(account.discovery?.sessionCount || 0),
          gap: account.discovery?.gap?.code || null,
          limited: !!(account.discovery?.gap) || account.discovery?.baselineComplete !== true,
          coverage: {
            knownWindow: account.discovery?.baselineCutoffMs !== null
              && account.discovery?.baselineCutoffMs !== undefined,
            missingHistory: account.discovery?.baselineComplete !== true
              || !!(account.discovery?.gap),
          },
        };
      }
    } catch {
      counters = null;
    }
    const live = liveCredentialSnapshot();
    if (live && live.sessionVersion !== null) sessionVersion = live.sessionVersion;
    if (live && live.accountEpoch !== null) accountEpoch = live.accountEpoch;
    const queue = delivery.status();
    const login = safeLoginStatus(false);
    if (live && live.sessionVersion !== null) login.sessionVersion = live.sessionVersion;
    if (live && live.accountEpoch !== null) login.accountEpoch = live.accountEpoch;
    const verified = credentialMatchesVerified(live);
    return {
      config: {
        enabled: config.enabled,
        pollSeconds: config.pollSeconds,
        targetKind: config.targetKind,
      },
      login,
      state: stateName,
      reasonCode: reasonCode ? safeCode(reasonCode) : '',
      reasonText: reasonCode ? reasonText(reasonCode) : '',
      lastCheckAt: lastCheckAt || null,
      lastSuccessAt,
      nextRetryAt: ((stateName === 'catching_up' || stateName === 'watching_limited')
        && catchupAt ? catchupAt : nextRetryAt) || null,
      account: {
        loggedIn: live ? live.hasCredential : !!(lastCredential?.cookie),
        verified,
        sessionVersion,
      },
      binding: {
        bound: !!(binding.ownerTarget),
        mask: maskTarget(binding.ownerTarget),
        version: Number(binding.version) || 0,
      },
      destination: {
        kind: binding.targetKind === 'group' ? 'group' : 'c2c',
        label: binding.targetKind === 'group'
          ? (binding.groupName || '群聊') : '主人私聊',
      },
      discovery,
      queue: queue.queue || {},
      polling: {
        seconds: config.pollSeconds,
        effectiveSeconds: effectivePollSeconds(),
        requestBudget: XHH_REQUEST_BUDGET,
      },
      migration: { complete: true, providerId: PROVIDER_ID },
      dm: {
        state: queue.state,
        binding: queue.binding,
        destination: queue.destination,
        queue: queue.queue,
        rate: queue.rate,
      },
      accountEpoch,
      sessionVersion,
      diagnostic: {
        acceptanceAvailable: acceptance !== null && !acceptanceUnavailable
          && (typeof acceptance.diagnostic !== 'function' || acceptance.diagnostic() === 'ok'),
        limited: lastLimited || stateName === 'watching_limited',
        gap: lastDiscoveryGap || null,
      },
      requestPolicy: policySnapshot ? {
        paused: policySnapshot.paused === true,
        cooldownReason: policySnapshot.cooldownReason || null,
        nextAllowedAt: policySnapshot.nextAllowedAt ?? null,
        effectiveIntervalSeconds: policySnapshot.effectiveIntervalSeconds ?? null,
      } : null,
    };
  }

  async function acceptanceSnapshot({ limit = 200 } = {}) {
    if (!acceptance) {
      return {
        available: false,
        diagnostic: 'diagnostic_unavailable',
        events: [],
        count: 0,
      };
    }
    try {
      return acceptance.snapshot({ limit });
    } catch {
      return {
        available: false,
        diagnostic: 'diagnostic_unavailable',
        events: [],
        count: 0,
      };
    }
  }

  function observe(msg) {
    let observed = false;
    try { observed = groupCatalog.observe(msg) === true; } catch { observed = false; }
    return { ok: true, observed };
  }

  async function claim(msg, options = {}) {
    try {
      const result = await delivery.claim(msg, options);
      log('claim', {
        phase: 'send',
        action: result.sent > 0 ? 'sent' : 'skipped',
        targetKind: 'c2c',
        counts: { sent: Number(result.sent) || 0, pending: Number(result.blocked) || 0 },
      });
      return result;
    } catch (error) {
      log('claim', { phase: 'send', action: 'failed', errorCode: safeCode(error?.code), targetKind: 'c2c' });
      throw error;
    }
  }

  async function view(msg, options = {}) {
    const result = await delivery.view(msg, options);
    log('view', {
      phase: 'send',
      action: result.ok ? 'completed' : 'failed',
      counts: { sent: Number(result.sent) || 0 },
    });
    return result;
  }

  async function sendTest(msg) {
    try {
      const result = await delivery.sendTest(msg, { guard: () => !disposed });
      const action = result.state === 'sent' ? 'sent'
        : result.state === 'pending' ? 'pending'
          : result.state === 'unknown' ? 'unknown' : 'failed';
      log('delivery', {
        phase: 'send',
        action,
        bools: { ok: result.ok === true, hostSent: result.state === 'sent', userConfirmed: false },
        counts: { sent: Number(result.sent) || 0 },
      });
      return { ...result, dm: getStatus() };
    } catch (error) {
      log('delivery', { phase: 'send', action: 'failed', errorCode: safeCode(error?.code) });
      throw error;
    }
  }

  function pendingSummary(options = {}) {
    return delivery.pendingSummary(options);
  }

  async function deactivate() {
    if (disposed) return getStatus();
    disposed = true;
    running = false;
    generation += 1;
    clearTimer();
    try { activeRound?.controller?.abort(); } catch { /* ignore */ }
    activeRound = null;
    try { delivery.deactivate?.(); } catch { /* ignore */ }
    try { loginInstance?.deactivate?.(); } catch { /* ignore */ }
    await drainActiveRound();
    setState('disabled', 'XHH_PAUSED');
    log('reload', { phase: 'stop', action: 'drained' });
    try { await acceptance?.flush?.(); } catch { /* diagnostics are best effort */ }
    try { acceptance?.deactivate?.(); } catch { /* ignore */ }
    return getStatus();
  }

  async function flush() {
    await drainActiveRound();
    await Promise.allSettled([
      settings.flush?.(),
      store.flush?.(),
      delivery.flush?.(),
      acceptance?.flush?.(),
      loginInstance?.flush?.(),
      requestPolicy?.flush?.(),
    ]);
  }

  const api = {
    ready,
    getStatus,
    loginStatus,
    loginStart,
    loginCancel,
    loginInspect,
    loginManual,
    loginLogout,
    saveConfig,
    groups,
    setTarget,
    check,
    sendTest,
    clearRecovery,
    acceptance: acceptanceSnapshot,
    observe,
    pendingSummary,
    claim,
    view,
    deactivate,
    flush,
    start,
    pause,
    _internal: {
      store,
      delivery,
      get client() { return clientInstance; },
      get login() { return loginInstance; },
      get acceptance() { return acceptance; },
    },
  };
  ready.then(() => {
    if (disposed || !autoSchedule) return;
    if (readConfig().enabled) start();
  }).catch(() => {});
  return api;
}

export { maskTarget, reasonText, safeCode };
