import test from 'node:test';
import assert from 'node:assert/strict';
import { createXhhDmStore, ensureXhhConversation, makeXhhMessageKey } from '../xiaoheihe-dm-store.js';
import { createXiaoheiheDmDelivery } from '../xiaoheihe-dm-delivery.js';
import { createBiliDmStore } from '../bili-dm-store.js';

const T = 1_700_000_000_000;

function memoryFs() {
  const files = new Map();
  return {
    async readFile(file) {
      if (!files.has(file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    async writeFile(file, data) { files.set(file, String(data)); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async unlink(file) { files.delete(file); },
    async mkdir() {},
  };
}

function host({
  owner = 'owner-1', reach = 'yes', quota = 10, responder = null, replyResponder = null,
  clock = () => T,
} = {}) {
  const calls = [];
  const replies = [];
  const ledger = new Map();
  const ctx = {
    isOwner: async (id) => id === owner,
    reach: {
      canC2C: async () => reach,
      canGroupPush: async () => reach,
    },
    quotaLeft: async () => quota,
    getGroup: async (id) => ({ groupId: id, groupOpenid: id, name: '测试群', enabled: true }),
    gate: { check: async () => ({ allowed: true }) },
    push: async (target, text, options) => {
      const call = { target, text, options };
      calls.push(call);
      if (responder) return responder(call, calls);
      ledger.set(options.requestId, { state: 'sent' });
      return { id: `sent-${calls.length}` };
    },
    delivery: { get: (requestId) => ledger.get(requestId) || null },
  };
  const makeMsg = (userId = owner, id = 'incoming-1') => {
    const msg = {
      id,
      kind: 'c2c',
      chatId: userId,
      userId,
      receivedAt: clock(),
      async replyNow(text, options = {}) {
        const call = { target: userId, text, options, passive: true };
        replies.push(call);
        if (replyResponder) return replyResponder(call, replies);
        ledger.set(options.requestId, { state: 'sent' });
        return { id: `reply-${replies.length}` };
      },
    };
    return msg;
  };
  return { ctx, calls, replies, ledger, makeMsg };
}

async function setup({ hostOptions = {}, budget = null } = {}) {
  let clock = T;
  const fs = memoryFs();
  const store = createXhhDmStore({
    dataDir: '/data', robotKey: 'bot-1', fs, now: () => clock,
  });
  await store.ready;
  const account = await store.setAccount({
    accountKey: 'account-A', accountEpoch: 'epoch-1', sessionVersion: 1,
  });
  await store.bindOwner('owner-1');
  await store.setTarget({ targetKind: 'c2c', target: 'owner-1' });
  const h = host({ ...hostOptions, clock: () => clock });
  let reserveSend = null;
  if (budget === 'shared') {
    const biliFs = memoryFs();
    const biliStore = createBiliDmStore({
      dataDir: '/bili', robotKey: 'bot-1', fs: biliFs, now: () => clock, maxSendsPerWindow: 2,
    });
    await biliStore.ready;
    reserveSend = (options) => biliStore.reserveSendCall(options);
    h.biliStore = biliStore;
  } else {
    const used = [];
    reserveSend = async ({ at = clock } = {}) => {
      const recent = used.filter((value) => at - value < 60_000);
      if (recent.length >= 2) {
        const error = new Error('rate');
        error.code = 'DM_RATE_LIMIT';
        error.retryAfterMs = Math.max(0, 60_000 - (at - Math.min(...recent)));
        throw error;
      }
      recent.push(at);
      used.splice(0, used.length, ...recent);
      return { ok: true };
    };
  }
  const addMessage = async (text, { peerId = 'peer-1', messageId = `m-${text}`, sentAtMs = T + 1000 } = {}) => {
    return store.transaction((draft) => {
      const current = draft.accounts[account.partition];
      const conversation = ensureXhhConversation(current, {
        peerId, baselineCutoffMs: T, adopted: true, now: clock,
      });
      conversation.baselineComplete = true;
      const key = makeXhhMessageKey({
        robotKey: 'bot-1',
        accountScope: current.partition,
        peerId,
        messageId,
        seq: '',
      });
      current.messages[key] = {
        key,
        accountScope: current.partition,
        peerId,
        conversationKey: conversation.key,
        messageId,
        seq: '',
        senderId: peerId,
        senderName: '对方',
        text,
        imageUrls: [],
        shareUrls: [],
        sentAtMs,
        type: 'text',
        status: 'unfinished',
        deliveryState: 'queued',
        createdAt: clock,
        completedAt: null,
      };
      return key;
    });
  };
  const advance = (ms) => { clock += ms; };
  return {
    store, h, account, addMessage, advance, clock: () => clock,
    delivery: createXiaoheiheDmDelivery({
      store, ctx: h.ctx, reserveSend, now: () => clock,
    }),
    reserveSend,
  };
}

function accountSegments(store, account) {
  return Object.values(store.current().accounts[account.partition].segments);
}

test('ledger sent/pending/unknown/failed are distinct and unknown is not resent', async () => {
  const cases = [
    ['sent', null],
    ['pending', null],
    ['unknown', null],
    ['failed', null],
  ];
  for (const [state] of cases) {
    const f = await setup({
      hostOptions: {
        responder: (call) => {
          if (state === 'sent') {
            f.h.ledger.set(call.options.requestId, { state: 'sent' });
            return { id: 'ok' };
          }
          if (state === 'pending') {
            f.h.ledger.set(call.options.requestId, { state: 'pending' });
            return { id: 'pending' };
          }
          if (state === 'failed') {
            f.h.ledger.set(call.options.requestId, { state: 'failed' });
            return { ok: false };
          }
          return {};
        },
      },
    });
    const key = await f.addMessage(`状态-${state}`);
    await f.delivery.pump();
    const segments = accountSegments(f.store, f.account);
    const segment = segments.find((item) => item.messageKey === key);
    assert.equal(segment.state, state, state);
    assert.match(segment.requestId, /^xhh-dm:[a-f0-9]{40}$/);
    const calls = f.h.calls.length;
    await f.delivery.pump();
    assert.equal(f.h.calls.length, calls, `${state} must not be resent blindly`);
  }
});

test('shared 2/60s budget is used through the existing Bili store', async () => {
  const f = await setup({ budget: 'shared' });
  await f.h.biliStore.reserveSendCall({ at: T });
  await f.h.biliStore.reserveSendCall({ at: T });
  const key = await f.addMessage('共享预算');
  await f.delivery.pump();
  let segment = accountSegments(f.store, f.account).find((item) => item.messageKey === key);
  assert.equal(f.h.calls.length, 0);
  assert.equal(segment.state, 'planned');

  f.advance(60_001);
  await f.delivery.pump();
  segment = accountSegments(f.store, f.account).find((item) => item.messageKey === key);
  assert.equal(f.h.calls.length, 1);
  assert.equal(segment.state, 'sent');
});

test('owner, reach, quota and group gate all fence before ctx.push', async () => {
  const ownerDown = await setup({ hostOptions: { owner: 'someone-else' } });
  const ownerKey = await ownerDown.addMessage('owner');
  await ownerDown.delivery.pump();
  assert.equal(ownerDown.h.calls.length, 0);
  assert.equal(
    accountSegments(ownerDown.store, ownerDown.account).find((item) => item.messageKey === ownerKey).state,
    'planned',
  );

  const noReach = await setup({ hostOptions: { reach: 'no' } });
  const reachKey = await noReach.addMessage('reach');
  await noReach.delivery.pump();
  assert.equal(noReach.h.calls.length, 0);
  assert.equal(
    accountSegments(noReach.store, noReach.account).find((item) => item.messageKey === reachKey).state,
    'planned',
  );

  const noQuota = await setup({ hostOptions: { quota: 0 } });
  const quotaKey = await noQuota.addMessage('quota');
  await noQuota.delivery.pump();
  assert.equal(noQuota.h.calls.length, 0);
  assert.equal(
    accountSegments(noQuota.store, noQuota.account).find((item) => item.messageKey === quotaKey).state,
    'planned',
  );

  const group = await setup();
  await group.store.setTarget({ targetKind: 'group', target: 'group-1', groupName: '测试群' });
  const groupKey = await group.addMessage('group', { peerId: 'peer-group' });
  await group.delivery.pump();
  assert.equal(group.h.calls.length, 1);
  assert.equal(group.h.calls[0].options.kind, 'group');
  assert.equal(group.h.calls[0].target, 'group-1');
  assert.equal(
    accountSegments(group.store, group.account).find((item) => item.messageKey === groupKey).state,
    'sent',
  );
});

test('target version freeze prevents old batches from being sent to a new target', async () => {
  const f = await setup();
  const oldKey = await f.addMessage('旧目标消息', { peerId: 'old-peer' });
  await f.delivery.materializeBacklog();
  await f.store.setTarget({ targetKind: 'group', target: 'group-2', groupName: '新群' });
  const newKey = await f.addMessage('新目标消息', { peerId: 'new-peer' });
  await f.delivery.pump();
  assert.equal(f.h.calls.length, 1);
  assert.equal(f.h.calls[0].target, 'group-2');
  const segments = accountSegments(f.store, f.account);
  assert.equal(segments.find((item) => item.messageKey === oldKey).state, 'planned');
  assert.equal(segments.find((item) => item.messageKey === newKey).state, 'sent');
});

test('claim only works for the bound owner C2C and uses replyNow with stable request ids', async () => {
  const f = await setup();
  const key = await f.addMessage('领取测试');
  await f.delivery.materializeBacklog();
  const stranger = f.h.makeMsg('stranger-1', 'stranger-msg');
  await assert.rejects(f.delivery.claim(stranger), { code: 'XHH_OWNER_REQUIRED' });
  const ownerMsg = f.h.makeMsg('owner-1', 'owner-claim');
  const result = await f.delivery.claim(ownerMsg, { limit: 3 });
  assert.equal(result.sent, 1);
  assert.equal(f.h.replies.length, 1);
  assert.equal(f.h.replies[0].target, 'owner-1');
  assert.match(f.h.replies[0].options.requestId, /^xhh-dm:/);
  assert.equal(
    accountSegments(f.store, f.account).find((item) => item.messageKey === key).state,
    'sent',
  );
});

test('queued request can be cancelled before delivery', async () => {
  const f = await setup();
  const key = await f.addMessage('取消测试');
  await f.delivery.materializeBacklog();
  const shortId = f.delivery.pendingSummary().messages[0].shortId;
  const msg = f.h.makeMsg('owner-1', 'cancel-msg');
  const result = await f.delivery.cancel(msg, { shortId });
  assert.equal(result.ok, true);
  await f.delivery.pump();
  assert.equal(f.h.calls.length, 0);
  assert.equal(f.store.current().accounts[f.account.partition].messages[key].status, 'cancelled');
});
