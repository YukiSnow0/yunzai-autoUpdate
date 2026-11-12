import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readState, UpdateService } from '../lib/service.js';
import { resolveTargets, splitMessage } from '../lib/report.js';

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yunzai-service-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('yunzai-service-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const file = path.join(directory, 'state.json');
  const calls = { update: 0, install: 0, restart: 0, messages: [] };
  const service = new UpdateService({
    file, state: await readState(file), bootId: 'boot-one',
    config: { timezone: 'Asia/Shanghai', autoRestart: true },
    now: () => new Date('2026-11-12T20:00:00Z'),
    update: async () => { calls.update++; return [{ name: 'TRSS-Yunzai', status: 'updated', changed: true, dependenciesChanged: true, before: 'a'.repeat(40), after: 'b'.repeat(40), commits: ['bbbbbbb new feature'], count: 1 }]; },
    install: async () => { calls.install++; },
    restart: async () => { calls.restart++; },
    targets: () => [{ qq: '100000001', botIds: ['100000002'] }],
    send: async (...args) => { calls.messages.push(args); return { message_id: 'local-test' }; },
    log: () => {},
    ...overrides,
  });
  return { file, calls, service };
}

test('重启前落盘报告；新进程上线后发送，成功后不重复推送', async t => {
  const { service, calls, file } = await setup(t);
  await service.run();
  assert.equal(calls.install, 1); assert.equal(calls.restart, 1);
  assert.equal(calls.messages.length, 0);
  assert.deepEqual((await readState(file)).pendingOwners, ['100000001']);
  service.bootId = 'boot-two';
  await service.resume(); await service.resume();
  assert.equal(calls.messages.length, 1);
  assert.match(calls.messages[0][2], /已完整重启/);
  assert.deepEqual((await readState(file)).pendingOwners, []);
});

test('依赖安装失败保留重试标记，次日即使无新提交也重试，成功后才重启', async t => {
  const { service, calls } = await setup(t, { install: async () => { throw new Error('registry unavailable'); } });
  await service.run();
  assert.equal(calls.restart, 0); assert.equal(service.state.needsInstall, true);
  assert.match(calls.messages[0][2], /安装失败/);
  service.now = () => new Date('2026-11-13T20:00:00Z');
  service.update = async () => [{ name: 'TRSS-Yunzai', status: 'unchanged', changed: false, commits: [] }];
  service.install = async () => { calls.install++; };
  await service.run();
  assert.equal(calls.install, 1); assert.equal(calls.restart, 1);
  assert.equal(service.state.needsInstall, false);
});

test('并发与同一时区日期只更新一次', async t => {
  const { service, calls } = await setup(t);
  await Promise.all([service.run(), service.run()]); await service.run();
  assert.equal(calls.update, 1); assert.equal(calls.install, 1);
});

test('离线暂存，失败切换机器人，主人 QQ 去重', async t => {
  const { service, calls } = await setup(t, {
    config: { timezone: 'Asia/Shanghai', autoRestart: false },
    targets: () => [{ qq: '100000001', botIds: [] }],
  });
  await service.run();
  assert.equal(calls.messages.length, 0);
  service.targets = () => [{ qq: '100000001', botIds: ['100000003', '100000002'] }];
  service.send = async (botId, qq, text) => {
    if (botId === '100000003') throw new Error('offline');
    calls.messages.push([botId, qq, text]); return { message_id: 'local' };
  };
  await service.resume(); await service.resume();
  assert.equal(calls.messages.length, 1);
  const targets = resolveTargets({ masterQQ: [100000001, 'stdin'], master: { 100000002: ['100000001'], stdin: ['stdin'] } }, { masters: [], botId: '' }, { uin: ['stdin', '100000002'] });
  assert.deepEqual(targets, [{ qq: '100000001', botIds: ['100000002'] }]);
});

test('在线发送失败不会清除待推送报告；重启异常也能通知主人', async t => {
  const { service } = await setup(t, {
    restart: async () => { throw new Error('restart denied'); },
    send: async () => ({ error: 'not friend' }),
  });
  await service.run();
  assert.match(service.state.report.restart, /自动重启失败/);
  assert.deepEqual(service.state.pendingOwners, ['100000001']);
});

test('没有配置主人时保留报告，后续配置后可补发', async t => {
  const { service, calls } = await setup(t, {
    config: { timezone: 'Asia/Shanghai', autoRestart: false }, targets: () => [],
  });
  await service.run(); assert.equal(service.state.pendingOwners, null);
  service.targets = () => [{ qq: '100000001', botIds: ['100000002'] }];
  await service.resume(); assert.equal(calls.messages.length, 1);
});

test('长报告分段，不截断 Unicode 字符', () => {
  assert.deepEqual(splitMessage('😀😀😀', 2), ['😀😀', '😀']);
});
