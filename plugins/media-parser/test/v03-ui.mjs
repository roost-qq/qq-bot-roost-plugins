import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const html = await fs.readFile(new URL('../page.html', import.meta.url), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

const sectionIds = [
  'engine-section',
  'dm-card',
  'settings-section',
  'engine-settings-section',
  'preview-section',
  'advanced-section',
  'credentials-section',
  'boundaries-section',
  'platforms-section',
  'logs-section'
];

function extractFunction(name) {
  const asyncToken = 'async function ' + name + '(';
  const plainToken = 'function ' + name + '(';
  let start = script.indexOf(asyncToken);
  if (start < 0) start = script.indexOf(plainToken);
  assert.ok(start >= 0, 'missing function ' + name);
  const brace = script.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    else if (script[index] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(start, index + 1);
    }
  }
  assert.fail('unterminated function ' + name);
}

function makeStorageHarness(botQuery) {
  const store = new Map();
  const writes = [];
  const fakeWindow = {
    localStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { writes.push([key, value]); store.set(key, value); }
    }
  };
  const source = ['storageKeyForBot', 'readPreferredProvider', 'savePreferredProvider']
    .map(extractFunction).join('\n');
  const api = new Function('window', 'bot', 'PROVIDER_IDS', source +
    '\nreturn { storageKeyForBot, readPreferredProvider, savePreferredProvider };')(
    fakeWindow, botQuery, ['bilibili', 'xiaoheihe']);
  return { api, store, writes };
}

function makeEpochHarness() {
  const state = {
    selectedProviderId: 'bilibili',
    viewGeneration: 1,
    accountRevision: 0,
    readSequence: 0,
    actionSequence: 0
  };
  const latestReadSequence = new Map();
  const latestActionSequence = new Map();
  const currentActionEpoch = new Map();
  const serverAccountVersion = new Map();
  const names = ['safeServerVersion', 'isOlderServerVersion', 'noteServerVersion', 'captureView', 'beginAction', 'viewStale', 'readStale'];
  const source = names.map(extractFunction).join('\n')
    .replace(/\bselectedProviderId\b/g, 'state.selectedProviderId')
    .replace(/\bviewGeneration\b/g, 'state.viewGeneration')
    .replace(/\baccountRevision\b/g, 'state.accountRevision')
    .replace(/\breadSequence\b/g, 'state.readSequence')
    .replace(/\bactionSequence\b/g, 'state.actionSequence');
  const api = new Function('state', 'latestReadSequence', 'latestActionSequence', 'currentActionEpoch', 'serverAccountVersion', source +
    '\nreturn { safeServerVersion, isOlderServerVersion, noteServerVersion, captureView, beginAction, viewStale, readStale };')(
    state, latestReadSequence, latestActionSequence, currentActionEpoch, serverAccountVersion);
  return { api, state };
}

function makeRunActionHarness() {
  const actionOwners = new Map();
  const state = { forbidden: false, stale: false };
  const button = { disabled: false };
  const applyControlState = () => { button.disabled = state.forbidden || actionOwners.has(button); };
  const feedback = () => {};
  const runAction = new Function('actionOwners', 'applyControlState', 'viewStale', 'feedback',
    extractFunction('runAction') + '\nreturn runAction;')(
    actionOwners, applyControlState, () => state.stale, feedback);
  return { runAction, actionOwners, state, button };
}

function makeSystemFieldHarness() {
  const elements = {
    'dm-system-field': { hidden: false },
    'dm-include-system': { disabled: false, checked: true }
  };
  const actionOwners = new Map();
  const lookup = (id) => elements[id] || null;
  const sync = new Function('$', 'actionOwners',
    extractFunction('syncSystemMessageField') + '\nreturn syncSystemMessageField;')(lookup, actionOwners);
  return { sync, elements, actionOwners };
}

function makeRenderLoginHarness() {
  const status = { textContent: '' };
  const calls = { qr: [], ensure: 0, clear: 0 };
  const labels = {
    idle: '未开始', starting: '生成中', waiting: '等待扫码', scanned: '已扫码待确认',
    success: '已登录', expired: '已过期', cancelled: '已取消', error: '错误',
    missing: '未登录', valid: '有效', invalid: '已失效', unavailable: '不可用'
  };
  const source = ['loginExpiryText', 'loginRetryWaitText', 'renderLogin'].map(extractFunction).join('\n');
  const api = new Function('viewStale', 'providerInfo', 'loginStateLabels', 'textValue', '$', 'showQr', 'ensureQrTimer', 'clearQrTimer',
    source + '\nreturn { renderLogin, loginExpiryText };')(
    () => false,
    () => ({ label: 'B站', capabilities: { supportsQrLogin: true } }),
    labels,
    (value) => typeof value === 'string' ? value : '',
    (id) => id === 'dm-login-status' ? status : null,
    (url) => { calls.qr.push(url); },
    () => { calls.ensure += 1; },
    () => { calls.clear += 1; }
  );
  return { ...api, status, calls };
}

test('page has the ten planned top-level sections in order with only three expanded', () => {
  const positions = sectionIds.map((id) => html.indexOf('id="' + id + '"'));
  assert.ok(positions.every((position) => position >= 0), 'every planned section exists');
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index - 1] < positions[index], sectionIds[index - 1] + ' precedes ' + sectionIds[index]);
  }
  for (const id of ['engine-section', 'settings-section', 'engine-settings-section']) {
    assert.match(html, new RegExp('<details class="card section" id="' + id + '" open>'));
  }
  for (const id of ['dm-card', 'preview-section', 'advanced-section', 'credentials-section', 'boundaries-section', 'platforms-section', 'logs-section']) {
    assert.match(html, new RegExp('<details class="card section" id="' + id + '"' + '>'));
  }
  assert.match(html, /id="shortcut-access"/);
  assert.ok(html.indexOf('id="shortcut-access"') < html.indexOf('id="dm-card"'));
  assert.match(html, /id="logs-section"[\s\S]*<h3>完整引擎诊断<\/h3>[\s\S]*id="diagnostics"/);
  assert.match(html, /id="logs-section"[\s\S]*id="task-rows"/);
  assert.match(html, /id="platforms-section"[\s\S]*id="save-platforms"[\s\S]*id="logs-section"/);
});

test('page displays plugin 0.4.2 and does not retain obsolete baseline text', () => {
  assert.match(html, /v0\.4\.2/);
  assert.equal(html.includes('v0.2.0'), false);
  assert.doesNotMatch(html, /验收中/);
  assert.match(html, /读取可能影响未读状态/);
});

test('page script parses and keeps token forwarding without unsafe DOM writes', () => {
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /\/api\/plugins\/media-parser\/r/);
  assert.match(script, /params\.set\('pt', token\)/);
  assert.match(script, /Content-Type/);
  assert.equal(script.includes('innerHTML'), false);
  assert.equal(script.includes('cdn'), false);
  assert.equal(script.includes('document.write'), false);
  assert.match(script, /textContent/);
  assert.match(script, /pagehide/);
  assert.match(script, /visibilitychange/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
});

test('provider preference uses clear localStorage and saves only a fixed provider id under a bot key', () => {
  assert.match(script, /window\.localStorage/);
  assert.equal(script.includes("window['local' + 'Storage']"), false);
  const harness = makeStorageHarness('bot-query-123');
  assert.equal(harness.api.storageKeyForBot(), 'media-parser.dmProvider.bot-query-123');
  harness.store.set('media-parser.dmProvider.bot-query-123', 'xiaoheihe');
  assert.equal(harness.api.readPreferredProvider(), 'xiaoheihe');
  harness.store.set('media-parser.dmProvider.bot-query-123', 'not-a-provider');
  assert.equal(harness.api.readPreferredProvider(), 'bilibili');
  harness.writes.length = 0;
  harness.api.savePreferredProvider('xiaoheihe');
  assert.deepEqual(harness.writes, [['media-parser.dmProvider.bot-query-123', 'xiaoheihe']]);
  harness.api.savePreferredProvider('evil');
  assert.equal(harness.writes.length, 1);
});

test('scoped read and action epochs reject stale responses', () => {
  const harness = makeEpochHarness();
  const staleRead = harness.api.captureView('bilibili', 'status');
  const latestRead = harness.api.captureView('bilibili', 'status');
  assert.equal(harness.api.readStale(staleRead), true);
  assert.equal(harness.api.readStale(latestRead), false);

  const beforeAction = harness.api.captureView('bilibili', 'status');
  const action = harness.api.beginAction('bilibili');
  assert.equal(harness.api.readStale(beforeAction), true);
  assert.equal(harness.api.viewStale(action), false);

  const olderAction = harness.api.beginAction('bilibili');
  const newerAction = harness.api.beginAction('bilibili');
  assert.equal(harness.api.viewStale(olderAction), true);
  assert.equal(harness.api.viewStale(newerAction), false);

  harness.state.selectedProviderId = 'xiaoheihe';
  harness.state.viewGeneration += 1;
  assert.equal(harness.api.readStale(newerAction), true);
});

test('server account/session versions reject late older responses', () => {
  const harness = makeEpochHarness();
  const read = harness.api.captureView('bilibili', 'status');
  const action = harness.api.beginAction('bilibili');
  harness.api.noteServerVersion('bilibili', 5);
  assert.equal(harness.api.isOlderServerVersion('bilibili', 4), true);
  assert.equal(harness.api.isOlderServerVersion('bilibili', 5), false);
  assert.equal(harness.api.readStale(read), true);
  assert.equal(harness.api.viewStale(action), true);
});

test('delayed action completion re-applies current capabilities and never unlocks a newer owner', async () => {
  const harness = makeRunActionHarness();
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const pending = harness.runAction(harness.button, { providerId: 'bilibili' }, () => first);
  assert.equal(harness.button.disabled, true);
  harness.state.forbidden = true;
  harness.state.stale = true;
  resolveFirst('done');
  await pending;
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.actionOwners.has(harness.button), false);

  const second = makeRunActionHarness();
  let resolveOlder;
  const olderPromise = new Promise((resolve) => { resolveOlder = resolve; });
  const older = second.runAction(second.button, { providerId: 'bilibili' }, () => olderPromise);
  const newerOwner = {};
  second.actionOwners.set(second.button, newerOwner);
  resolveOlder('done');
  await older;
  assert.equal(second.actionOwners.get(second.button), newerOwner);
  assert.equal(second.button.disabled, true);
});

test('Bili-only system-message field is hidden and disabled outside Bili then restored', () => {
  assert.match(html, /\[hidden\]\{display:none!important\}/);
  const harness = makeSystemFieldHarness();
  assert.equal(harness.sync('bilibili'), true);
  assert.equal(harness.elements['dm-system-field'].hidden, false);
  assert.equal(harness.elements['dm-include-system'].disabled, false);

  harness.elements['dm-include-system'].checked = true;
  assert.equal(harness.sync('xiaoheihe'), false);
  assert.equal(harness.elements['dm-system-field'].hidden, true);
  assert.equal(harness.elements['dm-include-system'].disabled, true);
  assert.equal(harness.elements['dm-include-system'].checked, true);

  assert.equal(harness.sync('page.html'), false);
  assert.equal(harness.elements['dm-system-field'].hidden, true);
  assert.equal(harness.elements['dm-include-system'].disabled, true);

  assert.equal(harness.sync('bilibili'), true);
  assert.equal(harness.elements['dm-system-field'].hidden, false);
  assert.equal(harness.elements['dm-include-system'].disabled, false);

  harness.actionOwners.set(harness.elements['dm-include-system'], {});
  harness.sync('bilibili');
  assert.equal(harness.elements['dm-include-system'].disabled, true);
});

test('login label distinguishes cached validation from QR expiry and makes no expiry claim on terminal states', () => {
  assert.equal(script.includes("' · 有效期至 '"), false);
  const harness = makeRenderLoginHarness();
  const expiresAt = Date.UTC(2030, 0, 1, 12, 0, 0);

  harness.renderLogin({ state: 'valid', expiresAt }, 'bilibili', {});
  assert.match(harness.status.textContent, /本次登录校验缓存至/);
  assert.doesNotMatch(harness.status.textContent, /二维码有效期至/);
  assert.doesNotMatch(harness.status.textContent, /Cookie|登录过期/);

  for (const state of ['starting', 'waiting', 'scanned']) {
    harness.status.textContent = '';
    harness.renderLogin({ state, expiresAt }, 'bilibili', {});
    assert.match(harness.status.textContent, /二维码有效期至/);
    assert.doesNotMatch(harness.status.textContent, /本次登录校验缓存至/);
  }

  for (const state of ['success', 'cancelled', 'expired', 'error', 'missing', 'idle', 'unavailable']) {
    harness.status.textContent = '';
    harness.renderLogin({ state, expiresAt }, 'bilibili', {});
    assert.doesNotMatch(harness.status.textContent, /本次登录校验缓存至|二维码有效期至/);
    assert.doesNotMatch(harness.status.textContent, /有效期至/);
  }

  harness.status.textContent = '';
  harness.renderLogin({ state: 'valid' }, 'bilibili', {});
  assert.doesNotMatch(harness.status.textContent, /本次登录校验缓存至|有效期至/);
});

test('login rendering shows bounded local waiting without adding wait text to network failures', () => {
  const harness = makeRenderLoginHarness();
  for (const errorCode of ['XHH_COOLDOWN', 'XHH_BUDGET']) {
    harness.renderLogin({ state: 'error', errorCode, retryAfterMs: 15_000 }, 'xiaoheihe', {});
    assert.match(harness.status.textContent, /剩余等待约 15 秒/);
    assert.doesNotMatch(harness.status.textContent, /二维码有效期至|自动重试/);
    harness.renderLogin({ state: 'error', errorCode, retryAfterMs: 10 ** 12 }, 'xiaoheihe', {});
    assert.match(harness.status.textContent, /剩余等待约 86400 秒/);
  }
  for (const retryAfterMs of [0, -1, NaN, Infinity]) {
    harness.renderLogin({ state: 'error', errorCode: 'XHH_COOLDOWN', retryAfterMs }, 'xiaoheihe', {});
    assert.doesNotMatch(harness.status.textContent, /剩余等待/);
  }
  harness.renderLogin({ state: 'error', errorCode: 'XHH_TIMEOUT', retryAfterMs: 15_000 }, 'xiaoheihe', {});
  assert.doesNotMatch(harness.status.textContent, /剩余等待/);
});

test('Xiaoheihe config payload never includes the unsupported system-message option', () => {
  assert.match(script, /const includeSystem = providerId === 'bilibili' && values\.includeSystem === true/);
  assert.match(script, /if \(providerId === 'bilibili'\) config\.includeSystem = includeSystem/);
  assert.match(script, /if \(providerId === 'bilibili'\) \{[\s\S]*elements\.includeSystem\.checked/);
  assert.match(script, /syncSystemMessageField\(selectedProviderId\)/);
});

test('page uses provider routes with local-only status and explicit compatibility fallback', () => {
  assert.match(script, /\/dm\/providers\//);
  for (const suffix of ['/status', '/login/status', '/login/start', '/login/cancel', '/login/inspect', '/login/manual', '/login/logout', '/config', '/groups', '/target', '/check', '/test', '/acceptance?limit=50']) {
    assert.ok(script.includes("'" + suffix + "'"), 'provider route suffix ' + suffix);
  }
  assert.match(script, /fallback/);
  assert.match(script, /\/bili\/dm\/status/);
  assert.match(script, /\/bili\/login\/start/);
  assert.match(script, /\/bili\/login\/inspect/);
  assert.match(script, /supportsPrivateMessages/);
  assert.match(script, /supportsQrLogin/);
  assert.match(script, /supportsManualLogin/);
  assert.match(script, /xiaoheihe/);
  assert.equal(script.includes('验收中'), false);
  assert.equal(script.includes('experimental'), false);
  assert.match(script, /cooldownReason/);
  assert.match(script, /effectivePollSeconds/);
  assert.match(script, /nextRetryAt/);
  assert.match(script, /lastSuccessAt/);
  assert.match(script, /migration/);
  assert.equal(script.includes("dm-login-start').click()"), false);
});

test('collapsed sections do not request tasks, platforms or render long diagnostics', () => {
  assert.match(script, /if \(isSectionOpen\('logs-section'\)\) await loadTasks\(\)/);
  assert.match(script, /if \(isSectionOpen\('platforms-section'\)\) await loadPlatforms\(\)/);
  assert.match(script, /logs-section'\)\.addEventListener\('toggle'[\s\S]*if \(!\$\('logs-section'\)\.open\) return;[\s\S]*renderLogs\(lastStatus\)/);
  assert.match(script, /if \(!logsLoaded\) loadTasks\(\)/);
  assert.match(script, /platforms-section'\)\.addEventListener\('toggle'[\s\S]*if \(!\$\('platforms-section'\)\.open\) return;[\s\S]*loadPlatforms\(\)/);
});

test('page preserves original forms, maintenance and group target controls', () => {
  for (const id of [
    'settings-form', 'engine-form', 'preview-form', 'preview-text', 'preview-result',
    'advanced-form', 'advanced', 'credentials-form', 'credentials-fields', 'extra-credentials',
    'platforms', 'save-platforms', 'task-rows', 'prev-page', 'next-page', 'pagination',
    'diagnostics', 'operations', 'boundaries', 'bypass', 'auth-boundary',
    'dm-provider-select', 'dm-login-start', 'dm-login-cancel', 'dm-login-inspect', 'dm-login-logout',
    'dm-manual-form', 'dm-manual-cookie', 'dm-manual-save', 'dm-config-form', 'dm-config-save',
    'dm-enabled', 'dm-poll-seconds', 'dm-system-field', 'dm-include-system',
    'dm-check', 'dm-test', 'dm-send-to-group', 'dm-group-select',
    'dm-groups-refresh', 'dm-target-save', 'dm-group-hint', 'dm-target-status', 'dm-status',
    'dm-login-status', 'dm-qr', 'dm-acceptance', 'dm-acceptance-refresh',
    'dm-acceptance-events', 'dm-acceptance-status'
  ]) {
    assert.ok(html.includes('id="' + id + '"'), 'kept #' + id);
  }
  assert.match(html, /B站私信提醒/);
  assert.match(html, /\/解析 私信 绑定/);
});

test('Xiaoheihe acceptance view is collapsed, read-only and platform-scoped', () => {
  assert.match(html, /<details id="dm-acceptance" hidden>/);
  assert.match(html, /<th>阶段<\/th><th>时间<\/th><th>码<\/th><th>计数<\/th>/);
  assert.match(script, /suffix: '\/acceptance\?limit=50'/);
  assert.match(script, /method: 'GET', suffix: '\/acceptance\?limit=50'/);
  assert.match(script, /provider !== 'xiaoheihe'/);
  assert.match(script, /clearAcceptance\(\)/);
  assert.match(script, /box\.hidden = !show/);
  assert.match(script, /replaceChildren\(\)/);
  assert.match(script, /td', acceptanceCode/);
  assert.match(script, /td', acceptanceCounts/);
  assert.doesNotMatch(script, /setInterval\([^)]*acceptance/i);
  assert.equal(script.includes('innerHTML'), false);
  assert.equal(script.includes('晚上好'), false);
});
