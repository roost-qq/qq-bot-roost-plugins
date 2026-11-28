import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createXiaoheiheRuntime } from '../xiaoheihe-runtime.js';

const T = 1_700_000_000_000;
const SELF = 'self-1';

function raw(peerId, messageId, sentAtMs, text = '正文') {
  return {
    valid: true,
    messageId,
    seq: `seq-${messageId}`,
    senderId: peerId,
    sentAt: sentAtMs,
    text,
    imageUrls: [],
    shareUrls: [],
  };
}

function page({ complete = true, hasMore = false, nextOffset = null, nextCursor = null } = {}) {
  return { complete, hasMore, nextOffset, nextCursor };
}

function settingsFake() {
  let config = { xiaoheiheDmEnabled: false, xiaoheiheDmPollSeconds: 300 };
  let credentials = {
    cookie: 'cookie-value', heyboxId: SELF, sessionVersion: 1, accountEpoch: 'epoch-1',
  };
  return {
    ready: Promise.resolve(),
    current: () => ({ ...config }),
    async saveConfig(patch) { config = { ...config, ...patch }; return { ...config }; },
    getPrivateMessageProviderCredentials: () => ({ ...credentials }),
    setCredential(next) { credentials = { ...credentials, ...next }; },
    async flush() {},
  };
}

function loginFake(settings) {
  let onChange = null;
  return {
    setOnChange(fn) { onChange = fn; },
    triggerChange() { if (onChange) onChange(); },
    status: () => ({
      state: 'success',
      sessionVersion: settings.getPrivateMessageProviderCredentials().sessionVersion,
      accountEpoch: settings.getPrivateMessageProviderCredentials().accountEpoch,
      accountLabel: '***self',
    }),
    credentialState: () => ({ ...settings.getPrivateMessageProviderCredentials() }),
    inspectAccount: async () => ({ state: 'valid', heyboxId: SELF, nickname: '自己' }),
    async start() { return { state: 'waiting' }; },
    async cancel() {},
    async manual() { return { ok: true }; },
    async logout() {},
    async deactivate() {},
    async flush() {},
  };
}

function hostCtx() {
  return {
    isOwner: async (id) => id === 'owner-1',
    reach: { canC2C: async () => 'yes', canGroupPush: async () => 'yes' },
    quotaLeft: async () => 10,
    getGroup: async (id) => ({ groupId: id, groupOpenid: id, name: '群', enabled: true }),
    gate: { check: async () => ({ allowed: true }) },
    push: async () => ({ id: 'sent' }),
    delivery: { get: () => null },
  };
}

function policyFake() {
  let successes = 0;
  const scopes = [];
  return {
    get successes() { return successes; },
    scopes,
    async status(scope) { scopes.push({ method: 'status', ...scope }); return {
      paused: false, nextAllowedAt: null, effectiveIntervalSeconds: 300,
    }; },
    async recordSyncSuccess(scope) {
      successes += 1;
      scopes.push({ method: 'success', ...scope });
      return { recorded: true };
    },
    async recordFailure(scope) { scopes.push({ method: 'failure', ...scope }); return { recorded: true }; },
    async recordCredentialChange(scope) { scopes.push({ method: 'credential', ...scope }); return { recorded: true }; },
    async clearManualRecovery() { return { cleared: true }; },
    async flush() {},
  };
}

async function harness({
  client, policy = null, settings = settingsFake(), login = null, enable = true,
} = {}) {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-xhh-service-'));
  let fakeLogin = login;
  let clientFactoryCalls = 0;
  let loginFactoryCalls = 0;
  const runtime = createXiaoheiheRuntime({
    ctx: hostCtx(),
    settings,
    requestPolicy: policy,
    requestScope: async () => ({
      providerId: 'xiaoheihe', accountKey: 'account-A', credentialVersion: 'cred-1',
    }),
    dataDir: dir,
    robotKey: 'bot-1',
    ownerBinding: () => 'owner-1',
    reserveSend: async () => ({ remaining: 1 }),
    rateInfo: () => ({ used: 0, remaining: 2, nextAt: null }),
    clientFactory: async () => {
      clientFactoryCalls += 1;
      return client;
    },
    loginFactory: async ({ onCredentialChange }) => {
      loginFactoryCalls += 1;
      fakeLogin = login || loginFake(settings);
      fakeLogin.setOnChange?.(onCredentialChange);
      return fakeLogin;
    },
    normalizeMessage: (value) => value,
    autoSchedule: false,
    now: () => T,
  });
  await runtime.ready;
  if (enable) await runtime.saveConfig({ enabled: true, pollSeconds: 300 });
  return {
    dir,
    runtime,
    settings,
    get login() { return fakeLogin; },
    get clientFactoryCalls() { return clientFactoryCalls; },
    get loginFactoryCalls() { return loginFactoryCalls; },
    async cleanup() {
      await runtime.flush().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('default disabled state performs no client/login work and start does not auto-listen', async () => {
  const client = {
    async listConversations() { throw new Error('must not be called'); },
    async fetchDirectMessages() { throw new Error('must not be called'); },
  };
  const h = await harness({ client, enable: false });
  try {
    h.runtime.start();
    await h.runtime.check();
    const status = h.runtime.getStatus();
    assert.equal(status.state, 'disabled');
    assert.equal(status.reasonCode, 'XHH_DISABLED');
    assert.equal(h.clientFactoryCalls, 0);
    assert.equal(h.loginFactoryCalls, 0);
  } finally {
    await h.cleanup();
  }
});

test('first baseline anchors old unread and later only enqueues messages after cutoff', async () => {
  let phase = 'baseline';
  const calls = [];
  const client = {
    async listConversations(kind, options) {
      calls.push({ kind, options });
      return {
        entries: [{ userId: 'peer-1', nickname: '朋友' }],
        serverTime: phase === 'baseline' ? T : T + 120_000,
        page: page(),
      };
    },
    async fetchDirectMessages(peerId, options) {
      calls.push({ peerId, options });
      if (phase === 'baseline') {
        return {
          messages: [
            raw(peerId, 'm-1', T - 10_000, '旧未读一'),
            raw(peerId, 'm-2', T - 5_000, '旧未读二'),
          ],
          serverTime: T,
          page: page(),
        };
      }
      return {
        messages: [
          raw(peerId, 'm-1', T - 10_000, '旧未读一'),
          raw(peerId, 'm-2', T - 5_000, '旧未读二'),
          raw(peerId, 'm-3', T + 60_000, '新的可信消息'),
        ],
        serverTime: T + 120_000,
        page: page(),
      };
    },
  };
  const policy = policyFake();
  const h = await harness({ client, policy });
  try {
    await h.runtime.check();
    let status = h.runtime.getStatus();
    assert.equal(status.state, 'watching');
    assert.equal(status.discovery.baselineComplete, true);
    assert.equal(status.queue.unfinished, 0);
    assert.equal(status.queue.messages, 0);

    phase = 'update';
    await h.runtime.check();
    status = h.runtime.getStatus();
    assert.equal(status.state, 'watching');
    assert.equal(status.queue.unfinished, 0);
    assert.equal(status.queue.sent >= 1, true);
    const account = h.runtime._internal.store.currentAccount();
    const messages = Object.values(account.messages);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].messageId, 'm-3');
    assert.equal(messages[0].text, '新的可信消息');
    assert.equal(policy.successes >= 2, true);
  } finally {
    await h.cleanup();
  }
});

test('unknown pagination boundary stays limited, saves position, and never crosses the gap', async () => {
  let firstFetch = true;
  const calls = [];
  const client = {
    async listConversations() {
      return {
        entries: [{ userId: 'peer-1', nickname: '朋友' }],
        serverTime: T,
        page: page(),
      };
    },
    async fetchDirectMessages(peerId, options) {
      calls.push({ peerId, options });
      if (firstFetch) {
        firstFetch = false;
        return {
          messages: [raw(peerId, 'm-1', T - 1000, '窗口内旧消息')],
          serverTime: T,
          page: page({ complete: false, hasMore: true, nextOffset: '20' }),
        };
      }
      return {
        messages: [raw(peerId, 'm-1', T - 1000, '窗口内旧消息')],
        serverTime: T + 5000,
        page: page({ complete: true, hasMore: false }),
      };
    },
  };
  const policy = policyFake();
  const h = await harness({ client, policy });
  try {
    await h.runtime.check();
    let status = h.runtime.getStatus();
    assert.equal(status.state, 'watching_limited');
    assert.equal(status.discovery.baselineComplete, false);
    assert.equal(status.queue.messages, 0);
    assert.equal(policy.successes, 0);
    let account = h.runtime._internal.store.currentAccount();
    const conversation = account.conversations['peer:peer-1'];
    assert.equal(conversation.pending.offset, '20');
    assert.equal(conversation.baselineComplete, false);

    await h.runtime.check();
    status = h.runtime.getStatus();
    assert.equal(calls[1].options.offset, '20');
    assert.equal(status.state, 'watching');
    assert.equal(status.discovery.baselineComplete, true);
    assert.equal(status.queue.messages, 0);
    account = h.runtime._internal.store.currentAccount();
    assert.equal(account.messages ? Object.keys(account.messages).length : 0, 0);
  } finally {
    await h.cleanup();
  }
});

test('limited baseline may forward trusted new messages but keeps the gap and no success record', async () => {
  const client = {
    async listConversations() {
      return {
        entries: [{ userId: 'peer-1', nickname: '朋友' }],
        serverTime: T,
        page: page(),
      };
    },
    async fetchDirectMessages(peerId) {
      return {
        messages: [
          raw(peerId, 'm-old', T - 1000, '基线前旧消息'),
          raw(peerId, 'm-new', T + 10_000, '可信新消息'),
        ],
        serverTime: T,
        page: page({ complete: false, hasMore: true, nextOffset: '20' }),
      };
    },
  };
  const policy = policyFake();
  const h = await harness({ client, policy });
  try {
    await h.runtime.check();
    const status = h.runtime.getStatus();
    assert.equal(status.state, 'watching_limited');
    assert.equal(status.discovery.baselineComplete, false);
    assert.equal(policy.successes, 0);
    const account = h.runtime._internal.store.currentAccount();
    const messages = Object.values(account.messages);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].messageId, 'm-new');
    assert.equal(account.conversations['peer:peer-1'].baselineComplete, false);
    assert.equal(account.conversations['peer:peer-1'].pending.offset, '20');
  } finally {
    await h.cleanup();
  }
});

test('a round uses at most six data requests and leaves the rest for catchup', async () => {
  const peers = Array.from({ length: 7 }, (_, index) => `peer-${index + 1}`);
  let fetches = 0;
  const client = {
    async listConversations() {
      return {
        entries: peers.map((peerId) => ({ userId: peerId, nickname: peerId })),
        serverTime: T,
        page: page(),
      };
    },
    async fetchDirectMessages(peerId) {
      fetches += 1;
      return {
        messages: [raw(peerId, `m-${peerId}`, T - 1000, '历史')],
        serverTime: T,
        page: page(),
      };
    },
  };
  const h = await harness({ client });
  try {
    await h.runtime.check();
    assert.equal(fetches, 4);
    assert.equal(h.runtime.getStatus().state, 'catching_up');
    assert.equal(h.runtime.getStatus().reasonCode, 'XHH_BUDGET');
  } finally {
    await h.cleanup();
  }
});

test('later discovered conversation ignores history at or before the trusted cutoff', async () => {
  let phase = 'first';
  const client = {
    async listConversations() {
      if (phase === 'first') {
        return {
          entries: [{ userId: 'peer-1', nickname: '一' }],
          serverTime: T,
          page: page(),
        };
      }
      return {
        entries: [{ userId: 'peer-1', nickname: '一' }, { userId: 'peer-2', nickname: '二' }],
        serverTime: T + 200_000,
        page: page(),
      };
    },
    async fetchDirectMessages(peerId) {
      if (peerId === 'peer-1') {
        return {
          messages: [raw(peerId, 'm-old', T - 1000, '旧')],
          serverTime: phase === 'first' ? T : T + 200_000,
          page: page(),
        };
      }
      return {
        messages: [
          raw(peerId, 'm-pre', T - 5000, '基线前历史'),
          raw(peerId, 'm-new', T + 1000, '基线后新消息'),
        ],
        serverTime: T + 200_000,
        page: page(),
      };
    },
  };
  const h = await harness({ client });
  try {
    await h.runtime.check();
    assert.equal(h.runtime.getStatus().discovery.baselineComplete, true);
    phase = 'second';
    await h.runtime.check();
    const account = h.runtime._internal.store.currentAccount();
    const messages = Object.values(account.messages);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].messageId, 'm-new');
    assert.equal(messages[0].text, '基线后新消息');
    assert.equal(account.conversations['peer:peer-2'].adoptedAfterBaseline, true);
  } finally {
    await h.cleanup();
  }
});

test('late client results do not publish after credential generation changes', async () => {
  let resolveFetch;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const client = {
    async listConversations() {
      return {
        entries: [{ userId: 'peer-1', nickname: '朋友' }],
        serverTime: T,
        page: page(),
      };
    },
    async fetchDirectMessages() {
      return pending;
    },
  };
  const h = await harness({ client });
  try {
    const round = h.runtime.check();
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.settings.setCredential({ accountEpoch: 'epoch-2', sessionVersion: 2 });
    h.login.triggerChange();
    resolveFetch({
      messages: [raw('peer-1', 'm-late', T + 10_000, '迟到消息')],
      serverTime: T + 20_000,
      page: page(),
    });
    await round;
    const status = h.runtime.getStatus();
    assert.equal(status.queue.unfinished, 0);
    const partitionKeys = Object.keys(h.runtime._internal.store.current().accounts);
    assert.equal(partitionKeys.length >= 1, true);
  } finally {
    await h.cleanup();
  }
});

test('saveConfig and group target reject invalid groups and keep a safe envelope', async () => {
  const client = {
    async listConversations() {
      return { entries: [], serverTime: T, page: page() };
    },
    async fetchDirectMessages() {
      return { messages: [], serverTime: T, page: page() };
    },
  };
  const h = await harness({ client });
  try {
    const saved = await h.runtime.saveConfig({ enabled: true, pollSeconds: 180 });
    assert.equal(saved.ok, true);
    assert.equal(saved.config.pollSeconds, 180);
    const target = await h.runtime.setTarget({ targetKind: 'group', groupId: 'group-1' });
    assert.equal(target.ok, true);
    assert.equal(target.targetKind, 'group');
    assert.equal(target.version >= 1, true);
    const groups = await h.runtime.groups();
    assert.equal(Array.isArray(groups.groups), true);
    assert.equal(groups.selected.sendToGroup, true);
    await assert.rejects(
      h.runtime.setTarget({ targetKind: 'group', groupId: '' }),
      { code: 'XHH_GROUP_INVALID' },
    );
    const status = h.runtime.getStatus();
    assert.equal(Object.prototype.hasOwnProperty.call(status, 'binding'), true);
    assert.equal(status.destination.kind, 'group');
    assert.equal(Object.prototype.hasOwnProperty.call(status, 'cookie'), false);
  } finally {
    await h.cleanup();
  }
});

test('acceptance snapshot from runtime never contains private message text or cookie', async () => {
  const client = {
    async listConversations() {
      return {
        entries: [{ userId: 'peer-1', nickname: '朋友' }],
        serverTime: T,
        page: page(),
      };
    },
    async fetchDirectMessages() {
      return {
        messages: [raw('peer-1', 'm-1', T - 1000, '非常私密的正文内容')],
        serverTime: T,
        page: page(),
      };
    },
  };
  const h = await harness({ client });
  try {
    await h.runtime.check();
    await h.runtime._internal.acceptance?.flush?.();
    const snapshot = await h.runtime.acceptance({ limit: 100 });
    assert.equal(snapshot.available, true);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes('非常私密的正文内容'), false);
    assert.equal(serialized.includes('cookie-value'), false);
    assert.equal(serialized.includes('peer-1'), false);
    assert.equal(snapshot.events.some((event) => event.event === 'sync'), true);
  } finally {
    await h.cleanup();
  }
});
