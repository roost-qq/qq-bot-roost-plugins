import fsDefault from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const XHH_SCHEMA_VERSION = 1;
export const XHH_STATE_FILE = 'xiaoheihe-dm-state.json';
export const XHH_PROVIDER_ID = 'xiaoheihe';
export const XHH_MAX_UNFINISHED = 1000;
export const XHH_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const XHH_COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const XHH_MAX_SEEN_PER_CONVERSATION = 2000;
export const XHH_RATE_WINDOW_MS = 60_000;
export const XHH_RATE_MAX_CALLS = 2;

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TARGET_KINDS = new Set(['c2c', 'group']);
const MESSAGE_STATUSES = new Set(['unfinished', 'sent', 'suppressed', 'cancelled']);
const SEGMENT_STATES = new Set([
  'planned', 'sending', 'sent', 'failed', 'pending', 'unknown', 'superseded',
]);

export class XhhDmStoreError extends Error {
  constructor(code, message = code, options = {}) {
    super(message);
    this.name = 'XhhDmStoreError';
    this.code = code;
    this.cause = options.cause;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs)
      ? Math.max(0, options.retryAfterMs) : 0;
  }
}

function fail(code, message = code, options) {
  throw new XhhDmStoreError(code, message, options);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isNonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableTime(value) {
  return value === null || isFiniteTime(value);
}

export function xhhKeyPart(value, name = '标识', max = 512) {
  const text = String(value ?? '');
  if (!text || text.length > max || /[\u0000-\u001f]/.test(text)) {
    fail('XHH_STATE_CORRUPT', `${name} 格式不合法`);
  }
  return text;
}

export function isOpaqueId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f]/.test(value);
}

function requireOpaqueId(value, name, max = 512) {
  if (!isOpaqueId(value) || value.length > max) {
    fail('XHH_MESSAGE_ID_INVALID', `${name} 不合法`);
  }
  return value;
}

function optionalOpaqueId(value, name, max = 512) {
  if (value === undefined || value === null || value === '') return '';
  if (!isOpaqueId(value) || value.length > max) {
    fail('XHH_STATE_CORRUPT', `${name} 不合法`);
  }
  return value;
}

export function normalizeTargetKind(value, fallback = 'c2c') {
  if (value === undefined || value === null || value === '') return fallback;
  if (value !== 'c2c' && value !== 'group') {
    fail('XHH_BINDING_INVALID', '通知目标类型不合法');
  }
  return value;
}

export function makeXhhConversationKey(peerId) {
  return `peer:${encodeURIComponent(requireOpaqueId(peerId, '会话 ID'))}`;
}

export function makeXhhMessageKey({
  robotKey, accountScope, peerId, messageId, seq,
}) {
  const identity = isOpaqueId(messageId) && messageId
    ? `id:${messageId}` : (isOpaqueId(seq) && seq ? `seq:${seq}` : '');
  if (!identity) fail('XHH_MESSAGE_ID_INVALID', '消息缺少稳定 ID');
  return [
    encodeURIComponent(xhhKeyPart(robotKey, '机器人标识')),
    encodeURIComponent(xhhKeyPart(accountScope, '账号标识')),
    encodeURIComponent(xhhKeyPart(peerId, '会话 ID')),
    encodeURIComponent(identity),
  ].join('|');
}

export function makeXhhSegmentKey({
  messageKey, bindingVersion, target, index, targetKind = 'c2c',
}) {
  const version = Number(bindingVersion);
  const position = Number(index);
  if (!isNonNegativeInt(version) || !isNonNegativeInt(position)) {
    fail('XHH_STATE_CORRUPT', '分段序号不合法');
  }
  const kind = normalizeTargetKind(targetKind);
  const encode = (value, name) => encodeURIComponent(xhhKeyPart(value, name, 2048));
  const parts = [encode(messageKey, '消息键'), version];
  if (kind === 'group') parts.push('kind:group');
  parts.push(encode(target, '通知目标'), position);
  return parts.join('|');
}

export function makeXhhRequestId({
  robotKey, accountScope, target, bindingVersion, messageKey, index,
  purpose = 'dm', targetKind = 'c2c',
}) {
  const kind = normalizeTargetKind(targetKind);
  const parts = [purpose, robotKey, accountScope, target, bindingVersion, messageKey, index];
  if (kind === 'group') parts.push('kind:group');
  return `xhh-dm:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 40)}`;
}

export function shortXhhMessageId(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex')
    .slice(0, 12).toUpperCase();
}

function safeAssign(target, key, value) {
  if (UNSAFE_KEYS.has(key)) fail('XHH_STATE_CORRUPT', '状态包含不允许的键');
  target[key] = value;
}

function assertSafeTree(value, depth = 0, count = { n: 0 }) {
  if (depth > 64 || ++count.n > 200000) fail('XHH_STATE_CORRUPT', '状态结构超过安全上限');
  if (Array.isArray(value)) {
    for (const item of value) assertSafeTree(item, depth + 1, count);
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) fail('XHH_STATE_CORRUPT', '状态包含不允许的键');
      assertSafeTree(child, depth + 1, count);
    }
  }
}

export function createEmptyXhhState(robotKey, now = Date.now()) {
  return {
    schemaVersion: XHH_SCHEMA_VERSION,
    providerId: XHH_PROVIDER_ID,
    robotKey: xhhKeyPart(robotKey, '机器人标识'),
    createdAt: now,
    updatedAt: now,
    currentAccountKey: null,
    accountEpoch: null,
    sessionVersion: null,
    config: {
      enabled: false,
      pollSeconds: 300,
      targetKind: 'c2c',
      groupId: '',
      updatedAt: null,
    },
    binding: {
      ownerTarget: null,
      target: null,
      targetKind: 'c2c',
      groupName: '',
      version: 0,
      updatedAt: null,
    },
    accounts: {},
  };
}

export function accountScopeKey(accountKey, _accountEpoch) {
  // The durable account partition must stay stable across credential/epoch
  // rotation for the same platform account. accountEpoch is only a fence for
  // stale operations, never part of message identity or request ids.
  return xhhKeyPart(accountKey, '账号标识');
}

function normalizeSessionVersion(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : null;
}

function emptyConversation(peerId, now) {
  return {
    key: makeXhhConversationKey(peerId),
    peerId,
    nickname: '',
    knownWindowInitialized: false,
    baselineComplete: false,
    baselineCutoffMs: null,
    adoptedAfterBaseline: false,
    seenIds: [],
    pending: null,
    gap: null,
    lastServerTime: null,
    lastMessageAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function ensureXhhConversation(account, {
  peerId, nickname = '', baselineCutoffMs = null, adopted = false, now,
}) {
  const peer = requireOpaqueId(peerId, '会话 ID');
  const key = makeXhhConversationKey(peer);
  let conversation = account.conversations[key];
  if (!conversation) {
    conversation = emptyConversation(peer, now);
    conversation.adoptedAfterBaseline = adopted === true;
    conversation.knownWindowInitialized = adopted === true;
    conversation.baselineComplete = adopted === true;
    conversation.baselineCutoffMs = adopted === true ? baselineCutoffMs : null;
    safeAssign(account.conversations, key, conversation);
  }
  if (nickname && typeof nickname === 'string') {
    conversation.nickname = nickname.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 128);
  }
  return conversation;
}

export function ensureXhhAccount(state, {
  accountKey, accountEpoch, sessionVersion, now,
}) {
  const partition = accountScopeKey(accountKey, accountEpoch);
  const epoch = xhhKeyPart(accountEpoch ?? '0', '账号代次', 128);
  const session = normalizeSessionVersion(sessionVersion);
  if (!state.accounts[partition]) {
    safeAssign(state.accounts, partition, {
      partition,
      accountKey: xhhKeyPart(accountKey, '账号标识'),
      accountEpoch: epoch,
      sessionVersion: session,
      createdAt: now,
      updatedAt: now,
      syncWorkflowId: '',
      discovery: {
        phase: 'idle',
        baselineComplete: false,
        baselineCutoffMs: null,
        scanActive: false,
        startedAt: null,
        pages: 0,
        sessionCount: 0,
        nextOffset: null,
        nextCursor: null,
        gap: null,
        lastServerTime: null,
        lastScanAt: null,
      },
      conversations: {},
      messages: {},
      segments: {},
    });
  }
  const account = state.accounts[partition];
  account.accountEpoch = epoch;
  if (session !== null) account.sessionVersion = session;
  account.updatedAt = now;
  return account;
}

export function countXhhUnfinished(state) {
  let count = 0;
  for (const account of Object.values(state.accounts || {})) {
    for (const message of Object.values(account.messages || {})) {
      if (message?.status === 'unfinished') count += 1;
    }
  }
  return count;
}

function assertCapacity(state, maxUnfinished, maxFileBytes) {
  if (countXhhUnfinished(state) > maxUnfinished) {
    fail('XHH_CAPACITY', '待投递私信数量已达上限');
  }
  if (Buffer.byteLength(JSON.stringify(state)) > maxFileBytes) {
    fail('XHH_CAPACITY', '私信状态文件已达上限');
  }
}

function requireText(value, name, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max
    || /[\u0000-\u001f]/.test(value)) {
    fail('XHH_STATE_CORRUPT', `${name} 格式不合法`);
  }
  return value;
}

function optionalText(value, name, max = 512) {
  if (value === undefined || value === null || value === '') return '';
  requireText(value, name, max);
  return value;
}

function validateGap(gap, name) {
  if (gap === null || gap === undefined) return;
  if (!isObject(gap) || typeof gap.code !== 'string' || !/^XHH_[A-Z0-9_]{1,64}$/.test(gap.code)) {
    fail('XHH_STATE_CORRUPT', `${name} 不合法`);
  }
  if (gap.at !== undefined && !isFiniteTime(gap.at)) {
    fail('XHH_STATE_CORRUPT', `${name} 时间不合法`);
  }
}

function validatePending(pending, name) {
  if (pending === null || pending === undefined) return;
  if (!isObject(pending)) fail('XHH_STATE_CORRUPT', `${name} 不合法`);
  if (pending.offset !== null && pending.offset !== undefined) {
    if (!isOpaqueId(String(pending.offset))) fail('XHH_STATE_CORRUPT', `${name} 偏移不合法`);
  }
  if (pending.cursor !== null && pending.cursor !== undefined) {
    if (!isOpaqueId(String(pending.cursor))) fail('XHH_STATE_CORRUPT', `${name} 游标不合法`);
  }
  if (!isNonNegativeInt(pending.pageCount)) fail('XHH_STATE_CORRUPT', `${name} 页计数不合法`);
  if (pending.startedAt !== undefined && !isFiniteTime(pending.startedAt)) {
    fail('XHH_STATE_CORRUPT', `${name} 时间不合法`);
  }
  if (pending.gap !== undefined && pending.gap !== null
    && (typeof pending.gap !== 'string' || !/^XHH_[A-Z0-9_]{1,64}$/.test(pending.gap))) {
    fail('XHH_STATE_CORRUPT', `${name} 状态不合法`);
  }
}

function validateDiscovery(discovery) {
  if (!isObject(discovery)) fail('XHH_STATE_CORRUPT', '私信发现状态不合法');
  if (typeof discovery.phase !== 'string' || !discovery.phase
    || typeof discovery.baselineComplete !== 'boolean'
    || typeof discovery.scanActive !== 'boolean') {
    fail('XHH_STATE_CORRUPT', '私信发现状态不合法');
  }
  if (!isNonNegativeInt(discovery.pages) || !isNonNegativeInt(discovery.sessionCount)) {
    fail('XHH_STATE_CORRUPT', '私信发现计数不合法');
  }
  if (!isNullableTime(discovery.baselineCutoffMs)
    || !isNullableTime(discovery.startedAt)
    || !isNullableTime(discovery.lastServerTime)
    || !isNullableTime(discovery.lastScanAt)) {
    fail('XHH_STATE_CORRUPT', '私信发现时间不合法');
  }
  if (discovery.nextOffset !== null && discovery.nextOffset !== undefined
    && !isOpaqueId(String(discovery.nextOffset))) {
    fail('XHH_STATE_CORRUPT', '私信发现偏移不合法');
  }
  if (discovery.nextCursor !== null && discovery.nextCursor !== undefined
    && !isOpaqueId(String(discovery.nextCursor))) {
    fail('XHH_STATE_CORRUPT', '私信发现游标不合法');
  }
  validateGap(discovery.gap, '私信发现异常状态');
}

function validateSeen(seen) {
  if (!Array.isArray(seen) || seen.length > XHH_MAX_SEEN_PER_CONVERSATION) {
    fail('XHH_STATE_CORRUPT', '私信已见标识不合法');
  }
  for (const value of seen) {
    if (!isOpaqueId(value)) fail('XHH_STATE_CORRUPT', '私信已见标识不合法');
  }
}

function validateConversation(key, conversation, account) {
  if (!isObject(conversation)) fail('XHH_STATE_CORRUPT', '私信会话结构不合法');
  if (conversation.key !== key) fail('XHH_STATE_CORRUPT', '私信会话键不匹配');
  const peerId = requireOpaqueId(conversation.peerId, '私信会话 ID');
  if (makeXhhConversationKey(peerId) !== key) {
    fail('XHH_STATE_CORRUPT', '私信会话键不一致');
  }
  optionalText(conversation.nickname, '私信会话名称', 128);
  if (typeof conversation.baselineComplete !== 'boolean'
    || typeof conversation.adoptedAfterBaseline !== 'boolean') {
    fail('XHH_STATE_CORRUPT', '私信会话基线状态不合法');
  }
  if (conversation.knownWindowInitialized !== undefined
    && typeof conversation.knownWindowInitialized !== 'boolean') {
    fail('XHH_STATE_CORRUPT', '私信会话已知窗口状态不合法');
  }
  if (!isNullableTime(conversation.baselineCutoffMs)
    || !isNullableTime(conversation.lastServerTime)
    || !isNullableTime(conversation.lastMessageAt)
    || !isFiniteTime(conversation.createdAt)
    || !isFiniteTime(conversation.updatedAt)) {
    fail('XHH_STATE_CORRUPT', '私信会话时间不合法');
  }
  validateSeen(conversation.seenIds);
  validatePending(conversation.pending, '私信会话续拉');
  validateGap(conversation.gap, '私信会话异常状态');
  if (account && !isObject(account.messages)) fail('XHH_STATE_CORRUPT', '私信消息集合不合法');
}

function validateMessage(key, message, account, robotKey) {
  if (!isObject(message)) fail('XHH_STATE_CORRUPT', '私信记录结构不合法');
  if (message.key !== key) fail('XHH_STATE_CORRUPT', '私信记录键不匹配');
  if (message.accountScope !== account.partition) {
    fail('XHH_STATE_CORRUPT', '私信记录账号不匹配');
  }
  const peerId = requireOpaqueId(message.peerId, '私信记录会话 ID');
  const messageId = optionalOpaqueId(message.messageId, '私信记录消息 ID');
  const seq = optionalOpaqueId(message.seq, '私信记录序号');
  if (!messageId && !seq) fail('XHH_STATE_CORRUPT', '私信记录缺少稳定标识');
  const expected = makeXhhMessageKey({
    robotKey,
    accountScope: account.partition,
    peerId,
    messageId,
    seq,
  });
  if (expected !== key) fail('XHH_STATE_CORRUPT', '私信记录编辑键不一致');
  if (message.conversationKey !== makeXhhConversationKey(peerId)) {
    fail('XHH_STATE_CORRUPT', '私信记录会话键不匹配');
  }
  if (!isOpaqueId(message.senderId) || message.senderId.length > 512) {
    fail('XHH_STATE_CORRUPT', '私信记录发送者不合法');
  }
  optionalText(message.senderName, '私信记录发送者名称', 128);
  if (typeof message.text !== 'string') fail('XHH_STATE_CORRUPT', '私信记录正文不合法');
  if (!Array.isArray(message.imageUrls) || !Array.isArray(message.shareUrls)
    || message.imageUrls.some((item) => typeof item !== 'string')
    || message.shareUrls.some((item) => typeof item !== 'string')) {
    fail('XHH_STATE_CORRUPT', '私信记录链接不合法');
  }
  if (!isFiniteTime(message.sentAtMs) || message.sentAtMs <= 0) {
    fail('XHH_STATE_CORRUPT', '私信记录时间不合法');
  }
  if (typeof message.type !== 'string' || !message.type) {
    fail('XHH_STATE_CORRUPT', '私信记录类型不合法');
  }
  if (!MESSAGE_STATUSES.has(message.status)) fail('XHH_STATE_CORRUPT', '私信记录状态不合法');
  if (typeof message.deliveryState !== 'string' || !message.deliveryState) {
    fail('XHH_STATE_CORRUPT', '私信记录投递状态不合法');
  }
  if (!isFiniteTime(message.createdAt)) fail('XHH_STATE_CORRUPT', '私信记录创建时间不合法');
  if (!isNullableTime(message.completedAt === undefined ? null : message.completedAt)) {
    fail('XHH_STATE_CORRUPT', '私信记录完成时间不合法');
  }
}

function validateSegment(key, segment, account, robotKey) {
  if (!isObject(segment)) fail('XHH_STATE_CORRUPT', '私信分段结构不合法');
  if (segment.key !== key) fail('XHH_STATE_CORRUPT', '私信分段键不匹配');
  if (segment.accountScope !== account.partition) {
    fail('XHH_STATE_CORRUPT', '私信分段账号不匹配');
  }
  if (!account.messages[segment.messageKey]) {
    fail('XHH_STATE_CORRUPT', '私信分段引用不存在的消息');
  }
  const targetKind = normalizeTargetKind(segment.targetKind);
  const target = requireText(segment.target, '私信分段目标', 512);
  if (!isNonNegativeInt(segment.bindingVersion) || !isNonNegativeInt(segment.index)) {
    fail('XHH_STATE_CORRUPT', '私信分段序号不合法');
  }
  if (!isNonNegativeInt(segment.total) || segment.total < 1 || segment.index >= segment.total) {
    fail('XHH_STATE_CORRUPT', '私信分段总数不合法');
  }
  const expectedKey = makeXhhSegmentKey({
    messageKey: segment.messageKey,
    bindingVersion: segment.bindingVersion,
    target,
    index: segment.index,
    targetKind,
  });
  if (expectedKey !== key) fail('XHH_STATE_CORRUPT', '私信分段键不一致');
  if (typeof segment.body !== 'string') fail('XHH_STATE_CORRUPT', '私信分段正文不合法');
  const expectedRequest = makeXhhRequestId({
    robotKey,
    accountScope: account.partition,
    target,
    bindingVersion: segment.bindingVersion,
    messageKey: segment.messageKey,
    index: segment.index,
    targetKind,
  });
  if (segment.requestId !== expectedRequest) {
    fail('XHH_STATE_CORRUPT', '私信分段请求标识不一致');
  }
  if (!SEGMENT_STATES.has(segment.state)) fail('XHH_STATE_CORRUPT', '私信分段状态不合法');
  if (!isNonNegativeInt(segment.attempts)) fail('XHH_STATE_CORRUPT', '私信分段尝试次数不合法');
  if (!isFiniteTime(segment.createdAt) || !isFiniteTime(segment.updatedAt)
    || !isFiniteTime(segment.nextRetryAt)) {
    fail('XHH_STATE_CORRUPT', '私信分段时间不合法');
  }
  if (segment.lastErrorCode !== undefined && typeof segment.lastErrorCode !== 'string') {
    fail('XHH_STATE_CORRUPT', '私信分段错误码不合法');
  }
  if (!isNullableTime(segment.sentAt === undefined ? null : segment.sentAt)) {
    fail('XHH_STATE_CORRUPT', '私信分段发送时间不合法');
  }
}

function validateAccount(partition, account, robotKey) {
  if (!isObject(account)) fail('XHH_STATE_CORRUPT', '私信账号状态不合法');
  if (account.partition !== partition) fail('XHH_STATE_CORRUPT', '私信账号分区不匹配');
  if (accountScopeKey(account.accountKey, account.accountEpoch) !== partition) {
    fail('XHH_STATE_CORRUPT', '私信账号分区不一致');
  }
  if (!isFiniteTime(account.createdAt) || !isFiniteTime(account.updatedAt)) {
    fail('XHH_STATE_CORRUPT', '私信账号时间不合法');
  }
  if (account.sessionVersion !== null && account.sessionVersion !== undefined
    && !isNonNegativeInt(account.sessionVersion)) {
    fail('XHH_STATE_CORRUPT', '私信账号会话版本不合法');
  }
  optionalText(account.syncWorkflowId, '私信同步工作流', 128);
  if (!isObject(account.discovery) || !isObject(account.conversations)
    || !isObject(account.messages) || !isObject(account.segments)) {
    fail('XHH_STATE_CORRUPT', '私信账号结构不合法');
  }
  validateDiscovery(account.discovery);
  for (const [key, conversation] of Object.entries(account.conversations)) {
    validateConversation(key, conversation, account);
  }
  for (const [key, message] of Object.entries(account.messages)) {
    validateMessage(key, message, account, robotKey);
  }
  for (const [key, segment] of Object.entries(account.segments)) {
    validateSegment(key, segment, account, robotKey);
  }
}

function validateState(state) {
  if (!isObject(state)) fail('XHH_STATE_CORRUPT', '私信状态必须是对象');
  if (state.schemaVersion !== XHH_SCHEMA_VERSION) {
    fail(typeof state.schemaVersion === 'number' && state.schemaVersion > XHH_SCHEMA_VERSION
      ? 'XHH_STATE_UNSUPPORTED' : 'XHH_STATE_CORRUPT', '私信状态版本不受支持');
  }
  if (state.providerId !== XHH_PROVIDER_ID) fail('XHH_STATE_CORRUPT', '私信状态平台不匹配');
  if (typeof state.robotKey !== 'string' || !state.robotKey || state.robotKey.length > 512
    || /[\u0000-\u001f]/.test(state.robotKey)) {
    fail('XHH_STATE_CORRUPT', '私信状态机器人标识不合法');
  }
  if (!isFiniteTime(state.createdAt) || !isFiniteTime(state.updatedAt)) {
    fail('XHH_STATE_CORRUPT', '私信状态时间不合法');
  }
  assertSafeTree(state);
  if (state.currentAccountKey !== null && typeof state.currentAccountKey !== 'string') {
    fail('XHH_STATE_CORRUPT', '私信状态当前账号不合法');
  }
  if (state.accountEpoch !== null && state.accountEpoch !== undefined) {
    requireText(state.accountEpoch, '私信状态账号代次', 128);
  }
  if (state.sessionVersion !== null && state.sessionVersion !== undefined
    && !isNonNegativeInt(state.sessionVersion)) {
    fail('XHH_STATE_CORRUPT', '私信状态会话版本不合法');
  }
  const config = state.config;
  if (!isObject(config) || typeof config.enabled !== 'boolean'
    || !isNonNegativeInt(config.pollSeconds)
    || !TARGET_KINDS.has(normalizeTargetKind(config.targetKind))
    || typeof config.groupId !== 'string' || config.groupId.length > 512
    || !isNullableTime(config.updatedAt)) {
    fail('XHH_STATE_CORRUPT', '私信配置不合法');
  }
  const binding = state.binding;
  if (!isObject(binding) || !TARGET_KINDS.has(normalizeTargetKind(binding.targetKind))
    || !isNonNegativeInt(binding.version) || !isNullableTime(binding.updatedAt)) {
    fail('XHH_STATE_CORRUPT', '私信通知绑定不合法');
  }
  if (binding.ownerTarget !== null) requireText(binding.ownerTarget, '主人目标', 512);
  if (binding.target !== null) requireText(binding.target, '通知目标', 512);
  optionalText(binding.groupName, '通知群名称', 128);
  if (!isObject(state.accounts)) fail('XHH_STATE_CORRUPT', '私信账号集合不合法');
  for (const [partition, account] of Object.entries(state.accounts)) {
    validateAccount(partition, account, state.robotKey);
  }
  if (state.currentAccountKey !== null && !state.accounts[state.currentAccountKey]) {
    fail('XHH_STATE_CORRUPT', '私信状态当前账号不存在');
  }
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

export function createXhhDmStore({
  dataDir, robotKey, fs = {}, beforeLoad, initialBarrier, isActive = () => true,
  now = () => Date.now(), file = XHH_STATE_FILE,
  maxUnfinished = XHH_MAX_UNFINISHED, maxFileBytes = XHH_MAX_FILE_BYTES,
  completedRetentionMs = XHH_COMPLETED_RETENTION_MS,
} = {}) {
  if (!dataDir) throw new TypeError('createXhhDmStore requires dataDir');
  const robot = xhhKeyPart(robotKey, '机器人标识');
  const filePath = path.join(dataDir, file);
  const io = defaultIo(fs);
  const limitUnfinished = Math.max(1, Number(maxUnfinished) || XHH_MAX_UNFINISHED);
  const limitBytes = Math.max(1024, Number(maxFileBytes) || XHH_MAX_FILE_BYTES);
  const retentionMs = Math.max(60_000, Number(completedRetentionMs) || XHH_COMPLETED_RETENTION_MS);

  let state = null;
  let loadError = null;
  let tail = Promise.resolve();
  let tempSeq = 0;

  const assertGuard = (guard) => {
    if (!isActive()) fail('XHH_STALE', '私信任务已失效');
    if (guard !== undefined) {
      let ok = false;
      try { ok = typeof guard === 'function' && guard() === true; } catch { ok = false; }
      if (!ok) fail('XHH_STALE', '私信状态写入已失效');
    }
  };

  function enqueue(fn) {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  }

  async function persist(draft, guard) {
    let text;
    try {
      text = `${JSON.stringify(draft)}\n`;
    } catch (error) {
      fail('XHH_STATE_CORRUPT', '私信状态无法序列化', { cause: error });
    }
    if (Buffer.byteLength(text) > limitBytes) fail('XHH_CAPACITY', '私信状态文件已达上限');
    assertGuard(guard);
    let temp = '';
    try {
      await io.mkdir(path.dirname(filePath), { recursive: true });
      temp = `${filePath}.${process.pid}.${now()}.${tempSeq += 1}.${randomUUID()}.tmp`;
      await io.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
      assertGuard(guard);
      await io.rename(temp, filePath);
      temp = '';
    } catch (error) {
      if (error instanceof XhhDmStoreError) throw error;
      fail('XHH_WRITE_FAILED', '私信状态写入失败', { cause: error });
    } finally {
      if (temp) {
        try { await io.unlink(temp); } catch { /* cleanup is best effort */ }
      }
    }
  }

  const ready = (async () => {
    if (initialBarrier) await initialBarrier;
    if (beforeLoad) await beforeLoad;
    assertGuard();
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
          fail('XHH_STATE_CORRUPT', '私信状态文件超过安全上限，已保留原文件');
        }
      }
      const raw = await io.readFile(filePath, 'utf8');
      text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        state = createEmptyXhhState(robot, now());
        return api;
      }
      if (error instanceof XhhDmStoreError) {
        loadError = error;
        throw error;
      }
      fail('XHH_STATE_READ_FAILED', '私信状态读取失败', { cause: error });
    }
    if (Buffer.byteLength(text, 'utf8') > limitBytes) {
      fail('XHH_STATE_CORRUPT', '私信状态文件超过安全上限，已保留原文件');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      loadError = new XhhDmStoreError('XHH_STATE_CORRUPT', '私信状态文件损坏，已保留原文件', { cause: error });
      throw loadError;
    }
    try {
      validateState(parsed);
      if (parsed.robotKey !== robot) fail('XHH_STATE_CORRUPT', '私信状态不属于当前机器人');
      assertCapacity(parsed, limitUnfinished, limitBytes);
    } catch (error) {
      loadError = error instanceof XhhDmStoreError
        ? error : new XhhDmStoreError('XHH_STATE_CORRUPT', '私信状态文件损坏，已保留原文件', { cause: error });
      throw loadError;
    }
    state = parsed;
    return api;
  })().catch((error) => {
    loadError = error instanceof XhhDmStoreError
      ? error : new XhhDmStoreError('XHH_STATE_READ_FAILED', '私信状态读取失败', { cause: error });
    throw loadError;
  });

  function transaction(mutator, { guard } = {}) {
    if (typeof mutator !== 'function') throw new TypeError('transaction requires a mutator');
    return enqueue(async () => {
      await ready;
      assertGuard(guard);
      const draft = clone(state);
      const result = await mutator(draft);
      assertGuard(guard);
      draft.schemaVersion = XHH_SCHEMA_VERSION;
      draft.providerId = XHH_PROVIDER_ID;
      draft.updatedAt = now();
      validateState(draft);
      assertCapacity(draft, limitUnfinished, limitBytes);
      await persist(draft, guard);
      state = draft;
      return clone(result);
    });
  }

  function read(fn) {
    if (!state) {
      if (loadError) throw loadError;
      fail('XHH_STATE_NOT_READY', '私信状态尚未加载');
    }
    return fn(state);
  }

  function setAccount({ accountKey, accountEpoch, sessionVersion }, { guard } = {}) {
    return transaction((draft) => {
      const account = ensureXhhAccount(draft, {
        accountKey, accountEpoch, sessionVersion, now: now(),
      });
      draft.currentAccountKey = account.partition;
      draft.accountEpoch = account.accountEpoch;
      draft.sessionVersion = account.sessionVersion;
      return {
        partition: account.partition,
        accountEpoch: account.accountEpoch,
        sessionVersion: account.sessionVersion,
      };
    }, { guard });
  }

  function bindOwner(ownerTarget, { guard } = {}) {
    const value = String(ownerTarget ?? '');
    if (!value || value.length > 512 || /[\u0000-\u001f\r\n]/.test(value)) {
      return Promise.reject(new XhhDmStoreError('XHH_BINDING_INVALID', '主人目标格式不合法'));
    }
    return transaction((draft) => {
      const binding = draft.binding;
      const previousOwner = binding.ownerTarget;
      if (previousOwner !== value) {
        binding.ownerTarget = value;
        binding.version = (Number(binding.version) || 0) + 1;
        binding.updatedAt = now();
        if (binding.targetKind !== 'group' || !binding.target) {
          binding.targetKind = 'c2c';
          binding.target = value;
        }
      }
      return clone(binding);
    }, { guard });
  }

  function setTarget({ targetKind, target, groupName = '' }, { guard } = {}) {
    const kind = normalizeTargetKind(targetKind);
    const value = String(target ?? '');
    return transaction((draft) => {
      const binding = draft.binding;
      if (!binding.ownerTarget) {
        throw new XhhDmStoreError('XHH_BINDING_REQUIRED', '尚未绑定主人私聊');
      }
      const nextTarget = kind === 'group' ? value : binding.ownerTarget;
      if (kind === 'group' && (!nextTarget || nextTarget.length > 512
        || /[\u0000-\u001f\r\n]/.test(nextTarget))) {
        throw new XhhDmStoreError('XHH_BINDING_INVALID', '群目标格式不合法');
      }
      const changed = binding.targetKind !== kind || binding.target !== nextTarget;
      if (changed) {
        binding.targetKind = kind;
        binding.target = nextTarget;
        binding.groupName = kind === 'group'
          ? String(groupName || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 128) : '';
        binding.version = (Number(binding.version) || 0) + 1;
        binding.updatedAt = now();
      }
      return clone(binding);
    }, { guard });
  }

  function setConfig(patch, { guard } = {}) {
    const request = isObject(patch) ? patch : {};
    return transaction((draft) => {
      const config = draft.config;
      if (request.enabled !== undefined) config.enabled = request.enabled === true;
      if (request.pollSeconds !== undefined) {
        const value = Math.floor(Number(request.pollSeconds));
        if (!Number.isFinite(value) || value < 180 || value > 3600) {
          throw new XhhDmStoreError('XHH_CONFIG', '轮询间隔不合法');
        }
        config.pollSeconds = value;
      }
      if (request.targetKind !== undefined) {
        config.targetKind = normalizeTargetKind(request.targetKind);
      }
      if (request.groupId !== undefined) {
        config.groupId = String(request.groupId ?? '');
      }
      config.updatedAt = now();
      return clone(config);
    }, { guard });
  }

  function cancelMessage(messageKey, { guard } = {}) {
    const key = String(messageKey ?? '');
    return transaction((draft) => {
      const account = draft.currentAccountKey ? draft.accounts[draft.currentAccountKey] : null;
      const message = account?.messages?.[key];
      if (!message) return { cancelled: false, reason: 'missing' };
      if (message.status === 'sent') return { cancelled: false, reason: 'sent' };
      if (message.status !== 'cancelled') {
        message.status = 'cancelled';
        message.deliveryState = 'cancelled';
        message.completedAt = now();
      }
      for (const [segmentKey, segment] of Object.entries(account.segments)) {
        if (segment.messageKey !== key) continue;
        if (segment.state === 'planned' && Number(segment.attempts || 0) === 0) {
          delete account.segments[segmentKey];
        } else if (['sending', 'pending', 'unknown'].includes(segment.state)) {
          segment.cancelled = true;
          segment.updatedAt = now();
        } else if (segment.state !== 'sent') {
          segment.state = 'superseded';
          segment.updatedAt = now();
        }
      }
      return { cancelled: true };
    }, { guard });
  }

  function prune(at = now(), options = {}) {
    if (isObject(at)) {
      options = at;
      at = now();
    }
    const { guard } = isObject(options) ? options : {};
    return transaction((draft) => {
      const cutoff = Number(at) - retentionMs;
      let removed = 0;
      for (const account of Object.values(draft.accounts)) {
        for (const [key, message] of Object.entries(account.messages)) {
          const done = (message.status === 'sent' || message.status === 'suppressed'
            || message.status === 'cancelled') && Number(message.completedAt || 0) <= cutoff;
          if (!done) continue;
          delete account.messages[key];
          for (const [segmentKey, segment] of Object.entries(account.segments)) {
            if (segment.messageKey === key) delete account.segments[segmentKey];
          }
          removed += 1;
        }
      }
      return { removed };
    }, { guard });
  }

  function statusCounters() {
    return read((current) => {
      const out = {
        messages: 0, sent: 0, unfinished: 0, suppressed: 0, cancelled: 0,
        segments: 0, planned: 0, sending: 0, pending: 0, unknown: 0, failed: 0, superseded: 0,
        conversations: 0, pendingConversations: 0, gapConversations: 0,
        bytes: Buffer.byteLength(JSON.stringify(current)),
      };
      for (const account of Object.values(current.accounts || {})) {
        out.conversations += Object.keys(account.conversations || {}).length;
        for (const conversation of Object.values(account.conversations || {})) {
          if (conversation.pending) out.pendingConversations += 1;
          if (conversation.gap) out.gapConversations += 1;
        }
        for (const message of Object.values(account.messages || {})) {
          out.messages += 1;
          if (Object.prototype.hasOwnProperty.call(out, message.status)) out[message.status] += 1;
        }
        for (const segment of Object.values(account.segments || {})) {
          out.segments += 1;
          if (Object.prototype.hasOwnProperty.call(out, segment.state)) out[segment.state] += 1;
        }
      }
      return out;
    });
  }

  const api = {
    ready,
    filePath,
    transaction,
    read,
    flush: () => tail,
    setAccount,
    bindOwner,
    setTarget,
    setConfig,
    cancelMessage,
    prune,
    statusCounters,
    current: () => read((value) => clone(value)),
    binding: () => read((value) => clone(value.binding)),
    config: () => read((value) => clone(value.config)),
    currentAccount: () => read((value) => {
      const account = value.currentAccountKey ? value.accounts[value.currentAccountKey] : null;
      return account ? clone(account) : null;
    }),
    loadError: () => loadError,
    limits: { maxUnfinished: limitUnfinished, maxFileBytes: limitBytes },
    ensureAccount: (input, { guard } = {}) => transaction(
      (draft) => clone(ensureXhhAccount(draft, { ...input, now: now() })),
      { guard },
    ),
  };
  return api;
}
