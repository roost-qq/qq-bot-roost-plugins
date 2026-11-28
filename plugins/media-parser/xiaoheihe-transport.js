/**
 * Native XiaoHeiHe transport selection.
 *
 * Electron's net.request is used only when the Electron capability is present
 * and the optional electron module exposes it. Otherwise node:https.request is
 * used. Selection happens once per transport instance, before any HTTP
 * dispatch; a failed HTTP attempt never switches transports. There is no
 * global fetch dependency and no package or binary path is hardcoded.
 */

import https from 'node:https';

export const XHH_MAX_BODY_BYTES = 256 * 1024;

export const XHH_DIAGNOSTIC_OPERATIONS = Object.freeze([
  'request', 'headers', 'complete', 'error',
]);
export const XHH_DIAGNOSTIC_TRANSPORTS = Object.freeze(['node', 'electron']);
export const XHH_DIAGNOSTIC_STAGES = Object.freeze([
  'select', 'headers', 'body', 'complete', 'timeout', 'cancel', 'error',
]);

export const XHH_DIAGNOSTIC_VALUES = Object.freeze({
  operations: XHH_DIAGNOSTIC_OPERATIONS,
  transports: XHH_DIAGNOSTIC_TRANSPORTS,
  networkStages: XHH_DIAGNOSTIC_STAGES,
});

function markedError(code, status = 0) {
  const error = new Error('xhh transport failure');
  error.name = 'XhhTransportError';
  error.code = code;
  if (Number.isFinite(status) && status > 0) error.status = Math.floor(status);
  return error;
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function notify(callback, value) {
  if (typeof callback !== 'function') return;
  try { callback(value); } catch { /* observers never affect transport */ }
}

async function defaultElectronNetLoader() {
  if (!process.versions || !process.versions.electron) return null;
  try {
    const module = await import('electron');
    const net = module?.net ?? module?.default?.net;
    return net && typeof net.request === 'function' ? net : null;
  } catch {
    return null;
  }
}

function requestWithNode(url, options, config) {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    let request = null;
    let response = null;
    let settled = false;
    let ended = false;
    let total = 0;
    const chunks = [];
    const cleanup = () => {
      try { signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    };
    const closeNetwork = () => {
      try { response?.destroy?.(); } catch { /* ignore */ }
      try { request?.destroy?.(); } catch { /* ignore */ }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeNetwork();
      reject(error);
    };
    const onAbort = () => fail(abortError());

    if (signal?.aborted) {
      fail(abortError());
      return;
    }

    const requestFn = config.httpsRequest || https.request;
    try {
      request = requestFn(url, {
        method: 'GET',
        headers: options?.headers || {},
        rejectUnauthorized: true,
      }, (incoming) => {
        if (settled) {
          try { incoming?.destroy?.(); } catch { /* ignore */ }
          return;
        }
        response = incoming;
        const statusCode = Number(incoming?.statusCode) || 0;
        notify(options?.onHeaders, { statusCode, headers: incoming?.headers || {} });
        incoming.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > config.maxBodyBytes) {
            fail(markedError('XHH_RESPONSE', statusCode));
            return;
          }
          chunks.push(buffer);
        });
        incoming.on('end', () => {
          ended = true;
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            statusCode,
            headers: incoming?.headers || {},
            text: Buffer.concat(chunks).toString('utf8'),
            transport: 'node',
            bytes: total,
          });
        });
        incoming.on('aborted', () => fail(markedError('XHH_NETWORK', statusCode)));
        incoming.on('error', (error) => fail(error));
        incoming.on('close', () => {
          if (!ended) fail(markedError('XHH_NETWORK', statusCode));
        });
      });
    } catch (error) {
      fail(error);
      return;
    }

    if (!request || typeof request.on !== 'function') {
      fail(markedError('XHH_NETWORK'));
      return;
    }
    request.on('error', (error) => fail(error));
    request.on('close', () => {
      if (!settled && !response) fail(markedError('XHH_NETWORK'));
    });
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    try {
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}

function requestWithElectron(net, url, options, config) {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    let request = null;
    let response = null;
    let settled = false;
    let ended = false;
    let total = 0;
    const chunks = [];
    const cleanup = () => {
      try { signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    };
    const closeNetwork = () => {
      try {
        if (request && typeof request.abort === 'function') request.abort();
        else request?.destroy?.();
      } catch { /* ignore */ }
      try { response?.destroy?.(); } catch { /* ignore */ }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeNetwork();
      reject(error);
    };
    const onAbort = () => fail(abortError());

    if (signal?.aborted) {
      fail(abortError());
      return;
    }

    try {
      request = net.request({
        method: 'GET',
        url: String(url),
        headers: options?.headers || {},
        redirect: 'manual',
        credentials: 'omit',
        useSessionCookies: false,
        cache: 'no-store',
        bypassCustomProtocolHandlers: true,
      });
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
      return;
    }

    if (!request || typeof request.on !== 'function') {
      settled = true;
      cleanup();
      reject(markedError('XHH_NETWORK'));
      return;
    }

    request.on('redirect', (statusCode) => {
      fail(markedError('XHH_HTTP', statusCode));
    });
    request.on('response', (incoming) => {
      if (settled) {
        try { incoming?.destroy?.(); } catch { /* ignore */ }
        return;
      }
      response = incoming;
      const statusCode = Number(incoming?.statusCode) || 0;
      notify(options?.onHeaders, { statusCode, headers: incoming?.headers || {} });
      incoming.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > config.maxBodyBytes) {
          fail(markedError('XHH_RESPONSE', statusCode));
          return;
        }
        chunks.push(buffer);
      });
      incoming.on('end', () => {
        ended = true;
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          statusCode,
          headers: incoming?.headers || {},
          text: Buffer.concat(chunks).toString('utf8'),
          transport: 'electron',
          bytes: total,
        });
      });
      incoming.on('aborted', () => fail(markedError('XHH_NETWORK', statusCode)));
      incoming.on('error', (error) => fail(error));
      incoming.on('close', () => {
        if (!ended) fail(markedError('XHH_NETWORK', statusCode));
      });
    });
    request.on('error', (error) => fail(error));
    request.on('abort', () => fail(abortError()));
    request.on('close', () => {
      if (!settled && !response) fail(markedError('XHH_NETWORK'));
    });

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    try {
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}

export function createXiaoheiheTransport({
  electronNetLoader = defaultElectronNetLoader,
  httpsRequest = null,
  maxBodyBytes = XHH_MAX_BODY_BYTES,
} = {}) {
  const cap = Number.isFinite(maxBodyBytes) && maxBodyBytes > 0
    ? Math.floor(maxBodyBytes) : XHH_MAX_BODY_BYTES;
  let selected = null;
  let selecting = null;

  async function select() {
    if (selected) return selected;
    if (!selecting) {
      selecting = (async () => {
        let net = null;
        try { net = await electronNetLoader(); } catch { net = null; }
        if (net && typeof net.request === 'function') {
          return { kind: 'electron', net };
        }
        return { kind: 'node' };
      })().then((value) => {
        selected = value;
        return value;
      }).finally(() => {
        selecting = null;
      });
    }
    return selecting;
  }

  async function request(url, options = {}) {
    const selection = await select();
    notify(options?.onTransport, selection.kind);
    if (selection.kind === 'electron') {
      return requestWithElectron(selection.net, url, options, { maxBodyBytes: cap });
    }
    return requestWithNode(url, options, {
      httpsRequest: httpsRequest || null,
      maxBodyBytes: cap,
    });
  }

  return {
    request,
    select,
    kind: () => (selected ? selected.kind : null),
    maxBodyBytes: cap,
  };
}
