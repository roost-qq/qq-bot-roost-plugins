import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_MODES, redact, isObject } from './settings.js';
import { extractLinks, REPLY_JUDGE_BYPASS } from './links.js';
import { isInternalChatText } from './delivery.js';

export const PANEL_AUTH_BOUNDARY = 'Roost 在插件路由之前校验面板会话或本插件页面令牌、JSON Content-Type 与同源策略。当前宿主 ctx 不向插件提供用户或角色身份；维护权限随本管理页面的实际授权令牌授予，不能在插件内进一步区分 owner。页面维护权限不等于 QQ 主人身份。请求体自报 owner 不参与授权；chatId、userId 或 target 也不能指定私信接收目标。';

export function previewOutcome(outcome, sanitize = redact) {
  const messages = [];
  let nodes = 0;
  const walk = (value, depth = 0) => {
    if (++nodes > 500 || depth > 10 || messages.length >= 100 || !value) return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    if (typeof value !== 'object') return;
    const type = String(value.type ?? value.kind ?? '').toLowerCase();
    if (['forward', 'node'].includes(type)) {
      walk(value.data?.content ?? value.data?.messages ?? value.data?.nodes ?? value.content ?? value.messages ?? value.nodes, depth + 1);
      return;
    }
    if (type === 'text') {
      const text = String(value.data?.text ?? value.text ?? value.content ?? '');
      if (!isInternalChatText(text)) messages.push({ type, text: text.slice(0, 6000) });
      return;
    }
    if (['image', 'video', 'record', 'audio', 'file'].includes(type)) {
      const file = value.data?.file ?? value.data?.path ?? value.file ?? value.path ?? value.data?.url ?? value.url ?? '';
      const name = String(value.data?.name ?? value.name ?? file).replace(/\\/g, '/').split('/').pop().slice(0, 160);
      messages.push({ type, name, ...(Number(value.size) > 0 ? { size: Number(value.size) } : {}) });
      return;
    }
    if (value.messages) walk(value.messages, depth + 1);
    else if (value.segments) walk(value.segments, depth + 1);
    else if (value.content && typeof value.content === 'object') walk(value.content, depth + 1);
  };
  walk(outcome?.plan?.messages ?? outcome?.items ?? []);
  return sanitize({
    messages,
    links: Array.isArray(outcome?.links) ? outcome.links.slice(0, 3).map((x) => typeof x === 'string' ? x : { platform: x.platform, url: x.url }) : [],
    blocked: outcome?.blocked ?? [],
    skipped: outcome?.skipped ?? [],
    truncated: nodes > 500 || messages.length >= 100,
    note: '仅真实解析并预览；没有向聊天发送任何内容。',
  });
}

export async function detectHostBoundaries(ctx) {
  const result = {
    replyJudge: { installed: false, enabled: null, bypassConfigured: false },
    bypassRegex: REPLY_JUDGE_BYPASS,
    warnings: [
      'reply-judge 中间件在普通监听器前运行。若启用，请把这里的受支持链接规则加入该插件现有 bypassRegex。',
      'Roost 外接事件先于普通插件处理广播；另开 DSH 自动聊天时，后续认领无法撤回已经广播的事件。本插件的默认解析链路不调用模型。',
      '普通群聊及 C2C 发送适配可用；频道和频道私信暂未支持。',
      '同机多机器人使用独立数据目录，托管引擎端口需要各自不同。',
    ],
    panelAuthorization: PANEL_AUTH_BOUNDARY,
    groupSwitch: '当前宿主 ctx 未提供群插件开关写接口；群开关使用宿主 /群插件 开|关 media-parser 或面板分群设置。「/解析 开|关」会指引到这个宿主开关，不会另存群名单。',
  };
  // Paths come from the framework-owned dataDir, never from request parameters.
  const botData = path.dirname(path.dirname(path.resolve(ctx.dataDir)));
  const botId = path.basename(botData);
  if (path.basename(path.dirname(botData)) !== 'bots') return result;
  const home = path.dirname(path.dirname(path.dirname(botData)));
  const configFile = path.join(home, 'config', 'bots', botId, 'plugins', 'reply-judge.json');
  const stateFile = path.join(botData, 'plugins.json');
  try {
    const text = await fs.readFile(configFile, 'utf8');
    const cfg = JSON.parse(text);
    result.replyJudge.installed = true;
    result.replyJudge.enabled = cfg.enabled !== false;
    result.replyJudge.bypassConfigured = typeof cfg.bypassRegex === 'string' && Boolean(cfg.bypassRegex.trim());
  } catch {}
  try {
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if ('reply-judge' in state) { result.replyJudge.installed = true; result.replyJudge.enabled = state['reply-judge'] !== false; }
  } catch {}
  return result;
}

export function registerPanel(ctx, runtime) {
  if (typeof ctx.registerRoute !== 'function') return;
  const respond = (req, code, data) => typeof req.json === 'function' ? req.json(code, data) : { __response: { code, data } };
  const route = (method, url, handler) => ctx.registerRoute(method, url, async (req) => {
    // The only trusted authority here is Roost's authenticated dispatcher.
    // body.owner, body.role and similarly named user data are never consulted.
    if (!runtime.isActive()) return respond(req, 409, { error: '该页面属于已停用的插件代次，请刷新面板' });
    try {
      await runtime.ready;
      if (!runtime.isActive()) return respond(req, 409, { error: '该页面属于已停用的插件代次，请刷新面板' });
      const result = await handler(req);
      if (!runtime.isActive()) return respond(req, 409, { error: '该页面属于已停用的插件代次，请刷新面板' });
      return result;
    } catch (error) {
      const code = error?.code === 'QUEUE_FULL' ? 429 : error?.code === 'DM_STALE' ? 409 : 400;
      const message = url.startsWith('/bili/') || url.startsWith('/dm/')
        ? runtime.dmErrorText?.(error) || '私信功能暂时不可用。'
        : runtime.settings.sanitize(error?.message || '操作失败');
      return respond(req, code, { error: message });
    }
  });
  route('GET', '/status', async () => runtime.publicStatus());
  route('GET', '/config', async () => ({
    config: runtime.settings.publicConfig(), advanced: runtime.settings.advanced(),
    credentials: runtime.settings.credentialHints(), restartRequired: runtime.restartRequired,
    migration: runtime.settings.configMigration(),
  }));
  route('PUT', '/config', async ({ body }) => {
    const patch = isObject(body?.config) ? body.config : body;
    if (!isObject(patch)) throw new Error('缺少配置对象');
    if (patch.biliDmEnabled === true && typeof runtime.verifyDmEnable === 'function') {
      const check = await runtime.verifyDmEnable();
      if (!check.ok) throw new Error(check.text);
    }
    const previous = runtime.settings.current();
    const config = await runtime.settings.saveConfig(patch);
    runtime.applyDmConfig?.();
    const restartKeys = ['engineMode', 'engineUrl', 'pythonPath', 'ffmpegPath', 'externalCacheRoot', 'hotComments', 'translation', 'maxFileMiB'];
    runtime.restartRequired ||= restartKeys.some((key) => previous[key] !== config[key]);
    runtime.refresh();
    return { ok: true, config, restartRequired: runtime.restartRequired };
  });
  route('GET', '/platforms', async () => ({ platforms: runtime.settings.platforms(), modes: PLATFORM_MODES }));
  route('PUT', '/platforms', async ({ body }) => {
    if (!isObject(body?.parsers)) throw new Error('缺少 parsers 对象');
    await runtime.settings.saveAdvanced({ parsers: body.parsers });
    runtime.restartRequired = true;
    return { ok: true, platforms: runtime.settings.platforms(), restartRequired: true };
  });
  route('PUT', '/advanced', async ({ body }) => {
    const advanced = await runtime.settings.saveAdvanced(body?.advanced ?? body);
    runtime.restartRequired = true;
    return { ok: true, advanced, credentials: runtime.settings.credentialHints(), restartRequired: true };
  });
  route('PUT', '/credentials', async ({ body }) => {
    const credentials = await runtime.settings.saveCredentials(body?.credentials ?? body);
    runtime.restartRequired = true;
    return { ok: true, credentials, restartRequired: true };
  });
  route('GET', '/tasks', async ({ query }) => runtime.settings.sanitize(runtime.queue.list(query ?? {})));
  route('GET', '/tasks/:id', async ({ params }) => {
    const task = runtime.queue.get(params.id);
    if (!task) throw new Error('任务不存在或已过保留上限');
    return { task: runtime.settings.sanitize(task), preview: runtime.previews.get(params.id) ?? null };
  });
  route('POST', '/preview', async ({ body }) => {
    if (typeof body?.text !== 'string' || body.text.length > 16000) throw new Error('请输入 16000 字符以内的分享链接');
    const links = extractLinks(body.text, runtime.settings.current());
    if (!links.length) throw new Error('没有发现已启用的受支持链接');
    if (!runtime.engineReady()) throw new Error('引擎准备中，请先查看引擎状态');
    return { ok: true, taskId: runtime.startPreview(links) };
  });
  route('POST', '/operations', async ({ body }) => {
    const action = String(body?.action ?? '');
    if (!['prepare', 'repair', 'start', 'stop', 'restart', 'clean'].includes(action)) throw new Error('维护动作不合法');
    return { ok: true, taskId: runtime.startOperation(action) };
  });
  route('GET', '/operations/:id', async ({ params }) => {
    const task = runtime.operations.get(params.id);
    if (!task) throw new Error('维护任务不存在或已过保留上限');
    return { task: runtime.settings.sanitize(task) };
  });
  route('GET', '/boundaries', async () => runtime.boundaries);
  route('GET', '/dm/providers', async () => ({ providers: runtime.providerList() }));
  route('GET', '/dm/providers/:provider/status', async ({ params }) => (
    runtime.providerStatus(params.provider)
  ));
  // Read-only local snapshot for the sanitized acceptance log. This route never
  // triggers an upstream request and never returns message bodies or credentials.
  route('GET', '/dm/providers/:provider/acceptance', async ({ params, query }) => (
    runtime.providerAcceptance(params.provider, { query })
  ));
  route('GET', '/dm/providers/:provider/login/status', async ({ params }) => (
    runtime.providerLoginStatus(params.provider, true)
  ));
  route('POST', '/dm/providers/:provider/login/start', async ({ params }) => (
    runtime.providerLoginStart(params.provider)
  ));
  route('POST', '/dm/providers/:provider/login/cancel', async ({ params }) => (
    runtime.providerLoginCancel(params.provider)
  ));
  route('POST', '/dm/providers/:provider/login/inspect', async ({ params }) => (
    runtime.providerLoginInspect(params.provider)
  ));
  route('POST', '/dm/providers/:provider/login/manual', async ({ params, body }) => (
    runtime.providerLoginManual(params.provider, body)
  ));
  route('POST', '/dm/providers/:provider/login/logout', async ({ params }) => (
    runtime.providerLoginLogout(params.provider)
  ));
  route('PUT', '/dm/providers/:provider/config', async ({ params, body }) => (
    runtime.providerSaveConfig(params.provider, body)
  ));
  route('GET', '/dm/providers/:provider/groups', async ({ params }) => (
    runtime.providerGroupOptions(params.provider)
  ));
  route('PUT', '/dm/providers/:provider/target', async ({ params, body }) => (
    runtime.providerSetTarget(params.provider, body)
  ));
  route('POST', '/dm/providers/:provider/check', async ({ params }) => ({
    ok: true,
    dm: await runtime.providerCheck(params.provider),
  }));
  route('POST', '/dm/providers/:provider/test', async ({ params }) => {
    const result = await runtime.providerSendTest(params.provider);
    return {
      ...result,
      note: '测试使用现有绑定并重新校验主人权限；不读取或消耗真实私信。',
    };
  });
  route('POST', '/dm/providers/:provider/recovery', async ({ params }) => (
    runtime.providerClearManualRecovery(params.provider)
  ));
  // Dedicated Bilibili login and private-message routes stay inside the same
  // authenticated plugin route prefix. The dispatcher's maintenance token is
  // not owner identity; these handlers never accept a target from the body.
  route('GET', '/bili/login/status', async () => runtime.dmLoginStatus(true));
  route('POST', '/bili/login/start', async () => runtime.dmLoginStart());
  route('POST', '/bili/login/cancel', async () => runtime.dmLoginCancel());
  route('GET', '/bili/login/inspect', async () => runtime.dmLoginInspect());
  route('POST', '/bili/login/manual', async ({ body }) => runtime.dmLoginManual(body));
  route('POST', '/bili/login/logout', async () => runtime.dmLoginLogout());
  route('GET', '/bili/dm/status', async () => runtime.safeDmStatus());
  route('GET', '/bili/dm/groups', async () => runtime.dmGroupOptions());
  route('PUT', '/bili/dm/target', async ({ body }) => runtime.dmSetTarget(body));
  route('PUT', '/bili/dm/config', async ({ body }) => {
    const saved = await runtime.dmSaveConfig(body);
    return { ...saved, dm: runtime.safeDmStatus() };
  });
  route('POST', '/bili/dm/check', async () => ({ ok: true, dm: await runtime.dmCheck() }));
  route('POST', '/bili/dm/test', async () => {
    const result = await runtime.dmSendTest();
    return { ...result, note: '测试使用现有绑定并重新校验主人权限；不读取或消耗真实私信。' };
  });
  route('POST', '/bili/dm/recovery', async () => runtime.dmClearManualRecovery());
  if (typeof ctx.registerPage === 'function') {
    const file = fileURLToPath(new URL('./page.html', import.meta.url));
    // Reading the local template is short and does not wait for engine setup.
    runtime.pageReady = fs.readFile(file, 'utf8').then((html) => {
      if (runtime.isActive()) return ctx.registerPage({ key: 'manage', label: '解析管理', html });
      return null;
    }).catch((error) => ctx.logger?.warn?.(`管理页加载失败：${runtime.settings.sanitize(error.message)}`));
  }
}
