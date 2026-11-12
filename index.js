import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import schedule from 'node-schedule';
import plugin from '../../lib/plugins/plugin.js';
import cfg from '../../lib/config/config.js';
import { updateAll, installDependencies } from './lib/updater.js';
import { resolveTargets } from './lib/report.js';
import { UpdateService, readState } from './lib/service.js';

const root = process.cwd();
const directory = path.join(root, 'data', 'yunzai-autoUpdate');
const runtime = globalThis[Symbol.for('yunzai-autoUpdate.runtime')] ??= { bootId: randomUUID() };
const log = message => logger.mark(`[yunzai-autoUpdate] ${message}`);

async function readConfig() {
  const defaults = JSON.parse(await fs.readFile(new URL('./config.example.json', import.meta.url), 'utf8'));
  const file = path.join(directory, 'config.json');
  await fs.mkdir(directory, { recursive: true });
  try { await fs.writeFile(file, JSON.stringify(defaults, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const config = { ...defaults, ...JSON.parse(await fs.readFile(file, 'utf8')) };
  if (typeof config.enabled !== 'boolean' || typeof config.autoRestart !== 'boolean') throw new Error('enabled / autoRestart 必须为布尔值');
  if (typeof config.cron !== 'string') throw new Error('cron 必须为字符串');
  new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  if (!Array.isArray(config.masters) || config.masters.some(id => !/^\d{5,12}$/.test(String(id)))) throw new Error('masters 必须是 QQ 号数组');
  if (config.botId && !/^\d{5,12}$/.test(String(config.botId))) throw new Error('botId 必须是机器人 QQ 号');
  for (const key of ['timeoutSeconds', 'installTimeoutSeconds', 'maxCommits']) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > (key === 'maxCommits' ? 50 : 3600)) throw new Error(`${key} 配置不合法`);
  }
  return config;
}

class AutoUpdate extends plugin {
  constructor() {
    super({ name: '每日自动更新', dsc: '更新 TRSS 本体和全部 Git 插件并推送主人', event: 'message', rule: [] });
  }

  async init() {
    if (typeof this.addCleanup !== 'function') throw new Error('需要支持 plugin.addCleanup 的近期 TRSS-Yunzai');
    const config = await readConfig();
    const state = runtime.service ? null : await readState(path.join(directory, 'state.json'));
    let job;
    if (config.enabled) {
      job = schedule.scheduleJob({ rule: config.cron, tz: config.timezone }, () =>
        runtime.service.run().catch(error => logger.error(`[yunzai-autoUpdate] ${error.stack || error}`)));
      if (!job) throw new Error('cron 无效，自动更新任务未启动');
    }
    if (!runtime.service) {
      runtime.service = new UpdateService({
        file: path.join(directory, 'state.json'), state,
        config, bootId: runtime.bootId,
        update: () => updateAll(root, runtime.service.config),
        install: () => installDependencies(root, runtime.service.config.installTimeoutSeconds),
        targets: () => resolveTargets(cfg, runtime.service.config, Bot),
        send: (botId, qq, message) => Bot.sendFriendMsg(botId, qq, message),
        restart: () => {
          if (typeof Bot.restart !== 'function') throw new Error('当前 TRSS 不支持 Bot.restart，请手动完整重启');
          return Bot.restart();
        },
        log,
      });
    }
    runtime.job?.cancel();
    if (runtime.listener) Bot.off('connect', runtime.listener);
    runtime.job = job;
    runtime.service.config = config;
    const resume = () => runtime.service.resume().catch(error => logger.error(`[yunzai-autoUpdate] ${error.stack || error}`));
    runtime.listener = resume;
    Bot.on('connect', resume);
    if (job) log(`已安排 ${config.timezone} ${config.cron}`);
    this.addCleanup(() => {
      job?.cancel();
      Bot.off('connect', resume);
    });
    await resume();
  }
}

export const apps = { autoUpdate: AutoUpdate };
