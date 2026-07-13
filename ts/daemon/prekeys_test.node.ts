// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { generateKeyPair } from '../Curve.node.ts';
import type { SignalProtocolStore } from '../SignalProtocolStore.node.ts';
import type { Storage } from '../textsecure/Storage.node.ts';
import { ServiceIdKind } from '../types/ServiceId.std.ts';
import {
  LibsignalPreKeyUpdater,
  PreKeyMaintainedProtocolRuntime,
  type HeadlessPreKeyUpdater,
} from './prekeys.node.ts';
import type { HeadlessProtocolStores } from './protocol_stores.node.ts';
import type { ProtocolRuntime } from './runtime.node.ts';
import type { HeadlessSendTransport } from './transport.node.ts';

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function fixture(
  updater: HeadlessPreKeyUpdater,
  options: Readonly<{
    lowKeysDelayMs?: number;
    periodicIntervalMs?: number;
    retryIntervalMs?: number;
  }> = {}
) {
  const events = new EventEmitter();
  let starts = 0;
  let stops = 0;
  const protocol: ProtocolRuntime = {
    connected: true,
    async start() {
      starts += 1;
    },
    async stop() {
      stops += 1;
    },
  };
  const runtime = new PreKeyMaintainedProtocolRuntime(
    protocol,
    () => updater,
    options
  );
  const context = {
    items: {},
    protocolStores: {
      signalProtocolStore: events,
    } as unknown as HeadlessProtocolStores,
    sql: {},
  } as Parameters<ProtocolRuntime['start']>[0];
  return {
    context,
    events,
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    runtime,
  };
}

void test('updates ACI and PNI at startup', async () => {
  const updates = new Array<ServiceIdKind>();
  const subject = fixture({
    areKeysOutOfDate: () => false,
    async update(kind) {
      updates.push(kind);
    },
  });

  await subject.runtime.start(subject.context);
  assert.deepEqual(updates, [ServiceIdKind.ACI, ServiceIdKind.PNI]);
  assert.equal(subject.starts, 1);
  await subject.runtime.stop();
});

void test('uploads and confirms rotated signed and last-resort keys', async () => {
  const aci = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const identity = generateKeyPair();
  const items = new Map<string, unknown>([
    ['signedKeyId', 7],
    ['maxKyberPreKeyId', 11],
  ]);
  const confirmed = new Array<string>();
  const requests = new Array<{
    body?: Uint8Array<ArrayBuffer>;
    path: string;
    verb: string;
  }>();
  const storage = {
    get(key: string, fallback?: unknown) {
      return items.get(key) ?? fallback;
    },
    async put(key: string, value: unknown) {
      items.set(key, value);
    },
    user: {
      getCheckedServiceId() {
        return aci;
      },
    },
  } as unknown as Storage;
  const store = {
    getIdentityKeyPair() {
      return identity;
    },
    loadKyberPreKeys() {
      return [];
    },
    loadSignedPreKeys() {
      return [];
    },
    async storeKyberPreKeys() {
      return undefined;
    },
    async storeSignedPreKey() {
      return undefined;
    },
    async confirmKyberPreKey(_serviceId: string, keyId: number) {
      confirmed.push(`kyber:${keyId}`);
    },
    async confirmSignedPreKey(_serviceId: string, keyId: number) {
      confirmed.push(`signed:${keyId}`);
    },
  } as unknown as SignalProtocolStore;
  const transport = {
    connected: true,
    async fetchAuthenticated(request) {
      requests.push(request);
      if (request.verb === 'GET') {
        return {
          body: Buffer.from(JSON.stringify({ count: 100, pqCount: 100 })),
          headers: [],
          message: 'OK',
          status: 200,
        };
      }
      return {
        body: undefined,
        headers: [],
        message: 'No Content',
        status: 204,
      };
    },
    async sendMessage() {
      return undefined;
    },
  } as HeadlessSendTransport;
  const updater = new LibsignalPreKeyUpdater(
    storage,
    store,
    transport,
    () => 1_700_000_000_000
  );

  await updater.update(ServiceIdKind.ACI, new AbortController().signal);

  assert.deepEqual(
    requests.map(request => [request.verb, request.path]),
    [
      ['GET', '/v2/keys?identity=aci'],
      ['PUT', '/v2/keys?identity=aci'],
    ]
  );
  const uploadRequest = requests[1];
  assert.ok(uploadRequest?.body);
  const uploaded = JSON.parse(Buffer.from(uploadRequest.body).toString());
  assert.equal(uploaded.signedPreKey.keyId, 7);
  assert.equal(uploaded.pqLastResortPreKey.keyId, 11);
  assert.deepEqual(confirmed, ['signed:7', 'kyber:11']);
  assert.equal(items.get('signedKeyUpdateTime'), 1_700_000_000_000);
  assert.equal(items.get('lastResortKeyUpdateTime'), 1_700_000_000_000);
});

void test('coalesces lowKeys events into a delayed update', async () => {
  const updates = new Array<ServiceIdKind>();
  const subject = fixture(
    {
      areKeysOutOfDate: () => false,
      async update(kind) {
        updates.push(kind);
      },
    },
    { lowKeysDelayMs: 5, periodicIntervalMs: 10_000 }
  );
  await subject.runtime.start(subject.context);
  updates.length = 0;

  subject.events.emit('lowKeys');
  subject.events.emit('lowKeys');
  await delay(20);

  assert.deepEqual(updates, [ServiceIdKind.ACI, ServiceIdKind.PNI]);
  await subject.runtime.stop();
});

void test('periodically checks key age and replenishes both identities', async () => {
  let ageChecks = 0;
  const updates = new Array<ServiceIdKind>();
  const subject = fixture(
    {
      areKeysOutOfDate() {
        ageChecks += 1;
        return true;
      },
      async update(kind) {
        updates.push(kind);
      },
    },
    { periodicIntervalMs: 5 }
  );
  await subject.runtime.start(subject.context);
  updates.length = 0;

  await delay(20);

  assert.ok(ageChecks > 0);
  assert.ok(updates.includes(ServiceIdKind.ACI));
  assert.ok(updates.includes(ServiceIdKind.PNI));
  await subject.runtime.stop();
});

void test('retries failures and stop cancels timers, listeners, and work', async () => {
  let attempts = 0;
  let aborted = false;
  const subject = fixture(
    {
      areKeysOutOfDate: () => false,
      async update(_kind, signal) {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary outage');
        if (attempts >= 4) {
          await new Promise<void>(resolve => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true }
            );
          });
        }
      },
    },
    { lowKeysDelayMs: 1, periodicIntervalMs: 5, retryIntervalMs: 5 }
  );
  await subject.runtime.start(subject.context);
  await delay(15);
  const stopping = subject.runtime.stop();
  await stopping;
  const attemptsAtStop = attempts;
  subject.events.emit('lowKeys');
  await delay(10);

  assert.ok(attempts >= 3, 'startup failure should be retried');
  assert.equal(aborted, true, 'active maintenance fetch should be aborted');
  assert.equal(attempts, attemptsAtStop, 'no work should run after stop');
  assert.equal(subject.events.listenerCount('lowKeys'), 0);
  assert.equal(subject.stops, 1);
  await subject.runtime.stop();
  assert.equal(subject.stops, 1, 'stop should be idempotent');
});
