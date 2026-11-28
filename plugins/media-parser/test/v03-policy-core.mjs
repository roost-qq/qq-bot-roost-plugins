import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DM_POLL_LIMITS,
  RequestPolicyError,
  classifyRequestFailure,
  createPrivateMessageRequestPolicy,
  migratePollSeconds,
  parseRetryAfter,
} from '../private-message-request-policy.js';

const START = Date.UTC(2026, 10, 27, 12, 0, 0);
let originCounter = 0;

function nextOrigin() {
  originCounter += 1;
  return `v03-policy-${process.pid}-${originCounter}`;
}

async function fixture(t, { start = START, originKey = nextOrigin(), stateName = 'state.json' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-policy-v03-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clock = { value: start };
  const sleeps = [];
  const policy = createPrivateMessageRequestPolicy({
    statePath: path.join(dir, stateName),
    originKey,
    now: () => clock.value,
    random: () => 0,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new RequestPolicyError('REQUEST_CANCELLED');
      sleeps.push({ at: clock.value, ms });
      clock.value += ms;
    },
  });
  return {
    dir,
    policy,
    sleeps,
    now: () => clock.value,
    advance: (ms) => { clock.value += ms; },
    statePath: path.join(dir, stateName),
    originKey,
  };
}

const scope = { providerId: 'bilibili', accountKey: 'account-one' };

test('poll migration, Retry-After parsing and failure classification stay conservative', () => {
  assert.deepEqual(DM_POLL_LIMITS, {
    defaultSeconds: 300, minSeconds: 180, maxSeconds: 3600,
  });
  assert.deepEqual(
    migratePollSeconds(60),
    { seconds: 300, migrated: true, originalSeconds: 60, previousRange: [60, 1800] },
  );
  assert.equal(migratePollSeconds(180).seconds, 180);
  assert.equal(migratePollSeconds(180).migrated, false);
  assert.equal(migratePollSeconds(2000).seconds, 2000);
  assert.equal(migratePollSeconds(9999).seconds, 3600);
  assert.equal(migratePollSeconds(undefined).seconds, 300);

  const now = START;
  assert.equal(parseRetryAfter('120', { now }), 120_000);
  assert.equal(parseRetryAfter('Thu, 27 Nov 2026 21:00:00 GMT', { now }), 9 * 60 * 60_000);
  assert.equal(parseRetryAfter(String(9 * 60 * 60), { now }), 9 * 60 * 60_000);
  assert.equal(parseRetryAfter('invalid', { now }), 0);
  assert.equal(parseRetryAfter('-2', { now }), 0);

  assert.equal(classifyRequestFailure({ code: 'BILI_RATE_LIMIT' }).kind, 'rate_limit');
  assert.equal(classifyRequestFailure({ code: 'BILI_AUTH' }).kind, 'auth');
  assert.equal(classifyRequestFailure({ status: 403 }).kind, 'rejected');
  assert.equal(classifyRequestFailure({ status: 412 }).kind, 'rejected');
  assert.equal(classifyRequestFailure({ code: 'BILI_HTTP', status: 412 }).kind, 'rejected');
  assert.equal(classifyRequestFailure({ code: 'BILI_RISK', apiCode: -412 }).kind, 'rejected');
  assert.equal(classifyRequestFailure({ code: 'BILI_CHALLENGE' }).kind, 'challenge');
  assert.equal(classifyRequestFailure({ code: 'BILI_HTTP', status: 503 }).kind, 'transient');
  assert.equal(classifyRequestFailure({ name: 'AbortError' }).kind, 'cancelled');

  assert.equal(classifyRequestFailure({ code: 'XHH_RATE_LIMIT' }).kind, 'rate_limit');
  assert.equal(classifyRequestFailure({ code: 'XHH_AUTH' }).kind, 'auth');
  assert.equal(classifyRequestFailure({ code: 'XHH_RISK' }).kind, 'rejected');
  assert.equal(classifyRequestFailure({ code: 'XHH_CHALLENGE' }).kind, 'challenge');
  assert.equal(classifyRequestFailure({ code: 'XHH_TIMEOUT' }).kind, 'timeout');
  assert.equal(classifyRequestFailure({ code: 'XHH_NETWORK' }).kind, 'network');
  assert.equal(classifyRequestFailure({ code: 'XHH_HTTP', status: 503 }).kind, 'transient');
  assert.equal(classifyRequestFailure({ code: 'XHH_HTTP', status: 403 }).kind, 'rejected');
  assert.equal(classifyRequestFailure({ code: 'XHH_RESPONSE' }).kind, 'response');
  assert.equal(classifyRequestFailure({ code: 'XHH_API' }).kind, 'api');
  assert.equal(classifyRequestFailure({ code: 'XHH_CANCELLED' }).kind, 'cancelled');
  assert.equal(classifyRequestFailure({ code: 'XHH_RATE_LIMIT', retryAfterMs: 9 * 60 * 60_000 }).retryAfterMs, 9 * 60 * 60_000);
  // Existing Bilibili semantics stay unchanged.
  assert.equal(classifyRequestFailure({ code: 'BILI_RISK', apiCode: -412 }).kind, 'rejected');
});

test('requests use actual dispatch spacing, persist before work and expose budget status', async (t) => {
  const env = await fixture(t);
  const executed = [];
  for (let index = 0; index < 2; index += 1) {
    await env.policy.run({
      ...scope, requestKey: `/control-${index}`, kind: 'control',
    }, async () => {
      const persisted = JSON.parse(await fs.readFile(env.statePath, 'utf8'));
      const provider = persisted.providers.bilibili;
      assert.ok(provider.requestTimes.length >= index + 1);
      executed.push(env.now());
      return index;
    });
  }
  assert.deepEqual(executed, [START, START + 5_000]);
  assert.equal(env.sleeps[0].ms, 5_000);
  const status = await env.policy.status({ ...scope, pollSeconds: 60 });
  assert.equal(status.configuredIntervalSeconds, 300);
  assert.equal(status.budget.totalUsed, 2);
  assert.equal(status.budget.totalLimit, 10);
  assert.equal(status.budget.dataLimit, 6);
  assert.equal(status.paused, false);
});

test('total and data sliding windows reject requests without running the task', async (t) => {
  const env = await fixture(t);
  let executed = 0;
  for (let index = 0; index < 10; index += 1) {
    await env.policy.run({
      ...scope, requestKey: `/c-${index}`, kind: 'control',
    }, async () => { executed += 1; });
  }
  await assert.rejects(
    env.policy.run({ ...scope, requestKey: '/c-over', kind: 'control' }, async () => { executed += 1; }),
    { code: 'REQUEST_BUDGET' },
  );
  assert.equal(executed, 10);

  const dataEnv = await fixture(t);
  for (let index = 0; index < 6; index += 1) {
    await dataEnv.policy.run({
      ...scope, requestKey: `/d-${index}`, kind: 'data',
    }, async () => { executed += 1; });
  }
  await assert.rejects(
    dataEnv.policy.run({ ...scope, requestKey: '/d-over', kind: 'data' }, async () => { executed += 1; }),
    { code: 'REQUEST_BUDGET' },
  );
  assert.equal(executed, 16);
});

test('same origin budget is shared by two policy objects in the same process', async (t) => {
  const originKey = nextOrigin();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-policy-shared-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clock = { value: START };
  const make = (name) => createPrivateMessageRequestPolicy({
    statePath: path.join(dir, `${name}.json`),
    originKey,
    now: () => clock.value,
    random: () => 0,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new RequestPolicyError('REQUEST_CANCELLED');
      clock.value += ms;
    },
  });
  const left = make('bot-left');
  const right = make('bot-right');
  for (let index = 0; index < 5; index += 1) {
    await left.run({ ...scope, requestKey: `/left-${index}`, kind: 'control' }, async () => index);
    await right.run({ ...scope, requestKey: `/right-${index}`, kind: 'control' }, async () => index);
  }
  await assert.rejects(
    left.run({ ...scope, requestKey: '/left-over', kind: 'control' }, async () => 1),
    { code: 'REQUEST_BUDGET' },
  );
  const status = await left.status({ ...scope, pollSeconds: 300 });
  assert.equal(status.budget.totalUsed, 10);
});

test('cooldown persists across reload and long Retry-After is not truncated', async (t) => {
  const env = await fixture(t);
  const retry = 9 * 60 * 60_000;
  await env.policy.recordFailure({ ...scope, kind: 'rate_limit', retryAfterMs: retry });
  let status = await env.policy.status({ ...scope, pollSeconds: 300 });
  assert.equal(status.paused, true);
  assert.equal(status.cooldownReason, 'rate_limit');
  assert.equal(status.nextAllowedAt, env.now() + retry);
  assert.equal(status.effectiveIntervalSeconds, retry / 1000);

  const reloaded = createPrivateMessageRequestPolicy({
    statePath: env.statePath,
    originKey: env.originKey,
    now: env.now,
  });
  status = await reloaded.status({ ...scope, pollSeconds: 300 });
  assert.equal(status.paused, true, 'reload must not bypass persisted cooldown');
  await assert.rejects(
    reloaded.run({ ...scope, requestKey: '/blocked', kind: 'data' }, async () => 1),
    { code: 'REQUEST_COOLDOWN' },
  );

  for (let probe = 0; probe < 3; probe += 1) {
    await env.policy.recordFailure({
      ...scope, kind: 'rate_limit', recoveryAttempt: true,
    });
  }
  status = await env.policy.status({ ...scope, pollSeconds: 300 });
  assert.equal(status.requiresManualRecovery, true);
  assert.equal(status.nextAllowedAt, env.now() + retry);
  assert.equal(status.serverNextAllowedAt, env.now() + retry);
  const released = await env.policy.clearManualRecovery({ providerId: 'bilibili' });
  assert.equal(released.cleared, true);
  assert.equal(released.released, 'one-recovery-workflow');
  status = await env.policy.status({ ...scope, pollSeconds: 300 });
  assert.equal(status.requiresManualRecovery, false);
  assert.equal(status.nextAllowedAt, env.now() + retry, 'server Retry-After survives manual restore');
});

test('expired cooldown admits exactly one data recovery workflow and its later pages', async (t) => {
  const env = await fixture(t);
  const workflowScope = { ...scope, credentialVersion: 'credential-sync-a' };
  await env.policy.recordFailure({ ...workflowScope, kind: 'rate_limit' });
  env.advance(15 * 60_000);
  assert.equal(
    await env.policy.run({
      ...workflowScope, requestKey: '/probe-page-1', kind: 'data', workflowId: 'sync-a',
    }, async () => 'page-1'),
    'page-1',
  );
  let status = await env.policy.status({ ...workflowScope, pollSeconds: 300 });
  assert.equal(status.recoveryProbePending, true);
  await assert.rejects(
    env.policy.run({
      ...workflowScope, requestKey: '/click-data', kind: 'data', workflowId: 'click-b',
    }, async () => 'other'),
    { code: 'REQUEST_COOLDOWN' },
  );
  assert.equal(
    await env.policy.run({
      ...workflowScope, requestKey: '/probe-page-2', kind: 'data', workflowId: 'sync-a',
    }, async () => 'page-2'),
    'page-2',
  );
  await assert.rejects(
    env.policy.run({
      ...workflowScope, requestKey: '/probe-nav-other', kind: 'control', workflowId: 'click-b',
    }, async () => 'nav'),
    { code: 'REQUEST_COOLDOWN' },
  );
  assert.equal(
    await env.policy.run({
      ...workflowScope, requestKey: '/probe-nav-same', kind: 'control', workflowId: 'sync-a',
    }, async () => 'nav'),
    'nav',
  );
  await env.policy.recordSyncSuccess({ ...workflowScope, workflowId: 'sync-a' });
  status = await env.policy.status({ ...workflowScope, pollSeconds: 300 });
  assert.equal(status.recoveryProbePending, false);
  assert.equal(
    await env.policy.run({ ...workflowScope, requestKey: '/after-recovery', kind: 'data' }, async () => 'after'),
    'after',
  );
});

test('five complete successes progressively halve the adaptive interval', async (t) => {
  const env = await fixture(t);
  const workflowScope = { ...scope, credentialVersion: 'credential-five' };
  await env.policy.recordFailure({ ...workflowScope, kind: 'rate_limit' });
  env.advance(15 * 60_000);
  await env.policy.run({
    ...workflowScope, requestKey: '/recovery-start', kind: 'data', workflowId: 'sync-five',
  }, async () => 1);
  await env.policy.recordSyncSuccess({ ...workflowScope, workflowId: 'sync-five' });
  let status = await env.policy.status({ ...workflowScope, pollSeconds: 300 });
  assert.equal(status.adaptiveMultiplier, 2);
  for (let index = 0; index < 4; index += 1) await env.policy.recordSyncSuccess(scope);
  status = await env.policy.status({ ...scope, pollSeconds: 300 });
  assert.equal(status.adaptiveMultiplier, 1);
  assert.equal(status.effectiveIntervalSeconds, 300);
});

test('stale workflow or credential cannot clear another recovery history', async (t) => {
  const env = await fixture(t);
  const credentialScope = { ...scope, credentialVersion: 'credential-a' };
  await env.policy.recordFailure({ ...credentialScope, kind: 'rate_limit' });
  env.advance(15 * 60_000);
  await env.policy.run({
    ...credentialScope,
    requestKey: '/recovery-page',
    kind: 'data',
    workflowId: 'complete-sync-a',
  }, async () => 1);

  assert.deepEqual(
    await env.policy.recordSyncSuccess({
      ...scope,
      credentialVersion: 'credential-b',
      workflowId: 'complete-sync-a',
    }),
    { recorded: false, staleCredential: true },
  );
  assert.deepEqual(
    await env.policy.recordSyncSuccess({
      ...credentialScope,
      workflowId: 'different-workflow',
    }),
    { recorded: false, staleWorkflow: true },
  );
  assert.equal(
    (await env.policy.status({ ...credentialScope, pollSeconds: 300 })).recoveryProbePending,
    true,
  );
  const recorded = await env.policy.recordSyncSuccess({
    ...credentialScope,
    workflowId: 'complete-sync-a',
  });
  assert.equal(recorded.recorded, true);
});

test('corrupt state, unsupported state and write failures stay paused', async (t) => {
  const env = await fixture(t);
  const corrupt = '{"schemaVersion":1,"providers":';
  await fs.writeFile(env.statePath, corrupt, 'utf8');
  const corruptPolicy = createPrivateMessageRequestPolicy({
    statePath: env.statePath, originKey: env.originKey, now: env.now,
  });
  let status = await corruptPolicy.status({ ...scope, pollSeconds: 300 });
  assert.equal(status.paused, true);
  assert.equal(status.pauseReason, 'corrupt');
  await assert.rejects(
    corruptPolicy.run({ ...scope, requestKey: '/corrupt', kind: 'data' }, async () => 1),
    { code: 'REQUEST_POLICY_UNAVAILABLE' },
  );
  assert.equal(await fs.readFile(env.statePath, 'utf8'), corrupt);

  const futurePath = path.join(env.dir, 'future.json');
  const future = '{"schemaVersion":2,"providers":{}}\n';
  await fs.writeFile(futurePath, future, 'utf8');
  const futurePolicy = createPrivateMessageRequestPolicy({
    statePath: futurePath, originKey: env.originKey, now: env.now,
  });
  status = await futurePolicy.status({ ...scope, pollSeconds: 300 });
  assert.equal(status.paused, true);
  assert.equal(status.pauseReason, 'unsupported');
  assert.equal(await fs.readFile(futurePath, 'utf8'), future);

  const writeEnv = await fixture(t, { stateName: 'nested/state.json' });
  await writeEnv.policy.run({ ...scope, requestKey: '/first', kind: 'control' }, async () => 1);
  const nestedDir = path.join(writeEnv.dir, 'nested');
  await fs.rm(nestedDir, { recursive: true, force: true });
  await fs.writeFile(nestedDir, 'not-a-directory', 'utf8');
  await assert.rejects(
    writeEnv.policy.run({ ...scope, requestKey: '/write-fail', kind: 'control' }, async () => 1),
    { code: 'REQUEST_POLICY_UNAVAILABLE' },
  );
  status = await writeEnv.policy.status({ ...scope, pollSeconds: 300 });
  assert.equal(status.paused, true);
  assert.equal(status.pauseReason, 'write_failed');
});

test('waiter cancellation does not abort another caller sharing the same deduplicated work', async (t) => {
  const env = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let executions = 0;
  const firstController = new AbortController();
  const first = env.policy.run({
    ...scope, requestKey: '/same-work', kind: 'data', signal: firstController.signal,
  }, async () => {
    executions += 1;
    await gate;
    return 'shared';
  });
  const second = env.policy.run({
    ...scope, requestKey: '/same-work', kind: 'data',
  }, async () => {
    executions += 1;
    return 'duplicate-must-not-run';
  });
  const third = env.policy.run({
    ...scope, requestKey: '/same-work', kind: 'data',
  }, async () => {
    executions += 1;
    return 'duplicate-must-not-run';
  });
  for (let attempt = 0; attempt < 50 && executions === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(executions, 1);
  firstController.abort();
  await assert.rejects(first, { code: 'REQUEST_CANCELLED' });
  release();
  assert.deepEqual(await Promise.all([second, third]), ['shared', 'shared']);
  assert.equal(executions, 1);
});

test('different credential versions never coalesce one request key', async (t) => {
  const env = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let executions = 0;
  const first = env.policy.run({
    ...scope, credentialVersion: 'credential-v1', requestKey: '/nav', kind: 'control',
  }, async () => {
    executions += 1;
    await gate;
    return 'v1';
  });
  const second = env.policy.run({
    ...scope, credentialVersion: 'credential-v2', requestKey: '/nav', kind: 'control',
  }, async () => {
    executions += 1;
    return 'v2';
  });
  for (let attempt = 0; attempt < 50 && executions === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(executions, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['v1', 'v2']);
  assert.equal(executions, 2);
});
