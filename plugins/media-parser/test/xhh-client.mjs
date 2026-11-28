import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_ORIGIN,
  PATHS,
  XHH_SAFE_MESSAGES,
  createXiaoheiheClient,
  createXiaoheiheRequestScope,
  normalizeXiaoheiheMessage,
} from '../xiaoheihe-client.js';

const SERVER_DATE = 'Sat, 28 Nov 2026 10:00:00 GMT';
const SERVER_MS = Date.parse(SERVER_DATE);
const COOKIE = 'user_pkey=fixture-only-pkey; heybox_id=42';
const BIG_ID = '9007199254740993';

function rawResponse(body, { status = 200, headers = {} } = {}) {
  const merged = new Headers(headers);
  if (!merged.has('date')) merged.set('date', SERVER_DATE);
  if (!merged.has('content-type')) merged.set('content-type', 'application/json');
  return {
    statusCode: status,
    headers: merged,
    text: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function makeClient(requestImpl, options = {}) {
  let clock = 1_700_000_000_000;
  const client = createXiaoheiheClient({
    requestImpl,
    requestMinIntervalMs: 0,
    requestWindowMs: 1000,
    requestMaxPerWindow: 1000,
    timeoutMs: 200,
    now: () => clock,
    random: () => 0.5,
    ...options,
  });
  return { client, setClock: (value) => { clock = value; } };
}

function ok(payload, options) {
  return rawResponse(payload, options);
}

test('request scope uses the independent xiaoheihe partition and opaque summaries', async () => {
  const settings = {
    getPrivateMessageProviderCredentials(providerId) {
      assert.equal(providerId, 'xiaoheihe');
      return { cookie: 'user_pkey=stored-secret', heyboxId: '9007199254740993' };
    },
    getBiliCookie() { throw new Error('Bili scope must not be touched'); },
  };
  const scope = createXiaoheiheRequestScope(settings, 'bot-1');
  const candidate = await scope({
    cookie: 'user_pkey=candidate-secret',
    heyboxId: '42',
    workflowId: 'workflow-1',
  });
  assert.equal(candidate.providerId, 'xiaoheihe');
  assert.match(candidate.accountKey, /^xhh-[a-f0-9]{32}$/);
  assert.equal(candidate.accountKey.includes('42'), false);
  assert.equal(candidate.credentialVersion.includes('candidate-secret'), false);
  assert.equal(candidate.workflowId, 'workflow-1');

  const stored = await scope({});
  assert.equal(stored.providerId, 'xiaoheihe');
  assert.equal(stored.accountKey.includes(BIG_ID), false);
  assert.equal(stored.credentialVersion.includes('stored-secret'), false);
});

test('QR apply and poll use fixed GET paths, carry cookies and expose only login cookies', async () => {
  const calls = [];
  const { client } = makeClient(async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (calls.length === 1) {
      const headers = new Headers();
      headers.append('set-cookie', 'sid=session-secret; Path=/; Secure');
      return rawResponse({
        status: 'ok',
        result: { qr_url: 'https://www.xiaoheihe.cn/qr?qr=QR_TOKEN&extra=SECRET', expire: 120 },
      }, { headers });
    }
    const headers = new Headers();
    headers.append('set-cookie', 'user_pkey=pkey-secret; Path=/');
    headers.append('set-cookie', 'heybox_id=9007199254740993; Path=/');
    headers.append('set-cookie', 'nickname=%E6%B5%8B%E8%AF%95; Path=/');
    headers.append('set-cookie', 'other=not-needed; Path=/');
    return rawResponse({
      status: 'ok',
      result: { error: 'ok', heyboxid: BIG_ID, nickname: '测试', level: '3' },
    }, { headers });
  });

  const qr = await client.requestQr();
  assert.equal(calls[0].url.origin, API_ORIGIN);
  assert.equal(calls[0].url.pathname, PATHS.qrRequest);
  assert.equal(calls[0].url.searchParams.get('app'), 'web');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Cookie, undefined);
  assert.equal(qr.qrId, 'QR_TOKEN');
  assert.deepEqual(qr.pollParams, { qr: 'QR_TOKEN', app: 'web' });
  assert.equal(qr.cookies.sid, 'session-secret');
  assert.equal(qr.expiresAt, 1_700_000_120_000);
  assert.equal(qr.serverTime, SERVER_MS);

  const session = {
    cookies: qr.cookies,
    pollParams: qr.pollParams,
    expiresAt: qr.expiresAt,
  };
  const polled = await client.pollQr(session);
  assert.equal(calls[1].url.pathname, PATHS.qrPoll);
  assert.match(calls[1].options.headers.Cookie, /sid=session-secret/);
  assert.equal(polled.state, 'success');
  assert.equal(polled.heyboxId, BIG_ID);
  assert.equal(polled.cookie.includes('user_pkey=pkey-secret'), true);
  assert.equal(polled.cookie.includes('heybox_id=9007199254740993'), true);
  assert.equal(polled.cookie.includes('sid='), false);
  assert.equal(polled.cookie.includes('other='), false);
  assert.equal(polled.serverTime, SERVER_MS);
  assert.equal(Object.values(polled).join(' ').includes('QR_TOKEN'), false);
});

test('QR states map waiting, scanned, denied and expired without arbitrary URLs', async () => {
  let state = 'wait';
  const { client } = makeClient(async () => ok({ status: 'ok', result: { error: state } }));
  const session = { cookies: {}, pollParams: { qr: 'qr-token' }, expiresAt: 1_700_000_120_000 };
  assert.equal((await client.pollQr(session)).state, 'waiting');
  state = 'ready';
  assert.equal((await client.pollQr(session)).state, 'scanned');
  state = 'denied';
  assert.equal((await client.pollQr(session)).state, 'denied');
  state = 'timeout';
  assert.equal((await client.pollQr(session)).state, 'expired');

  for (const qrUrl of [
    'http://www.xiaoheihe.cn/qr?qr=abc',
    'https://evil.example/qr?qr=abc',
    'https://user:pass@www.xiaoheihe.cn/qr?qr=abc',
    'https://www.xiaoheihe.cn:8443/qr?qr=abc',
  ]) {
    const bad = makeClient(async () => ok({ status: 'ok', result: { qr_url: qrUrl } })).client;
    await assert.rejects(bad.requestQr(), { code: 'XHH_QR' });
  }
});

test('every HTTP request dispatches through the shared policy with control/data kind', async () => {
  const seen = [];
  const policy = {
    async run(input, task) {
      seen.push(input);
      return task(undefined);
    },
  };
  const scope = async () => ({
    providerId: 'xiaoheihe',
    accountKey: 'xhh-account-summary',
    credentialVersion: 'xhh-credential-summary',
    workflowId: 'scope-workflow',
  });
  const { client } = makeClient(async (url) => {
    const path = new URL(url).pathname;
    if (path === PATHS.qrRequest) {
      return ok({ status: 'ok', result: { qr_url: 'https://www.xiaoheihe.cn/qr?qr=QR1', expire: 120 } });
    }
    if (path === PATHS.authCheck) {
      return ok({ status: 'ok', result: { messages: [] } });
    }
    return ok({ status: 'ok', result: { list: [], has_more: 0 } });
  }, { requestPolicy: policy, requestScope: scope });

  await client.requestQr({ workflowId: 'workflow-qr' });
  await client.checkAuthEndpoint({ cookie: COOKIE, heyboxId: BIG_ID, workflowId: 'workflow-auth' });
  await client.listConversations('normal', { cookie: COOKIE, heyboxId: BIG_ID });
  await client.fetchDirectMessages('42', { cookie: COOKIE, heyboxId: BIG_ID, seq: '99' });

  assert.equal(seen.length, 4);
  assert.equal(seen.every((entry) => entry.providerId === 'xiaoheihe'), true);
  assert.equal(seen.every((entry) => entry.accountKey === 'xhh-account-summary'), true);
  assert.equal(seen.every((entry) => entry.credentialVersion === 'xhh-credential-summary'), true);
  assert.equal(seen[0].kind, 'control');
  assert.equal(seen[0].workflowId, 'workflow-qr');
  assert.equal(seen[1].kind, 'control');
  assert.equal(seen[2].kind, 'data');
  assert.equal(seen[3].kind, 'data');
  for (const entry of seen) {
    assert.equal(entry.requestKey.includes('fixture-only-pkey'), false);
    assert.equal(entry.requestKey.includes(BIG_ID), false);
    assert.equal(entry.requestKey.includes('QR1'), false);
    assert.match(entry.requestKey, new RegExp(`^${PATHS.qrRequest}|^${PATHS.authCheck}|^${PATHS.normalConversations}|^${PATHS.directMessages}`));
  }
});

test('HTTP and business failures translate to finite safe XHH errors', async () => {
  async function expectFailure(response, expected) {
    const { client } = makeClient(async () => response);
    await assert.rejects(client.checkAuthEndpoint({ cookie: COOKIE, heyboxId: BIG_ID }), (error) => {
      assert.equal(error.code, expected.code);
      assert.equal(error.message, XHH_SAFE_MESSAGES[expected.code]);
      if (expected.retryAfterMs !== undefined) assert.equal(error.retryAfterMs, expected.retryAfterMs);
      if (expected.status !== undefined) assert.equal(error.status, expected.status);
      if (expected.apiCode !== undefined) assert.equal(error.apiCode, expected.apiCode);
      assert.equal(String(error.message).includes('secret'), false);
      return true;
    });
  }

  await expectFailure(rawResponse({ status: 'fail' }, {
    status: 429, headers: { 'retry-after': '2' },
  }), { code: 'XHH_RATE_LIMIT', retryAfterMs: 2000, status: 429 });
  await expectFailure(rawResponse({ status: 'fail' }, { status: 401 }), { code: 'XHH_AUTH', status: 401 });
  await expectFailure(rawResponse({ status: 'fail' }, { status: 403 }), { code: 'XHH_CHALLENGE', status: 403 });
  await expectFailure(rawResponse({ status: 'fail' }, { status: 500 }), { code: 'XHH_HTTP', status: 500 });
  await expectFailure(rawResponse({ status: 'fail' }, { status: 302 }), { code: 'XHH_HTTP', status: 302 });
  await expectFailure(ok({
    status: 'fail', msg: 'secret server text', code: 42,
  }), { code: 'XHH_API', status: 200, apiCode: 42 });
  await expectFailure(ok({ status: 'login_required', msg: 'secret server text' }), {
    code: 'XHH_AUTH', status: 200,
  });
});

test('conversation and history shapes keep opaque IDs and never claim complete pagination', async () => {
  const { client } = makeClient(async (url) => {
    const path = new URL(url).pathname;
    if (path === PATHS.normalConversations) {
      return ok({
        status: 'ok',
        result: {
          messages: [{
            entry: 'message',
            message_id: '42',
            user_a: { heybox_id: BIG_ID, username: '对端' },
          }],
          has_more: 0,
        },
      });
    }
    return ok({
      status: 'ok',
      result: {
        list: [{ seq: '100', msg_id: 'm-1', sender_id: '42' }],
        next_cursor: '101',
      },
    });
  });

  const list = await client.listConversations('normal', { cookie: COOKIE, heyboxId: BIG_ID });
  assert.deepEqual(list.entries, [{ userId: BIG_ID, nickname: '对端' }]);
  assert.equal(list.shape.recognized, true);
  assert.equal(list.shape.listField, 'messages');
  assert.equal(list.precisionSafe, true);
  assert.equal(list.serverTime, SERVER_MS);
  assert.deepEqual(list.page, {
    hasMore: false, nextOffset: null, nextCursor: null, complete: true, limited: false,
  });

  const history = await client.fetchDirectMessages('42', {
    cookie: COOKIE, heyboxId: BIG_ID, seq: '100',
  });
  assert.equal(history.messages[0].msg_id, 'm-1');
  assert.equal(history.shape.recognized, true);
  assert.equal(history.page.hasMore, null);
  assert.equal(history.page.nextCursor, '101');
  assert.equal(history.page.complete, false);
  assert.equal(history.page.limited, true);

  const noPage = makeClient(async () => ok({ status: 'ok', result: { list: [] } })).client;
  const unknownPage = await noPage.fetchDirectMessages('42', { cookie: COOKIE, heyboxId: BIG_ID });
  assert.equal(unknownPage.page.hasMore, null);
  assert.equal(unknownPage.page.complete, false);

  const badShape = makeClient(async () => ok({ status: 'ok', result: {} })).client;
  await assert.rejects(
    badShape.fetchDirectMessages('42', { cookie: COOKIE, heyboxId: BIG_ID }),
    { code: 'XHH_RESPONSE' },
  );
});

test('large integer literals are preserved while integer-like fractions are rejected', async () => {
  const bigBody = `{"status":"ok","result":{"messages":[{"entry":"message","message_id":${BIG_ID},"user_a":{"heybox_id":"42"}}],"has_more":0}}`;
  const { client } = makeClient(async () => rawResponse(bigBody));
  const list = await client.listConversations('normal', { cookie: COOKIE, heyboxId: BIG_ID });
  assert.equal(list.convertedIntegerCount, 1);
  assert.equal(list.precisionSafe, true);
  assert.equal(list.entries[0].userId, '42');

  const unsafeBody = '{"status":"ok","result":{"list":[],"x":1e0}}';
  const unsafe = makeClient(async () => rawResponse(unsafeBody)).client;
  await assert.rejects(
    unsafe.fetchDirectMessages('42', { cookie: COOKIE, heyboxId: BIG_ID }),
    { code: 'XHH_PRECISION' },
  );
});

test('normalize messages requires peer sender, stable identity and real server time', () => {
  const valid = normalizeXiaoheiheMessage({
    sender_id: '42',
    msg_id: BIG_ID,
    seq: '7',
    send_time: 1_700_000_000_000,
    content: '你好',
    img: ['https://img.example/a.png'],
    link: { url: 'https://share.example/post/1' },
  }, { peerId: '42', selfId: '99' });
  assert.equal(valid.valid, true);
  assert.equal(valid.messageId, BIG_ID);
  assert.equal(valid.seq, '7');
  assert.equal(valid.senderId, '42');
  assert.equal(valid.sentAt, 1_700_000_000_000);
  assert.equal(valid.text, '你好');
  assert.deepEqual(valid.imageUrls, ['https://img.example/a.png']);
  assert.deepEqual(valid.shareUrls, ['https://share.example/post/1']);
  assert.equal(valid.reasonCode, '');

  const mismatch = normalizeXiaoheiheMessage({
    sender_id: '99', msg_id: '1', send_time: 1_700_000_000_000, content: 'x',
  }, { peerId: '42', selfId: '99' });
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.reasonCode, 'SENDER_SELF');

  const wrongPeer = normalizeXiaoheiheMessage({
    sender_id: '77', msg_id: '1', send_time: 1_700_000_000_000, content: 'x',
  }, { peerId: '42', selfId: '99' });
  assert.equal(wrongPeer.reasonCode, 'SENDER_MISMATCH');

  const noId = normalizeXiaoheiheMessage({
    sender_id: '42', send_time: 1_700_000_000_000, content: 'x',
  }, { peerId: '42' });
  assert.equal(noId.reasonCode, 'MISSING_STABLE_ID');

  const badTime = normalizeXiaoheiheMessage({
    sender_id: '42', msg_id: '1', send_time: 1, content: 'x',
  }, { peerId: '42' });
  assert.equal(badTime.reasonCode, 'INVALID_SERVER_TIME');

  const unsafe = normalizeXiaoheiheMessage({
    sender_id: '42', msg_id: 9007199254740993, send_time: 1_700_000_000_000, content: 'x',
  }, { peerId: '42' });
  assert.equal(unsafe.reasonCode, 'UNSAFE_PRECISION');

  const empty = normalizeXiaoheiheMessage({ sender_id: '42', msg_id: '1' }, { peerId: '42' });
  assert.equal(empty.reasonCode, 'INVALID_SERVER_TIME');

  const imageOnly = normalizeXiaoheiheMessage({
    sender_id: '42', seq: '9', send_time: 1_700_000_000_000,
    imgs: [{ url: 'https://img.example/b.png' }],
  }, { peerId: '42' });
  assert.equal(imageOnly.valid, true);
  assert.equal(imageOnly.messageId, '9');
  assert.deepEqual(imageOnly.imageUrls, ['https://img.example/b.png']);
});

test('local policy budget and cooldown stay distinct from upstream rate limits', async () => {
  for (const [policyCode, expected] of [
    ['REQUEST_BUDGET', 'XHH_BUDGET'],
    ['REQUEST_COOLDOWN', 'XHH_COOLDOWN'],
  ]) {
    let dispatched = 0;
    const nextAllowedAt = 1_700_000_120_000;
    const client = createXiaoheiheClient({
      requestPolicy: {
        async run() {
          throw Object.assign(new Error('local policy gate'), {
            code: policyCode, retryAfterMs: 120_000, nextAllowedAt,
          });
        },
      },
      requestScope: async () => ({
        providerId: 'xiaoheihe', accountKey: 'xhh-account-summary',
      }),
      requestImpl: async () => { dispatched += 1; throw new Error('must not dispatch'); },
      now: () => 1_700_000_000_000,
    });
    await assert.rejects(
      client.listConversations('normal', { cookie: COOKIE, heyboxId: BIG_ID }),
      (error) => {
        assert.equal(error.code, expected);
        assert.equal(error.message, XHH_SAFE_MESSAGES[expected]);
        assert.equal(error.retryAfterMs, 120_000);
        assert.equal(error.nextAllowedAt, nextAllowedAt);
        assert.equal(error.requestPolicyRecorded, true);
        return true;
      },
    );
    assert.equal(dispatched, 0);
  }
});

test('REQUEST_DEADLINE with an unexpired QR maps a proven local cooldown', async () => {
  const now = 1_700_000_000_000;
  const nextAllowedAt = now + 900_000;
  let statusCalls = 0;
  let dispatched = 0;
  const client = createXiaoheiheClient({
    requestPolicy: {
      async run() {
        throw Object.assign(new Error('local deadline'), { code: 'REQUEST_DEADLINE' });
      },
      async status(input) {
        statusCalls += 1;
        assert.equal(input.providerId, 'xiaoheihe');
        assert.equal(input.accountKey, 'xhh-status-account');
        assert.equal(input.kind, 'control');
        return {
          paused: true,
          cooldownReason: 'api',
          nextAllowedAt,
          serverNextAllowedAt: null,
          budget: { totalUsed: 1, totalLimit: 8, dataUsed: 0, dataLimit: 4 },
        };
      },
    },
    requestScope: async () => ({
      providerId: 'xiaoheihe', accountKey: 'xhh-status-account',
    }),
    requestImpl: async () => { dispatched += 1; throw new Error('must not dispatch'); },
    now: () => now,
    timeoutMs: 200,
  });
  await assert.rejects(client.requestQr({ expiresAt: now + 60_000 }), (error) => {
    assert.equal(error.code, 'XHH_COOLDOWN');
    assert.equal(error.message, XHH_SAFE_MESSAGES.XHH_COOLDOWN);
    assert.equal(error.nextAllowedAt, nextAllowedAt);
    assert.equal(error.retryAfterMs, 900_000);
    assert.equal(error.requestPolicyRecorded, true);
    return true;
  });
  assert.equal(statusCalls, 1);
  assert.equal(dispatched, 0);
});

test('REQUEST_DEADLINE maps an exhausted relevant local budget to XHH_BUDGET', async () => {
  const now = 1_700_000_000_000;
  const nextAllowedAt = now + 30_000;
  let statusCalls = 0;
  let dispatched = 0;
  const client = createXiaoheiheClient({
    requestPolicy: {
      async run() {
        throw Object.assign(new Error('local deadline'), { code: 'REQUEST_DEADLINE' });
      },
      async status(input) {
        statusCalls += 1;
        assert.equal(input.kind, 'data');
        return {
          paused: false,
          cooldownReason: null,
          nextAllowedAt,
          budget: { totalUsed: 2, totalLimit: 8, dataUsed: 4, dataLimit: 4 },
        };
      },
    },
    requestScope: async () => ({
      providerId: 'xiaoheihe', accountKey: 'xhh-account-summary',
    }),
    requestImpl: async () => { dispatched += 1; throw new Error('must not dispatch'); },
    now: () => now,
    timeoutMs: 200,
  });
  await assert.rejects(
    client.listConversations('normal', {
      cookie: COOKIE, heyboxId: BIG_ID, expiresAt: now + 60_000,
    }),
    (error) => {
      assert.equal(error.code, 'XHH_BUDGET');
      assert.equal(error.nextAllowedAt, nextAllowedAt);
      assert.equal(error.retryAfterMs, 30_000);
      assert.equal(error.requestPolicyRecorded, true);
      return true;
    },
  );
  assert.equal(statusCalls, 1);
  assert.equal(dispatched, 0);
});

test('REQUEST_DEADLINE keeps XHH_TIMEOUT when local status cannot prove the cause', async () => {
  const now = 1_700_000_000_000;
  const makeClientWithStatus = (statusImpl) => createXiaoheiheClient({
    requestPolicy: {
      async run() {
        throw Object.assign(new Error('local deadline'), { code: 'REQUEST_DEADLINE' });
      },
      status: statusImpl,
    },
    requestScope: async () => ({
      providerId: 'xiaoheihe', accountKey: 'xhh-account-summary',
    }),
    requestImpl: async () => { throw new Error('must not dispatch'); },
    now: () => now,
    timeoutMs: 200,
  });

  const unproven = makeClientWithStatus(async () => ({
    paused: true,
    cooldownReason: null,
    nextAllowedAt: now + 60_000,
    budget: { totalUsed: 1, totalLimit: 8, dataUsed: 1, dataLimit: 4 },
  }));
  await assert.rejects(
    unproven.requestQr({ expiresAt: now + 60_000 }),
    { code: 'XHH_TIMEOUT' },
  );

  const throwing = makeClientWithStatus(async () => { throw new Error('status unavailable'); });
  await assert.rejects(
    throwing.requestQr({ expiresAt: now + 60_000 }),
    { code: 'XHH_TIMEOUT' },
  );

  let statusCalls = 0;
  const expired = makeClientWithStatus(async () => {
    statusCalls += 1;
    return { paused: true, cooldownReason: 'api', nextAllowedAt: now + 60_000 };
  });
  await assert.rejects(
    expired.requestQr({ expiresAt: now }),
    { code: 'XHH_TIMEOUT' },
  );
  assert.equal(statusCalls, 0);
});

test('opaque message identities are preserved and unsafe identities rejected', () => {
  const id = 'opaque/abc+def==';
  const valid = normalizeXiaoheiheMessage({
    msg_id: id, sender_id: '42', send_time: 1_700_000_000_000, content: 'x',
  }, { peerId: '42' });
  assert.equal(valid.valid, true);
  assert.equal(valid.messageId, id);

  for (const bad of ['bad\u0000id', 'bad\nid', `x${'a'.repeat(256)}`]) {
    const normalized = normalizeXiaoheiheMessage({
      msg_id: bad, sender_id: '42', send_time: 1_700_000_000_000, content: 'x',
    }, { peerId: '42' });
    assert.equal(normalized.valid, false);
    assert.equal(normalized.reasonCode, 'MISSING_STABLE_ID');
  }
});

test('hard deadline and cancellation abort queued or in-flight requests', async () => {
  const stalled = (url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('not aborted')), 500);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const error = new Error('aborted');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      reject(error);
    }, { once: true });
  });
  const timed = makeClient(stalled, { timeoutMs: 20 }).client;
  await assert.rejects(timed.requestQr(), { code: 'XHH_TIMEOUT' });

  const controller = new AbortController();
  const cancelled = makeClient(stalled, { timeoutMs: 1000 }).client;
  const pending = cancelled.requestQr({ signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { code: 'XHH_CANCELLED' });
});

test('production construction requires a shared policy unless a test requestImpl is injected', () => {
  assert.throws(() => createXiaoheiheClient({}), /requestPolicy/);
  assert.throws(
    () => createXiaoheiheClient({ requestPolicy: { run() {} } }),
    /requestScope/,
  );
});
