import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createXiaoheiheTransport } from '../xiaoheihe-transport.js';
import { createXiaoheiheClient } from '../xiaoheihe-client.js';
import { createDmAcceptanceLog } from '../dm-acceptance.js';

const QR_BODY = JSON.stringify({
  status: 'ok',
  result: { qr_url: 'https://www.xiaoheihe.cn/qr?qr=OFFLINE_TOKEN', expire: 120 },
});

function machine(behavior) {
  const calls = [];

  function request(...args) {
    const urlFirst = typeof args[0] === 'string' || args[0] instanceof URL;
    const options = urlFirst ? { ...(args[1] || {}) } : { ...(args[0] || {}) };
    const url = urlFirst ? String(args[0]) : String(options.url || '');
    const callback = args.find((value) => typeof value === 'function');
    const req = new EventEmitter();
    req.destroyed = false;
    req.aborted = false;
    req.setHeader = () => {};
    req.setTimeout = () => req;
    req.on('error', () => {});
    req.destroy = (error) => {
      req.destroyed = true;
      if (error) queueMicrotask(() => req.emit('error', error));
      queueMicrotask(() => req.emit('close'));
      return req;
    };
    req.abort = () => {
      req.aborted = true;
      req.destroy();
    };
    if (callback) req.once('response', callback);
    req.end = () => {
      queueMicrotask(() => behavior({ req, options, url, respond }));
      return req;
    };
    calls.push({ req, options, url });

    function respond(body = QR_BODY, status = 200, extraHeaders = {}) {
      const response = new EventEmitter();
      response.statusCode = status;
      response.headers = {
        date: 'Sat, 28 Nov 2026 04:00:00 GMT',
        'content-type': 'application/json',
        ...extraHeaders,
      };
      response.complete = false;
      response.destroy = () => {
        response.destroyed = true;
        queueMicrotask(() => response.emit('close'));
      };
      response.resume = () => {};
      req.emit('response', response);
      if (body !== null) {
        response.emit('data', Buffer.from(body));
        response.complete = true;
        response.emit('end');
        response.emit('close');
        req.emit('close');
      }
      return response;
    }

    return req;
  }

  return { request, calls };
}

function makeClient(behavior, { timeoutMs = 200 } = {}) {
  const fake = machine(behavior);
  const events = [];
  const transport = createXiaoheiheTransport({
    electronNetLoader: async () => null,
    httpsRequest: fake.request,
  });
  const client = createXiaoheiheClient({
    requestPolicy: {
      async run(input, task) { return task(input.signal); },
    },
    requestScope: async () => ({ providerId: 'xiaoheihe', accountKey: 'offline-test' }),
    onDiagnostic: (event) => events.push(event),
    transport,
    timeoutMs,
  });
  return { client, calls: fake.calls, events };
}

async function bounded(promise, ms = 700) {
  let timer;
  const fence = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('request failed to settle')), ms);
  });
  try {
    return await Promise.race([promise, fence]);
  } finally {
    clearTimeout(timer);
  }
}

test('transport selects node:https when Electron is unavailable', async () => {
  const fake = machine(({ respond }) => respond());
  const transport = createXiaoheiheTransport({
    electronNetLoader: async () => null,
    httpsRequest: fake.request,
  });
  const kinds = [];
  const result = await transport.request('https://api.xiaoheihe.cn/account/get_qrcode_url/', {
    headers: {}, onTransport: (kind) => kinds.push(kind),
  });
  assert.equal(result.transport, 'node');
  assert.deepEqual(kinds, ['node']);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options.rejectUnauthorized, true);
  assert.equal(transport.kind(), 'node');
});

test('transport selects Electron net.request when the capability is available', async () => {
  const fake = machine(({ respond }) => respond());
  let httpsCalls = 0;
  const transport = createXiaoheiheTransport({
    electronNetLoader: async () => ({ request: fake.request }),
    httpsRequest: () => {
      httpsCalls += 1;
      throw new Error('node transport must not be used');
    },
  });
  const kinds = [];
  const result = await transport.request('https://api.xiaoheihe.cn/account/get_qrcode_url/', {
    headers: { Cookie: 'explicit=offline' },
    onTransport: (kind) => kinds.push(kind),
  });
  assert.equal(result.transport, 'electron');
  assert.deepEqual(kinds, ['electron']);
  assert.equal(httpsCalls, 0);
  const options = fake.calls[0].options;
  assert.equal(options.redirect, 'manual');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.useSessionCookies, false);
  assert.equal(options.cache, 'no-store');
  assert.equal(options.bypassCustomProtocolHandlers, true);
  assert.equal(Object.hasOwn(options, 'partition'), false);
  assert.equal(Object.hasOwn(options, 'session'), false);
  assert.equal(options.headers.Cookie, 'explicit=offline');
});

test('transport falls back only before dispatch and never after an Electron attempt', async () => {
  const fake = machine(({ respond }) => respond());
  const fallback = createXiaoheiheTransport({
    electronNetLoader: async () => { throw new Error('no electron'); },
    httpsRequest: fake.request,
  });
  const before = await fallback.request('https://api.xiaoheihe.cn/account/qr_state/', { headers: {} });
  assert.equal(before.transport, 'node');
  assert.equal(fake.calls.length, 1);

  let httpsCalls = 0;
  const failed = createXiaoheiheTransport({
    electronNetLoader: async () => ({
      request() { throw new Error('electron dispatch failed'); },
    }),
    httpsRequest: () => { httpsCalls += 1; throw new Error('must not fall back'); },
  });
  await assert.rejects(failed.request('https://api.xiaoheihe.cn/account/qr_state/', { headers: {} }));
  assert.equal(httpsCalls, 0);
});

test('client preserves separate Set-Cookie lines including Expires commas', async () => {
  const { client } = makeClient(({ respond }) => respond(QR_BODY, 200, {
    'set-cookie': [
      'session_a=OFFLINE_A; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Secure',
      'session_b=OFFLINE_B; Path=/; Secure',
    ],
  }));
  const qr = await bounded(client.requestQr());
  assert.equal(qr.cookies.session_a, 'OFFLINE_A');
  assert.equal(qr.cookies.session_b, 'OFFLINE_B');
});

test('client rejects redirects without a second dispatch', async () => {
  const { client, calls } = makeClient(({ respond }) => respond('', 302, {
    location: 'https://untrusted.invalid/OFFLINE_REDIRECT',
  }));
  await assert.rejects(bounded(client.requestQr()), { code: 'XHH_HTTP' });
  assert.equal(calls.length, 1);
});

test('client keeps a total deadline over headers and body and closes the request', async () => {
  const missing = makeClient(() => {}, { timeoutMs: 35 });
  await assert.rejects(bounded(missing.client.requestQr()), { code: 'XHH_TIMEOUT' });
  assert.equal(missing.calls.length, 1);
  assert.equal(missing.calls[0].req.destroyed, true);

  const stalled = makeClient(({ respond }) => { respond(null); }, { timeoutMs: 35 });
  await assert.rejects(bounded(stalled.client.requestQr()), { code: 'XHH_TIMEOUT' });
  assert.equal(stalled.calls.length, 1);
  assert.equal(stalled.calls[0].req.destroyed, true);
});

test('client cancellation closes the request and never starts another', async () => {
  const controller = new AbortController();
  const { client, calls } = makeClient(() => {});
  const pending = client.requestQr({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(bounded(pending), { code: 'XHH_CANCELLED' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].req.destroyed, true);
});

test('client caps oversized bodies locally', async () => {
  const { client, calls } = makeClient(({ respond }) => respond('x'.repeat(300 * 1024)));
  await assert.rejects(bounded(client.requestQr()), { code: 'XHH_RESPONSE' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].req.destroyed, true);
});

test('client rejects a prematurely closed body', async () => {
  const { client, calls } = makeClient(({ respond }) => {
    const response = respond(null);
    response.emit('data', Buffer.from(QR_BODY));
    response.emit('close');
  });
  await assert.rejects(bounded(client.requestQr()), (error) => {
    assert.ok(['XHH_NETWORK', 'XHH_RESPONSE'].includes(error.code));
    return true;
  });
  assert.equal(calls.length, 1);
});

test('client diagnostics stay finite and never expose URLs, cookies or QR data', async () => {
  const { client, events } = makeClient(({ respond }) => respond(QR_BODY, 200, {
    'set-cookie': ['offline_cookie=OFFLINE_PRIVATE_COOKIE; Path=/'],
  }));
  await bounded(client.requestQr());
  assert.ok(events.length >= 2);
  const serialized = JSON.stringify(events);
  for (const secret of [
    'OFFLINE_TOKEN', 'OFFLINE_PRIVATE_COOKIE', 'https:', 'qr_url', 'set-cookie',
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  const operations = new Set(['request', 'headers', 'complete', 'error']);
  const transports = new Set(['node', 'electron']);
  const stages = new Set(['select', 'headers', 'body', 'complete', 'timeout', 'cancel', 'error']);
  for (const event of events) {
    assert.equal(operations.has(event.operation), true);
    assert.equal(transports.has(event.transport), true);
    assert.equal(stages.has(event.networkStage), true);
    assert.equal(Number.isFinite(event.elapsedMs), true);
    for (const key of Object.keys(event)) {
      assert.equal([
        'operation', 'transport', 'networkStage', 'elapsedMs', 'bytes',
        'status', 'errorCode',
      ].includes(key), true);
    }
  }
});

test('client timeout diagnostics preserve XHH_TIMEOUT without raw errors', async () => {
  const { client, events } = makeClient(() => {}, { timeoutMs: 35 });
  await assert.rejects(bounded(client.requestQr()), { code: 'XHH_TIMEOUT' });
  const serialized = JSON.stringify(events);
  assert.match(serialized, /XHH_TIMEOUT/);
  assert.equal(serialized.includes('request failed'), false);
  assert.ok(events.length >= 2);
});

test('acceptance whitelist keeps only finite diagnostic enum and bounded numbers', async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-xhh-diagnostic-'));
  try {
    const log = createDmAcceptanceLog({ dataDir: dir, now: () => 1_700_000_000_000 });
    await log.ready;
    const accepted = await log.record('diagnostic', {
      providerId: 'xiaoheihe',
      phase: 'check',
      action: 'requested',
      operation: 'request',
      transport: 'node',
      networkStage: 'select',
      elapsedMs: 0,
      status: 200,
      bytes: 12,
    });
    assert.equal(accepted.accepted, true);

    for (const fields of [
      { transport: 'other' },
      { operation: 'url' },
      { networkStage: 'https://api.xiaoheihe.cn' },
      { elapsedMs: 24 * 60 * 60 * 1000 + 1 },
      { bytes: 16 * 1024 * 1024 + 1 },
      { status: 600 },
    ]) {
      const rejected = await log.record('diagnostic', {
        phase: 'check', operation: 'request', transport: 'node',
        networkStage: 'select', ...fields,
      });
      assert.equal(rejected.accepted, false, JSON.stringify(fields));
    }
    await log.flush();
    const snapshot = log.snapshot({ limit: 10 });
    assert.equal(snapshot.count, 1);
    assert.equal(snapshot.events[0].operation, 'request');
    assert.equal(snapshot.events[0].transport, 'node');
    assert.equal(snapshot.events[0].networkStage, 'select');
    assert.equal(snapshot.events[0].elapsedMs, 0);
    assert.equal(snapshot.events[0].bytes, 12);
    assert.equal(snapshot.events[0].status, 200);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
