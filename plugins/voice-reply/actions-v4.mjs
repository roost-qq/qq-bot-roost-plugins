import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8')).version;
const { createService } = await import(`./lib/service.mjs?v=${version}`);
const { currentConfig, dataDir, ROOT } = await import(`./lib/config.mjs?v=${version}`);
const { createProfiles } = await import(`./lib/profiles.mjs?v=${version}`);
const { createLauncher } = await import(`./lib/launcher.mjs?v=${version}`);

export function createActions({ config = {}, secrets = {}, env = {}, root = ROOT } = {}) {
  const dir = dataDir(env);
  const getConfig = () => currentConfig({ config, secrets, env, root });
  const service = createService({ getConfig, dir });
  const profiles = createProfiles({ root, dir });
  const launcher = createLauncher({ getConfig, dir });
  const wrap = fn => async (payload = {}) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, message: String(e.message || '动作失败') }; }
  };
  return {
    status: wrap(() => service.status()),
    probe: wrap(() => service.probe()),
    startPreview: wrap(payload => service.startPreview({ text: payload.text ?? '' })),
    job: wrap(payload => service.job(payload.id)),
    audio: wrap(payload => service.audio(payload.id)),
    profiles: wrap(payload => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('音色方案参数需要对象');
      if (payload.op === 'list') return profiles.list();
      if (payload.op === 'save') return profiles.save({ id: payload.id, name: payload.name, values: payload.values });
      if (payload.op === 'apply') return profiles.apply({ id: payload.id });
      if (payload.op === 'remove') return profiles.remove({ id: payload.id });
      throw new Error('未知音色方案操作');
    }),
    service: wrap(payload => {
      if (payload?.op === 'status') return launcher.status();
      if (payload?.op === 'start') return launcher.start();
      if (payload?.op === 'stop') return launcher.stop();
      throw new Error('未知服务操作');
    }),
  };
}
