import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createEngineHost } from './engine-host.js';
import { deliver } from './delivery.js';
import { createSettings, readConfig } from './settings.js';
import { extractLinks } from './links.js';
import { createTaskQueue } from './queue.js';
import { detectHostBoundaries, previewOutcome, registerPanel } from './panel.js';
import { createBiliClient, SAFE_MESSAGES } from './bili-client.js';
import { createBiliLogin } from './bili-login.js';
import { createBiliDmGroupCatalog } from './bili-dm-groups.js';
import {
  PRIVATE_MESSAGE_PROVIDER_IDS, getPrivateMessageProvider,
  publicProviderCapabilities, resolvePrivateMessageProvider,
} from './private-message-providers.js';
import { createPrivateMessageRequestPolicy } from './private-message-request-policy.js';
import { ACCEPTANCE_EVENTS } from './dm-acceptance.js';

export const VERSION = '0.4.2';

export function engineStatus(engine) {
  const status = typeof engine?.status === 'function' ? engine.status() : engine?.status;
  return status && typeof status === 'object' ? status : { state: 'unknown', ready: false };
}

const CONFIG_SCHEMA = {
  enabled: { type: 'boolean', default: true, label: '自动解析' },
  privateEnabled: { type: 'boolean', default: true, label: '私聊解析' },
  requireMention: { type: 'boolean', default: false, label: '群聊要求 @' },
  engineMode: { type: 'select', default: 'managed', options: ['managed', 'external'], label: '引擎模式' },
  engineUrl: { type: 'text', default: 'http://127.0.0.1:3199', label: '本机引擎地址' },
  maxLinks: { type: 'number', default: 3, min: 1, max: 3, label: '每条消息最多链接数' },
  maxFileMiB: { type: 'number', default: 200, min: 1, max: 200, label: '文件上限 MiB', desc: '有效上限还受当前通道限制' },
  timeoutSeconds: { type: 'number', default: 300, min: 5, max: 300, label: '本轮解析与发送总预算秒' },
  concurrency: { type: 'number', default: 2, min: 1, max: 8, label: '全局同时解析任务' },
  queueLimit: { type: 'number', default: 10, min: 0, max: 100, label: '等待任务上限' },
  queueWaitSeconds: { type: 'number', default: 30, min: 1, max: 30, label: '排队等待上限秒' },
  dedupeSeconds: { type: 'number', default: 120, min: 0, max: 3600, label: '同会话链接去重秒' },
  sendCaption: { type: 'boolean', default: true, label: '发送正常标题及正文' },
  handleTextOnly: { type: 'boolean', default: false, label: '接管天生纯文字结果' },
  audioMode: { type: 'select', default: 'auto', options: ['auto', 'voice', 'file'], label: '音频输出' },
  cacheSeconds: { type: 'number', default: 1800, min: 60, max: 86400, label: '缓存保留秒' },
  hotComments: { type: 'number', default: 0, min: 0, max: 20, label: '热评条数' },
  translation: { type: 'boolean', default: false, label: '翻译（可调用模型）' },
  pythonPath: { type: 'text', default: '', label: 'Python 可执行路径（可选）' },
  ffmpegPath: { type: 'text', default: '', label: 'ffmpeg 路径（可选）' },
  externalCacheRoot: { type: 'text', default: '', label: '外部模式本地缓存根' },
  biliDmEnabled: { type: 'boolean', default: false, label: 'B站私信提醒' },
  biliDmPollSeconds: { type: 'number', default: 300, min: 180, max: 3600, label: 'B站私信轮询间隔秒' },
  biliDmIncludeSystem: { type: 'boolean', default: false, label: '纳入已支持的系统私信' },
  xiaoheiheDmEnabled: { type: 'boolean', default: false, label: '小黑盒私信提醒' },
  xiaoheiheDmPollSeconds: { type: 'number', default: 300, min: 180, max: 3600, label: '小黑盒私信轮询间隔秒' },
};

const DM_CONFIG_KEYS = Object.freeze([
  'biliDmEnabled', 'biliDmPollSeconds', 'biliDmIncludeSystem',
  'xiaoheiheDmEnabled', 'xiaoheiheDmPollSeconds',
]);
const DM_SAFE_TEXT = Object.freeze({
  DM_MODULE_UNAVAILABLE: '私信模块尚未就绪，请等待审核模块载入或查看管理页。',
  DM_STATE_CORRUPT: '私信状态文件损坏，原文件已保留，请管理员检查数据目录。',
  DM_STATE_UNSUPPORTED: '私信状态版本高于当前插件，已保留原文件未做重置。',
  DM_STATE_READ_FAILED: '私信状态文件读取失败，已保留原文件。',
  DM_WRITE_FAILED: '私信状态保存失败，本轮进度未推进。',
  DM_CAPACITY: '待投递私信已达数量或体积上限，已暂停抓取并保留进度。',
  DM_GAP: '私信历史存在无法确认的缺口，已停止推进并保留续拉位置。',
  DM_AMBIGUOUS_CURSOR: '私信分页边界无法可靠确认，已保留续拉位置。',
  DM_NO_SERVER_TIME: '缺少可用于基线确认的服务器时间，暂不推进。',
  DM_BUDGET: '本轮请求预算已用完，稍后继续。',
  DM_AUTH: 'B 站登录未登录或已失效，请重新登录。',
  DM_NETWORK: '暂时无法连接 B 站，稍后重试。',
  DM_TIMEOUT: '请求 B 站超时，稍后重试。',
  DM_RATE_LIMIT: '请求过于频繁，已进入退避。',
  DM_HTTP: 'B 站服务暂时不可用，稍后重试。',
  DM_RESPONSE: 'B 站返回了无法识别的数据，已停止推进。',
  DM_API: 'B 站拒绝了私信读取请求。',
  DM_CANCELLED: '操作已取消。',
  DM_BASELINE: '正在建立历史基线。',
  DM_CATCHUP: '正在追赶新增私信。',
  DM_NO_COOKIE: '尚未登录 B 站。',
  DM_NO_OWNER: '尚未绑定接收私聊。',
  DM_DISABLED: '私信提醒已停用。',
  DM_PAUSED: '私信提醒已暂停。',
  DM_LOGOUT: '已退出 B 站共享登录。',
  DM_RECOVERED: '私信读取已恢复。',
  DM_CREDENTIAL_CHANGED: '共享凭据已变更，正在重新校验账号。',
  DM_CONTENT_INVALID: '单条私信内容超过安全上限，未自动推进进度。',
  DM_MESSAGE_ID_INVALID: '单条私信缺少可靠 ID，未自动推进进度。',
  DM_ACCOUNT_INVALID: '私信账号状态无效。',
  DM_BINDING_REQUIRED: '请先绑定接收私聊。',
  DM_BINDING_INVALID: '接收目标格式不合法。',
  DM_GROUP_INVALID: '所选群不存在、已停用或不接受该目标，请刷新群列表后重试。',
  DM_GROUP_UNAVAILABLE: '当前私信投递模块尚不支持群目标，请稍后重试。',
  DM_OWNER_REQUIRED: '仅机器人主人可在私聊中操作。',
  DM_STATE_NOT_READY: '私信状态尚未加载完成。',
  DM_STALE: '旧代次任务结果已丢弃。',
  DM_ERROR: '私信功能暂时不可用。',
  DM_CONFIG: '私信配置不完整。',
  DM_PROVIDER_UNKNOWN: '未知的私信平台。',
  DM_PROVIDER_UNVERIFIED: '该平台的私信能力和后端状态不满足当前使用条件。',
  DM_PROVIDER_UNAVAILABLE: '该平台的私信模块当前不可用。',
  DM_ACCEPTANCE_UNSUPPORTED: 'B站当前不提供脱敏验收记录接口；小黑盒可查看验收记录。',
  DM_ACCEPTANCE_LIMIT: '验收记录数量必须是 0～100 的整数。',
});
const SAFE_LOGIN_STATES = new Set([
  'idle', 'starting', 'waiting', 'scanned', 'success', 'expired', 'cancelled',
  'error', 'missing', 'valid', 'invalid', 'unavailable',
]);
const SAFE_LOGIN_ERROR_CODES = new Set(Object.keys(SAFE_MESSAGES));
// The B runtime works with a wider, finite set of state/reason codes than the
// A client error map. These static texts keep status intelligible without
// accepting arbitrary raw code or raw text from either module.
const XHH_RUNTIME_REASON_TEXT = Object.freeze({
  XHH_CANCELLED: '操作已取消。',
  XHH_AUTH: '小黑盒登录状态已失效，请重新登录。',
  XHH_RATE_LIMIT: '请求频率已达上限，稍后会自动重试。',
  XHH_RISK: '小黑盒触发了风控限制，已暂停请求。',
  XHH_CHALLENGE: '小黑盒要求完成安全验证，已暂停请求。',
  XHH_TIMEOUT: '请求小黑盒超时，请稍后重试。',
  XHH_NETWORK: '暂时无法连接小黑盒，稍后会自动重试。',
  XHH_HTTP: '小黑盒服务暂时不可用，请稍后重试。',
  XHH_RESPONSE: '小黑盒返回了无法识别的数据，已暂停同步。',
  XHH_API: '小黑盒拒绝了请求。',
  XHH_BUDGET: '本轮请求预算已用完，稍后继续。',
  XHH_COOLDOWN: '本地请求冷却中，请稍后重试。',
  XHH_PRECISION: '小黑盒返回的标识精度不安全，已暂停同步。',
  XHH_QR: '小黑盒二维码响应无效。',
  XHH_QR_CREDENTIAL: '扫码成功但未取得有效登录凭据。',
  XHH_STORAGE: '登录成功但凭据保存失败，请稍后重试。',
  XHH_LOGIN: '小黑盒登录未完成。',
  XHH_REJECTED: '小黑盒拒绝了当前操作。',
  XHH_GAP: '历史边界不完整，仅处理可确认窗口内的新消息。',
  XHH_WATCHING_LIMITED: '历史窗口有限，已保留缺口，不声称完整同步。',
  XHH_BASELINE: '正在建立首次历史基线。',
  XHH_CATCHUP: '正在继续读取未完成的历史窗口。',
  XHH_NO_OWNER: '尚未绑定接收通知的主人。',
  XHH_NO_COOKIE: '尚未配置小黑盒登录信息。',
  XHH_OWNER_REQUIRED: '当前用户不是机器人主人，已暂停通知。',
  XHH_BINDING_REQUIRED: '尚未配置接收通知的目标。',
  XHH_BINDING_INVALID: '接收目标格式不合法。',
  XHH_CREDENTIAL_CHANGED: '小黑盒账号已变化，等待重新检查。',
  XHH_NO_SERVER_TIME: '缺少可信服务器时间，未建立完整基线。',
  XHH_MESSAGE_INVALID: '存在无法可靠识别的消息，已保留缺口。',
  XHH_MESSAGE_ID_INVALID: '存在缺少可靠 ID 的消息，已保留缺口。',
  XHH_CONTENT_INVALID: '存在超过安全上限的消息内容，未推进进度。',
  XHH_STATE_CORRUPT: '本地私信状态异常，需要检查状态文件。',
  XHH_STATE_UNSUPPORTED: '本地私信状态版本过高，需要更新插件。',
  XHH_STATE_READ_FAILED: '本地私信状态读取失败，需要检查文件权限。',
  XHH_STATE_NOT_READY: '小黑盒私信状态尚未加载完成。',
  XHH_WRITE_FAILED: '本地私信状态写入失败，需要检查磁盘空间。',
  XHH_CAPACITY: '待处理私信数量已达上限，已暂停继续拉取。',
  XHH_DISABLED: '小黑盒私信提醒未开启。',
  XHH_PAUSED: '小黑盒私信提醒已暂停。',
  XHH_MODULE_UNAVAILABLE: '小黑盒客户端或登录模块不可用。',
  XHH_POLICY_UNAVAILABLE: '请求调度状态不可用，已安全暂停。',
  XHH_ERROR: '小黑盒私信处理发生错误。',
  XHH_RECOVERED: '小黑盒私信读取已恢复。',
  XHH_LOGOUT: '已退出小黑盒登录。',
  XHH_ACCOUNT_INVALID: '小黑盒账号状态无效。',
  XHH_CONFIG: '小黑盒配置不完整。',
  XHH_STALE: '旧代次任务结果已丢弃。',
  XHH_GROUP_INVALID: '所选群不存在、已停用或当前不可用。',
  XHH_GROUP_UNAVAILABLE: '当前宿主不支持该群目标。',
  XHH_NOT_FOUND: '未找到保留期内的内容。',
  XHH_PAGE_OUT_OF_RANGE: '查看页码超出范围。',
});
const XHH_FAILURE_CODES = new Set([
  ...Object.keys(XHH_RUNTIME_REASON_TEXT),
  'XHH_QR_CREDENTIAL', 'XHH_STORAGE', 'XHH_REJECTED',
]);
const SAFE_DISCOVERY_PHASES = new Set([
  'idle', 'baseline', 'rescan', 'complete', 'limited', 'gap',
]);
const ACCEPTANCE_EVENT_FIELDS = Object.freeze([
  'event', 'providerId', 'phase', 'action', 'errorCode', 'httpStatus', 'apiCode',
  'knownBusinessStatus', 'counts', 'bools', 'at', 'serverTime', 'messageHash',
  'conversationHash', 'targetKind', 'maskedTarget', 'attempts', 'sessionVersion',
]);
const ACCEPTANCE_EVENT_NAMES = new Set(ACCEPTANCE_EVENTS);
const ACCEPTANCE_META_FIELDS = Object.freeze([
  'providerId', 'generatedAt', 'recordedAt', 'total', 'count', 'truncated',
  'limited', 'limit', 'rotation', 'available', 'diagnostic', 'dropped',
  'maxEvents', 'maxBytes', 'updatedAt',
]);
const ACCEPTANCE_SAFE_TEXT = /^[A-Za-z0-9_.:\-*+ ]{1,64}$/;
const DM_STATE_LABELS = Object.freeze({
  disabled: '已停用', waiting_login: '等待登录', waiting_owner: '等待绑定',
  initializing: '初始化中', watching: '监听中', watching_limited: '监听中（范围受限）',
  catching_up: '追赶中', backoff: '退避中', paused_capacity: '容量暂停',
  error: '错误', unavailable: '不可用',
});
const LOGIN_STATE_LABELS = Object.freeze({
  idle: '未开始', starting: '生成中', waiting: '等待扫码', scanned: '已扫码待确认',
  success: '已登录', expired: '已过期', cancelled: '已取消', error: '错误',
  missing: '未登录', valid: '有效', invalid: '已失效', unavailable: '不可用',
});

function dmText(code) {
  return DM_SAFE_TEXT[String(code || '')] || DM_SAFE_TEXT.DM_ERROR;
}

function dmFailure(code) {
  const error = new Error(dmText(code));
  error.code = code;
  return error;
}

function dmErrorCode(error) {
  const code = String(error?.code || '');
  if (code.startsWith('DM_')) return DM_SAFE_TEXT[code] ? code : 'DM_ERROR';
  if (code.startsWith('BILI_') || code.startsWith('XHH_')) return code;
  return 'DM_ERROR';
}

function dmErrorText(error, runtime = null) {
  const code = dmErrorCode(error);
  if (code.startsWith('BILI_')) return SAFE_MESSAGES[code] || '请求失败。';
  if (code.startsWith('XHH_')) {
    const text = xhhSafeMessages(runtime)[code];
    return typeof text === 'string' && text.length <= 120
      ? text : '小黑盒操作失败，请稍后重试或查看验收记录。';
  }
  return dmText(code);
}

function safeMask(mask) {
  const text = typeof mask === 'string' ? mask : '';
  return /^\*{2,4}.{0,4}$/.test(text) ? text : '';
}

function safeVersion(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function loginSafe(status, includePng = false, sessionVersion = 0) {
  const value = status && typeof status === 'object' ? status : {};
  const errorCode = SAFE_LOGIN_ERROR_CODES.has(String(value.errorCode ?? '')) ? String(value.errorCode) : null;
  const version = safeVersion(sessionVersion ?? value.sessionVersion);
  const out = {
    state: SAFE_LOGIN_STATES.has(value.state) ? value.state : 'unavailable',
    expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : null,
    errorCode,
    errorSummary: errorCode ? SAFE_MESSAGES[errorCode] || null : null,
    retryAfterMs: Number.isFinite(value.retryAfterMs) ? Math.max(0, value.retryAfterMs) : 0,
    sessionVersion: version,
  };
  if (includePng && typeof value.pngDataUrl === 'string'
    && value.pngDataUrl.startsWith('data:image/png;base64,')
    && value.pngDataUrl.length <= 512 * 1024) {
    out.pngDataUrl = value.pngDataUrl;
  }
  return out;
}

function formatTime(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  try { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); } catch { return '—'; }
}

async function defaultDmModules() {
  try {
    const [service, store, delivery] = await Promise.all([
      import('./bili-dm.js'),
      import('./bili-dm-store.js'),
      import('./bili-dm-delivery.js'),
    ]);
    if (typeof service.createBiliDmService !== 'function'
      || typeof store.createBiliDmStore !== 'function'
      || typeof delivery.createBiliDmDelivery !== 'function') {
      throw new Error('missing export');
    }
    return {
      createBiliDmService: service.createBiliDmService,
      createBiliDmStore: store.createBiliDmStore,
      createBiliDmDelivery: delivery.createBiliDmDelivery,
    };
  } catch {
    const error = new Error('私信模块尚未就绪');
    error.code = 'DM_MODULE_UNAVAILABLE';
    throw error;
  }
}

async function defaultXhhRuntimeFactory(options) {
  const module = await import('./xiaoheihe-runtime.js');
  if (typeof module.createXiaoheiheRuntime !== 'function') {
    throw new Error('missing createXiaoheiheRuntime');
  }
  return module.createXiaoheiheRuntime(options);
}

async function defaultXhhSafeMessages() {
  try {
    const module = await import('./xiaoheihe-client.js');
    return module.XHH_SAFE_MESSAGES && typeof module.XHH_SAFE_MESSAGES === 'object'
      ? module.XHH_SAFE_MESSAGES : {};
  } catch {
    return {};
  }
}

function safeReasonCode(value) {
  const code = String(value ?? '');
  return Object.prototype.hasOwnProperty.call(DM_SAFE_TEXT, code) ? code : '';
}

function xhhSafeMessages(runtime) {
  const value = runtime?.xhhSafeMessages;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function xhhReasonText(runtime, code) {
  if (!code) return '';
  const injected = xhhSafeMessages(runtime)[code];
  if (typeof injected === 'string' && injected.length <= 120) return injected;
  const fixed = XHH_RUNTIME_REASON_TEXT[code];
  return typeof fixed === 'string' ? fixed : '';
}

function safeXhhReasonCode(runtime, value) {
  const code = String(value ?? '');
  if (Object.prototype.hasOwnProperty.call(DM_SAFE_TEXT, code)) return code;
  if (!XHH_FAILURE_CODES.has(code)) return '';
  if (Object.prototype.hasOwnProperty.call(XHH_RUNTIME_REASON_TEXT, code)
    || typeof xhhSafeMessages(runtime)[code] === 'string') return code;
  return '';
}

function safeXhhReasonText(runtime, code) {
  if (!code) return '';
  if (Object.prototype.hasOwnProperty.call(DM_SAFE_TEXT, code)) return dmText(code);
  return xhhReasonText(runtime, code) || dmText('DM_ERROR');
}

function xhhLoginSafe(runtime, status, includePng = false, sessionVersion = undefined) {
  const value = status && typeof status === 'object' ? status : {};
  const messages = xhhSafeMessages(runtime);
  const rawCode = String(value.errorCode ?? '');
  const errorCode = XHH_FAILURE_CODES.has(rawCode)
    && (Object.prototype.hasOwnProperty.call(XHH_RUNTIME_REASON_TEXT, rawCode)
      || typeof messages[rawCode] === 'string') ? rawCode : null;
  const version = safeVersion(sessionVersion ?? value.sessionVersion);
  const out = {
    state: SAFE_LOGIN_STATES.has(value.state) ? value.state : 'unavailable',
    expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : null,
    errorCode,
    errorSummary: errorCode ? (xhhReasonText(runtime, errorCode) || null) : null,
    retryAfterMs: Number.isFinite(value.retryAfterMs) ? Math.max(0, value.retryAfterMs) : 0,
    sessionVersion: version,
  };
  if (includePng && typeof value.pngDataUrl === 'string'
    && value.pngDataUrl.startsWith('data:image/png;base64,')
    && value.pngDataUrl.length <= 512 * 1024) {
    out.pngDataUrl = value.pngDataUrl;
  }
  return out;
}

function safeShortText(value, max = 120) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > max || /[\0\r\n]/.test(text)) return '';
  if (/:\/\//.test(text) || /(?:cookie|token|session|secret|authorization)\s*[:=]/i.test(text)) return '';
  return text;
}

function safeAcceptanceText(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > 64 || !ACCEPTANCE_SAFE_TEXT.test(text)) return undefined;
  if (/:\/\//.test(text) || /(?:cookie|token|session|secret|authorization)/i.test(text)) return undefined;
  return text;
}

function safeAcceptanceCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/i.test(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = Math.max(-1_000_000, Math.min(1_000_000, Math.floor(item)));
  }
  return Object.keys(out).length ? out : undefined;
}

function safeAcceptanceBools(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/i.test(key)) continue;
    if (typeof item === 'boolean') out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

function safeAcceptanceEvent(runtime, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const field of ACCEPTANCE_EVENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const item = value[field];
    if (field === 'event') {
      if (ACCEPTANCE_EVENT_NAMES.has(item)) out.event = item;
      continue;
    }
    if (field === 'counts') {
      const counts = safeAcceptanceCounts(item);
      if (counts) out.counts = counts;
      continue;
    }
    if (field === 'bools') {
      const bools = safeAcceptanceBools(item);
      if (bools) out.bools = bools;
      continue;
    }
    if (field === 'providerId') {
      if (item === 'xiaoheihe') out.providerId = item;
      continue;
    }
    if (['httpStatus', 'apiCode', 'at', 'serverTime', 'attempts', 'sessionVersion'].includes(field)) {
      if (typeof item === 'number' && Number.isFinite(item)) out[field] = Math.floor(item);
      continue;
    }
    const text = safeAcceptanceText(item);
    if (text !== undefined) out[field] = text;
  }
  return Object.keys(out).length ? out : null;
}

function safeAcceptanceSnapshot(runtime, value, limit) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const list = Array.isArray(value) ? value : Array.isArray(source.events) ? source.events : [];
  const events = [];
  for (const item of list.slice(0, limit)) {
    const event = safeAcceptanceEvent(runtime, item);
    if (event) events.push(event);
  }
  const out = { providerId: 'xiaoheihe', events };
  for (const field of ACCEPTANCE_META_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const item = source[field];
    if (field === 'providerId') {
      if (item === 'xiaoheihe') out.providerId = item;
    } else if (field === 'truncated' || field === 'limited' || field === 'available') {
      if (typeof item === 'boolean') out[field] = item;
    } else if (field === 'diagnostic') {
      if (['ok', 'diagnostic_unavailable', 'corrupt', 'unavailable'].includes(item)) {
        out.diagnostic = item;
      }
    } else if (['generatedAt', 'recordedAt', 'total', 'count', 'limit', 'rotation',
      'dropped', 'maxEvents', 'maxBytes', 'updatedAt'].includes(field)
      && typeof item === 'number' && Number.isFinite(item)) {
      out[field] = Math.floor(item);
    }
  }
  if (out.total === undefined) out.total = Math.max(0, list.length);
  return out;
}

function parseAcceptanceLimit(query) {
  const raw = query && typeof query === 'object' ? query.limit : undefined;
  if (raw === undefined || raw === null || raw === '') return 50;
  const text = String(raw);
  if (!/^\d{1,3}$/.test(text)) throw providerFailure('DM_ACCEPTANCE_LIMIT');
  const limit = Number(text);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) throw providerFailure('DM_ACCEPTANCE_LIMIT');
  return limit;
}

function maskGroup(target) {
  const value = String(target || '');
  if (!value) return '';
  return value.length <= 4 ? '***' : `***${value.slice(-4)}`;
}

function safeDestination(runtime) {
  try {
    const binding = runtime.dmStore?.binding?.() ?? {};
    if (binding.notifyKind === 'group' && binding.groupTarget) {
      return { kind: 'group', label: `群 ${maskGroup(binding.groupTarget)}` };
    }
  } catch {}
  return { kind: 'c2c', label: '主人私聊' };
}

function sessionVersionOf(settings) {
  return typeof settings.getBiliSessionVersion === 'function'
    ? safeVersion(settings.getBiliSessionVersion()) : 0;
}

function buildDmStatus(runtime, settings) {
  const cfg = settings.current();
  const sessionVersion = sessionVersionOf(settings);
  const login = loginSafe(runtime.biliLogin?.status?.() ?? { state: 'unavailable' }, false, sessionVersion);
  const accountEpoch = typeof settings.getBiliAccountEpoch === 'function'
    ? settings.getBiliAccountEpoch() : null;
  const out = {
    destination: safeDestination(runtime),
    accountEpoch,
    sessionVersion,
    accountVersion: sessionVersion,
    available: Boolean(runtime.dm && !runtime.dmFatal),
    moduleError: runtime.dmLoadError ? dmText(runtime.dmLoadError) : '',
    enabled: cfg.biliDmEnabled === true,
    pollSeconds: cfg.biliDmPollSeconds,
    includeSystem: cfg.biliDmIncludeSystem === true,
    login,
    state: 'unavailable',
    reasonCode: '',
    reasonText: '',
    lastCheckAt: null,
    lastSuccessAt: null,
    nextRetryAt: null,
    account: { loggedIn: false, verified: false, version: sessionVersion },
    binding: { bound: false, mask: '', version: 0 },
    discovery: { phase: 'idle', baselineComplete: false, pages: 0, sessionCount: 0, gap: false },
    queue: {
      unfinished: 0, pending: 0, unknown: 0, failed: 0, sent: 0,
      pendingConversations: 0, gapConversations: 0,
    },
    polling: { seconds: cfg.biliDmPollSeconds, requestBudget: 6 },
    noticePending: false,
  };
  if (!runtime.dm) {
    if (runtime.dmLoading && !runtime.dmLoadError) out.state = 'initializing';
    return out;
  }
  let status;
  try { status = runtime.dm.status(); } catch { return out; }
  if (!status || typeof status !== 'object') return out;
  out.state = DM_STATE_LABELS[status.state] ? status.state : 'error';
  out.reasonCode = safeReasonCode(status.reasonCode);
  out.reasonText = out.reasonCode ? dmText(out.reasonCode) : '';
  out.lastCheckAt = Number.isFinite(status.lastCheckAt) ? status.lastCheckAt : null;
  out.lastSuccessAt = Number.isFinite(status.lastSuccessAt) ? status.lastSuccessAt : null;
  out.nextRetryAt = Number.isFinite(status.nextRetryAt) ? status.nextRetryAt : null;
  out.account = {
    loggedIn: status.account?.loggedIn === true,
    verified: status.account?.verified === true,
    version: sessionVersion,
  };
  out.binding = {
    bound: status.binding?.bound === true,
    mask: safeMask(status.binding?.mask),
    version: Number.isFinite(status.binding?.version) ? status.binding.version : 0,
  };
  out.discovery = {
    phase: SAFE_DISCOVERY_PHASES.has(status.discovery?.phase) ? status.discovery.phase : 'unknown',
    baselineComplete: status.discovery?.baselineComplete === true,
    pages: Math.max(0, Number(status.discovery?.pages) || 0),
    sessionCount: Math.max(0, Number(status.discovery?.sessionCount) || 0),
    gap: status.discovery?.gap === true,
  };
  out.queue = {
    unfinished: Math.max(0, Number(status.queue?.unfinished) || 0),
    pending: Math.max(0, Number(status.queue?.pending) || 0),
    unknown: Math.max(0, Number(status.queue?.unknown) || 0),
    failed: Math.max(0, Number(status.queue?.failed) || 0),
    sent: Math.max(0, Number(status.queue?.sent) || 0),
    pendingConversations: Math.max(0, Number(status.queue?.pendingConversations) || 0),
    gapConversations: Math.max(0, Number(status.queue?.gapConversations) || 0),
  };
  const seconds = Number(status.polling?.seconds);
  const requestBudget = Number(status.polling?.requestBudget);
  out.polling = {
    seconds: Number.isFinite(seconds) && seconds >= 180 && seconds <= 3600 ? Math.floor(seconds) : cfg.biliDmPollSeconds,
    requestBudget: Number.isFinite(requestBudget) && requestBudget > 0 ? Math.floor(requestBudget) : 6,
  };
  out.noticePending = status.noticePending === true;
  return out;
}

function providerFailure(code) {
  return dmFailure(code);
}

function requireProvider(providerId) {
  const provider = getPrivateMessageProvider(providerId);
  if (!provider) throw providerFailure('DM_PROVIDER_UNKNOWN');
  return provider;
}

function safeCount(value) {
  return Math.max(0, Math.min(1_000_000, Math.floor(Number(value) || 0)));
}

function safeOptionalTime(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * Normalize the B runtime envelope through the shared C allow-list. The B
 * implementation owns protocol details; the public plugin surface only ever
 * exposes fixed, bounded fields and never an internal message or credential.
 */
function xhhStatusEnvelope(runtime, settings, raw = null) {
  const cfg = settings.current();
  const provider = requireProvider('xiaoheihe');
  const capabilities = publicProviderCapabilities(provider);
  const source = raw && typeof raw === 'object' ? raw : {};
  // Xiaoheihe has its own numeric UI session version. Never borrow the Bili
  // counter: accounts and credentials are independent partitions.
  const sessionVersion = safeVersion(
    source.sessionVersion ?? source.account?.sessionVersion ?? 0,
  );
  const configure = source.config && typeof source.config === 'object' ? source.config : {};
  const requestPolicy = source.requestPolicy && typeof source.requestPolicy === 'object'
    ? source.requestPolicy : {};
  const pollSeconds = Number.isFinite(configure.pollSeconds)
    && configure.pollSeconds >= 180 && configure.pollSeconds <= 3600
    ? Math.floor(configure.pollSeconds) : cfg.xiaoheiheDmPollSeconds;
  // An explicit runtime boolean wins. The host setting is only the fallback
  // when the runtime did not report its effective configuration.
  const enabled = typeof configure.enabled === 'boolean'
    ? configure.enabled : cfg.xiaoheiheDmEnabled === true;
  const rawEffective = requestPolicy.effectiveIntervalSeconds
    ?? configure.effectivePollSeconds ?? source.polling?.effectiveSeconds
    ?? source.polling?.seconds;
  // Server cooldowns may legitimately exceed one hour. Do not truncate a
  // longer effective interval back to the configured 180-3600 window.
  const effective = Number.isFinite(rawEffective) && rawEffective > 0
    ? Math.max(1, Math.floor(rawEffective)) : pollSeconds;
  const login = xhhLoginSafe(runtime, source.login ?? { state: 'unavailable' }, false, sessionVersion);
  const reasonCode = safeXhhReasonCode(runtime, source.reasonCode);
  const state = DM_STATE_LABELS[source.state] ? source.state : 'unavailable';
  const accountEpoch = typeof source.accountEpoch === 'string'
    && /^[0-9a-f-]{8,64}$/i.test(source.accountEpoch) ? source.accountEpoch : null;
  const account = {
    loggedIn: source.account?.loggedIn === true,
    verified: source.account?.verified === true,
    version: safeVersion(source.account?.version ?? sessionVersion),
  };
  const binding = {
    bound: source.binding?.bound === true,
    mask: safeMask(source.binding?.mask),
    version: safeCount(source.binding?.version),
  };
  const destination = {
    kind: source.destination?.kind === 'group' ? 'group' : 'c2c',
    label: source.destination?.kind === 'group'
      ? (safeShortText(source.destination?.label, 80) || '群目标')
      : '主人私聊',
  };
  const discovery = {
    phase: SAFE_DISCOVERY_PHASES.has(source.discovery?.phase) ? source.discovery.phase : 'idle',
    baselineComplete: source.discovery?.baselineComplete === true,
    pages: safeCount(source.discovery?.pages),
    sessionCount: safeCount(source.discovery?.sessionCount),
    gap: source.discovery?.gap === true || Boolean(source.discovery?.gap),
  };
  const queue = {
    unfinished: safeCount(source.queue?.unfinished),
    pending: safeCount(source.queue?.pending),
    unknown: safeCount(source.queue?.unknown),
    failed: safeCount(source.queue?.failed),
    sent: safeCount(source.queue?.sent),
    pendingConversations: safeCount(source.queue?.pendingConversations),
    gapConversations: safeCount(source.queue?.gapConversations),
  };
  const serverNextAllowedAt = safeOptionalTime(
    source.polling?.serverNextAllowedAt ?? requestPolicy.serverNextAllowedAt
      ?? requestPolicy.nextAllowedAt,
  );
  const paused = source.polling?.paused === true || requestPolicy.paused === true;
  const polling = {
    seconds: effective,
    effectiveSeconds: effective,
    requestBudget: Number.isFinite(source.polling?.requestBudget)
      ? Math.max(1, Math.min(100, Math.floor(source.polling.requestBudget))) : 6,
    paused,
    pauseReason: safeXhhReasonCode(runtime,
      source.polling?.pauseReason ?? requestPolicy.pauseReason
        ?? (requestPolicy.paused === true ? requestPolicy.cooldownReason : '')),
    cooldownReason: safeXhhReasonCode(runtime,
      source.polling?.cooldownReason ?? requestPolicy.cooldownReason),
    manualRecoveryRequired: source.polling?.manualRecoveryRequired === true
      || requestPolicy.requiresManualRecovery === true,
    serverNextAllowedAt,
    nextAllowedAt: safeOptionalTime(requestPolicy.nextAllowedAt),
  };
  const available = runtime.xhh !== null && runtime.xhh !== undefined;
  const model = {
    provider: {
      id: provider.id, label: provider.label,
      capabilities: { ...capabilities, available: available && capabilities.available === true },
    },
    config: {
      enabled,
      disabled: !enabled,
      pollSeconds,
      effectivePollSeconds: effective,
      includeSystem: false,
      defaultTarget: 'c2c',
    },
    login,
    state,
    reasonCode,
    reasonText: safeShortText(source.reasonText, 120) || safeXhhReasonText(runtime, reasonCode),
    lastCheckAt: safeOptionalTime(source.lastCheckAt),
    lastSuccessAt: safeOptionalTime(source.lastSuccessAt),
    nextRetryAt: safeOptionalTime(source.nextRetryAt ?? serverNextAllowedAt),
    account,
    binding,
    destination,
    discovery,
    queue,
    polling,
    noticePending: source.noticePending === true,
    available,
    moduleError: available ? '' : dmText('DM_PROVIDER_UNAVAILABLE'),
    accountEpoch,
    sessionVersion,
    accountVersion: sessionVersion,
  };
  model.dm = {
    available: model.available,
    enabled: model.config.enabled,
    state: model.state,
    reasonCode: model.reasonCode,
    reasonText: model.reasonText,
    destination: model.destination,
    account: model.account,
    binding: model.binding,
    discovery: model.discovery,
    queue: model.queue,
    polling: model.polling,
    login: model.login,
    noticePending: model.noticePending,
    accountEpoch: model.accountEpoch,
    sessionVersion: model.sessionVersion,
    accountVersion: model.accountVersion,
  };
  return model;
}

function currentXhhStatus(runtime, settings) {
  let raw = null;
  try { raw = runtime.xhh?.getStatus?.() ?? null; } catch { raw = null; }
  const model = xhhStatusEnvelope(runtime, settings, raw);
  if (!runtime.xhh) {
    model.state = 'unavailable';
    model.moduleError = dmText('DM_PROVIDER_UNAVAILABLE');
  }
  return model;
}

function providerSummary(runtime, settings, providerId) {
  const provider = requireProvider(providerId);
  const cfg = settings.current();
  const capabilities = publicProviderCapabilities(provider);
  if (provider.id === 'xiaoheihe') {
    const status = currentXhhStatus(runtime, settings);
    return {
      id: provider.id,
      label: provider.label,
      enabled: status.config.enabled,
      status: status.state,
      statusText: status.config.enabled
        ? (DM_STATE_LABELS[status.state] || '不可用')
        : (status.available ? '未启用' : '不可用'),
      paused: status.polling.paused,
      accountEpoch: status.accountEpoch,
      sessionVersion: status.sessionVersion,
      accountVersion: status.accountVersion,
      login: status.login,
      capabilities: { ...capabilities, available: status.available && capabilities.available },
    };
  }
  const dm = buildDmStatus(runtime, settings);
  const enabled = cfg.biliDmEnabled === true;
  const state = dm.state === 'unavailable' && dm.moduleError ? 'error' : dm.state;
  return {
    id: provider.id,
    label: provider.label,
    enabled,
    status: state,
    statusText: enabled
      ? (DM_STATE_LABELS[state] || '不可用')
      : '未启用',
    accountEpoch: dm.accountEpoch,
    sessionVersion: dm.sessionVersion,
    accountVersion: dm.accountVersion,
    login: dm.login,
    capabilities: { ...capabilities, available: dm.available === true },
  };
}

function providerStatus(runtime, settings, providerId) {
  const provider = requireProvider(providerId);
  const cfg = settings.current();
  const capabilities = publicProviderCapabilities(provider);
  const migration = settings.configMigration();
  if (provider.id === 'xiaoheihe') {
    const status = currentXhhStatus(runtime, settings);
    return { ...status, migration };
  }
  const dm = buildDmStatus(runtime, settings);
  return {
    provider: { id: provider.id, label: provider.label, capabilities: { ...capabilities, available: dm.available } },
    config: {
      enabled: dm.enabled,
      pollSeconds: dm.pollSeconds,
      effectivePollSeconds: dm.polling.seconds,
      includeSystem: dm.includeSystem,
      defaultTarget: 'c2c',
    },
    login: dm.login,
    state: dm.state,
    reasonCode: dm.reasonCode,
    reasonText: dm.reasonText,
    lastCheckAt: dm.lastCheckAt,
    lastSuccessAt: dm.lastSuccessAt,
    nextRetryAt: dm.nextRetryAt,
    account: dm.account,
    binding: dm.binding,
    destination: dm.destination,
    discovery: dm.discovery,
    queue: dm.queue,
    polling: {
      requestBudget: dm.polling.requestBudget,
      minIntervalMs: 5000,
      windowLimit: 10,
      windowMs: 60000,
      cooldownLevel: 0,
      manualRecoveryRequired: false,
    },
    noticePending: dm.noticePending,
    available: dm.available,
    moduleError: dm.moduleError,
    accountEpoch: dm.accountEpoch,
    sessionVersion: dm.sessionVersion,
    accountVersion: dm.accountVersion,
    dm,
    migration,
  };
}

function dmStatusText(status, prefix) {
  const login = LOGIN_STATE_LABELS[status.login?.state] || '不可用';
  const listening = DM_STATE_LABELS[status.state] || '不可用';
  const binding = status.binding?.bound ? `已绑定 ${status.binding.mask}` : '未绑定';
  const destination = status.destination?.kind === 'group'
    ? `${status.destination.label}（自动通知唯一目标）` : '主人私聊';
  const lines = [
    `登录：${login}；监听：${listening}${status.reasonText ? `（${status.reasonText}）` : ''}`,
    `接收：${destination}；主人绑定：${binding}`,
    `待发送 ${status.queue?.unfinished || 0}；待核对 ${status.queue?.pending || 0}；未知 ${status.queue?.unknown || 0}`,
    `上次成功：${formatTime(status.lastSuccessAt)}；下次重试：${formatTime(status.nextRetryAt)}`,
  ];
  if (status.state === 'initializing') lines.push('正在建立历史基线，完成后才会监听新增私信；历史未读不会批量转发。');
  if (status.moduleError) lines.push(status.moduleError);
  lines.push(`下一步：${prefix}解析 私信 待发 / 领取；登录与状态也可在「解析管理」查看。`);
  return lines.join('\n');
}

function xhhStatusText(status) {
  const login = LOGIN_STATE_LABELS[status.login?.state] || '未开始';
  const listening = status.config.enabled
    ? (DM_STATE_LABELS[status.state] || '不可用') : '未启用';
  const binding = status.binding?.bound ? `已绑定 ${status.binding.mask}` : '未绑定';
  const lines = [
    '小黑盒：私信提醒',
    `登录：${login}；监听：${listening}${status.reasonText ? `（${status.reasonText}）` : ''}`,
    `接收：${status.destination?.kind === 'group' ? status.destination.label : '主人私聊'}；主人绑定：${binding}`,
    `待发送 ${status.queue?.unfinished || 0}；待核对 ${status.queue?.pending || 0}；未知 ${status.queue?.unknown || 0}`,
    `发现：${status.discovery?.phase || 'idle'}${status.discovery?.gap ? '；存在缺口' : ''}；上次成功：${formatTime(status.lastSuccessAt)}`,
    status.moduleError ? status.moduleError : '',
    '读取可能影响未读状态；完整分页与恢复待实测，不能据此宣称全部私信已同步。',
  ].filter(Boolean);
  return lines.join('\n');
}

function botKey(ctx) {
  return createHash('sha256').update(String(ctx.dataDir)).digest('hex').slice(0, 16);
}

export function isBotMessage(msg) {
  return Boolean(msg?.isBot || msg?.isSelf || msg?.self ||
    msg?.raw?.author?.bot || msg?.raw?.author?.is_bot || msg?.raw?.author?.is_you ||
    msg?.raw?.sender?.isBot);
}

function sessionKey(ctx, msg) {
  return `${botKey(ctx)}:${msg.kind}:${String(msg.chatId ?? msg.groupId ?? msg.userId ?? '')}`;
}

async function allowed(ctx, msg, cfg, manual) {
  if (!msg || isBotMessage(msg) || msg.claimedBy && msg.claimedBy !== 'media-parser') return false;
  if (!manual && (msg.isCommand || !cfg.enabled)) return false;
  if (!['group', 'c2c'].includes(msg.kind)) return false;
  if (msg.kind === 'c2c' && !cfg.privateEnabled) return false;
  if (msg.kind === 'group' && cfg.requireMention && !msg.mentioned && !manual) return false;
  if (typeof ctx.gate?.check === 'function' && (await ctx.gate.check(msg.chatId))?.ok === false) return false;
  if (msg.kind === 'group' && typeof ctx.getGroup === 'function') {
    const group = await ctx.getGroup(msg.groupId || msg.chatId);
    if (group?.enabled === false) return false;
  }
  // Roost itself applies whitelist, pause and cfg.plugins.groups before dispatch.
  // Do not invent a second per-group list in this plugin.
  return true;
}

function parsePayload(ctx, msg, links, taskId, cfg) {
  return {
    text: links.map((link) => link.url).join('\n'),
    userKey: sessionKey(ctx, msg), senderName: String(msg.userName ?? '').slice(0, 120),
    senderId: String(msg.userId ?? '').slice(0, 200), quoteFirstText: false,
    taskId, maxLinks: cfg.maxLinks,
  };
}

function makeRuntime(ctx, state, {
  engineFactory, delivery, dmModules = null,
  biliClientFactory = createBiliClient, biliLoginFactory = createBiliLogin,
  xhhRuntimeFactory = null, xhhSafeMessages: injectedXhhSafeMessages = null,
}) {
  const previous = state.runtime;
  let previousHandoff = Promise.resolve();
  if (previous) {
    try { previous.deactivate?.('插件热重载，旧代次任务已取消'); } catch { /* old shutdown is best effort */ }
    if (previous.handoff && typeof previous.handoff.then === 'function') {
      previousHandoff = Promise.resolve(previous.handoff).catch(() => {});
    }
  }
  const generation = (Number(state.generation) || 0) + 1;
  state.generation = generation;
  let runtimeRef = null;
  const settings = createSettings(ctx, {
    initialBarrier: previousHandoff,
    isActive: () => runtimeRef?.isActive?.() === true,
  });
  // A fresh facade per runtime generation. The policy's process-wide
  // coordinator still shares state, dispatch and coalesced work; closing this
  // instance drains only this generation and cannot close a successor.
  const requestPolicy = createPrivateMessageRequestPolicy({
    statePath: path.join(path.resolve(ctx.dataDir), 'private-message-request-state.json'),
  });
  const biliRequestScope = (context = {}) => {
    // The client supplies the candidate Cookie before manual-nav validation.
    // The policy must see that candidate, not the still-saved Cookie, or two
    // credential versions can coalesce into one request.
    const provided = typeof context?.cookie === 'string';
    let cookie = '';
    if (provided) cookie = context.cookie;
    else {
      try { cookie = settings.getBiliCookie(); } catch { cookie = ''; }
    }
    const uid = /(?:^|;\s*)DedeUserID=([1-9]\d{0,39})(?:;|$)/.exec(cookie)?.[1] ?? '';
    const fingerprint = cookie
      ? createHash('sha256').update(cookie).digest('hex').slice(0, 32)
      : '';
    // A restart-local revision counter is not a credential identity. Hash the
    // actual candidate Cookie so the policy sees the same credential after a
    // reload and a different version immediately after a manual Cookie change.
    const accountKey = uid
      ? `bilibili:uid:${uid}`
      : fingerprint
        ? `bilibili:credential:${fingerprint}`
        : `bilibili:anonymous:${botKey(ctx)}`;
    const credentialVersion = fingerprint
      ? `bilibili:${uid || 'credential'}:${fingerprint}`
      : 'bilibili:anonymous';
    const scope = {
      providerId: 'bilibili',
      accountKey,
      credentialVersion,
    };
    if (typeof context?.workflowId === 'string' && context.workflowId) {
      scope.workflowId = context.workflowId;
    }
    return scope;
  };
  const runtime = {
    generation, settings, active: true, engineEnabled: true, restartRequired: false,
    previews: new Map(), operations: new Map(), boundaries: null,
    prepareError: '', unavailableLogged: false,
    dm: null, dmStore: null, dmDelivery: null, biliLogin: null,
    dmLoadError: '', dmFatal: false, dmLoading: true, dmReady: null,
    dmGroups: null, cookieUnsubscribe: null, requestPolicy,
    xhh: null, xhhReady: null, xhhLoadError: '', xhhLoading: true,
    xhhSafeMessages: injectedXhhSafeMessages || null,
    handoff: null, shutdown: null,
    isActive: () => runtime.active && state.runtime === runtime && state.generation === generation,
    engineReady: () => {
      const status = engineStatus(runtime.engine);
      return runtime.isActive() && runtime.engineEnabled &&
        (status.ready === true || status.state === 'ready' || status.phase === 'ready');
    },
    refresh: () => {
      if (!runtime.isActive()) return;
      const stats = runtime.queue.snapshot();
      const status = engineStatus(runtime.engine);
      ctx.setDashboard?.({
        metrics: [
          { label: '引擎', value: status.state ?? status.phase ?? (status.ready ? 'ready' : 'unknown') },
          { label: '运行任务', value: stats.running, unit: '个' },
          { label: '等待任务', value: stats.waiting, unit: '个' },
          { label: '完成', value: stats.totals.completed ?? 0, unit: '次' },
          { label: '失败', value: stats.totals.failed ?? 0, unit: '次' },
          { label: '跳过', value: stats.totals.skipped ?? 0, unit: '次' },
          { label: '媒体发送', value: Object.entries(stats.totals.sent).filter(([type]) => type !== 'text').reduce((sum, [, count]) => sum + count, 0), unit: '项' },
          { label: '缓存', value: Number(status.cacheBytes ?? status.cache?.bytes ?? 0) / 1024 / 1024, unit: 'MiB' },
        ],
        note: settings.sanitize(runtime.prepareError || '普通群聊及 C2C；默认解析不调用模型。查看「解析管理」了解中间件与 DSH 外接边界。'),
      });
    },
    publicStatus: () => settings.sanitize({
      version: VERSION, generation, active: runtime.isActive(),
      engine: engineStatus(runtime.engine), ready: runtime.engineReady(),
      queue: runtime.queue.snapshot(), platformCount: settings.platforms().length,
      prepareError: runtime.prepareError, restartRequired: runtime.restartRequired,
      operations: [...runtime.operations.values()].slice(-20), boundaries: runtime.boundaries,
    }),
    deactivate(reason) {
      if (!runtime.active) return runtime.shutdown ?? runtime.handoff ?? Promise.resolve();
      runtime.active = false;
      runtime.queue.cancelAll(reason);
      try { runtime.cookieUnsubscribe?.(); } catch { /* cookie subscription cleanup is best effort */ }
      runtime.cookieUnsubscribe = null;
      try { runtime.dm?.deactivate?.(); } catch { /* DM shutdown is best effort */ }
      try { runtime.biliLogin?.deactivate?.(); } catch { /* login shutdown is best effort */ }
      // Abort native Xiaoheihe work immediately, before any queued module
      // initialization can write late. xhhReady may still be pending; the
      // handoff below waits for that settlement and then flushes only when the
      // factory actually produced a runtime.
      try { runtime.xhh?.deactivate?.(); } catch { /* xhh shutdown is best effort */ }
      // The new generation waits for the storage write tail and for the shared
      // policy instance's own drain/commit tail. It does not close the shared
      // policy here: the successor may still need to join a coalesced request.
      const policyDrain = typeof requestPolicy.drain === 'function'
        ? Promise.resolve().then(() => requestPolicy.drain())
        : typeof requestPolicy.close === 'function'
          ? Promise.resolve().then(() => requestPolicy.close())
          : typeof requestPolicy.flush === 'function'
            ? Promise.resolve().then(() => requestPolicy.flush())
            : Promise.resolve();
      const xhhDrain = Promise.resolve(runtime.xhhReady).catch(() => {}).then(() => {
        try { runtime.xhh?.deactivate?.(); } catch { /* already aborted */ }
        return runtime.xhh?.flush ? Promise.resolve(runtime.xhh.flush()) : undefined;
      });
      runtime.handoff = Promise.allSettled([
        Promise.resolve().then(() => settings.flush()),
        runtime.dmStore?.flush ? Promise.resolve().then(() => runtime.dmStore.flush()) : Promise.resolve(),
        policyDrain,
        xhhDrain,
      ]).then(() => {});
      runtime.handoff.catch(() => {});
      runtime.shutdown = Promise.allSettled([runtime.handoff, runtime.queue.flush()]).then(() => {});
      runtime.shutdown.catch(() => {});
      return runtime.shutdown;
    },
  };
  state.runtime = runtime;
  runtimeRef = runtime;
  runtime.dmGroups = createBiliDmGroupCatalog({
    ctx,
    store: { binding: () => runtime.dmStore?.binding?.() ?? {} },
    isActive: runtime.isActive,
  });
  if (typeof settings.subscribeBiliCookie === 'function') {
    runtime.cookieUnsubscribe = settings.subscribeBiliCookie(() => {
      if (!runtime.isActive()) return undefined;
      runtime.restartRequired = true;
      runtime.refresh();
      try {
        return requestPolicy.recordCredentialChange?.(biliRequestScope());
      } catch {
        // Policy persistence failures stay visible in local status.
        return undefined;
      }
    });
  }
  // The authority is state.runtime, but the engine host must belong to the
  // current module generation. Roost imports each reload from a new snapshot
  // and removes the previous snapshot; reusing an old host leaves its
  // PLUGIN_DIR pointing at deleted engine.tar.gz and service files. The host
  // still shares ctx.state.mediaParserEngine, so it can adopt the running
  // authenticated Python service without restarting it.
  state.engineHost = engineFactory({
    ctx,
    config: () => state.runtime?.settings.current() ?? readConfig(ctx),
  });
  runtime.engine = state.engineHost;
  const storage = state.storage ??= ctx.storage;
  runtime.queue = createTaskQueue({
    ctx: { storage }, repository: state.taskRepository ??= {},
    config: () => settings.current(), sanitize: settings.sanitize, onChange: () => runtime.refresh(),
  });
  runtime.ready = Promise.all([settings.ready, runtime.queue.ready]).then(() => runtime).catch((error) => {
    runtime.prepareError = settings.sanitize(error?.message || '插件配置读取失败');
    runtime.refresh();
    throw new Error(runtime.prepareError);
  });
  runtime.requireDm = () => {
    if (runtime.dmLoadError) throw dmFailure(runtime.dmLoadError);
    if (!runtime.dm) throw dmFailure('DM_MODULE_UNAVAILABLE');
    return runtime.dm;
  };
  runtime.safeDmStatus = () => buildDmStatus(runtime, settings);
  runtime.dmErrorText = (error) => dmErrorText(error, runtime);
  runtime.applyDmConfig = () => {
    try {
      if (runtime.dm && !runtime.dmFatal) runtime.dm.configChanged?.();
    } catch { /* configuration changes are reflected by the DM status */ }
  };
  runtime.providerList = () => PRIVATE_MESSAGE_PROVIDER_IDS.map((id) => providerSummary(runtime, settings, id));
  runtime.providerStatus = async (providerId) => {
    const base = providerStatus(runtime, settings, providerId);
    if (providerId !== 'bilibili') return base;
    let policyStatus = null;
    try {
      policyStatus = await requestPolicy.status({
        ...biliRequestScope(),
        pollSeconds: base.config.pollSeconds,
      });
    } catch {
      base.polling = {
        ...base.polling,
        paused: true,
        pauseReason: 'REQUEST_POLICY_UNAVAILABLE',
        manualRecoveryRequired: true,
      };
      base.reasonCode = base.reasonCode || 'DM_PAUSED';
      base.reasonText = base.reasonText || '请求调度状态不可用，请管理员检查数据目录。';
      base.paused = true;
      base.dm.polling = { ...base.polling };
      base.dm.paused = true;
      return base;
    }
    const effective = Number(policyStatus?.effectiveIntervalSeconds);
    if (Number.isFinite(effective) && effective > 0) {
      base.config.effectivePollSeconds = Math.floor(effective);
    }
    base.polling = {
      ...base.polling,
      paused: policyStatus?.paused === true,
      pauseReason: policyStatus?.pauseReason || null,
      cooldownReason: policyStatus?.cooldownReason || null,
      cooldownScope: policyStatus?.cooldownScope || null,
      cooldownLevel: Number(policyStatus?.adaptiveMultiplier) || 1,
      manualRecoveryRequired: policyStatus?.requiresManualRecovery === true,
      recoveryProbePending: policyStatus?.recoveryProbePending === true,
      recoveryProbeExpiresAt: policyStatus?.recoveryProbeExpiresAt ?? null,
      serverNextAllowedAt: policyStatus?.serverNextAllowedAt ?? null,
      effectiveIntervalSeconds: base.config.effectivePollSeconds,
      budget: policyStatus?.budget ?? null,
      lastRequestAt: policyStatus?.lastRequestAt ?? null,
    };
    base.accountEpoch = base.dm.accountEpoch;
    base.sessionVersion = base.dm.sessionVersion;
    base.accountVersion = base.dm.accountVersion;
    base.dm.accountEpoch = base.accountEpoch;
    base.dm.sessionVersion = base.sessionVersion;
    base.dm.accountVersion = base.accountVersion;
    if (Number.isFinite(policyStatus?.nextAllowedAt)) {
      base.nextRetryAt = Math.max(Number(base.nextRetryAt) || 0, policyStatus.nextAllowedAt);
    }
    base.dm.polling = { ...base.polling };
    base.dm.nextRetryAt = base.nextRetryAt;
    base.dm.lastSuccessAt = base.lastSuccessAt;
    return base;
  };
  runtime.requireProvider = (providerId) => requireProvider(providerId);
  runtime.requireVerifiedProvider = (providerId) => {
    const provider = requireProvider(providerId);
    if (!provider.capabilities.supportsPrivateMessages) {
      throw providerFailure('DM_PROVIDER_UNVERIFIED');
    }
    // Both providers now expose a verified private-message capability; the
    // established requirement stays in force for Bilibili and Xiaoheihe alike.
    if (!provider.capabilities.verified) {
      throw providerFailure('DM_PROVIDER_UNVERIFIED');
    }
    return provider;
  };
  runtime.requireXhh = () => {
    if (!runtime.xhh) throw providerFailure('DM_PROVIDER_UNAVAILABLE');
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return runtime.xhh;
  };
  runtime.xhhResultStatus = (value) => {
    const source = value && typeof value === 'object' ? value : null;
    const looksLikeStatus = source
      && (source.config || source.login || source.provider || source.state || source.queue);
    const raw = looksLikeStatus ? source
      : source?.dm && typeof source.dm === 'object' ? source.dm
        : source?.status;
    return xhhStatusEnvelope(runtime, settings, raw ?? null);
  };
  runtime.providerSaveConfig = async (providerId, body) => {
    const provider = runtime.requireProvider(providerId);
    const source = body && typeof body === 'object' && body.config && typeof body.config === 'object'
      ? body.config : (body && typeof body === 'object' ? body : {});
    if (provider.id === 'xiaoheihe') {
      const unsupported = Object.keys(source).filter((key) => !['enabled', 'pollSeconds'].includes(key));
      if (unsupported.length) throw providerFailure('DM_CONFIG');
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(source, 'enabled')) {
        if (typeof source.enabled !== 'boolean') throw providerFailure('DM_CONFIG');
        patch.xiaoheiheDmEnabled = source.enabled;
      }
      if (Object.prototype.hasOwnProperty.call(source, 'pollSeconds')) {
        patch.xiaoheiheDmPollSeconds = source.pollSeconds;
      }
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      if (runtime.xhh && typeof runtime.xhh.saveConfig === 'function') {
        // The B runtime owns the flat config contract and persists the shared
        // host settings itself, including the target fields. Never wrap it as
        // { config: ... }: that shape would silently save nothing.
        const flat = {};
        if (Object.prototype.hasOwnProperty.call(source, 'enabled')) flat.enabled = source.enabled;
        if (Object.prototype.hasOwnProperty.call(source, 'pollSeconds')) flat.pollSeconds = source.pollSeconds;
        if (Object.keys(flat).length) await runtime.xhh.saveConfig(flat);
        let state = '';
        try { state = String(runtime.xhh.getStatus?.()?.state ?? ''); } catch { state = ''; }
        if (source.enabled === true && typeof runtime.xhh.start === 'function') {
          // A runtime that already auto-started from its persisted config stays
          // running; only an explicitly disabled/unavailable instance is started.
          if (!state || state === 'disabled' || state === 'unavailable') runtime.xhh.start();
        } else if (source.enabled === false && typeof runtime.xhh.pause === 'function') {
          runtime.xhh.pause('XHH_DISABLED');
        }
      } else if (source.enabled === true) {
        runtime.requireXhh();
      } else if (Object.keys(patch).length) {
        await settings.saveConfig(patch, { guard: () => runtime.isActive() });
      }
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      return { ok: true, dm: await runtime.providerStatus(provider.id) };
    }
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(source, 'enabled')) patch.biliDmEnabled = source.enabled;
    if (Object.prototype.hasOwnProperty.call(source, 'pollSeconds')) patch.biliDmPollSeconds = source.pollSeconds;
    if (Object.prototype.hasOwnProperty.call(source, 'includeSystem')) patch.biliDmIncludeSystem = source.includeSystem;
    const saved = await runtime.dmSaveConfig(patch);
    return { ...saved, dm: await runtime.providerStatus(provider.id) };
  };
  runtime.providerLoginStatus = async (providerId, includePng = false) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      let status = { state: 'unavailable' };
      if (runtime.xhh && typeof runtime.xhh.loginStatus === 'function') {
        // The dedicated authenticated login GET is the only refresh path that
        // may reopen the current QR. Ordinary status routes still pass false.
        status = await runtime.xhh.loginStatus(includePng === true);
      }
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      const login = status?.login ?? status;
      return xhhLoginSafe(runtime, login, includePng === true, login?.sessionVersion ?? status?.sessionVersion);
    }
    runtime.requireVerifiedProvider(providerId);
    return runtime.dmLoginStatus(includePng);
  };
  runtime.providerLoginStart = async (providerId) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      const xhh = runtime.requireXhh();
      const result = await xhh.loginStart();
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      const login = result?.login ?? result;
      return xhhLoginSafe(runtime, login, true, login?.sessionVersion ?? result?.sessionVersion);
    }
    runtime.requireVerifiedProvider(providerId);
    return runtime.dmLoginStart();
  };
  runtime.providerLoginCancel = async (providerId) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      const xhh = runtime.requireXhh();
      const result = await xhh.loginCancel();
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      const login = result?.login ?? result;
      return xhhLoginSafe(runtime, login, false, login?.sessionVersion ?? result?.sessionVersion);
    }
    runtime.requireVerifiedProvider(providerId);
    return runtime.dmLoginCancel();
  };
  runtime.providerLoginInspect = async (providerId) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      const xhh = runtime.requireXhh();
      const result = await xhh.loginInspect();
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      const login = result?.login ?? result;
      return xhhLoginSafe(runtime, login, false, login?.sessionVersion ?? result?.sessionVersion);
    }
    runtime.requireVerifiedProvider(providerId);
    return runtime.dmLoginInspect();
  };
  runtime.providerLoginManual = async (providerId, body) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      const xhh = runtime.requireXhh();
      const cookie = typeof body?.cookie === 'string' ? body.cookie.trim() : '';
      if (!cookie || cookie.length > 8192 || /[\0\r\n]/.test(cookie)) {
        const error = new Error('Cookie 格式不合法');
        error.code = 'XHH_AUTH';
        throw error;
      }
      const result = await xhh.loginManual({ cookie });
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      const login = result?.login ?? result;
      return {
        ok: result?.ok === true,
        ...xhhLoginSafe(runtime, login, false, login?.sessionVersion ?? result?.sessionVersion),
      };
    }
    runtime.requireVerifiedProvider(providerId);
    return runtime.dmLoginManual(body);
  };
  runtime.providerLoginLogout = async (providerId) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      const xhh = runtime.requireXhh();
      const result = await xhh.loginLogout();
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      const state = result?.login?.state ?? result?.state;
      // The A logout tombstone keeps a monotonic numeric Xhh session version so
      // the page's local ordering survives reload. Read only that dedicated
      // partition; never fall back to the Bili version.
      let stored = {};
      try { stored = settings.getPrivateMessageProviderCredentials('xiaoheihe') || {}; } catch { stored = {}; }
      const logoutEpoch = typeof stored.accountEpoch === 'string'
        && /^[0-9a-f-]{8,64}$/i.test(stored.accountEpoch) ? stored.accountEpoch : null;
      return {
        ok: result?.ok !== false,
        state: SAFE_LOGIN_STATES.has(state) ? state : 'idle',
        sessionVersion: safeVersion(result?.login?.sessionVersion ?? stored.sessionVersion),
        accountEpoch: logoutEpoch,
        warning: '已清除本插件保存的小黑盒登录；不会影响其他客户端。',
      };
    }
    runtime.requireVerifiedProvider(providerId);
    return runtime.dmLoginLogout();
  };
  runtime.providerGroupOptions = async (providerId) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      const xhh = runtime.requireXhh();
      const result = await xhh.groups();
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      return result;
    }
    runtime.requireVerifiedProvider(providerId);
    return runtime.dmGroupOptions();
  };
  runtime.providerSetTarget = async (providerId, body) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      const xhh = runtime.requireXhh();
      const source = body && typeof body === 'object' ? body : {};
      const sendToGroup = source.sendToGroup === true || source.targetKind === 'group' || source.kind === 'group';
      const result = await xhh.setTarget({
        targetKind: sendToGroup ? 'group' : 'c2c',
        groupId: sendToGroup ? String(source.groupId ?? source.target ?? '') : '',
      });
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      return result;
    }
    runtime.requireVerifiedProvider(providerId);
    return runtime.dmSetTarget(body);
  };
  runtime.providerCheck = async (providerId) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      const xhh = runtime.requireXhh();
      const result = await xhh.check();
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      return runtime.xhhResultStatus(result);
    }
    runtime.requireVerifiedProvider(providerId);
    return runtime.dmCheck();
  };
  runtime.providerSendTest = async (providerId, msg) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      const xhh = runtime.requireXhh();
      const result = await xhh.sendTest();
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      return { ok: result?.ok !== false, sent: safeCount(result?.sent), dm: runtime.xhhResultStatus(result) };
    }
    runtime.requireVerifiedProvider(providerId);
    return runtime.dmSendTest(msg);
  };
  const clearManualRecovery = async () => {
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    if (typeof requestPolicy.clearManualRecovery !== 'function') {
      throw providerFailure('DM_PROVIDER_UNAVAILABLE');
    }
    const result = await requestPolicy.clearManualRecovery(biliRequestScope());
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return result;
  };
  runtime.providerClearManualRecovery = async (providerId) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id === 'xiaoheihe') {
      const xhh = runtime.requireXhh();
      const result = await xhh.clearRecovery();
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      return {
        ok: result?.ok !== false,
        cleared: result?.result?.cleared === true || result?.cleared === true
          || (result?.ok === true && result?.result === undefined),
        dm: await runtime.providerStatus(provider.id),
      };
    }
    runtime.requireVerifiedProvider(providerId);
    const result = await clearManualRecovery();
    return {
      ok: true,
      cleared: result?.cleared === true,
      dm: await runtime.providerStatus(providerId),
    };
  };
  runtime.providerAcceptance = async (providerId, options = {}) => {
    const provider = runtime.requireProvider(providerId);
    if (provider.id !== 'xiaoheihe') {
      throw providerFailure('DM_ACCEPTANCE_UNSUPPORTED');
    }
    const limit = parseAcceptanceLimit(options.query ?? options);
    const xhh = runtime.requireXhh();
    if (typeof xhh.acceptance !== 'function') {
      throw providerFailure('DM_PROVIDER_UNAVAILABLE');
    }
    const value = await xhh.acceptance({ limit });
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return safeAcceptanceSnapshot(runtime, value, limit);
  };
  runtime.dmClearManualRecovery = async () => {
    runtime.requireDm();
    const result = await clearManualRecovery();
    return { ok: true, cleared: result?.cleared === true };
  };
  runtime.verifyDmEnable = async () => {
    if (!runtime.biliLogin) return { ok: false, text: '登录模块暂时不可用，请稍后重试。' };
    let inspected;
    try { inspected = await runtime.biliLogin.inspect(); } catch {
      return { ok: false, text: '暂时无法确认 B 站登录，请稍后重试。' };
    }
    if (inspected?.state === 'missing') {
      return { ok: false, text: `尚未登录 B 站，请先使用 ${ctx.prefix || '/'}解析 私信 登录。` };
    }
    if (inspected?.state === 'invalid') {
      return { ok: false, text: 'B 站登录已失效，请重新登录。' };
    }
    if (inspected?.state !== 'valid') {
      return { ok: false, text: '暂时无法确认 B 站登录，请稍后重试。' };
    }
    if (!runtime.dmStore) return { ok: false, text: '私信模块尚未就绪，请稍后重试。' };
    let binding;
    try { binding = runtime.dmStore.binding(); } catch { return { ok: false, text: '私信绑定状态读取失败。' }; }
    if (!binding?.target) {
      return { ok: false, text: `尚未绑定接收私聊，请先使用 ${ctx.prefix || '/'}解析 私信 绑定。` };
    }
    return { ok: true };
  };
  runtime.dmSaveConfig = async (body) => {
    const source = body && typeof body === 'object' && body.config && typeof body.config === 'object'
      ? body.config : (body && typeof body === 'object' ? body : {});
    const patch = {};
    for (const key of DM_CONFIG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) patch[key] = source[key];
    }
    if (!Object.keys(patch).length) throw dmFailure('DM_CONFIG');
    // The legacy /bili/dm/config route remains Bilibili-only. Xiaoheihe
    // settings are handled by the unified provider route and host config.
    if (Object.prototype.hasOwnProperty.call(patch, 'xiaoheiheDmEnabled')
      || Object.prototype.hasOwnProperty.call(patch, 'xiaoheiheDmPollSeconds')) {
      throw dmFailure('DM_CONFIG');
    }
    if (patch.biliDmEnabled === true) {
      runtime.requireDm();
      const check = await runtime.verifyDmEnable();
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      if (!check.ok) {
        const error = new Error(check.text);
        error.code = 'DM_BINDING_REQUIRED';
        throw error;
      }
    }
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const config = await settings.saveConfig(patch, { guard: () => runtime.isActive() });
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    runtime.applyDmConfig();
    return {
      ok: true,
      config: {
        biliDmEnabled: config.biliDmEnabled,
        biliDmPollSeconds: config.biliDmPollSeconds,
        biliDmIncludeSystem: config.biliDmIncludeSystem,
      },
    };
  };
  runtime.dmGroupOptions = async () => {
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const result = await runtime.dmGroups.list();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return result;
  };
  runtime.dmSetTarget = async (body) => {
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const source = body && typeof body === 'object' ? body : {};
    if (typeof source.sendToGroup !== 'boolean') throw dmFailure('DM_CONFIG');
    const sendToGroup = source.sendToGroup;
    let groupId = '';
    let group = null;
    if (sendToGroup) {
      if (typeof source.groupId !== 'string') throw dmFailure('DM_GROUP_INVALID');
      group = await runtime.dmGroups.resolve(source.groupId);
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      if (!group) throw dmFailure('DM_GROUP_INVALID');
      groupId = group.id;
    }
    let binding;
    try { binding = runtime.dmStore?.binding?.(); } catch { throw dmFailure('DM_STATE_CORRUPT'); }
    if (!binding?.target) throw dmFailure('DM_BINDING_REQUIRED');
    if (typeof ctx.isOwner !== 'function') throw dmFailure('DM_OWNER_REQUIRED');
    let owner = false;
    try { owner = await ctx.isOwner(binding.target) === true; } catch { owner = false; }
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    if (!owner) throw dmFailure('DM_OWNER_REQUIRED');
    if (!runtime.dmDelivery || typeof runtime.dmDelivery.configureTarget !== 'function') {
      throw dmFailure('DM_GROUP_UNAVAILABLE');
    }
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const target = sendToGroup ? { kind: 'group', target: groupId } : { kind: 'c2c', target: '' };
    await runtime.dmDelivery.configureTarget(target, { guard: () => runtime.isActive() });
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return { ok: true, selected: { sendToGroup, groupId } };
  };
  runtime.dmCheck = async () => {
    runtime.requireDm();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    await runtime.dm.check();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return runtime.safeDmStatus();
  };
  runtime.dmSendTest = async (msg) => {
    runtime.requireDm();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    let binding;
    try { binding = runtime.dmStore.binding(); } catch { throw dmFailure('DM_STATE_CORRUPT'); }
    if (!binding?.target) throw dmFailure('DM_BINDING_REQUIRED');
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const result = await runtime.dmDelivery.sendTest(msg ?? undefined, { guard: () => runtime.isActive() });
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return { ok: true, sent: Math.max(0, Number(result?.sent) || 0) };
  };
  runtime.dmLoginStatus = (includePng = false) => loginSafe(
    runtime.biliLogin?.status?.() ?? { state: 'unavailable' }, includePng,
    sessionVersionOf(settings),
  );
  runtime.dmLoginStart = async () => {
    if (!runtime.biliLogin) throw dmFailure('DM_MODULE_UNAVAILABLE');
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const result = await runtime.biliLogin.start();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return loginSafe(result, true, sessionVersionOf(settings));
  };
  runtime.dmLoginCancel = async () => {
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const version = sessionVersionOf(settings);
    if (!runtime.biliLogin) return loginSafe({ state: 'unavailable' }, false, version);
    return loginSafe(runtime.biliLogin.cancel(), false, version);
  };
  runtime.dmLoginInspect = async () => {
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const version = sessionVersionOf(settings);
    if (!runtime.biliLogin) return loginSafe({ state: 'unavailable' }, false, version);
    let result;
    try { result = await runtime.biliLogin.inspect(); } catch { return loginSafe({ state: 'error', errorCode: 'BILI_RESPONSE' }, false, version); }
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return loginSafe(result, false, version);
  };
  runtime.dmLoginManual = async (body) => {
    if (!runtime.biliLogin) throw dmFailure('DM_MODULE_UNAVAILABLE');
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    const cookie = typeof body?.cookie === 'string' ? body.cookie.trim() : '';
    if (!cookie || cookie.length > 8192 || /[\0\r\n]/.test(cookie)) {
      const error = new Error('Cookie 格式不合法');
      error.code = 'BILI_AUTH';
      throw error;
    }
    const result = await runtime.biliLogin.manual(cookie);
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    return {
      ok: result?.ok === true,
      ...loginSafe(result, false, sessionVersionOf(settings)),
    };
  };
  runtime.dmLoginLogout = async () => {
    if (!runtime.biliLogin) throw dmFailure('DM_MODULE_UNAVAILABLE');
    try { runtime.dm?.pause?.(); } catch { /* pause is retried by the config save */ }
    try { runtime.biliLogin.cancel?.(); } catch { /* logout clears the session */ }
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    if (settings.current().biliDmEnabled) {
      try {
        await settings.saveConfig({ biliDmEnabled: false }, { guard: () => runtime.isActive() });
      } catch (error) {
        throw dmFailure(dmErrorCode(error) === 'DM_STALE' ? 'DM_STALE' : 'DM_CONFIG');
      }
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
    }
    runtime.applyDmConfig();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    let bindingTarget = '';
    try { bindingTarget = String(runtime.dmStore?.binding?.()?.target || ''); } catch { bindingTarget = ''; }
    if (bindingTarget && typeof ctx.isOwner === 'function') {
      let owner = false;
      try { owner = await ctx.isOwner(bindingTarget) === true; } catch { owner = false; }
      if (!runtime.isActive()) throw dmFailure('DM_STALE');
      if (!owner) throw dmFailure('DM_OWNER_REQUIRED');
    }
    const result = await runtime.biliLogin.logout();
    if (!runtime.isActive()) throw dmFailure('DM_STALE');
    if (result?.ok !== true) {
      const code = String(result?.errorCode || 'BILI_COOKIE');
      const error = new Error('共享登录清除失败');
      error.code = code;
      throw error;
    }
    return {
      ok: true,
      state: SAFE_LOGIN_STATES.has(result?.state) ? result.state : 'idle',
      sessionVersion: sessionVersionOf(settings),
      warning: '已清除本插件共享的 B 站登录，并暂停私信提醒；使用同一 Cookie 的增强解析也会受影响。不会注销 B 站其他设备。',
    };
  };
  const sendQrImage = async (msg, pngDataUrl) => {
    const prefix = 'data:image/png;base64,';
    if (typeof pngDataUrl !== 'string' || !pngDataUrl.startsWith(prefix)) return false;
    const buffer = Buffer.from(pngDataUrl.slice(prefix.length), 'base64');
    if (!buffer.length) return false;
    if (typeof msg?.replyImageBuffer === 'function') {
      await msg.replyImageBuffer(buffer);
      return true;
    }
    if (typeof msg?.replyImage === 'function') {
      await msg.replyImage(pngDataUrl);
      return true;
    }
    return false;
  };
  runtime.dmCommand = async (msg, args) => {
    const prefix = ctx.prefix || '/';
    let sub = String(Array.isArray(args) ? args[0] ?? '' : '').trim();
    let rest = Array.isArray(args) ? args.slice(1) : [];
    const help = () => [
      '平台接入与私信提醒（仅机器人主人 QQ 私聊）',
      `${prefix}解析 私信 平台 查看可用平台与服务状态`,
      `${prefix}解析 私信 B站 绑定｜登录｜状态｜开｜关｜检查｜测试｜恢复｜待发｜领取｜查看 <编号> [页码]｜退出登录`,
      `${prefix}解析 私信 小黑盒 登录｜状态｜检查｜开｜关｜测试｜待发｜领取｜查看 <编号> [页码]｜退出登录`,
      '首次启用会建立历史基线，不会批量转发旧未读；主动私聊受限时可使用「领取」。',
      '小黑盒读取可能影响未读状态；完整分页与恢复待实测，不能据此宣称全部私信已同步。',
    ].join('\n');
    const reply = (text) => runtime.isActive() ? msg?.reply?.(text) : undefined;
    const stillOwner = async () => {
      if (!runtime.isActive()) return false;
      let owner = false;
      try { owner = await ctx.isOwner?.(String(msg.userId ?? '')) === true; } catch { owner = false; }
      return owner && runtime.isActive();
    };
    if (!runtime.isActive()) return undefined;
    if (msg?.kind !== 'c2c') {
      return reply('平台接入与私信提醒操作请移到机器人主人 QQ 私聊中使用。');
    }
    const nativeUserId = String(msg.userId ?? '');
    const chatId = msg.chatId === undefined || msg.chatId === null ? nativeUserId : String(msg.chatId);
    if (!nativeUserId || chatId !== nativeUserId) {
      return reply('私信提醒只接受机器人主人的普通 QQ 私聊，当前会话不可用。');
    }
    if (typeof ctx.isOwner !== 'function') {
      return reply('当前宿主未提供主人校验，私信提醒命令已拒绝。');
    }
    let owner = false;
    try { owner = await ctx.isOwner(nativeUserId) === true; } catch { owner = false; }
    if (!runtime.isActive()) return undefined;
    if (!owner) return reply('仅机器人主人可在 QQ 私聊中使用私信提醒命令。');
    if (!sub || ['帮助', 'help', '用法'].includes(sub)) return reply(help());
    if (sub === '平台') {
      return reply(runtime.providerList()
        .map((provider) => `${provider.label}：${provider.statusText}`)
        .join('\n'));
    }
    const requestedProvider = resolvePrivateMessageProvider(sub);
    if (requestedProvider) {
      sub = String(rest[0] ?? '状态').trim();
      rest = rest.slice(1);
      if (requestedProvider.id !== 'xiaoheihe') sub = sub === '平台状态' ? '状态' : sub;
    }
    try {
      if (requestedProvider?.id === 'xiaoheihe') {
        if (!sub || ['帮助', 'help', '用法'].includes(sub)) {
          return reply([
            '小黑盒私信提醒（默认关闭）',
            `${prefix}解析 私信 小黑盒 登录｜状态｜检查｜开｜关｜测试｜待发｜领取｜查看 <编号> [页码]｜退出登录`,
            `未绑定接收目标时请先发送 ${prefix}解析 私信 绑定；命令仍只在机器人主人普通 QQ 私聊中可用。`,
            '读取可能影响未读状态；完整分页与恢复待实测，不能据此宣称全部私信已同步。',
          ].join('\n'));
        }
        if (sub === '状态') {
          const status = await runtime.providerStatus('xiaoheihe');
          if (!(await stillOwner())) return undefined;
          return reply(xhhStatusText(status));
        }
        if (sub === '登录') {
          const status = await runtime.providerLoginStart('xiaoheihe');
          if (!runtime.isActive()) return undefined;
          if (!(await stillOwner())) return undefined;
          if (status.pngDataUrl && await sendQrImage(msg, status.pngDataUrl)) {
            if (!runtime.isActive()) return undefined;
            return reply('请使用小黑盒手机客户端扫码并确认。二维码只在本次认证登录中出现；不会在群聊或公开状态中输出。');
          }
          if (['starting', 'waiting', 'scanned'].includes(status.state)) {
            return reply('小黑盒登录二维码正在生成或等待扫码确认，请稍后发送 状态 查看。');
          }
          return reply(`小黑盒登录未能开始：${status.errorSummary || dmText(status.errorCode || 'DM_PROVIDER_UNAVAILABLE')}`);
        }
        if (sub === '开' || sub === '关') {
          const enabled = sub === '开';
          const saved = await runtime.providerSaveConfig('xiaoheihe', { config: { enabled } });
          if (!runtime.isActive()) return undefined;
          if (!(await stillOwner())) return undefined;
          return reply(enabled
            ? '已按你的显式选择启用小黑盒私信提醒。首次启用建立历史窗口基线，历史未读不会批量转发；读取可能影响未读状态，完整分页与恢复待实测。'
            : '已暂停小黑盒私信抓取和自动投递；登录、绑定与进度保留。');
        }
        if (sub === '检查') {
          const status = await runtime.providerCheck('xiaoheihe');
          if (!runtime.isActive()) return undefined;
          if (!(await stillOwner())) return undefined;
          return reply(xhhStatusText(status));
        }
        if (sub === '测试') {
          const result = await runtime.providerSendTest('xiaoheihe');
          if (!runtime.isActive()) return undefined;
          if (!(await stillOwner())) return undefined;
          return reply(result.sent > 0
            ? '已向当前绑定目标发送带明确标记的小黑盒测试通知。'
            : '测试通知未确认送达，请查看验收记录并确认绑定与主人权限。');
        }
        if (sub === '待发') {
          const xhh = runtime.requireXhh();
          const summary = await xhh.pendingSummary();
          if (!runtime.isActive()) return undefined;
          if (!(await stillOwner())) return undefined;
          const pending = safeCount(summary?.pending ?? summary?.unfinished);
          const unknown = safeCount(summary?.unknown);
          return reply(`小黑盒待发送：${pending}；待核对：${unknown}。发送 ${prefix}解析 私信 领取 可主动领取。`);
        }
        if (sub === '领取') {
          const xhh = runtime.requireXhh();
          const result = await xhh.claim(msg);
          if (!runtime.isActive()) return undefined;
          if (result?.handled === true || Number(result?.sent) > 0) return undefined;
          if (!(await stillOwner())) return undefined;
          return reply(`暂无可领取内容或本次额度不足；稍后可再次发送 ${prefix}解析 私信 领取。`);
        }
        if (sub === '查看') {
          const xhh = runtime.requireXhh();
          const shortId = String(rest[0] || '').trim();
          if (!shortId) return reply(`用法：${prefix}解析 私信 小黑盒 查看 <编号> [页码]`);
          const pageNumber = Number(rest[1]);
          const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : undefined;
          const result = await xhh.view(msg, { shortId, page });
          if (!runtime.isActive()) return undefined;
          if (result?.handled === true) return undefined;
          if (!(await stillOwner())) return undefined;
          if (result?.ok === true && Number(result?.sent) > 0) return undefined;
          return reply(result?.ok
            ? `没有可重复查看的内容；编号：${shortId}。`
            : '未找到保留期内的该编号，或它不属于当前账号。');
        }
        if (['退出登录', '退出', 'logout'].includes(sub)) {
          const xhh = runtime.requireXhh();
          const result = await xhh.loginLogout();
          if (!runtime.isActive()) return undefined;
          try {
            await settings.saveConfig({ xiaoheiheDmEnabled: false }, { guard: () => runtime.isActive() });
          } catch { /* credential removal remains authoritative if config save fails */ }
          try { xhh.pause?.('XHH_DISABLED'); } catch { /* logout already invalidated work */ }
          if (!runtime.isActive()) return undefined;
          if (!(await stillOwner())) return undefined;
          return reply(result?.warning || '已清除本插件保存的小黑盒登录并暂停提醒；不会影响其他客户端。');
        }
        return reply(help());
      }

      if (sub === '绑定') {
        runtime.requireDm();
        const result = await runtime.dmDelivery.bind(msg, { guard: () => runtime.isActive() });
        if (!runtime.isActive()) return undefined;
        return reply(`已绑定当前主人私聊作为接收目标（${result?.mask || '已脱敏'}）。下一步可发送 ${prefix}解析 私信 登录。`);
      }
      if (sub === '登录') {
        const status = await runtime.dmLoginStart();
        if (!runtime.isActive()) return undefined;
        if (!(await stillOwner())) return undefined;
        if (status.pngDataUrl && await sendQrImage(msg, status.pngDataUrl)) {
          if (!runtime.isActive()) return undefined;
          return reply('请使用 B 站手机客户端扫码并确认。二维码约 3 分钟后过期；也可在「解析管理」手动填写 Cookie。');
        }
        if (!runtime.isActive()) return undefined;
        if (['starting', 'waiting', 'scanned'].includes(status.state)) {
          return reply('登录二维码正在生成或等待扫码确认，请稍后发送 状态 查看。');
        }
        return reply(`登录未能开始：${status.errorSummary || dmText(status.errorCode || 'DM_ERROR')}`);
      }
      if (sub === '状态') {
        if (!(await stillOwner())) return undefined;
        return reply(dmStatusText(runtime.safeDmStatus(), prefix));
      }
      if (sub === '开') {
        runtime.requireDm();
        const check = await runtime.verifyDmEnable();
        if (!runtime.isActive()) return undefined;
        if (!check.ok) return reply(check.text);
        if (!(await stillOwner())) return undefined;
        await settings.saveConfig({ biliDmEnabled: true }, { guard: () => runtime.isActive() });
        if (!runtime.isActive()) return undefined;
        runtime.applyDmConfig();
        return reply('已启用 B 站私信提醒，正在初始化或恢复进度；基线完成前不会显示监听中，历史未读不会批量转发。');
      }
      if (sub === '关') {
        if (!(await stillOwner())) return undefined;
        await settings.saveConfig({ biliDmEnabled: false }, { guard: () => runtime.isActive() });
        if (!runtime.isActive()) return undefined;
        runtime.applyDmConfig();
        return reply('已暂停 B 站私信抓取和自动投递，账号、绑定和进度均已保留。');
      }
      if (sub === '检查') {
        const status = await runtime.dmCheck();
        if (!runtime.isActive()) return undefined;
        if (!(await stillOwner())) return undefined;
        return reply(dmStatusText(status, prefix));
      }
      if (sub === '测试') {
        const result = await runtime.dmSendTest(msg);
        if (!runtime.isActive()) return undefined;
        if (!(await stillOwner())) return undefined;
        return reply(result.sent > 0
          ? '已向绑定的主人私聊发送带明确标记的测试通知。'
          : '测试通知未确认送达，请查看私信状态并在需要时使用领取。');
      }
      if (sub === '恢复') {
        const result = await runtime.providerClearManualRecovery('bilibili');
        if (!runtime.isActive()) return undefined;
        if (!(await stillOwner())) return undefined;
        if (!result.cleared) return reply('当前没有需要人工恢复的冷却状态。');
        const nextAllowed = result.dm?.polling?.serverNextAllowedAt ?? result.dm?.nextRetryAt ?? null;
        return reply(nextAllowed
          ? `已清除人工恢复状态；服务端要求的等待时间仍保留到 ${formatTime(nextAllowed)}，之后只放行一次受控恢复探测。`
          : '已清除人工恢复状态；下一次检查只放行一次受控恢复探测。');
      }
      if (sub === '待发') {
        if (!(await stillOwner())) return undefined;
        const status = runtime.safeDmStatus();
        return reply(`待发送：${status.queue.unfinished}；待核对：${status.queue.pending}；未知：${status.queue.unknown}。发送 ${prefix}解析 私信 领取 可主动领取。`);
      }
      if (sub === '领取') {
        runtime.requireDm();
        const result = await runtime.dmDelivery.claim(msg, { guard: () => runtime.isActive() });
        if (!runtime.isActive()) return undefined;
        if (result?.handled === true || Number(result?.sent) > 0) return undefined;
        if (!(await stillOwner())) return undefined;
        return reply(`暂无可领取内容或本次额度不足；稍后可再次发送 ${prefix}解析 私信 领取。`);
      }
      if (sub === '查看') {
        runtime.requireDm();
        const shortId = String(rest[0] || '').trim();
        if (!shortId) return reply(`用法：${prefix}解析 私信 查看 <编号> [页码]`);
        const pageNumber = Number(rest[1]);
        const page = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : undefined;
        const result = await runtime.dmDelivery.view(msg, { shortId, page, guard: () => runtime.isActive() });
        if (!runtime.isActive()) return undefined;
        if (result?.handled === true) return undefined;
        if (!(await stillOwner())) return undefined;
        if (result?.ok === true && Number(result?.sent) > 0) {
          if (Number.isInteger(result.nextPage) && result.nextPage > 0 && Number(result.sent) < 4) {
            return reply(`如需继续查看，请发送 ${prefix}解析 私信 查看 ${shortId} ${result.nextPage}`);
          }
          return undefined;
        }
        return reply(result?.ok
          ? `没有可重复查看的内容；编号：${shortId}。`
          : '未找到保留期内的该编号，或它不属于当前账号。');
      }
      if (['退出登录', '退出', 'logout'].includes(sub)) {
        const result = await runtime.dmLoginLogout();
        if (!runtime.isActive()) return undefined;
        return reply(result.warning || '已清除本插件共享 B 站登录并暂停提醒。');
      }
      return reply(help());
    } catch (error) {
      if (!runtime.isActive()) return undefined;
      return reply(`私信操作失败：${dmErrorText(error, runtime)}`);
    }
  };
  let dmClient = null;
  if (typeof biliClientFactory === 'function') {
    try {
      dmClient = biliClientFactory({
        requestPolicy,
        requestScope: biliRequestScope,
      });
    } catch {
      runtime.dmLoadError = 'DM_MODULE_UNAVAILABLE';
    }
  }
  if (dmClient && typeof biliLoginFactory === 'function') {
    try { runtime.biliLogin = biliLoginFactory({ settings, client: dmClient }); } catch { runtime.biliLogin = null; }
  }
  runtime.dmReady = (async () => {
    if (!dmClient) throw dmFailure('DM_MODULE_UNAVAILABLE');
    const modules = dmModules || await defaultDmModules();
    if (!runtime.isActive()) return runtime;
    const store = modules.createBiliDmStore({
      dataDir: ctx.dataDir,
      robotKey: botKey(ctx),
      initialBarrier: previousHandoff,
      isActive: () => runtime.isActive(),
    });
    const dmDelivery = modules.createBiliDmDelivery({ store, ctx });
    const service = modules.createBiliDmService({
      settings,
      client: dmClient,
      store,
      delivery: dmDelivery,
      isActive: () => runtime.isActive(),
      pollSeconds: settings.current().biliDmPollSeconds,
      requestPolicy,
      requestScope: biliRequestScope,
    });
    runtime.dmStore = store;
    runtime.dmDelivery = dmDelivery;
    runtime.dm = service;
    await store.ready;
    await service.ready;
    if (!runtime.isActive()) return runtime;
    if (settings.current().biliDmEnabled) service.start();
    return runtime;
  })();
  runtime.dmReady.then(() => {
    runtime.dmLoading = false;
    runtime.refresh();
  }).catch((error) => {
    runtime.dmLoading = false;
    if (!runtime.isActive()) return;
    const code = dmErrorCode(error);
    runtime.dmLoadError = code === 'DM_ERROR' ? 'DM_MODULE_UNAVAILABLE' : code;
    runtime.dmFatal = Boolean(runtime.dm);
    ctx.logger?.info?.(`私信提醒未就绪：${dmText(runtime.dmLoadError)}`);
    runtime.refresh();
  });
  runtime.dmReady.catch(() => {});
  const ownerBinding = () => {
    try { return runtime.dmStore?.binding?.() ?? {}; } catch { return {}; }
  };
  const reserveSend = (args = {}) => {
    if (typeof runtime.dmStore?.reserveSendCall !== 'function') {
      // Never hand the runtime a synthetic "unavailable" reservation: a caller
      // could treat it as a granted send and bypass the shared 2/60s budget.
      const error = new Error('共享发送预算不可用');
      error.code = 'XHH_BUDGET';
      throw error;
    }
    try {
      return runtime.dmStore.reserveSendCall(args);
    } catch (error) {
      if (error && typeof error === 'object' && !error.code) error.code = 'XHH_BUDGET';
      throw error;
    }
  };
  const rateInfo = (at) => {
    try { return runtime.dmStore?.rateInfo?.(at) ?? null; } catch { return null; }
  };
  const startXhh = async () => {
    if (!runtime.isActive()) return;
    if (!runtime.xhhSafeMessages) runtime.xhhSafeMessages = await defaultXhhSafeMessages();
    if (!runtime.isActive()) return;
    const factory = typeof xhhRuntimeFactory === 'function'
      ? xhhRuntimeFactory : defaultXhhRuntimeFactory;
    const instance = await factory({
      ctx,
      settings,
      requestPolicy,
      isActive: () => runtime.isActive(),
      ownerBinding,
      reserveSend,
      rateInfo,
      initialBarrier: previousHandoff,
      dataDir: ctx.dataDir,
      robotKey: botKey(ctx),
      now: Date.now,
      autoSchedule: true,
    });
    if (!instance || typeof instance !== 'object') {
      throw new Error('xiaoheihe runtime factory returned no runtime');
    }
    if (!runtime.isActive()) {
      try { instance.deactivate?.(); } catch { /* late module was already invalid */ }
      return;
    }
    runtime.xhh = instance;
    if (instance.ready) await instance.ready;
    if (!runtime.isActive()) {
      try { instance.deactivate?.(); } catch { /* late activation */ }
      return;
    }
    if (settings.current().xiaoheiheDmEnabled === true && typeof instance.start === 'function') {
      let state = '';
      try { state = String(instance.getStatus?.()?.state ?? ''); } catch { state = ''; }
      // Coordinate with a runtime that already auto-started from persisted
      // config; only start an explicitly disabled/unavailable instance.
      if (!state || state === 'disabled' || state === 'unavailable') instance.start();
    }
  };
  // The native Xiaoheihe runtime begins only after the Bili DM initial result
  // has settled. A Bili failure must not prevent Xiaoheihe login/status from
  // becoming available, and an absent optional module must never reject the
  // ordinary media-parser runtime.
  runtime.xhhReady = runtime.dmReady.then(startXhh, startXhh).then(() => {
    runtime.xhhLoading = false;
    runtime.xhhLoadError = '';
    runtime.refresh();
    return runtime;
  }).catch((error) => {
    runtime.xhhLoading = false;
    if (!runtime.isActive()) return runtime;
    runtime.xhhLoadError = 'DM_PROVIDER_UNAVAILABLE';
    ctx.logger?.info?.(`小黑盒原生模块未就绪：${dmText(runtime.xhhLoadError)}`);
    runtime.refresh();
    return runtime;
  });
  runtime.xhhReady.catch(() => {});
  runtime.ensure = async (repair = false) => {
    await runtime.ready;
    if (!runtime.isActive()) return;
    runtime.engineEnabled = true;
    if (runtime.preparePromise) return runtime.preparePromise;
    runtime.prepareError = '';
    runtime.preparePromise = Promise.resolve().then(() => runtime.engine.ensure({ repair })).then((out) => {
      if (out === false) throw new Error(engineStatus(runtime.engine).lastError || '引擎准备未成功，请查看依赖与进程状态');
      runtime.unavailableLogged = false; runtime.restartRequired = false; return out;
    }).catch((error) => {
      runtime.prepareError = settings.sanitize(error?.message || '引擎准备失败');
      ctx.logger?.warn?.(`引擎准备失败：${runtime.prepareError}`);
      throw error;
    }).finally(() => { runtime.preparePromise = null; runtime.refresh(); });
    return runtime.preparePromise;
  };
  runtime.startOperation = (action) => {
    if (['stop', 'restart'].includes(action) && settings.current().engineMode === 'external') {
      throw new Error('外部模式的进程不由本插件停止或重启，请在外部引擎处操作');
    }
    if (action === 'restart' && !runtime.queue.isIdle()) throw new Error('请等解析及发送任务空闲后再重启');
    const existing = [...runtime.operations.values()].find((task) => task.action === action && task.state === 'running');
    if (existing) return existing.id;
    const task = { id: randomUUID(), action, state: 'running', startedAt: Date.now() };
    runtime.operations.set(task.id, task);
    while (runtime.operations.size > 20) {
      const remove = [...runtime.operations.values()].find((item) => item.state !== 'running');
      if (!remove) break;
      runtime.operations.delete(remove.id);
    }
    if (action === 'stop') {
      runtime.engineEnabled = false;
      runtime.queue.cancelAll('管理员停止了引擎', { close: false });
    }
    Promise.resolve().then(async () => {
      await runtime.ready;
      if (!runtime.isActive()) throw new Error('插件已停用');
      if (['prepare', 'repair', 'start'].includes(action)) return runtime.ensure(action === 'repair');
      if (action === 'stop') return runtime.engine.stop();
      if (action === 'restart') {
        runtime.engineEnabled = true;
        const out = await runtime.engine.restart();
        if (out === false) throw new Error(engineStatus(runtime.engine).lastError || '引擎重启未成功');
        runtime.restartRequired = false; return out;
      }
      if (action === 'clean') return runtime.engine.clean();
    }).then((out) => {
      task.state = 'completed';
      if (out !== undefined) task.result = settings.sanitize(out);
    }).catch((error) => {
      task.state = 'failed'; task.error = settings.sanitize(error?.message || '维护失败');
    }).finally(() => {
      task.endedAt = Date.now(); runtime.refresh();
      storage?.set?.('media-parser:operations:v1', [...runtime.operations.values()].map((item) => settings.sanitize(item))).catch?.(() => {});
    });
    runtime.refresh();
    return task.id;
  };
  runtime.startPreview = (links) => {
    const cfg = settings.current();
    const promise = runtime.queue.enqueue({
      session: `${botKey(ctx)}:preview`, links, kind: 'preview',
      run: async ({ taskId, deadlineAt, signal, isActive }) => {
        const msg = { kind: 'preview', chatId: 'preview', userId: 'panel', userName: '管理预览' };
        const outcome = await runtime.engine.parse(parsePayload(ctx, msg, links, taskId, cfg), { deadlineAt, signal });
        if (!runtime.isActive() || !isActive()) throw new Error('预览任务已取消');
        runtime.previews.set(taskId, previewOutcome(outcome, settings.sanitize));
        while (runtime.previews.size > 20) runtime.previews.delete(runtime.previews.keys().next().value);
        return { preview: true, claimed: false };
      },
    });
    promise.catch(() => {});
    if (!promise.taskId) throw new Error('预览队列已满或已停止');
    return promise.taskId;
  };
  runtime.handle = async (msg, manual = false, text) => {
    try { await runtime.ready; } catch {
      if (manual && runtime.isActive()) await msg.reply('插件配置读取失败，请管理员查看解析管理页或数据目录中的配置文件。');
      return;
    }
    if (!runtime.isActive()) return;
    const cfg = settings.current();
    if (!await allowed(ctx, msg, cfg, manual)) return;
    const input = text === undefined ? msg : { ...msg, content: text };
    let links = extractLinks(input, cfg);
    if (!links.length) {
      if (manual) await msg.reply('没有发现已启用的受支持分享链接。可用 /解析 平台 查看平台。');
      return;
    }
    if (!runtime.engineReady()) {
      if (manual) await msg.reply(runtime.prepareError ? '解析引擎尚未就绪，请管理员查看「解析管理」中的准备错误并重试。' : '解析引擎准备中，请稍后重试。');
      else if (!runtime.unavailableLogged) {
        runtime.unavailableLogged = true;
        ctx.logger?.info?.('收到受支持链接，但引擎尚未就绪；本轮放行。');
      }
      return;
    }
    const session = sessionKey(ctx, msg);
    links = runtime.queue.filterFresh(session, links);
    if (!links.length) {
      if (manual) await msg.reply('这个会话中的链接正在处理或刚刚发送过，请稍后重试。');
      return;
    }
    const receivedAt = Number(msg.receivedAt) > 0 ? Number(msg.receivedAt) : Date.now();
    const deadlineAt = receivedAt + cfg.timeoutSeconds * 1000;
    try {
      const result = await runtime.queue.enqueue({
        session, links, receivedAt, deadlineAt, manual,
        run: async (task) => {
          const active = () => runtime.isActive() && runtime.engineEnabled && task.isActive();
          if (!active()) throw new Error('任务已取消');
          const payload = parsePayload(ctx, msg, links, task.taskId, cfg);
          // EngineHost owns its single unreachable-service recovery attempt.
          // Do not wrap that with a second retry or replay a delivered result.
          const outcome = await runtime.engine.parse(payload, { deadlineAt: task.deadlineAt, signal: task.signal });
          if (!active()) throw new Error('任务已取消');
          const delivered = await delivery(outcome, {
            ctx, msg, config: cfg, engine: runtime.engine,
            taskId: task.taskId, deadlineAt: task.deadlineAt,
            signal: task.signal, isActive: active,
          });
          // The delivery adapter claims at its first confirmed/pending send.
          // Never pre-claim a request whose whole delivery can still fail.
          return delivered;
        },
      });
      return result?.claimed ? true : undefined;
    } catch (error) {
      if (manual && runtime.isActive()) {
        const reason = error?.code === 'QUEUE_FULL' ? '解析队列已满，请稍后重试。'
          : ['QUEUE_WAIT_TIMEOUT', 'TASK_TIMEOUT'].includes(error?.code) ? '本次解析已超时，请稍后重新发送链接。'
            : error?.code === 'CANCELLED' ? '解析任务已取消。' : '本次解析失败，请稍后重试；管理员可查看管理页任务记录。';
        await msg.reply(reason);
      }
      if (runtime.isActive()) ctx.logger?.debug?.(`解析任务结束：${settings.sanitize(error?.code || error?.message || '失败')}`);
      return;
    } finally { runtime.refresh(); }
  };
  runtime.bootstrap = runtime.ready.then(async () => {
    runtime.boundaries = await detectHostBoundaries(ctx);
    if (runtime.isActive()) await runtime.ensure(false);
  }).catch(() => {}).finally(runtime.refresh);
  return runtime;
}

export function createPlugin({
  engineFactory = createEngineHost, delivery = deliver,
  dmModules = null, biliClientFactory = createBiliClient, biliLoginFactory = createBiliLogin,
  xhhRuntimeFactory = null, xhhSafeMessages = null,
} = {}) {
  return {
    id: 'media-parser',
    name: '流媒体聚合解析',
    version: '0.4.2',
    description: '自动解析分享链接，可选 B 站与小黑盒私信提醒；默认不调用模型',
    shortDesc: '31 个平台入口，可选 B 站与小黑盒私信提醒',
    frameworkVersion: '>=1.1.5',
    supportPlatforms: ['group', 'c2c'],
    priority: 40,
    config: CONFIG_SCHEMA,
    setup(ctx) {
      ctx.state ??= {};
      const runtime = makeRuntime(ctx, ctx.state, {
        engineFactory, delivery, dmModules, biliClientFactory, biliLoginFactory,
        xhhRuntimeFactory, xhhSafeMessages,
      });
      ctx.command('解析 [链接或操作]', { desc: '手动解析分享链接；状态、平台、私信与群开关', usage: `${ctx.prefix || '/'}解析 <链接> | 状态 | 平台 | 私信 | 开 | 关` }, async (msg) => {
        const args = Array.isArray(msg.args) ? msg.args : [];
        const action = String(args[0] ?? '').trim();
        if (!runtime.isActive() || isBotMessage(msg)) return;
        try { await runtime.ready; } catch {
          return msg.reply('插件配置读取失败，请管理员检查数据目录中的配置文件。');
        }
        if (action === '私信') return runtime.dmCommand(msg, args.slice(1));
        if (['guild', 'dm'].includes(msg.kind)) return msg.reply('当前发送适配未支持频道或频道私信。');
        if (action === '状态') {
          const status = runtime.publicStatus();
          return msg.reply(`解析引擎：${status.ready ? '就绪' : '准备中或未就绪'}\n支持平台：${status.platformCount}\n运行任务：${status.queue.running}，等待：${status.queue.waiting}\n详细状态与维护操作请查看管理面板「解析管理」。`);
        }
        if (action === '平台') return msg.reply(runtime.settings.platforms().map((platform) => `${platform.enabled ? '●' : '○'} ${platform.name}：${platform.mode}`).join('\n'));
        if (['开', '关'].includes(action)) {
          if (msg.kind !== 'group') return msg.reply('群级自动解析开关只能在普通群聊中使用。');
          const groupId = msg.groupId || msg.chatId;
          const can = typeof ctx.isGroupAdmin === 'function' ? await ctx.isGroupAdmin(groupId, msg.userId) : typeof ctx.can === 'function' && await ctx.can(msg, 'admin');
          if (!can) return msg.reply('需要当前群管理员权限。');
          // Current ctx exposes no setter for cfg.plugins.groups. Delegating to the
          // existing core command is the only supported way to use its authority.
          return msg.reply(`请使用宿主群插件开关：${ctx.prefix || '/'}群插件 ${action} media-parser\n或在面板的分群插件设置中操作。这会修改本群的同一个插件开关。`);
        }
        if (!action) return msg.reply(`用法：${ctx.prefix || '/'}解析 <分享链接>\n${ctx.prefix || '/'}解析 状态 / 平台\n群级启停请用 ${ctx.prefix || '/'}群插件 开|关 media-parser。`);
        return runtime.handle(msg, true, args.join(' '));
      });
      ctx.menu('自动解析', [
        { text: '直接发送受支持的分享链接', desc: '默认不要求 @，私聊也可用；最多三个不同链接' },
        { text: `${ctx.prefix || '/'}解析 状态`, desc: '查看公开状态' },
        { text: `${ctx.prefix || '/'}解析 平台`, desc: '查看平台输出模式' },
        { text: `${ctx.prefix || '/'}解析 私信`, desc: 'B站私信提醒：主人私聊中绑定、登录、启停、待发与领取' },
        { text: `${ctx.prefix || '/'}群插件 开|关 media-parser`, desc: '使用宿主的本群插件开关' },
      ]);
      ctx.on('message', (msg) => {
        runtime.dmGroups?.observe(msg);
        return runtime.handle(msg);
      });
      registerPanel(ctx, runtime);
      ctx.onTeardown?.(() => runtime.deactivate('插件已停用'));
      ctx.schedule?.('media-parser-dashboard', 5000, runtime.refresh);
      runtime.refresh();
      return undefined;
    },
    teardown(ctx) {
      return ctx.state?.runtime?.deactivate?.('插件已停用') ?? Promise.resolve();
    },
  };
}

export default createPlugin();
