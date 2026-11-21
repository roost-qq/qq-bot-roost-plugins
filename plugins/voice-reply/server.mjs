#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { MANIFEST } from './lib/config.mjs';
import { createService } from './lib/service.mjs';

export const TOOLS = [
  {
    name: 'voice_reply',
    description: '用户要求语音回复、说话、发个语音或念一句时使用。text 传准备好的简短答复或待朗读原文；随口一句可留空抽台词。返回的 reply 含语音标记，最终回复只输出 reply，不再调用 qq_send 或 say。工具只生成音频，未发送 QQ；失败请回复文字说明。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      text: { type: 'string', maxLength: 4000, description: '要朗读的正文；问答先组织答案再传入，留空抽一句台词' },
      message: { type: 'string', maxLength: 4000, description: '可选原始点播请求，仅在 text 留空时解析关键字后的正文' },
      chatId: { type: 'string', maxLength: 256, description: '当前会话标识，用于冷却和台词去重；省略则共用默认冷却' },
    } },
  },
  { name: 'voice_status', description: '查看语音扩展是否启用、缺少哪些配置、最近合成结果；不检测 QQ 收听或送达，不返回密钥。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
const resultOf = (out, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(out) }], isError });
export function createHandler(service = createService()) {
  let inflight = 0;
  return async msg => {
    if (!msg || msg.id === undefined) return null;
    const { id, method, params = {} } = msg;
    const result = data => ({ jsonrpc: '2.0', id, result: data });
    if (method === 'initialize') return result({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: MANIFEST.id, version: MANIFEST.version } });
    if (method === 'ping') return result({});
    if (method === 'tools/list') return result({ tools: TOOLS });
    if (method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    if (!TOOLS.some(t => t.name === params.name)) return result(resultOf({ mode: 'text', reason: '未知语音工具' }, true));
    if (params.name === 'voice_status') {
      try {
        if (params.arguments && (typeof params.arguments !== 'object' || Array.isArray(params.arguments) || Object.keys(params.arguments).length)) throw new Error('状态工具不接受参数');
        const s = service.status();
        const j = s.lastJob;
        // 状态工具对所有会话可见，只回合成状态，不回其他会话的正文或本地目录。
        const lastJob = j ? Object.fromEntries(['id', 'status', 'at', 'ms', 'bytes', 'durationSec'].filter(k => j[k] !== undefined).map(k => [k, j[k]])) : null;
        return result(resultOf({ version: s.version, enabled: s.enabled, missing: s.missing, lineCount: s.lineCount, lastJob }));
      } catch (e) { return result(resultOf({ mode: 'text', reason: e.message }, true)); }
    }
    if (inflight >= 2) return result(resultOf({ mode: 'text', reason: '已有语音任务正在处理，请稍后再试' }, true));
    inflight += 1;
    try {
      const out = await service.run(params.arguments ?? {});
      return result(resultOf(out, out.mode !== 'voice'));
    } catch (e) { return result(resultOf({ mode: 'text', reason: e.message, generated: false, delivered: false }, true)); }
    finally { inflight -= 1; }
  };
}
export function startServer() {
  const handle = createHandler();
  const decoder = new StringDecoder('utf8');
  let buffer = '', dropping = false;
  const send = msg => { if (msg) process.stdout.write(JSON.stringify(msg) + '\n'); };
  process.stdin.on('data', chunk => {
    buffer += decoder.write(chunk);
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (dropping) { dropping = false; continue; }
      if (!line) continue;
      if (line.length > 65536) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }); continue; }
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); continue;
      }
      handle(msg).then(send).catch(() => send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: 'Internal error' } }));
    }
    if (buffer.length > 65536) { buffer = ''; dropping = true; send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startServer();
