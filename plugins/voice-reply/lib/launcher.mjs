import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { openSync, closeSync, existsSync, statSync, readSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
const VERSION = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')).version;
const { atomicJson, readJson, withLock } = await import(`./store.mjs?v=${VERSION}`);
const { limitedBody } = await import(`./client.mjs?v=${VERSION}`);
const REQUIRED = ['/tts', '/set_sovits_weights', '/set_gpt_weights'];
const alive = pid => { try { if (!Number.isSafeInteger(pid) || pid < 1) return false; process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function localTarget(api) {
  const u = new URL(api);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('一键启动仅支持本机 HTTP 根地址，例如 http://127.0.0.1:9880；远程服务请在对应机器启动');
  return { host: u.hostname === '[::1]' ? '::1' : '127.0.0.1', port: Number(u.port || 80) };
}
export function servicePaths(c, dir) {
  const key = createHash('sha256').update(c.api).digest('hex').slice(0, 16), folder = join(dir, 'services');
  return { folder, state: join(folder, `${key}.json`), log: join(folder, `${key}.log`) };
}
function logTail(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size, count = Math.min(size, 32768), b = Buffer.alloc(count);
    readSync(fd, b, 0, count, size - count);
    const lines = b.toString('utf8').split(/\r?\n/); if (size > count) lines.shift();
    return lines.filter(x => x.trim()).slice(-20).map(x => x.slice(0, 500));
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
}
export function findServiceFiles(input, platform = process.platform) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('请先填写并保存 GPT-SoVITS 安装目录');
  const app = resolve(input.trim());
  if (!existsSync(app) || !statSync(app).isDirectory() || !existsSync(join(app, 'api_v2.py'))) throw new Error('安装目录中未找到 api_v2.py，请选择 GPT-SoVITS 根目录');
  const candidates = platform === 'win32' ? ['runtime/python.exe', '.venv/Scripts/python.exe', 'venv/Scripts/python.exe'] : ['runtime/bin/python3', 'runtime/bin/python', '.venv/bin/python3', '.venv/bin/python', 'venv/bin/python3', 'venv/bin/python'];
  const python = candidates.map(p => join(app, p)).find(p => existsSync(p) && statSync(p).isFile());
  if (!python) throw new Error('安装目录内未找到 Python：请使用自带 runtime 或 .venv/venv 的 GPT-SoVITS 目录');
  const config = 'GPT_SoVITS/configs/tts_infer.yaml';
  return { app, python, config: existsSync(join(app, config)) ? config : '' };
}
const exec = promisify(execFile);
export async function inspectServiceProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('服务 PID 无效');
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 5000, maxBuffer: 16384, encoding: 'utf8' });
    const value = stdout.trim() ? JSON.parse(stdout.trim()) : null;
    return value ? { executable: value.ExecutablePath, command: value.CommandLine } : null;
  }
  if (process.platform === 'linux') {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    return argv.length ? { executable: argv[0], command: argv.join(' ') } : null;
  }
  const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000, maxBuffer: 16384, encoding: 'utf8' });
  return stdout.trim() ? { command: stdout.trim() } : null;
}
const normalizedPath = value => String(value || '').replace(/\\/g, '/').toLowerCase();
function ownsProcess(info, record, runner, target) {
  if (!info?.command || !record.app) return false;
  const command = normalizedPath(info.command);
  if (!command.includes(normalizedPath(record.runner || runner)) || !command.includes('--app-dir') || !command.includes(normalizedPath(record.app))) return false;
  const port = command.match(/(?:^|\s)--port(?:=|\s+)["']?(\d+)(?=["'\s]|$)/)?.[1];
  if (Number(port) !== target.port) return false;
  if (info.executable && normalizedPath(info.executable) !== normalizedPath(record.python || findServiceFiles(record.app).python)) return false;
  return true;
}
export function createLauncher({ getConfig, dir, fetchImpl = fetch, spawnImpl = spawn, runner = fileURLToPath(new URL('../service-runner.py', import.meta.url)), isAlive = alive, startupMs = 180000, inspectImpl = inspectServiceProcess, killImpl = pid => process.kill(pid, 'SIGTERM'), stopWaitMs = 5000 } = {}) {
  const snapshot = (c, record, phase, message, features, logs = []) => ({ phase, api: c.api, pid: isAlive(record.pid) ? record.pid : 0, canStop: phase !== 'stopping' && Boolean(record.app && isAlive(record.pid)), ...(features ? { features } : {}), message, logTail: logs });
  async function probe(c) {
    try {
      const signal = AbortSignal.timeout(1500), r = await fetchImpl(`${c.api}/openapi.json`, { signal, redirect: 'error' });
      if (!r.ok) { await r.body?.cancel(); return null; }
      const body = JSON.parse((await limitedBody(r, 2 * 1024 * 1024, signal)).toString('utf8'));
      if (!body?.paths || !REQUIRED.every(p => Object.hasOwn(body.paths, p))) return null;
      return { semanticFreeze: Boolean(body.paths['/voice-reply/tts']?.post) };
    } catch { return null; }
  }
  function stopped(c, paths, record) {
    const next = { ...record, pid: 0, error: '', stopping: false, readyAt: 0, stoppedAt: Date.now() };
    atomicJson(paths.state, next);
    return snapshot(c, next, 'stopped', '语音服务已关闭');
  }
  async function status() {
    const c = getConfig(), paths = servicePaths(c, dir), record = readJson(paths.state, {});
    if (record.stopping) return isAlive(record.pid) ? snapshot(c, record, 'stopping', '正在关闭语音服务…') : stopped(c, paths, record);
    const features = await probe(c);
    if (features) {
      if (isAlive(record.pid) && !record.readyAt) atomicJson(paths.state, { ...record, readyAt: Date.now(), features });
      return snapshot(c, record, 'running', isAlive(record.pid) ? '语音服务已就绪' : '服务由其他入口启动，请从原启动位置关闭', features);
    }
    const logs = logTail(paths.log);
    if (isAlive(record.pid) && record.readyAt) return snapshot(c, record, 'running', '服务进程运行中，接口正在处理任务或暂未响应', record.features, logs);
    if (isAlive(record.pid)) return snapshot(c, record, Date.now() - record.startedAt > startupMs ? 'error' : 'starting', Date.now() - record.startedAt > startupMs ? '模型加载超过等待时间，可关闭服务后重试；详见启动日志' : '正在加载模型，首次启动可能需要几分钟', undefined, logs);
    if (record.pid || record.error) return snapshot(c, record, 'error', record.error || '语音服务已退出，请查看启动日志后重新启动', undefined, logs);
    return snapshot(c, record, 'stopped', record.stoppedAt ? '语音服务已关闭' : '语音服务尚未启动', undefined, logs);
  }
  async function start() {
    const c = getConfig(), target = localTarget(c.api), paths = servicePaths(c, dir), features = await probe(c);
    if (features) return snapshot(c, readJson(paths.state, {}), 'running', '语音服务已经就绪，无需重复启动', features);
    const files = findServiceFiles(c.serviceDir); mkdirSync(paths.folder, { recursive: true });
    return withLock(`${paths.state}.guard`, AbortSignal.timeout(5000), async () => {
      const prior = readJson(paths.state, {});
      if (isAlive(prior.pid)) return snapshot(c, prior, prior.stopping ? 'stopping' : prior.readyAt ? 'running' : 'starting', prior.stopping ? '正在关闭，请稍后再启动' : '已有服务进程，请查看当前状态', prior.features);
      if (!existsSync(runner)) throw new Error('扩展启动适配器缺失，请重新安装完整扩展包');
      const log = openSync(paths.log, 'a', 0o600), nonce = randomUUID(); let child;
      try {
        child = spawnImpl(files.python, ['-u', runner, '--app-dir', files.app, '--host', target.host, '--port', String(target.port), ...(files.config ? ['--config', files.config] : [])], { cwd: files.app, detached: true, windowsHide: true, shell: false, stdio: ['ignore', log, log], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
      } finally { closeSync(log); }
      const record = { nonce, pid: child.pid || 0, startedAt: Date.now(), api: c.api, app: files.app, python: files.python, runner, error: '' }; atomicJson(paths.state, record);
      child.on('error', e => { try { const last = readJson(paths.state, {}); if (last.nonce === nonce) atomicJson(paths.state, { ...last, error: `服务进程启动失败：${String(e.code || e.message).slice(0, 240)}` }); } catch {} });
      child.unref();
      return snapshot(c, record, 'starting', '启动请求已提交，正在加载 GPT-SoVITS 模型');
    });
  }
  async function stop() {
    const c = getConfig(), target = localTarget(c.api), paths = servicePaths(c, dir); mkdirSync(paths.folder, { recursive: true });
    return withLock(`${paths.state}.guard`, AbortSignal.timeout(12000), async () => {
      const record = readJson(paths.state, {});
      if (!isAlive(record.pid)) {
        if (!record.pid && !record.stoppedAt && await probe(c)) throw new Error('当前服务由其他入口启动，请从原启动位置关闭');
        return stopped(c, paths, record);
      }
      let info;
      try { info = await inspectImpl(record.pid); }
      catch { throw new Error('读取服务进程信息失败，请刷新状态后重试'); }
      if (!ownsProcess(info, record, runner, target)) throw new Error('记录的进程与本扩展语音服务不匹配，已保留该进程，请刷新状态');
      atomicJson(paths.state, { ...record, stopping: true });
      try { await killImpl(record.pid); }
      catch (e) { if (isAlive(record.pid)) { atomicJson(paths.state, { ...record, stopping: false }); throw new Error(`关闭服务失败：${e.code || '请重试'}`); } }
      const deadline = Date.now() + stopWaitMs;
      while (isAlive(record.pid) && Date.now() < deadline) await pause(100);
      return isAlive(record.pid) ? snapshot(c, record, 'stopping', '关闭请求已提交，等待进程退出…') : stopped(c, paths, record);
    });
  }
  return { status, start, stop };
}
