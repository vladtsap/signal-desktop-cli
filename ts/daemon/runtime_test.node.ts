// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DaemonConfig } from './config.node.ts';
import { DaemonRuntime, type RuntimeDependencies } from './runtime.node.ts';
import type { HeadlessSql } from './sql.node.ts';

const config: DaemonConfig = {
  connect: true,
  logLevel: 'info',
  profileLockPath: '/state/lock',
  shutdownTimeoutMs: 30_000,
  storagePath: '/state/profile',
};

function createHarness({ connect = true } = {}) {
  const events = new Array<string>();
  const sql: HeadlessSql = {
    async close() {
      events.push('sql:close');
    },
    read: (async method => {
      assert.equal(method, 'getAllItems');
      return {
        number_id: '+12025550123.2',
        password: 'secret',
      };
    }) as HeadlessSql['read'],
    write: (async () => {
      throw new Error('Unexpected write');
    }) as HeadlessSql['write'],
  };
  const protocolRuntime = {
    connected: true,
    async start() {
      events.push('protocol:start');
    },
    async stop() {
      events.push('protocol:stop');
    },
  };
  const dependencies: RuntimeDependencies = {
    appVersion: '8.21.0-alpha.1',
    async loadProfile(storagePath) {
      events.push('profile:load');
      return { sqlKey: 'ab'.repeat(32), storagePath };
    },
    openSql() {
      events.push('sql:open');
      return sql;
    },
    protocolRuntime,
  };
  return {
    dependencies,
    events,
    runtime: new DaemonRuntime({ ...config, connect }, dependencies),
  };
}

void test('DaemonRuntime starts and drains protocol before SQL', async () => {
  const { events, runtime } = createHarness();
  await runtime.start();
  assert.deepEqual(runtime.getStatus(), {
    buildExpiration: { days: 90, managedExternally: true },
    connected: true,
    databaseReady: true,
    linked: true,
    phase: 'ready',
    ready: true,
  });

  await runtime.stop();
  assert.deepEqual(events, [
    'profile:load',
    'sql:open',
    'protocol:start',
    'protocol:stop',
    'sql:close',
  ]);
  assert.equal(runtime.getStatus().phase, 'stopped');
});

void test('DaemonRuntime can validate a profile without network access', async () => {
  const { events, runtime } = createHarness({ connect: false });
  await runtime.start();
  assert.equal(runtime.getStatus().ready, true);
  assert.equal(runtime.getStatus().connected, false);
  assert.deepEqual(events, ['profile:load', 'sql:open']);
  await runtime.stop();
});

void test('DaemonRuntime refuses an online start without a protocol adapter', async () => {
  const { dependencies, runtime } = createHarness();
  const withoutProtocol = new DaemonRuntime(config, {
    ...dependencies,
    protocolRuntime: undefined,
  });

  await assert.rejects(
    withoutProtocol.start(),
    /protocol bootstrap is unavailable/
  );
  assert.equal(withoutProtocol.getStatus().phase, 'failed');
  assert.equal(withoutProtocol.getStatus().databaseReady, false);
  assert.equal(runtime.getStatus().phase, 'created');
});
