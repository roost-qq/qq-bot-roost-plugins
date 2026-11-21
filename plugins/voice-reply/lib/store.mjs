import { mkdirSync, rmdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

export function ensureDir(dir) { mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
export function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } finally { try { unlinkSync(tmp); } catch {} }
}
export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('运行记录损坏，请保留原文件后检查'); }
}
export function jobPath(dir, id) {
  if (!/^[a-f0-9-]{36}$/.test(String(id)) || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(String(id))) throw new Error('试听 ID 格式有误');
  return join(dir, 'jobs', `${id}.json`);
}
export function saveJob(dir, job) { ensureDir(join(dir, 'jobs')); atomicJson(jobPath(dir, job.id), job); }
export function getJob(dir, id) {
  const job = readJson(jobPath(dir, id));
  if (!job) throw new Error('没有这条试听记录，或已过期');
  if (job.status === 'running' && Date.now() - job.at > 180_000) return { ...job, status: 'error', error: '任务已中断或超时，请重新生成' };
  return job;
}
/** 回收已死进程的锁；空/坏锁须先超过 180 秒。单独恢复闸防止两个进程互删新锁。 */
function reapLock(lock) {
  const gate = `${lock}.reaping`;
  try { mkdirSync(gate); }
  catch (e) {
    if (e.code === 'EEXIST') { try { if (Date.now() - statSync(gate).mtimeMs > 180_000) rmdirSync(gate); } catch {} }
    return;
  }
  try {
    const before = statSync(lock);
    let dead = false, invalid = false;
    try {
      const v = JSON.parse(readFileSync(lock, 'utf8'));
      if (!Number.isInteger(v.pid) || v.pid <= 0 || typeof v.nonce !== 'string') invalid = true;
      else try { process.kill(v.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
    } catch { invalid = true; }
    if (dead || (invalid && Date.now() - before.mtimeMs > 180_000)) {
      const after = statSync(lock);
      if (after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs) unlinkSync(lock);
    }
  } catch {} finally { try { rmdirSync(gate); } catch {} }
}
/** 两个入口（MCP / UI）共用文件锁，锁内涵盖切权重和合成，防止串音色。 */
export async function withLock(dir, signal, fn) {
  ensureDir(dir);
  const lock = join(dir, 'synthesis.lock');
  const nonce = randomUUID();
  while (true) {
    signal?.throwIfAborted();
    let handle;
    try {
      handle = await open(lock, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      reapLock(lock);
      await pause(80, undefined, { signal });
      continue;
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); }
    catch (e) { await handle.close(); await unlink(lock).catch(() => {}); throw e; }
    await handle.close();
    break;
  }
  try { return await fn(); }
  finally {
    try { const v = JSON.parse(await readFile(lock, 'utf8')); if (v.nonce === nonce) await unlink(lock); } catch {}
  }
}
/** 缓存只放本次生成的 UUID 文件；24 小时过期，最多保留 120 项。 */
export function prune(dir, now = Date.now()) {
  for (const folder of ['audio', 'jobs', 'cooldowns']) {
    const root = join(dir, folder);
    let files;
    try { files = readdirSync(root).filter(x => (folder === 'cooldowns' ? /^[a-f0-9]{64}\.json$/ : /^[a-f0-9-]{36}\.(wav|silk|json)$/).test(x)).map(name => ({ name, st: statSync(join(root, name)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const [i, f] of files.entries()) if (now - f.st.mtimeMs > 86400_000 || (i >= (folder === 'audio' ? 240 : 120) && now - f.st.mtimeMs > 180_000)) { try { unlinkSync(join(root, f.name)); } catch {} }
  }
}
export function cooldownPath(dir, chatId) {
  return join(ensureDir(join(dir, 'cooldowns')), createHash('sha256').update(String(chatId || 'default')).digest('hex') + '.json');
}
