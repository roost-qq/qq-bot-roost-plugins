import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVICE_ID = 'roost-media-parser';
export const ENGINE_VERSION = '0.1.0';
export const ORIGINAL_ARCHIVE_SHA256 =
  'd75f10eba41d3c202696d3da7c5c5efce1135b39401fd4cf170075e37bba9c05';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const STATIC_NAMES = new Set(['requirements.txt', 'config.example.json', 'LICENSE', 'README.md']);
const HASH_RE = /^[a-f0-9]{64}$/;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class EngineHostError extends Error {
  constructor(message, code = 'ENGINE_ERROR', options) {
    super(message, options);
    this.name = 'EngineHostError';
    this.code = code;
  }
}

function isStatic(name) {
  return name.endsWith('.py') || STATIC_NAMES.has(path.posix.basename(name));
}

function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const [name, data] of [...files].filter(([name]) => isStatic(name)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(`${name}\0`);
    hash.update(data);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Strict tar reader. Archive identity is checked separately before production use. */
export function readSafeTarGz(compressed) {
  if (compressed.length > 16 * 1024 * 1024) throw new Error('Engine archive is too large');
  const raw = zlib.gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map();
  const names = new Set();
  const text = (header, start, length) => {
    const value = header.subarray(start, start + length);
    const zero = value.indexOf(0);
    return value.subarray(0, zero === -1 ? value.length : zero).toString('utf8');
  };
  const octal = (header, start, length) => {
    const value = text(header, start, length).trim();
    if (!/^[0-7]+$/.test(value)) throw new Error('Invalid tar numeric field');
    const number = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(number)) throw new Error('Invalid tar size');
    return number;
  };
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!raw.subarray(offset).every((byte) => byte === 0)) throw new Error('Unexpected data after tar terminator');
      return files;
    }
    const checksum = octal(header, 148, 8);
    let actual = 0;
    for (let index = 0; index < 512; index++) actual += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== actual) throw new Error('Invalid tar checksum');
    const prefix = text(header, 345, 155);
    let name = prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100);
    while (name.startsWith('./')) name = name.slice(2);
    const type = header[156];
    const size = octal(header, 124, 12);
    const parts = name.replace(/\/$/, '').split('/');
    if (
      !name || name.startsWith('/') || name.includes('\\') || name.includes('\ufffd')
      || parts.some((part) => !part || part === '.' || part === '..'
        || /[:\x00-\x1f]/.test(part) || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    ) throw new Error('Unsafe path in engine archive');
    name = parts.join('/');
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error('Duplicate path in engine archive');
    names.add(key);
    if (![0, 48, 53].includes(type)) throw new Error('Engine archive contains a link or special file');
    if (type === 53 && size !== 0) throw new Error('Invalid tar directory');
    offset += 512;
    const rounded = Math.ceil(size / 512) * 512;
    if (offset + rounded > raw.length) throw new Error('Truncated engine archive');
    if (type !== 53) files.set(name, Buffer.from(raw.subarray(offset, offset + size)));
    offset += rounded;
    if (names.size > 2048) throw new Error('Engine archive has too many entries');
  }
  throw new Error('Engine archive has no terminator');
}

function bundledSource() {
  const archive = fs.readFileSync(path.join(PLUGIN_DIR, 'engine.tar.gz'));
  if (crypto.createHash('sha256').update(archive).digest('hex') !== ORIGINAL_ARCHIVE_SHA256) {
    throw new EngineHostError('Bundled engine archive checksum failed', 'ENGINE_INTEGRITY');
  }
  const files = readSafeTarGz(archive);
  const overlayRoot = path.join(PLUGIN_DIR, 'engine');
  const visit = (dir, prefix) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Bundled service contains a symlink');
      const relative = `${prefix}/${item.name}`;
      if (item.isDirectory()) {
        if (item.name !== '__pycache__' && item.name !== 'tests') visit(path.join(dir, item.name), relative);
      } else if (item.isFile() && item.name.endsWith('.py')) {
        files.set(relative, fs.readFileSync(path.join(dir, item.name)));
      }
    }
  };
  visit(path.join(overlayRoot, 'service'), 'service');
  files.set('run_engine.py', fs.readFileSync(path.join(overlayRoot, 'run_engine.py')));
  files.set('config.example.json', fs.readFileSync(path.join(overlayRoot, 'config.example.json')));
  if (!files.has('service/network_guard.py')) throw new Error('Bundled network guard is missing');
  return { files, sourceHash: digestFiles(files) };
}

function readJson(file, fallback = {}) {
  try {
    const data = fs.readFileSync(file);
    if (data.length > 1024 * 1024) throw new Error('Configuration file is too large');
    const value = JSON.parse(data.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new EngineHostError('Engine configuration cannot be read', 'ENGINE_CONFIG');
  }
}

function merge(base, override) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override || {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) ? result[key] : {}, value)
      : structuredClone(value);
  }
  return result;
}

/**
 * Remove every private-message credential partition at any depth while keeping
 * all unrelated platform, download and translation settings intact.
 */
export function stripPrivateMessageProviders(value, depth = 0) {
  if (depth > 32) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => stripPrivateMessageProviders(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'privateMessageProviders') continue;
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    out[key] = stripPrivateMessageProviders(child, depth + 1);
  }
  return out;
}

/**
 * Merge root credential secrets with the legacy `upstream` block while keeping
 * the canonical root Bili cookie. The old layout duplicated the cookie under
 * `upstream.bilibili_enhanced`; that duplicate is ignored so it cannot mask the
 * shared Node login credential. All other upstream secrets still apply.
 * The private-message provider partition is deliberately excluded in both
 * spellings so unverified credentials are never copied into Python config.
 */
export function credentialSecretConfig(credentials = {}) {
  const cleaned = stripPrivateMessageProviders(
    credentials && typeof credentials === 'object' && !Array.isArray(credentials) ? credentials : {},
  );
  const source = cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) ? cleaned : {};
  const root = {};
  for (const [key, value] of Object.entries(source)) {
    if (['engineToken', 'engine', 'upstream', 'privateMessageProviders', '__proto__', 'constructor', 'prototype'].includes(key)) continue;
    root[key] = structuredClone(value);
  }
  const upstream = source.upstream && typeof source.upstream === 'object' && !Array.isArray(source.upstream)
    ? structuredClone(source.upstream) : {};
  if (upstream.bilibili_enhanced && typeof upstream.bilibili_enhanced === 'object' && !Array.isArray(upstream.bilibili_enhanced)) {
    delete upstream.bilibili_enhanced.cookie;
  }
  return merge(root, upstream);
}

export function parseEngineUrl(value = 'http://127.0.0.1:3199') {
  let url;
  try { url = new URL(value); } catch { throw new EngineHostError('Invalid engine URL', 'ENGINE_CONFIG'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'http:' || !['127.0.0.1', '::1'].includes(host)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
  ) throw new EngineHostError('Engine URL must be an HTTP loopback address with no path', 'ENGINE_CONFIG');
  return { url: url.origin, host, port: Number(url.port || 80) };
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function normalizeFileReference(file) {
  const value = String(file);
  const absolute = path.resolve(value.startsWith('file:') ? fileURLToPath(value) : value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      windowsHide: true, shell: false, timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options,
    }, (error, stdout, stderr) => resolve({
      code: error ? error.code ?? 1 : 0,
      stdout: String(stdout || ''), stderr: String(stderr || ''), error,
    }));
  });
}

/**
 * Options for the managed long-running Python engine process.
 *
 * On Windows a detached child receives its own console, which can surface a
 * visible window when the host itself has no console. Hidden windows are
 * therefore requested without detaching on win32. POSIX keeps the detached
 * behavior so the engine survives the host process. `shell` is always off so
 * every argument (including Chinese paths and spaces) reaches argv unchanged.
 */
export function managedPythonSpawnOptions({
  cwd, logFd, env, platform = process.platform,
} = {}) {
  return {
    cwd,
    windowsHide: true,
    detached: platform !== 'win32',
    shell: false,
    stdio: ['ignore', logFd, logFd],
    env,
  };
}

async function limitedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > RESPONSE_LIMIT) throw new EngineHostError('Engine response is too large', 'ENGINE_RESPONSE');
  if (!response.body) throw new EngineHostError('Engine returned an empty response', 'ENGINE_RESPONSE');
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new EngineHostError('Engine response is too large', 'ENGINE_RESPONSE');
      }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch (error) {
    if (error instanceof EngineHostError) throw error;
    throw new EngineHostError('Engine returned invalid JSON', 'ENGINE_RESPONSE');
  } finally {
    reader.releaseLock();
  }
}

export function createEngineHost({ ctx, config = () => ({}) }) {
  if (!ctx?.dataDir || !ctx.state) throw new TypeError('Engine host requires ctx.dataDir and ctx.state');
  const dataDir = path.resolve(ctx.dataDir);
  const state = ctx.state.mediaParserEngine ??= {
    phase: 'idle', ready: false, lastError: '', progress: '', child: null,
    starting: null, record: null, health: null, python: null, dependencies: null,
    held: new Map(), responseLeases: new Map(), activeRequests: 0,
  };
  state.held ??= new Map();
  state.responseLeases ??= new Map();
  state.lifecycleEpoch ??= 0;
  const instanceFile = path.join(dataDir, 'engine-instance.json');
  const readyFile = path.join(dataDir, 'engine-ready.json');
  const logFile = path.join(dataDir, 'engine.log');
  const cfg = () => config() || {};
  const managed = () => cfg().engineMode !== 'external';
  const cacheRoot = () => {
    const root = managed() ? path.join(dataDir, 'cache')
      : cfg().externalCacheRoot ? path.resolve(String(cfg().externalCacheRoot)) : '';
    return root && fs.existsSync(root) ? fs.realpathSync(root) : root;
  };
  const settingsFile = () => path.join(dataDir, 'engine-settings.json');
  const credentialsFile = () => path.join(dataDir, 'credentials.json');
  const timeoutMs = () => boundedNumber(
    cfg().parseTimeoutMs ?? Number(cfg().parseTimeoutSeconds ?? cfg().timeoutSeconds ?? 300) * 1000,
    300000, 1000, 900000,
  );

  function ensureDataDir() {
    fs.mkdirSync(dataDir, { recursive: true });
    for (const folder of ['cache', 'tmp', 'python']) safeMkdir(path.join(dataDir, folder));
  }

  function contained(target) {
    const resolved = path.resolve(target);
    if (resolved === dataDir || !resolved.startsWith(dataDir + path.sep)) {
      throw new EngineHostError('Runtime path escapes the plugin data directory', 'ENGINE_PATH');
    }
    const realRoot = fs.realpathSync(dataDir);
    let ancestor = resolved;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const realAncestor = fs.realpathSync(ancestor);
    if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
      throw new EngineHostError('Runtime path contains an escaping symlink', 'ENGINE_PATH');
    }
    return resolved;
  }

  function safeMkdir(target) {
    contained(target);
    fs.mkdirSync(target, { recursive: true });
  }

  function atomicJson(file, value) {
    contained(file);
    const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function phase(value, progress) {
    state.phase = value;
    state.progress = progress;
    if (value !== 'ready' && value !== 'external') state.ready = false;
  }

  function failed(error) {
    state.ready = false;
    state.phase = 'error';
    state.progress = '';
    const code = String(error?.code || error?.name || 'UNKNOWN');
    const message = String(error?.message || 'Unknown error')
      .replace(/(?:cookie|authorization|api[-_ ]?key|token|secret)\s*[:=]\s*\S+/gi, '[credential hidden]')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 500);
    state.lastError = error instanceof EngineHostError
      ? error.message
      : `Engine preparation failed (${code}): ${message}`;
    ctx.logger?.warn?.(`[media-parser] ${state.lastError}`);
    return false;
  }

  function tokenForExternal() {
    const credentials = readJson(credentialsFile());
    const token = String(credentials.engineToken || credentials.engine?.token || credentials.qq?.token || '');
    if (token.length < 24) throw new EngineHostError('External engine token is missing from credentials.json', 'ENGINE_CONFIG');
    return token;
  }

  function record() {
    if (!state.record) state.record = readJson(instanceFile, null);
    return state.record;
  }

  function transport({ owned = false } = {}) {
    if (managed() || owned) {
      const info = record();
      if (!info || info.serviceId !== SERVICE_ID || !HASH_RE.test(info.sourceHash || '') || !info.token) {
        throw new EngineHostError('No verified managed engine instance is recorded', 'ENGINE_NOT_READY');
      }
      return { ...parseEngineUrl(info.url), token: info.token, record: info };
    }
    if (
      !cfg().externalCacheRoot || !path.isAbsolute(String(cfg().externalCacheRoot))
      || /^(\\\\|\/\/)/.test(String(cfg().externalCacheRoot))
    ) {
      throw new EngineHostError('External mode requires an absolute local cache root', 'ENGINE_CONFIG');
    }
    return { ...parseEngineUrl(cfg().engineUrl), token: tokenForExternal(), record: null };
  }

  async function request(route, { method = 'GET', body, signal, budget = 2500, connection } = {}) {
    const target = connection || transport();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new EngineHostError('Engine request deadline exceeded', 'ENGINE_DEADLINE')), Math.max(1, budget));
    timer.unref?.();
    try {
      const response = await fetch(target.url + route, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          Authorization: `Bearer ${target.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await limitedJson(response);
      if (!response.ok || payload.ok !== true) {
        const code = response.status === 408 ? 'ENGINE_DEADLINE'
          : response.status === 401 ? 'ENGINE_AUTH' : 'ENGINE_REQUEST';
        // Service errors can embed platform credentials; expose a bounded generic error.
        throw new EngineHostError(
          response.status === 408 ? 'Engine parse deadline exceeded' : `Engine request failed (HTTP ${response.status})`,
          code,
        );
      }
      return payload;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || new EngineHostError('Engine request cancelled', 'ENGINE_CANCELLED');
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof EngineHostError) throw error;
      throw new EngineHostError('Engine is unreachable', 'ENGINE_UNREACHABLE', { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  function validIdentity(info, connection, expectedHash, forStop = false) {
    const expected = connection.record;
    if (
      info?.ok !== true || info.serviceId !== SERVICE_ID || info.version !== ENGINE_VERSION
      || info.sourceHash !== expectedHash || !HASH_RE.test(info.sourceHash || '')
      || !/^[a-f0-9-]{16,64}$/i.test(info.instanceId || '')
      || !Number.isInteger(info.pid) || info.pid <= 0
      || (!forStop && !forTranslationAllowed() && info.translation === true)
      || !info.cacheDir
      || normalizeFileReference(info.cacheDir) !== normalizeFileReference(expected?.cacheRoot || cacheRoot())
      || (expected && info.instanceId !== expected.instanceId)
    ) return false;
    return true;
  }

  function forTranslationAllowed() {
    return cfg().translation === true;
  }

  async function probe({ owned = false, forStop = false } = {}) {
    try {
      const connection = transport({ owned });
      if (!forStop && connection.url !== parseEngineUrl(cfg().engineUrl).url) return null;
      const expectedHash = forStop ? connection.record?.sourceHash : bundledSource().sourceHash;
      const info = await request('/health', { connection, budget: 1200 });
      if (!validIdentity(info, connection, expectedHash, forStop)) return null;
      return info;
    } catch { return null; }
  }

  async function health() {
    const info = await probe();
    if (info) {
      state.health = info;
      state.ready = true;
      state.phase = managed() ? 'ready' : 'external';
      state.lastError = '';
      state.progress = '';
    } else if (state.ready) {
      state.ready = false;
      state.phase = 'unavailable';
    }
    return info;
  }

  function runtimeEnv(extra = {}) {
    return {
      ...process.env,
      PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1',
      MEDIA_PARSER_DATA_DIR: dataDir,
      TEMP: path.join(dataDir, 'tmp'), TMP: path.join(dataDir, 'tmp'),
      PIP_NO_CACHE_DIR: '1', PIP_REQUIRE_VIRTUALENV: '1',
      ...extra,
    };
  }

  function prepareSource(bundle) {
    const destination = path.join(dataDir, `engine-${bundle.sourceHash.slice(0, 20)}`);
    const valid = () => {
      try {
        const files = new Map();
        const visit = (dir, prefix = '') => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) throw new Error();
            if (entry.isDirectory()) {
              if (entry.name !== '__pycache__') visit(path.join(dir, entry.name), name);
            } else if (isStatic(name)) files.set(name, fs.readFileSync(path.join(dir, entry.name)));
          }
        };
        contained(destination);
        visit(destination);
        return digestFiles(files) === bundle.sourceHash;
      } catch { return false; }
    };
    if (valid()) return destination;
    const staging = `${destination}.preparing-${crypto.randomBytes(6).toString('hex')}`;
    safeMkdir(staging);
    try {
      for (const [name, bytes] of bundle.files) {
        const target = path.join(staging, ...name.split('/'));
        safeMkdir(path.dirname(target));
        fs.writeFileSync(contained(target), bytes);
      }
      if (fs.existsSync(destination)) {
        // This is a generated runtime directory, checked before recursive removal.
        fs.rmSync(contained(destination), { recursive: true, force: true });
      }
      fs.renameSync(staging, destination);
    } finally {
      if (fs.existsSync(staging)) fs.rmSync(contained(staging), { recursive: true, force: true });
    }
    return destination;
  }

  function effectiveConfig(bundle, endpoint) {
    let raw = JSON.parse(bundle.files.get('config.example.json').toString('utf8'));
    const advanced = readJson(settingsFile());
    const credentials = readJson(credentialsFile());
    raw = merge(raw, stripPrivateMessageProviders(advanced.upstream || advanced));
    raw = merge(raw, credentialSecretConfig(credentials));
    raw = stripPrivateMessageProviders(raw);
    const maxFileMiB = boundedNumber(cfg().maxFileSizeMiB ?? cfg().maxFileMiB ?? cfg().maxFileSizeMb, 200, 1, 200);
    const configuredVideo = boundedNumber(raw.download?.max_video_size_mb, maxFileMiB, 0, 200);
    raw.download = {
      ...(raw.download || {}),
      max_video_size_mb: Math.min(maxFileMiB, configuredVideo || maxFileMiB),
    };
    raw.download.max_audio_size_mb = Math.min(
      maxFileMiB, boundedNumber(raw.download.max_audio_size_mb, 30, 0, 200) || maxFileMiB,
    );
    raw.qq = {
      ...(raw.qq || {}), host: endpoint.host, port: endpoint.port, token: '',
      cacheDir: cacheRoot(), ffmpegPath: String(cfg().ffmpegPath || ''),
      maxLinksPerMessage: boundedNumber(cfg().maxLinks ?? cfg().maxLinksPerMessage, 3, 1, 3),
      cacheTtlSeconds: boundedNumber(cfg().cacheSeconds ?? cfg().cacheTtlSeconds, 1800, 60, 604800),
      cacheMaxBytes: boundedNumber(cfg().cacheMaxMiB, 2048, 16, 102400) * 1024 * 1024,
      maxRequestSeconds: Math.ceil(timeoutMs() / 1000),
      maxActiveRequests: boundedNumber(cfg().maxConcurrent ?? cfg().concurrency, 2, 1, 8),
      send: { ...(raw.qq?.send || {}), maxFileSizeMb: maxFileMiB },
    };
    raw.message ??= {};
    raw.message.text_metadata = {
      ...(raw.message.text_metadata || {}),
      quote_user_message: false,
      // The original QQ message already contains this URL. Repeating it in the
      // caption makes the same link visible to another DSH turn and can trigger
      // a second fetch. Media success captions stay metadata-only.
      show_original_link: false,
    };
    raw.message.hot_comments = { ...(raw.message.hot_comments || {}), count: boundedNumber(cfg().hotComments, 0, 0, 20) };
    raw.translation = { ...(raw.translation || {}), enable: forTranslationAllowed() };
    const effectiveFile = path.join(dataDir, 'engine-config.json');
    atomicJson(effectiveFile, raw);
    return effectiveFile;
  }

  async function detectPython() {
    const candidates = [
      ...(cfg().pythonPath ? [[String(cfg().pythonPath), []]] : []),
      ...(process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]]),
    ];
    for (const [command, prefix] of candidates) {
      const result = await run(command, [...prefix, '-c',
        'import json,sys;print(json.dumps({"version":list(sys.version_info[:3]),"executable":sys.executable}))',
      ], { cwd: dataDir, env: runtimeEnv(), timeout: 15000 });
      if (result.code !== 0) continue;
      try {
        const info = JSON.parse(result.stdout.trim());
        if (info.version[0] === 3 && info.version[1] >= 10) return { command, prefix, ...info };
      } catch { /* try the next real interpreter */ }
    }
    throw new EngineHostError('Python 3.10 or later was not found; set pythonPath and retry repair', 'ENGINE_PYTHON');
  }

  async function dependencies(python) {
    const script = [
      'import json,sys,importlib.metadata as m',
      'import aiohttp,PIL',
      'a=m.version("aiohttp");p=m.version("pillow")',
      'av=tuple(map(int,a.split(".")[:2]));pv=int(p.split(".")[0])',
      'assert sys.version_info >= (3,10) and (3,9)<=av<(4,0) and 10<=pv<13',
      'print(json.dumps({"python":sys.version.split()[0],"aiohttp":a,"pillow":p}))',
    ].join(';');
    const result = await run(python, ['-c', script], { cwd: dataDir, env: runtimeEnv(), timeout: 20000 });
    if (result.code !== 0) return null;
    try { return JSON.parse(result.stdout.trim()); } catch { return null; }
  }

  async function preparePython(engineDir, configFile, sourceHash) {
    const venv = path.join(dataDir, 'python', 'venv');
    const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    let deps = fs.existsSync(python) ? await dependencies(python) : null;
    if (!deps) {
      phase('preparing', 'Checking Python and the isolated environment');
      const detected = await detectPython();
      state.python = { executable: detected.executable, version: detected.version.join('.') };
      if (fs.existsSync(python)) {
        const version = await run(python, ['-c', 'import sys;assert sys.version_info >= (3,10);print(sys.executable)'], {
          cwd: dataDir, env: runtimeEnv(), timeout: 15000,
        });
        if (version.code !== 0) {
          // A partial or broken generated venv must be recoverable without user deletion.
          fs.rmSync(contained(venv), { recursive: true, force: true });
        }
      }
      if (!fs.existsSync(python)) {
        const creation = await run(detected.command, [...detected.prefix, '-m', 'venv', venv], {
          cwd: dataDir, env: runtimeEnv(), timeout: 180000,
        });
        if (creation.code !== 0 || !fs.existsSync(python)) {
          throw new EngineHostError('Creating the isolated Python environment failed; retry repair', 'ENGINE_VENV');
        }
      }
      const pipCheck = await run(python, ['-m', 'pip', '--version'], { cwd: dataDir, env: runtimeEnv(), timeout: 20000 });
      if (pipCheck.code !== 0) {
        const bootstrapped = await run(python, ['-m', 'ensurepip', '--upgrade'], { cwd: dataDir, env: runtimeEnv(), timeout: 120000 });
        if (bootstrapped.code !== 0) {
          fs.rmSync(contained(venv), { recursive: true, force: true });
          const recreated = await run(detected.command, [...detected.prefix, '-m', 'venv', venv], {
            cwd: dataDir, env: runtimeEnv(), timeout: 180000,
          });
          if (recreated.code !== 0 || !fs.existsSync(python)) {
            throw new EngineHostError('Rebuilding the damaged isolated environment failed; retry repair', 'ENGINE_VENV');
          }
        }
      }
      phase('installing', 'Installing aiohttp and Pillow; progress depends on the package connection');
      const pip = await run(python, [
        '-m', 'pip', 'install', '--force-reinstall', '--disable-pip-version-check', '--no-input',
        '-r', path.join(engineDir, 'requirements.txt'),
      ], { cwd: dataDir, env: runtimeEnv(), timeout: 600000 });
      if (pip.code !== 0) {
        throw new EngineHostError('Dependency installation failed; check the Python package connection and retry repair', 'ENGINE_DEPENDENCIES');
      }
      deps = await dependencies(python);
      if (!deps) throw new EngineHostError('Dependency verification failed after installation; retry repair', 'ENGINE_DEPENDENCIES');
    }
    phase('checking', 'Checking the actual engine and its configuration');
    const check = await run(python, [path.join(engineDir, 'run_engine.py'), '--check', '--config', configFile], {
      cwd: dataDir, env: runtimeEnv(), timeout: 60000,
    });
    if (check.code !== 0) {
      throw new EngineHostError('Engine self-check failed; check the advanced configuration and retry repair', 'ENGINE_CHECK');
    }
    state.dependencies = deps;
    state.python = { executable: python, version: deps.python };
    atomicJson(readyFile, { sourceHash, dependencies: deps, checkedAt: new Date().toISOString() });
    return python;
  }

  async function ensure({ repair = false } = {}) {
    if (state.starting) return state.starting;
    const epoch = state.lifecycleEpoch;
    state.starting = (async () => {
      try {
        const endpoint = parseEngineUrl(cfg().engineUrl);
        const bundle = bundledSource();
        state.sourceHash = bundle.sourceHash;
        const current = await probe();
        if (current && !repair) {
          state.health = current;
          state.ready = true;
          state.lastError = '';
          phase(managed() ? 'ready' : 'external', '');
          return true;
        }
        if (!managed()) {
          if (!current) throw new EngineHostError('External engine identity, token or local cache root could not be verified', 'ENGINE_IDENTITY');
          state.health = current;
          state.ready = true;
          phase('external', '');
          return true;
        }
        if (current && repair && (state.activeRequests || state.held.size)) {
          throw new EngineHostError('Wait for active parsing and sending before repairing dependencies', 'ENGINE_BUSY');
        }
        if (!current && await portOpen(endpoint.host, endpoint.port)) {
          throw new EngineHostError(`Loopback port ${endpoint.port} is occupied by an unverified service; choose another engineUrl port`, 'ENGINE_PORT_CONFLICT');
        }
        ensureDataDir();
        phase('preparing', 'Verifying and copying the bundled engine source');
        if (fs.existsSync(readyFile)) fs.unlinkSync(contained(readyFile));
        const engineDir = prepareSource(bundle);
        const configFile = effectiveConfig(bundle, endpoint);
        const python = await preparePython(engineDir, configFile, bundle.sourceHash);
        if (state.lifecycleEpoch !== epoch) {
          phase('stopped', '');
          return false;
        }
        if (current) {
          state.health = current;
          state.ready = true;
          phase('ready', '');
          return true;
        }
        if (await portOpen(endpoint.host, endpoint.port)) {
          throw new EngineHostError(`Loopback port ${endpoint.port} became occupied; no process was stopped`, 'ENGINE_PORT_CONFLICT');
        }
        const info = {
          serviceId: SERVICE_ID, version: ENGINE_VERSION, sourceHash: bundle.sourceHash,
          instanceId: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'),
          url: endpoint.url, cacheRoot: cacheRoot(), engineDir, createdAt: new Date().toISOString(),
        };
        state.record = info;
        atomicJson(instanceFile, info);
        if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) {
          fs.renameSync(contained(logFile), contained(`${logFile}.previous`));
        }
        const fd = fs.openSync(contained(logFile), 'a', 0o600);
        phase('starting', 'Starting the authenticated local engine');
        try {
          const child = spawn(python, [path.join(engineDir, 'run_engine.py'), '--config', configFile],
            managedPythonSpawnOptions({
              cwd: dataDir,
              logFd: fd,
              env: runtimeEnv({
                MEDIA_PARSER_TOKEN: info.token,
                MEDIA_PARSER_INSTANCE_ID: info.instanceId,
                MEDIA_PARSER_SOURCE_HASH: info.sourceHash,
                ...(cfg().ffmpegPath ? { MEDIA_PARSER_FFMPEG: String(cfg().ffmpegPath) } : {}),
              }),
            }));
          state.child = child;
          child.once('error', () => {
            state.lastError = 'Starting the Python engine process failed';
            state.ready = false;
          });
          child.once('exit', () => {
            if (state.child === child) {
              state.child = null;
              state.ready = false;
              if (state.phase === 'ready') state.phase = 'unavailable';
            }
          });
          child.unref();
        } finally {
          fs.closeSync(fd);
        }
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          const currentHealth = await probe();
          if (currentHealth) {
            if (state.lifecycleEpoch !== epoch) {
              await request('/shutdown', {
                method: 'POST',
                body: { instanceId: currentHealth.instanceId, sourceHash: currentHealth.sourceHash },
                budget: 3000,
              });
              phase('stopped', '');
              return false;
            }
            state.health = currentHealth;
            state.ready = true;
            state.lastError = '';
            phase('ready', '');
            return true;
          }
          if (state.child?.exitCode !== null && state.child?.exitCode !== undefined) break;
          await delay(250);
        }
        throw new EngineHostError('The local engine did not become ready; inspect engine.log and retry repair', 'ENGINE_START');
      } catch (error) {
        return failed(error);
      }
    })().finally(() => { state.starting = null; });
    return state.starting;
  }

  async function waitForEnsure(deadlineAt, signal) {
    if (signal?.aborted) throw signal.reason || new EngineHostError('Parse cancelled', 'ENGINE_CANCELLED');
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new EngineHostError('Parse deadline exceeded', 'ENGINE_DEADLINE');
    let timer;
    let abort;
    try {
      const ok = await Promise.race([
        ensure(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new EngineHostError('Parse deadline exceeded', 'ENGINE_DEADLINE')), remaining);
          abort = () => reject(signal.reason || new EngineHostError('Parse cancelled', 'ENGINE_CANCELLED'));
          signal?.addEventListener('abort', abort, { once: true });
        }),
      ]);
      if (!ok) throw new EngineHostError(state.lastError || 'Engine is preparing', 'ENGINE_NOT_READY');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function parse(payload, { deadlineAt = Date.now() + timeoutMs(), signal } = {}) {
    if (!payload || typeof payload !== 'object' || typeof payload.text !== 'string' || payload.text.length > 65536) {
      throw new EngineHostError('Invalid parse payload', 'ENGINE_REQUEST');
    }
    deadlineAt = Math.min(Number(deadlineAt), Date.now() + timeoutMs());
    if (!Number.isFinite(deadlineAt)) throw new EngineHostError('Invalid parse deadline', 'ENGINE_REQUEST');
    await waitForEnsure(deadlineAt, signal);
    const taskId = crypto.randomUUID();
    const connection = transport();
    state.activeRequests += 1;
    try {
      const result = await request('/parse', {
        method: 'POST', body: { ...payload, taskId, deadlineAt }, connection, signal,
        budget: Math.max(1, deadlineAt - Date.now()),
      });
      if (result.leaseId && Array.isArray(result.leasedFiles)) {
        for (const [id, files] of state.responseLeases) {
          if (files.expiresAt <= Date.now()) state.responseLeases.delete(id);
        }
        const files = new Set(result.leasedFiles.map(normalizeFileReference));
        files.expiresAt = Date.now() + 600000;
        state.responseLeases.set(result.leaseId, files);
      }
      return result;
    } catch (error) {
      await request('/cancel', { method: 'POST', connection, body: { taskId }, budget: 1800 }).catch(() => {});
      if (error.code === 'ENGINE_UNREACHABLE' && !signal?.aborted) {
        state.ready = false;
        // Recover the managed service for the next request, but never replay
        // this parse. The service may already have downloaded most of a file.
        if (managed()) Promise.resolve().then(() => ensure()).catch(() => {});
        throw new EngineHostError(
          'Engine connection was interrupted; the parse request was not replayed',
          'ENGINE_INTERRUPTED',
          { cause: error },
        );
      }
      throw error;
    } finally {
      state.activeRequests -= 1;
    }
  }

  async function stop() {
    if (!managed()) return false;
    state.lifecycleEpoch += 1;
    const info = await probe({ owned: true, forStop: true });
    if (!info) {
      state.ready = false;
      state.phase = 'stopped';
      return false;
    }
    const connection = transport({ owned: true });
    await request('/shutdown', {
      method: 'POST', connection,
      body: { instanceId: info.instanceId, sourceHash: info.sourceHash }, budget: 3000,
    });
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if (!await portOpen(connection.host, connection.port)) {
        state.ready = false;
        state.phase = 'stopped';
        state.health = null;
        state.child = null;
        return true;
      }
      await delay(150);
    }
    throw new EngineHostError('The authenticated engine has not finished stopping', 'ENGINE_STOP');
  }

  async function holdFiles(files) {
    if (!files?.length) return { ok: true, files: [] };
    const result = await request('/hold-files', { method: 'POST', body: { files, seconds: 600 } });
    for (const file of result.files || []) {
      const key = normalizeFileReference(file);
      const entries = state.held.get(key) || [];
      entries.push(result.leaseId);
      state.held.set(key, entries);
    }
    if (!state.leaseHeartbeat && state.held.size) {
      state.leaseHeartbeat = setInterval(() => {
        const leases = new Map();
        for (const [file, ids] of state.held) {
          for (const leaseId of ids) {
            const refs = leases.get(leaseId) || [];
            refs.push(file);
            leases.set(leaseId, refs);
          }
        }
        for (const [leaseId, refs] of leases) {
          request('/hold-files', {
            method: 'POST', body: { files: refs, leaseId, seconds: 600 }, budget: 2500,
          }).catch(() => {});
        }
      }, 120000);
      state.leaseHeartbeat.unref?.();
    }
    return result;
  }

  async function releaseFiles(files) {
    const normalized = new Set((files || []).map(normalizeFileReference));
    const ids = new Set();
    for (const file of normalized) {
      const entries = state.held.get(file);
      if (entries?.length) {
        ids.add(entries.pop());
        if (!entries.length) state.held.delete(file);
      }
    }
    // A lease may cover several files. Only release it after all its held files finish.
    const inUse = new Set([...state.held.values()].flat());
    for (const id of [...ids]) if (inUse.has(id)) ids.delete(id);
    for (const [id, pinned] of state.responseLeases) {
      for (const file of normalized) pinned.delete(file);
      if (!pinned.size) {
        ids.add(id);
        state.responseLeases.delete(id);
      }
    }
    if (!state.held.size && state.leaseHeartbeat) {
      clearInterval(state.leaseHeartbeat);
      state.leaseHeartbeat = null;
    }
    for (const leaseId of ids) {
      await request('/release-files', { method: 'POST', body: { leaseId }, budget: 2500 });
    }
    return { ok: true, released: ids.size };
  }

  return {
    get cacheRoot() { return cacheRoot(); },
    status() {
      return {
        phase: state.phase, ready: Boolean(state.ready), mode: managed() ? 'managed' : 'external',
        lastError: state.lastError, progress: state.progress, version: ENGINE_VERSION,
        sourceHash: state.sourceHash || state.health?.sourceHash || '',
        instanceId: state.health?.instanceId || '', platformCount: state.health?.platforms || 0,
        python: state.python, dependencies: state.dependencies,
        ffmpeg: Boolean(state.health?.ffmpeg), cache: state.health?.cache || null,
        translation: Boolean(state.health?.translation),
        cacheRoot: cacheRoot(), activeRequests: state.activeRequests || 0,
        preparing: Boolean(state.starting),
      };
    },
    ensure, health, parse, stop, holdFiles, releaseFiles,
    async platforms() { return (await request('/platforms')).platforms; },
    async clean() { return request('/clean', { method: 'POST', body: {}, budget: 15000 }); },
    async cleanupFiles(files) { return request('/cleanup-files', { method: 'POST', body: { files }, budget: 10000 }); },
    async restart() {
      if (!managed()) return false;
      if (state.activeRequests || state.held.size) throw new EngineHostError('Wait for active parsing and sending before restarting', 'ENGINE_BUSY');
      if (await probe({ owned: true, forStop: true })) await stop();
      return ensure();
    },
  };
}
