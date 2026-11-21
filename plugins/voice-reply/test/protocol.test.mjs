import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { temporary, fakeApi } from './helpers.mjs';

function rpcProcess(t, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.stdin.end(); child.kill(); });
  const waits = new Map(); let serial = 0, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let out;
    try { out = JSON.parse(line); } catch { for (const w of waits.values()) w.reject(new Error('stdout 非JSON: ' + line)); return; }
    const w = waits.get(out.id);
    if (w) { waits.delete(out.id); w.resolve(out); }
  });
  function rpc(method, params) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waits.delete(id); reject(new Error('MCP 超时: ' + stderr)); }, 10000);
      waits.set(id, { resolve: out => { clearTimeout(timer); resolve(out); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return { rpc, child };
}
test('两个真实MCP子进程共用数据目录仍串行切换角色', async t => {
  const { c, requests } = await fakeApi(t, { delay: 15 }), dir = temporary(t);
  const a = rpcProcess(t, { ROOST_EXT_CONFIG: JSON.stringify({ ...c, sovitsWeights: 'A.pth', gptWeights: 'A.ckpt' }), VOICE_REPLY_DATA_DIR: dir });
  const b = rpcProcess(t, { ROOST_EXT_CONFIG: JSON.stringify({ ...c, sovitsWeights: 'B.pth', gptWeights: 'B.ckpt' }), VOICE_REPLY_DATA_DIR: dir });
  const results = await Promise.all([a.rpc('tools/call', { name: 'voice_reply', arguments: { text: '你好' } }), b.rpc('tools/call', { name: 'voice_reply', arguments: { text: 'こんにちは' } })]);
  assert.ok(results.every(x => x.result.isError === false));
  assert.deepEqual(requests.map(x => x.path), ['/set_sovits_weights', '/set_gpt_weights', '/tts', '/set_sovits_weights', '/set_gpt_weights', '/tts']);
  for (const r of requests.filter(x => x.path === '/tts')) assert.equal(r.weights.sovits[0], r.weights.gpt[0]);
});
test('真实stdio握手→列工具→合成成功→状态不泄露正文→错误不假报发送', async t => {
  const { c } = await fakeApi(t), dir = temporary(t);
  const { rpc, child } = rpcProcess(t, { ROOST_EXT_CONFIG: JSON.stringify(c), VOICE_REPLY_DATA_DIR: dir });
  const initialized = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'voice-reply');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await rpc('tools/list', {});
  assert.deepEqual(tools.result.tools.map(x => x.name), ['voice_reply', 'voice_status']);
  const raw = await rpc('tools/call', { name: 'voice_reply', arguments: { text: '这是一句仅供本地测试的正文' } });
  assert.equal(raw.result.isError, false);
  const speech = JSON.parse(raw.result.content[0].text);
  assert.equal(speech.delivered, false); assert.match(speech.reply, /\.silk>>$/);
  const status = await rpc('tools/call', { name: 'voice_status', arguments: {} });
  assert.doesNotMatch(JSON.stringify(status), /仅供本地测试|audio\/|wavFile|silkFile/);
  const bad = await rpc('tools/call', { name: 'voice_reply', arguments: { text: '你好', api: 'http://override.invalid' } });
  assert.equal(bad.result.isError, true); assert.doesNotMatch(JSON.stringify(bad), /<<voice:/);
  const unknown = await rpc('nonexistent', {}); assert.equal(unknown.error.code, -32601);
});
