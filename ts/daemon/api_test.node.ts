// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HeadlessControlService } from './api.node.ts';
import type { DaemonConfig } from './config.node.ts';
import type { HeadlessProtocolStores } from './protocol_stores.node.ts';
import type { DaemonStatus, RuntimeServiceContext } from './runtime.node.ts';
import type { HeadlessSql } from './sql.node.ts';
import type {
  HeadlessSendTransport,
  HeadlessTransportRuntime,
} from './transport.node.ts';

const TOKEN = 'test-api-token-at-least-sixteen';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

function status(): DaemonStatus {
  return {
    buildExpiration: { days: 90, managedExternally: true },
    connected: false,
    databaseReady: true,
    linked: true,
    phase: 'ready',
    ready: true,
  };
}

void test('control API exposes health and protects validated sends', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-api-'));
  const apiPort = await availablePort();
  const config: DaemonConfig = {
    apiHost: '127.0.0.1',
    apiPort,
    apiToken: TOKEN,
    connect: false,
    logLevel: 'info',
    profileLockPath: join(storagePath, '.lock'),
    shutdownTimeoutMs: 30_000,
    storagePath,
    webhookMaxPending: 10,
    webhookTimeoutMs: 1_000,
  };
  const sql = {
    close: async () => undefined,
    read: (async method => {
      if (method === '_getAllMessages' || method === 'getAllConversations') {
        return [];
      }
      throw new Error(`Unexpected SQL read: ${method}`);
    }) as HeadlessSql['read'],
    write: (async () => undefined) as HeadlessSql['write'],
  } satisfies HeadlessSql;
  const transport = {
    connected: false,
    fetchAuthenticated: async () => {
      throw new Error('Unexpected fetch');
    },
    pendingRequestCount: 0,
    sendMessage: async () => {
      throw new Error('Unexpected send');
    },
    setRequestHandler: () => undefined,
    start: async () => undefined,
    state: 'idle',
    stop: async () => undefined,
  } as unknown as HeadlessTransportRuntime & HeadlessSendTransport;
  const service = new HeadlessControlService(config, transport, {
    getStatus: status,
  });
  const context: RuntimeServiceContext = {
    items: {},
    profileSqlKey: 'ab'.repeat(32),
    protocolStores: {
      itemStorage: {
        user: {
          getCheckedAci: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          getCheckedDeviceId: () => 1,
        },
      },
      signalProtocolStore: {},
    } as unknown as HeadlessProtocolStores,
    sql,
  };
  try {
    await service.prepare(context);
    await service.start();
    const base = `http://127.0.0.1:${apiPort}`;
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);

    const unauthorized = await fetch(`${base}/v1/messages`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(unauthorized.status, 401);

    const invalid = await fetch(`${base}/v1/messages`, {
      body: JSON.stringify({ body: 'hello', destination: 'recipient' }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    assert.equal(invalid.status, 400);

    const disconnected = await fetch(`${base}/v1/messages`, {
      body: JSON.stringify({
        body: 'hello',
        destination: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        idempotency_key: 'request-1',
      }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    assert.equal(disconnected.status, 503);
    assert.deepEqual(await disconnected.json(), {
      error: {
        code: 'not-connected',
        message: 'Signal service is not connected',
        retryable: true,
      },
    });
  } finally {
    await service.stop();
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('connected control service fails closed without an API token', async () => {
  const config = {
    apiHost: '127.0.0.1',
    apiPort: 8080,
    connect: true,
    logLevel: 'info',
    profileLockPath: '/state/.lock',
    shutdownTimeoutMs: 30_000,
    storagePath: '/state/profile',
    webhookMaxPending: 10,
    webhookTimeoutMs: 1_000,
  } satisfies DaemonConfig;
  const service = new HeadlessControlService(config, {} as never, {
    getStatus: status,
  });
  await assert.rejects(
    service.prepare({} as RuntimeServiceContext),
    /SIGNAL_API_TOKEN/
  );
});
