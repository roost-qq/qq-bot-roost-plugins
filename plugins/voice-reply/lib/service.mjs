import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// 进程内面板会缓存 ESM；版本号进入整条依赖链，升级后不再混用旧模块。
const V = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')).version;
const { currentConfig, dataDir, missingSetup } = await import(`./config.mjs?v=${V}`);
const { ensureDir, atomicJson, readJson, saveJob, getJob, withLock, prune, cooldownPath } = await import(`./store.mjs?v=${V}`);
const { composeSpeech, BUILTIN_LINES, cleanText } = await import(`./speech.mjs?v=${V}`);
const { createClient } = await import(`./client.mjs?v=${V}`);
const { encodeVoice } = await import(`./audio.mjs?v=${V}`);

function checkArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数需要对象');
  if (Object.keys(args).some(k => !['text', 'message', 'chatId'].includes(k))) throw new Error('参数包含未知字段');
  for (const k of ['text', 'message', 'chatId']) if (args[k] !== undefined && (typeof args[k] !== 'string' || args[k].length > (k === 'chatId' ? 256 : 4000))) throw new Error(`${k} 格式有误或过长`);
}
export function publicJob(job) {
  if (!job) return null;
  const { silkFile, wavFile, ...out } = job;
  return out;
}
export function createService({ getConfig = currentConfig, dir = dataDir(), fetchImpl = fetch, codec, random = Math.random } = {}) {
  const client = createClient(fetchImpl);
  const pending = new Set();
  function status() {
    const c = getConfig();
    const last = readJson(join(dir, 'last.json'));
    let lastJob = null;
    if (last?.id) { try { lastJob = publicJob(getJob(dir, last.id)); } catch {} }
    return { version: V, enabled: c.enabled, missing: missingSetup(c), dataDir: dir, lastJob, lineCount: c.lines.filter(x => x.trim()).length || BUILTIN_LINES.length };
  }
  function job(id) { return publicJob(getJob(dir, id)); }
  function audio(id) {
    const j = getJob(dir, id);
    if (j.status !== 'done') throw new Error('试听尚未完成');
    const wav = readFileSync(join(dir, 'audio', `${id}.wav`));
    if (wav.length > 10 * 1024 * 1024) throw new Error('试听音频过大');
    return { dataUrl: `data:audio/wav;base64,${wav.toString('base64')}`, durationSec: j.durationSec };
  }
  async function run(args, { preview = false, id = randomUUID() } = {}) {
    checkArgs(args);
    const c = getConfig(); // 一个任务一份配置快照，清空配置下轮立即生效。
    if (!preview && !c.enabled) throw new Error('语音回复扩展已停用');
    const lack = missingSetup(c);
    if (lack.length) throw new Error(`请在表达 → 语音回复配置：${lack.join('、')}`);
    ensureDir(dir);
    const at = Date.now();
    saveJob(dir, { id, status: 'running', at });
    const signal = AbortSignal.timeout(c.timeoutSec * 1000);
    let reservation, recordPath;
    try {
      return await withLock(dir, signal, async () => {
        signal.throwIfAborted();
        prune(dir);
        const ctx = preview ? 'preview' : args.chatId || 'default';
        recordPath = cooldownPath(dir, ctx);
        const prev = readJson(recordPath, {});
        if (!preview && c.cooldownSec > 0 && Date.now() - (prev.at || 0) < c.cooldownSec * 1000) throw new Error('语音请求过于频繁，请稍后再试');
        const speech = await composeSpeech({ ...args, c, recent: prev.recent || [], random, translate: text => client.translate(c, text, signal) });
        if (speech.mode === 'text') {
          saveJob(dir, { id, at, status: 'error', error: speech.reason });
          return speech;
        }
        reservation = { at: Date.now(), id, recent: prev.recent || [] };
        atomicJson(recordPath, reservation);
        await client.weights(c, signal);
        const wav = await client.wav(c, speech, signal);
        signal.throwIfAborted();
        const encoded = await encodeVoice(wav, codec);
        signal.throwIfAborted();
        const root = ensureDir(join(dir, 'audio'));
        const wavFile = join(root, `${id}.wav`);
        const silkFile = join(root, `${id}.silk`);
        if (/[<>\r\n]/.test(silkFile)) throw new Error('扩展数据目录包含语音标记不支持的字符');
        try {
          writeFileSync(wavFile, encoded.wav, { mode: 0o600, flag: 'wx' });
          writeFileSync(silkFile, encoded.silk, { mode: 0o600, flag: 'wx' });
        } catch (e) { for (const f of [wavFile, silkFile]) try { unlinkSync(f); } catch {} throw e; }
        const done = { id, at, status: 'done', text: speech.text, lang: speech.lang, source: speech.source,
          ...(speech.warning ? { warning: speech.warning } : {}), ms: Date.now() - at,
          bytes: encoded.silk.length, durationSec: encoded.durationSec, sampleRate: encoded.sampleRate,
          rms: Math.round(encoded.rms), outRms: Math.round(encoded.outRms), wavFile, silkFile };
        saveJob(dir, done);
        atomicJson(join(dir, 'last.json'), { id });
        atomicJson(recordPath, { ...reservation, recent: [speech.text, ...(prev.recent || []).filter(x => x !== speech.text)].slice(0, 8) });
        const marker = `<<voice: ${silkFile}>>`;
        return { mode: 'voice', id, text: speech.text, lang: speech.lang, source: speech.source,
          ...(speech.warning ? { warning: speech.warning } : {}), marker,
          reply: c.replyNote ? `${cleanText(speech.text)}\n${marker}` : marker,
          generated: true, delivered: false, instruction: '音频已生成；最终仅输出 reply，由宿主执行语音发送。工具未发 QQ 消息。' };
      });
    } catch (e) {
      const error = signal.aborted ? '语音任务超时（含排队、模型加载与合成），请检查服务后重试'
        : e instanceof TypeError ? '语音服务连接失败，请检查 api_v2.py、地址和端口'
          : ['EACCES', 'EPERM', 'ENOSPC'].includes(e.code) ? '扩展数据目录写入失败，请检查磁盘和目录权限' : String(e.message || '语音任务失败').slice(0, 240);
      // 合成失败不占冷却；仅撤销自己的预留，避免覆盖后续进程的记录。
      if (reservation && recordPath) { try { const v = readJson(recordPath); if (v?.id === id) atomicJson(recordPath, { ...v, at: 0 }); } catch {} }
      saveJob(dir, { id, at, status: 'error', error, ms: Date.now() - at });
      atomicJson(join(dir, 'last.json'), { id });
      throw new Error(error);
    }
  }
  function startPreview(args = {}) {
    checkArgs(args);
    // 同步验证配置，再创建任务；后台结果持久化，页面不等长请求。
    const c = getConfig();
    const lack = missingSetup(c);
    if (lack.length) throw new Error(`请先配置：${lack.join('、')}`);
    if (pending.size >= 2) throw new Error('已有两个试听任务，请等待完成');
    const id = randomUUID();
    ensureDir(dir);
    saveJob(dir, { id, status: 'running', at: Date.now() });
    pending.add(id);
    run(args, { preview: true, id }).catch(() => {}).finally(() => pending.delete(id));
    return { jobId: id };
  }
  return { status, job, audio, run, startPreview, probe: () => client.probe(getConfig()) };
}
