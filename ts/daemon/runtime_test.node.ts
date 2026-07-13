// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DaemonConfig } from './config.node.ts';
import { DaemonRuntime, type RuntimeDependencies } from './runtime.node.ts';
import type { HeadlessSql } from './sql.node.ts';
import type { HeadlessProtocolStores } from './protocol_stores.node.ts';
import { DAY } from '../util/durations/index.std.ts';

const BUILD_CREATED_AT = Date.UTC(2026, 6, 1);
const BUILD_EXPIRES_AT = BUILD_CREATED_AT + 90 * DAY;
const NOW = BUILD_CREATED_AT + 45 * DAY;

const config: DaemonConfig = {
  apiHost: '127.0.0.1',
  apiPort: 8080,
  connect: true,
  logLevel: 'info',
  profileLockPath: '/state/lock',
  shutdownTimeoutMs: 30_000,
  storagePath: '/state/profile',
  webhookMaxPending: 1_000,
  webhookTimeoutMs: 10_000,
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
    buildCreation: BUILD_CREATED_AT,
    buildExpiration: BUILD_EXPIRES_AT,
    now: () => NOW,
    async loadProfile(storagePath) {
      events.push('profile:load');
      return { sqlKey: 'ab'.repeat(32), storagePath };
    },
    openSql() {
      events.push('sql:open');
      return sql;
    },
    async openProtocolStores() {
      events.push('stores:open');
      return {
        itemStorage: {
          getItemsState() {
            return {
              number_id: '+12025550123.2',
              password: 'secret',
            };
          },
        },
        signalProtocolStore: {},
      } as unknown as HeadlessProtocolStores;
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
    buildExpiration: {
      createdAt: BUILD_CREATED_AT,
      createdAtIso: new Date(BUILD_CREATED_AT).toISOString(),
      daysRemaining: 45,
      expired: false,
      expiresAt: BUILD_EXPIRES_AT,
      expiresAtIso: new Date(BUILD_EXPIRES_AT).toISOString(),
      validityDays: 90,
    },
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
    'stores:open',
    'protocol:start',
    'protocol:stop',
    'sql:close',
  ]);
  assert.equal(runtime.getStatus().phase, 'stopped');
});

void test('DaemonRuntime stays offline and exposes readiness after build expiry', async () => {
  const { dependencies, events } = createHarness();
  const runtime = new DaemonRuntime(config, {
    ...dependencies,
    now: () => BUILD_EXPIRES_AT,
    controlService: {
      prepare() {
        events.push('control:prepare');
      },
      start() {
        events.push('control:start');
      },
      stop() {
        events.push('control:stop');
      },
    },
  });

  await runtime.start();
  const status = runtime.getStatus();
  assert.equal(status.phase, 'expired');
  assert.equal(status.ready, false);
  assert.equal(status.connected, false);
  assert.equal(status.buildExpiration.expired, true);
  assert.match(status.reason ?? '', /build has expired/);
  assert.equal(events.includes('protocol:start'), false);
  assert.equal(events.includes('control:start'), true);
  await runtime.stop();
});

void test('DaemonRuntime can validate a profile without network access', async () => {
  const { events, runtime } = createHarness({ connect: false });
  await runtime.start();
  assert.equal(runtime.getStatus().ready, true);
  assert.equal(runtime.getStatus().connected, false);
  assert.deepEqual(events, ['profile:load', 'sql:open', 'stores:open']);
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

void test('DaemonRuntime closes SQL when an earlier service fails to stop', async () => {
  const { dependencies, events } = createHarness();
  const runtime = new DaemonRuntime(config, {
    ...dependencies,
    controlService: {
      prepare() {
        events.push('control:prepare');
      },
      start() {
        events.push('control:start');
      },
      stop() {
        events.push('control:stop');
        throw new Error('control stop failed');
      },
    },
  });
  await runtime.start();
  await assert.rejects(runtime.stop(), /control stop failed/);
  assert.deepEqual(events.slice(-3), [
    'control:stop',
    'protocol:stop',
    'sql:close',
  ]);
  assert.equal(runtime.getStatus().phase, 'stopped');
  assert.equal(runtime.getStatus().databaseReady, false);
});
