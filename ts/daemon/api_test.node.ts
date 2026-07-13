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
import { DAY } from '../util/durations/index.std.ts';
import type { AciString } from '../types/ServiceId.std.ts';

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
  const createdAt = Date.UTC(2026, 6, 1);
  const expiresAt = createdAt + 90 * DAY;
  return {
    buildExpiration: {
      createdAt,
      createdAtIso: new Date(createdAt).toISOString(),
      daysRemaining: 45,
      expired: false,
      expiresAt,
      expiresAtIso: new Date(expiresAt).toISOString(),
      validityDays: 90,
    },
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
  const webhookMethods = new Array<string>();
  const webhookServer = createServer((request, response) => {
    webhookMethods.push(request.method ?? '');
    response.writeHead(200).end();
  });
  await new Promise<void>(resolve =>
    webhookServer.listen(0, '127.0.0.1', resolve)
  );
  const webhookAddress = webhookServer.address();
  assert.ok(webhookAddress && typeof webhookAddress !== 'string');
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
    webhookUrl: `http://127.0.0.1:${webhookAddress.port}/hook`,
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
    assert.deepEqual(webhookMethods, ['GET']);
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

    const obsoleteIdempotencyKey = await fetch(`${base}/v1/messages`, {
      body: JSON.stringify({
        body: 'hello',
        destination: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        idempotency_key: 'no-longer-supported',
      }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    assert.equal(obsoleteIdempotencyKey.status, 400);

    const disconnected = await fetch(`${base}/v1/messages`, {
      body: JSON.stringify({
        body: 'hello',
        destination: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
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
    await new Promise<void>(resolve => webhookServer.close(() => resolve()));
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

void test('control service aborts and drains an active send before stopping', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-api-stop-'));
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
    connected: true,
    pendingRequestCount: 0,
    setRequestHandler: () => undefined,
    state: 'connected',
  } as unknown as HeadlessTransportRuntime & HeadlessSendTransport;
  let enterSend: (() => void) | undefined;
  const sendEntered = new Promise<void>(resolve => {
    enterSend = resolve;
  });
  let releaseSend: (() => void) | undefined;
  const sendReleased = new Promise<void>(resolve => {
    releaseSend = resolve;
  });
  let sendSignal: AbortSignal | undefined;
  const service = new HeadlessControlService(config, transport, {
    createSendService: () => ({
      async sendText(request, signal) {
        sendSignal = signal;
        enterSend?.();
        await sendReleased;
        return {
          destination: request.destination as AciString,
          messageId: 'paused-message',
          status: 'sent',
          timestamp: 1_700_000_000_000,
        };
      },
    }),
    getStatus: status,
  });
  const context: RuntimeServiceContext = {
    items: {},
    profileSqlKey: 'ab'.repeat(32),
    protocolStores: {} as HeadlessProtocolStores,
    sql,
  };
  try {
    await service.prepare(context);
    await service.start();
    const request = fetch(`http://127.0.0.1:${apiPort}/v1/messages`, {
      body: JSON.stringify({
        body: 'pause while stopping',
        destination: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    await sendEntered;

    let stopped = false;
    const stopping = (async () => {
      await service.stop();
      stopped = true;
    })();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sendSignal?.aborted, true);
    assert.equal(stopped, false);

    releaseSend?.();
    await stopping;
    await request.catch(() => undefined);
    assert.equal(stopped, true);
  } finally {
    releaseSend?.();
    await service.stop();
    await rm(storagePath, { force: true, recursive: true });
  }
});
