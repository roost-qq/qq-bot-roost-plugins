import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accountScopeKey, createXhhDmStore, ensureXhhConversation, makeXhhMessageKey,
  makeXhhRequestId, makeXhhSegmentKey, shortXhhMessageId,
} from '../xiaoheihe-dm-store.js';

const T = 1_700_000_000_000;

async function tempDir() {
  return fs.mkdtemp(path.join(process.cwd(), '.tmp-xhh-store-'));
}

function addMessage(account, {
  messageId = 'opaque/message-1', seq = 'seq-α', text = '正文', key,
} = {}) {
  const peerId = 'peer-1';
  const conversation = ensureXhhConversation(account, {
    peerId, baselineCutoffMs: T, adopted: true, now: T,
  });
  conversation.baselineComplete = true;
  const messageKey = key || makeXhhMessageKey({
    robotKey: 'bot-1',
    accountScope: account.partition,
    peerId,
    messageId,
    seq,
  });
  account.messages[messageKey] = {
    key: messageKey,
    accountScope: account.partition,
    peerId,
    conversationKey: conversation.key,
    messageId,
    seq,
    senderId: peerId,
    senderName: '对方',
    text,
    imageUrls: [],
    shareUrls: [],
    sentAtMs: T + 1000,
    type: 'text',
    status: 'unfinished',
    deliveryState: 'queued',
    createdAt: T,
    completedAt: null,
  };
  return messageKey;
}

test('store persists real temp file state and restarts without resetting baseline', async () => {
  const dir = await tempDir();
  try {
    const store = createXhhDmStore({ dataDir: dir, robotKey: 'bot-1', now: () => T });
    await store.ready;
    const account = await store.setAccount({
      accountKey: 'account-A', accountEpoch: 'epoch-1', sessionVersion: 1,
    });
    await store.bindOwner('owner-1');
    await store.setTarget({ targetKind: 'c2c', target: 'owner-1' });
    const persisted = await store.transaction((draft) => {
      const current = draft.accounts[account.partition];
      const messageKey = addMessage(current);
      const segmentKey = makeXhhSegmentKey({
        messageKey, bindingVersion: 1, target: 'owner-1', index: 0,
      });
      const requestId = makeXhhRequestId({
        robotKey: 'bot-1',
        accountScope: current.partition,
        target: 'owner-1',
        bindingVersion: 1,
        messageKey,
        index: 0,
      });
      current.segments[segmentKey] = {
        key: segmentKey,
        messageKey,
        accountScope: current.partition,
        target: 'owner-1',
        targetKind: 'c2c',
        bindingVersion: 1,
        index: 0,
        total: 1,
        body: '正文',
        requestId,
        state: 'planned',
        attempts: 0,
        createdAt: T,
        updatedAt: T,
        nextRetryAt: 0,
        lastErrorCode: '',
        sentAt: null,
      };
      return { messageKey, segmentKey, requestId };
    });
    const { messageKey } = persisted;
    await store.flush();

    const reloaded = createXhhDmStore({ dataDir: dir, robotKey: 'bot-1', now: () => T + 1 });
    await reloaded.ready;
    const state = reloaded.current();
    assert.equal(state.binding.ownerTarget, 'owner-1');
    const restored = state.accounts[account.partition];
    assert.equal(restored.messages[messageKey].text, '正文');
    assert.equal(restored.conversations['peer:peer-1'].baselineComplete, true);
    assert.equal(restored.messages[messageKey].messageId, 'opaque/message-1');
    assert.equal(restored.segments[persisted.segmentKey].requestId, persisted.requestId);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('corrupt state file is preserved and never rebuilt as empty', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'xiaoheihe-dm-state.json');
    await fs.writeFile(file, '{"schemaVersion":1,"broken":', 'utf8');
    const before = await fs.readFile(file, 'utf8');
    const store = createXhhDmStore({ dataDir: dir, robotKey: 'bot-1' });
    await assert.rejects(store.ready, { code: 'XHH_STATE_CORRUPT' });
    assert.equal(await fs.readFile(file, 'utf8'), before);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('opaque message identity is stable, non-numeric and target/version scoped', async () => {
  const robotKey = 'bot-1';
  const scope = accountScopeKey('account-A', 'epoch-1');
  const first = makeXhhMessageKey({
    robotKey, accountScope: scope, peerId: 'peer/α', messageId: 'm-α', seq: 's-9',
  });
  const again = makeXhhMessageKey({
    robotKey, accountScope: scope, peerId: 'peer/α', messageId: 'm-α', seq: 's-9',
  });
  const other = makeXhhMessageKey({
    robotKey, accountScope: scope, peerId: 'peer/α', messageId: 'm-β', seq: 's-9',
  });
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.match(shortXhhMessageId(first), /^[A-F0-9]{12}$/);
  const requestA = makeXhhRequestId({
    robotKey, accountScope: scope, target: 'owner-1', bindingVersion: 1,
    messageKey: first, index: 0,
  });
  const requestB = makeXhhRequestId({
    robotKey, accountScope: scope, target: 'owner-1', bindingVersion: 2,
    messageKey: first, index: 0,
  });
  assert.match(requestA, /^xhh-dm:[a-f0-9]{40}$/);
  assert.notEqual(requestA, requestB);
  const segment = makeXhhSegmentKey({
    messageKey: first, bindingVersion: 1, target: 'owner-1', index: 0,
  });
  assert.ok(segment.includes('owner-1'));
});

test('capacity rejects extra unfinished messages and preserves prior file', async () => {
  const dir = await tempDir();
  try {
    const store = createXhhDmStore({
      dataDir: dir, robotKey: 'bot-1', maxUnfinished: 1, now: () => T,
    });
    await store.ready;
    const account = await store.setAccount({
      accountKey: 'account-A', accountEpoch: 'epoch-1', sessionVersion: 1,
    });
    await store.bindOwner('owner-1');
    await store.transaction((draft) => {
      addMessage(draft.accounts[account.partition], { messageId: 'm-1', seq: 's-1' });
    });
    await assert.rejects(store.transaction((draft) => {
      addMessage(draft.accounts[account.partition], { messageId: 'm-2', seq: 's-2' });
    }), { code: 'XHH_CAPACITY' });
    assert.equal(store.statusCounters().unfinished, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('same account epoch rotation keeps one partition and a new account gets a new partition', async () => {
  const dir = await tempDir();
  try {
    const store = createXhhDmStore({ dataDir: dir, robotKey: 'bot-1', now: () => T });
    await store.ready;
    const first = await store.setAccount({
      accountKey: 'account-A', accountEpoch: 'epoch-1', sessionVersion: 1,
    });
    await store.bindOwner('owner-1');
    await store.transaction((draft) => {
      addMessage(draft.accounts[first.partition], { messageId: 'old-account-message', seq: 's-old' });
    });
    const second = await store.setAccount({
      accountKey: 'account-A', accountEpoch: 'epoch-2', sessionVersion: 2,
    });
    assert.equal(first.partition, second.partition);
    const current = store.currentAccount();
    assert.equal(current.partition, second.partition);
    assert.equal(Object.keys(current.messages).length, 1);
    assert.equal(current.accountEpoch, 'epoch-2');
    assert.equal(current.sessionVersion, 2);
    assert.equal(Object.keys(store.current().accounts).length, 1);

    await store.transaction((draft) => {
      addMessage(draft.accounts[first.partition], { messageId: 'old-account-message', seq: 's-old' });
    });
    assert.equal(store.statusCounters().messages, 1);

    const other = await store.setAccount({
      accountKey: 'account-B', accountEpoch: 'epoch-1', sessionVersion: 1,
    });
    assert.notEqual(other.partition, first.partition);
    assert.equal(Object.keys(store.current().accounts).length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('cancel removes unattempted segments and marks message cancelled', async () => {
  const dir = await tempDir();
  try {
    const store = createXhhDmStore({ dataDir: dir, robotKey: 'bot-1', now: () => T });
    await store.ready;
    const account = await store.setAccount({
      accountKey: 'account-A', accountEpoch: 'epoch-1', sessionVersion: 1,
    });
    await store.bindOwner('owner-1');
    await store.setTarget({ targetKind: 'c2c', target: 'owner-1' });
    const messageKey = await store.transaction((draft) => {
      const current = draft.accounts[account.partition];
      const key = addMessage(current, { messageId: 'm-cancel', seq: 's-cancel' });
      const segmentKey = makeXhhSegmentKey({
        messageKey: key, bindingVersion: 1, target: 'owner-1', index: 0,
      });
      current.segments[segmentKey] = {
        key: segmentKey,
        messageKey: key,
        accountScope: current.partition,
        target: 'owner-1',
        targetKind: 'c2c',
        bindingVersion: 1,
        index: 0,
        total: 1,
        body: 'body',
        requestId: makeXhhRequestId({
          robotKey: 'bot-1',
          accountScope: current.partition,
          target: 'owner-1',
          bindingVersion: 1,
          messageKey: key,
          index: 0,
        }),
        state: 'planned',
        attempts: 0,
        createdAt: T,
        updatedAt: T,
        nextRetryAt: 0,
        lastErrorCode: '',
        sentAt: null,
      };
      return key;
    });
    const result = await store.cancelMessage(messageKey);
    assert.equal(result.cancelled, true);
    const state = store.current().accounts[account.partition];
    assert.equal(state.messages[messageKey].status, 'cancelled');
    assert.equal(Object.keys(state.segments).length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
