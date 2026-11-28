import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDmAcceptanceLog } from '../dm-acceptance.js';

const T = 1_700_000_000_000;

async function tempDir() {
  return fs.mkdtemp(path.join(process.cwd(), '.tmp-xhh-acceptance-'));
}

test('acceptance keeps fixed safe fields and refuses secrets or arbitrary strings', async () => {
  const dir = await tempDir();
  try {
    const log = createDmAcceptanceLog({ dataDir: dir, now: () => T });
    await log.ready;
    const accepted = await log.record('sync', {
      providerId: 'xiaoheihe',
      phase: 'watching',
      action: 'completed',
      counts: { messages: 2, enqueued: 1 },
      bools: { ok: true, baselineComplete: true },
      messageHash: 'a'.repeat(32),
      conversationHash: 'b'.repeat(32),
      targetKind: 'c2c',
      maskedTarget: '***1234',
      sessionVersion: 1,
      at: T,
      serverTime: T,
    });
    assert.equal(accepted.accepted, true);
    const rejected = await log.record('message', {
      phase: 'send',
      action: 'completed',
      text: '这是私信正文',
      cookie: 'SESSDATA=secret-value',
    });
    assert.equal(rejected.accepted, false);
    const badPhase = await log.record('message', {
      phase: '自由文本阶段', action: 'completed',
    });
    assert.equal(badPhase.accepted, false);
    await log.flush();
    const snapshot = log.snapshot({ limit: 50 });
    const serialized = JSON.stringify(snapshot);
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.count, 1);
    assert.equal(serialized.includes('私信正文'), false);
    assert.equal(serialized.includes('SESSDATA'), false);
    assert.equal(serialized.includes('secret-value'), false);
    assert.equal(snapshot.events[0].messageHash, 'a'.repeat(32));
    assert.equal(snapshot.events[0].counts.messages, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('acceptance rotates to its bounded event limit', async () => {
  const dir = await tempDir();
  try {
    const log = createDmAcceptanceLog({ dataDir: dir, now: () => T, maxEvents: 3 });
    await log.ready;
    for (let index = 0; index < 5; index += 1) {
      const result = await log.record('request', {
        phase: 'check', action: 'requested', attempts: index,
      });
      assert.equal(result.accepted, true);
    }
    const snapshot = log.snapshot({ limit: 10 });
    assert.equal(snapshot.count, 3);
    assert.equal(snapshot.dropped, 2);
    assert.equal(snapshot.events.length, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('acceptance persists across restart and reports corrupt logs as unavailable without deleting', async () => {
  const dir = await tempDir();
  try {
    const first = createDmAcceptanceLog({ dataDir: dir, now: () => T });
    await first.ready;
    await first.record('baseline', { phase: 'baseline', action: 'completed' });
    await first.record('reload', { phase: 'restart', action: 'drained' });
    await first.flush();
    const second = createDmAcceptanceLog({ dataDir: dir, now: () => T + 1 });
    await second.ready;
    assert.equal(second.snapshot().count, 2);

    const file = path.join(dir, 'dm-acceptance.json');
    await fs.writeFile(file, '{broken', 'utf8');
    const before = await fs.readFile(file, 'utf8');
    const third = createDmAcceptanceLog({ dataDir: dir, now: () => T + 2 });
    await third.ready;
    const snapshot = third.snapshot();
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.diagnostic, 'diagnostic_unavailable');
    const result = await third.record('sync', { phase: 'watching', action: 'completed' });
    assert.equal(result.accepted, false);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('acceptance write failures never throw into delivery', async () => {
  const dir = await tempDir();
  try {
    const log = createDmAcceptanceLog({
      dataDir: dir,
      now: () => T,
      fs: {
        async readFile() {
          const error = new Error('ENOENT');
          error.code = 'ENOENT';
          throw error;
        },
        async writeFile() {
          const error = new Error('disk full');
          error.code = 'ENOSPC';
          throw error;
        },
        async rename() { throw new Error('no rename'); },
        async unlink() {},
        async mkdir() {},
      },
    });
    await log.ready;
    const result = await log.record('delivery', {
      phase: 'send', action: 'sent', bools: { hostSent: true },
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostic, 'unavailable');
    assert.equal(log.snapshot().available, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
