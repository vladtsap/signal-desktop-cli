// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AuthenticatedHeadlessTransport,
  type HeadlessIncomingRequest,
  type HeadlessTransportClose,
  type HeadlessTransportConnection,
  type HeadlessTransportConnector,
  type HeadlessTransportCredentials,
} from './transport.node.ts';

type ConnectCall = Readonly<{
  callbacks: Readonly<{
    onClose: (close: HeadlessTransportClose) => void;
    onRequest: (request: HeadlessIncomingRequest) => void;
  }>;
  credentials: HeadlessTransportCredentials;
  signal: AbortSignal;
}>;

function createHarness() {
  const calls = new Array<ConnectCall>();
  const disconnected = new Array<number>();
  let nextConnectError: Error | undefined;
  const connector: HeadlessTransportConnector = {
    async connect(credentials, callbacks, signal) {
      const index = calls.length;
      calls.push({ callbacks, credentials, signal });
      if (nextConnectError) {
        const error = nextConnectError;
        nextConnectError = undefined;
        throw error;
      }
      return {
        disconnect() {
          disconnected.push(index);
        },
        localPort: 12_345,
      } satisfies HeadlessTransportConnection;
    },
  };
  const reconnectAttempts = new Array<number>();
  const transport = new AuthenticatedHeadlessTransport(connector, {
    reconnectDelay(attempt, signal) {
      assert.equal(signal.aborted, false);
      reconnectAttempts.push(attempt);
      return Promise.resolve();
    },
  });
  return {
    calls,
    disconnected,
    reconnectAttempts,
    setNextConnectError(error: Error) {
      nextConnectError = error;
    },
    transport,
  };
}

const startContext = {
  items: {
    number_id: '+12025550123.2',
    password: 'secret',
    uuid_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.2',
  },
  protocolStores: {},
  sql: {},
} as unknown as Parameters<AuthenticatedHeadlessTransport['start']>[0];

function request(body: number): HeadlessIncomingRequest {
  return {
    body: Uint8Array.of(body),
    respond() {
      return undefined;
    },
    timestamp: body,
    type: 'message',
  };
}

async function settle(): Promise<void> {
  await new Promise(resolve => {
    setImmediate(resolve);
  });
}

void test('transport authenticates with restored ACI credentials and stops cleanly', async () => {
  const { calls, disconnected, transport } = createHarness();
  await transport.start(startContext);

  assert.equal(transport.connected, true);
  assert.equal(transport.state, 'open');
  assert.deepEqual(calls[0]?.credentials, {
    password: 'secret',
    username: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.2',
  });

  await transport.stop();
  assert.equal(transport.connected, false);
  assert.equal(transport.state, 'stopped');
  assert.equal(calls[0]?.signal.aborted, true);
  assert.deepEqual(disconnected, [0]);

  await transport.stop();
  assert.deepEqual(disconnected, [0]);
});

void test('transport falls back to the restored phone-number username', async () => {
  const { calls, transport } = createHarness();
  await transport.start({
    ...startContext,
    items: {
      number_id: '+12025550123.2',
      password: 'secret',
    },
  });
  assert.equal(calls[0]?.credentials.username, '+12025550123.2');
  await transport.stop();
});

void test('transport queues requests until the receiver handler is installed', async () => {
  const { calls, transport } = createHarness();
  await transport.start(startContext);
  calls[0]?.callbacks.onRequest(request(1));
  calls[0]?.callbacks.onRequest(request(2));
  assert.equal(transport.pendingRequestCount, 2);

  const received = new Array<number>();
  transport.setRequestHandler(incoming => {
    received.push(incoming.body?.[0] ?? -1);
  });
  await settle();
  assert.deepEqual(received, [1, 2]);
  assert.equal(transport.pendingRequestCount, 0);

  calls[0]?.callbacks.onRequest(request(3));
  await settle();
  assert.deepEqual(received, [1, 2, 3]);
  await transport.stop();
});

void test('transport reconnects after a retryable interruption', async () => {
  const { calls, reconnectAttempts, transport } = createHarness();
  await transport.start(startContext);
  calls[0]?.callbacks.onClose({ reason: 'network changed', retry: true });
  await settle();

  assert.equal(calls.length, 2);
  assert.deepEqual(reconnectAttempts, [0]);
  assert.equal(transport.state, 'open');
  assert.equal(transport.connected, true);
  await transport.stop();
});

void test('transport reconnects when an authenticated keepalive fails', async () => {
  const calls = new Array<ConnectCall>();
  const disconnected = new Array<number>();
  let keepaliveCalls = 0;
  const transport = new AuthenticatedHeadlessTransport(
    {
      async connect(credentials, callbacks, signal) {
        const index = calls.length;
        calls.push({ callbacks, credentials, signal });
        return {
          disconnect() {
            disconnected.push(index);
          },
          async keepalive() {
            keepaliveCalls += 1;
            if (index === 0) throw new Error('stale authenticated socket');
          },
        };
      },
    },
    {
      keepaliveIntervalMs: 1,
      keepaliveTimeoutMs: 10,
      reconnectDelay: async () => undefined,
    }
  );
  await transport.start(startContext);
  const received = new Array<number>();
  transport.setRequestHandler(incoming => {
    received.push(incoming.body?.[0] ?? -1);
  });

  const deadline = Date.now() + 1_000;
  while (calls.length < 2) {
    if (Date.now() > deadline) throw new Error('Keepalive did not reconnect');
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling observes the timer
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.ok(keepaliveCalls >= 1);
  assert.deepEqual(disconnected, [0]);
  assert.equal(transport.connected, true);
  assert.equal(transport.state, 'open');
  assert.equal(transport.failureReason, 'stale authenticated socket');
  const staleStatuses = new Array<number>();
  calls[0]?.callbacks.onRequest({
    ...request(9),
    respond: status => staleStatuses.push(status),
  });
  await settle();
  assert.deepEqual(received, []);
  assert.deepEqual(staleStatuses, [503]);
  await transport.stop();
});

void test('transport cancels the keepalive watchdog when stopped', async () => {
  let keepaliveCalls = 0;
  const transport = new AuthenticatedHeadlessTransport(
    {
      async connect() {
        return {
          disconnect() {
            return undefined;
          },
          keepalive() {
            keepaliveCalls += 1;
          },
        };
      },
    },
    { keepaliveIntervalMs: 20, keepaliveTimeoutMs: 10 }
  );
  await transport.start(startContext);
  await transport.stop();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(keepaliveCalls, 0);
});

void test('transport retries a failed reconnect without failing the daemon', async () => {
  const { calls, reconnectAttempts, setNextConnectError, transport } =
    createHarness();
  await transport.start(startContext);
  setNextConnectError(new Error('temporary DNS failure'));
  calls[0]?.callbacks.onClose({ reason: 'I/O failure', retry: true });
  await settle();
  await settle();

  assert.equal(calls.length, 3);
  assert.deepEqual(reconnectAttempts, [0, 1]);
  assert.equal(transport.state, 'open');
  assert.equal(transport.failureReason, 'temporary DNS failure');
  await transport.stop();
});

void test('transport fails closed after a terminal interruption', async () => {
  const { calls, reconnectAttempts, transport } = createHarness();
  await transport.start(startContext);
  calls[0]?.callbacks.onClose({ reason: 'device delinked', retry: false });

  assert.equal(transport.connected, false);
  assert.equal(transport.state, 'failed');
  assert.equal(transport.failureReason, 'device delinked');
  assert.equal(calls[0]?.signal.aborted, true);
  assert.deepEqual(reconnectAttempts, []);
  await transport.stop();
});

void test('transport disconnects instead of dropping an overflowing pending queue', async () => {
  const calls = new Array<ConnectCall>();
  let disconnected = false;
  const transport = new AuthenticatedHeadlessTransport(
    {
      async connect(credentials, callbacks, signal) {
        calls.push({ callbacks, credentials, signal });
        return {
          disconnect() {
            disconnected = true;
          },
        };
      },
    },
    { maxPendingRequests: 1 }
  );
  await transport.start(startContext);
  calls[0]?.callbacks.onRequest(request(1));
  calls[0]?.callbacks.onRequest(request(2));
  await settle();

  assert.equal(disconnected, true);
  assert.equal(transport.state, 'failed');
  assert.match(transport.failureReason ?? '', /queue exceeded 1/);
  assert.equal(transport.pendingRequestCount, 1);
  await transport.stop();
  assert.equal(transport.pendingRequestCount, 0);
});

void test('transport rejects missing credentials before touching the network', async () => {
  const { calls, transport } = createHarness();
  await assert.rejects(
    transport.start({ ...startContext, items: { password: 'secret' } }),
    /no network username/
  );
  assert.equal(calls.length, 0);
  assert.equal(transport.state, 'idle');
});

void test('transport reports initial connection failures and can still stop', async () => {
  const { calls, setNextConnectError, transport } = createHarness();
  setNextConnectError(new Error('authentication rejected'));
  await assert.rejects(
    transport.start(startContext),
    /authentication rejected/
  );
  assert.equal(calls.length, 1);
  assert.equal(transport.state, 'failed');
  assert.equal(transport.failureReason, 'authentication rejected');
  await transport.stop();
  assert.equal(transport.state, 'stopped');
});
