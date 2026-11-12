import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const sourceURL = source => `data:text/javascript,${encodeURIComponent(source)}`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node-schedule') return { shortCircuit: true, url: sourceURL('export default {scheduleJob: (...args) => globalThis.scheduleStub(...args)}') };
    if (specifier.endsWith('/lib/plugins/plugin.js')) return { shortCircuit: true, url: sourceURL('export default class Plugin { constructor(config){Object.assign(this,config); this.cleanups=[]} addCleanup(fn){this.cleanups.push(fn)} }') };
    if (specifier.endsWith('/lib/config/config.js')) return { shortCircuit: true, url: sourceURL('export default globalThis.hostConfig') };
    return next(specifier, context);
  },
});

test('加载、时区注册、重复热加载和卸载均不重复创建任务或监听', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yunzai-plugin-'));
  const cwd = process.cwd();
  const runtimeKey = Symbol.for('yunzai-autoUpdate.runtime');
  t.after(async () => {
    hooks.deregister(); process.chdir(cwd); delete globalThis[runtimeKey];
    delete globalThis.Bot; delete globalThis.logger; delete globalThis.scheduleStub; delete globalThis.hostConfig;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('yunzai-plugin-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  process.chdir(directory);
  globalThis.Bot = Object.assign(new EventEmitter(), { uin: [], sendFriendMsg() { throw new Error('不应在加载时发消息'); } });
  globalThis.hostConfig = { master: {}, masterQQ: [] };
  globalThis.logger = { mark() {}, error() {} };
  const jobs = [];
  globalThis.scheduleStub = (rule, callback) => {
    if (rule.rule === 'INVALID') return null;
    const job = { rule, callback, cancelled: false, cancel() { this.cancelled = true; } };
    jobs.push(job); return job;
  };
  const { apps } = await import('../index.js');
  const first = new apps.autoUpdate(); await first.init();
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].rule, { rule: '0 0 4 * * *', tz: 'Asia/Shanghai' });
  assert.deepEqual(first.rule, []);
  assert.equal(Bot.listenerCount('connect'), 1);
  await first.cleanups[0]();
  assert.equal(jobs[0].cancelled, true);
  const second = new apps.autoUpdate(); await second.init();
  assert.equal(Bot.listenerCount('connect'), 1);
  assert.equal(jobs.length, 2);
  const file = path.join(directory, 'data', 'yunzai-autoUpdate', 'config.json');
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...config, cron: 'INVALID' }));
  await assert.rejects(() => new apps.autoUpdate().init(), /cron 无效/);
  assert.equal(Bot.listenerCount('connect'), 1);
  assert.equal(jobs[1].cancelled, false);
  await fs.writeFile(file, JSON.stringify({ ...config, enabled: false }));
  const disabled = new apps.autoUpdate(); await disabled.init();
  assert.equal(jobs[1].cancelled, true);
  assert.equal(jobs.length, 2);
  await disabled.cleanups[0]();
  assert.equal(Bot.listenerCount('connect'), 0);
});
