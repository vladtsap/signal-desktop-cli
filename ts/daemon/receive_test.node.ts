// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SignalService as Proto } from '../protobuf/index.std.ts';
import type { UnprocessedType } from '../textsecure/Types.d.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import type { HeadlessProtocolStores } from './protocol_stores.node.ts';
import {
  HeadlessMessageReceiver,
  UnsupportedIncomingContentError,
} from './receive.node.ts';
import type { HeadlessSql } from './sql.node.ts';
import type {
  HeadlessIncomingRequest,
  HeadlessTransportRuntime,
} from './transport.node.ts';

const OUR_ACI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as AciString;
const SENDER_ACI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as AciString;

class FakeTransport implements HeadlessTransportRuntime {
  public connected = false;
  public pendingRequestCount = 0;
  public state = 'idle' as const;
  public stopCount = 0;
  public failStart = false;
  #handler:
    | ((request: HeadlessIncomingRequest) => Promise<void> | void)
    | undefined;

  public setRequestHandler(
    handler: ((request: HeadlessIncomingRequest) => Promise<void> | void) | null
  ): void {
    this.#handler = handler ?? undefined;
  }

  public async start(): Promise<void> {
    if (this.failStart) throw new Error('connect failed');
    this.connected = true;
  }

  public async stop(): Promise<void> {
    this.stopCount += 1;
    this.connected = false;
  }

  public async emit(incomingRequest: HeadlessIncomingRequest): Promise<void> {
    assert.ok(this.#handler);
    await this.#handler(incomingRequest);
  }
}

function makeEnvelope(
  content: Uint8Array<ArrayBuffer> = Uint8Array.from([1, 2, 3])
): Uint8Array<ArrayBuffer> {
  return Proto.Envelope.encode({
    clientTimestamp: 1234n,
    content,
    destinationServiceId: OUR_ACI,
    serverGuid: 'server-guid',
    serverTimestamp: 1300n,
    sourceDeviceId: 2,
    sourceServiceId: SENDER_ACI,
    type: Proto.Envelope.Type.DOUBLE_RATCHET,
  } as never);
}

function makePlaintext(body?: string): Uint8Array<ArrayBuffer> {
  return Proto.Content.encode({
    content: {
      dataMessage:
        body === undefined
          ? { attachments: [{ cdnNumber: 1 }], timestamp: 1234n }
          : { body, timestamp: 1234n },
    },
  } as never);
}

function makeHarness({
  decryptError,
  plaintext = makePlaintext('hello'),
  saveFailureCount = 0,
  wasEncrypted = true,
}: Readonly<{
  decryptError?: Error;
  plaintext?: Uint8Array<ArrayBuffer>;
  saveFailureCount?: number;
  wasEncrypted?: boolean;
}> = {}) {
  const staged = new Map<string, UnprocessedType>();
  const saved = new Array<Record<string, unknown>>();
  let decryptCount = 0;
  let remainingFailures = saveFailureCount;
  const signalProtocolStore = {
    async addUnprocessed(item: UnprocessedType) {
      staged.set(item.id, item);
    },
    async getUnprocessedByIdsAndIncrementAttempts(ids: ReadonlyArray<string>) {
      return ids.flatMap(id => {
        const value = staged.get(id);
        return value ? [value] : [];
      });
    },
    async removeUnprocessed(id: string) {
      staged.delete(id);
    },
    async withZone(
      _zone: unknown,
      _name: string,
      body: () => Promise<unknown>
    ) {
      return body();
    },
  };
  const stores = {
    conversationController: {
      lookupOrCreate() {
        return { id: 'conversation', initialPromise: Promise.resolve() };
      },
    },
    itemStorage: {
      user: {
        getCheckedAci: () => OUR_ACI,
        getCheckedDeviceId: () => 1,
      },
    },
    messageCache: {
      create: (attributes: Record<string, unknown>) => ({ attributes }),
      findBySentAt: async () => undefined,
      register: (model: unknown) => model,
      async saveMessage(model: { attributes: Record<string, unknown> }) {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error('simulated SQL failure');
        }
        saved.push(model.attributes);
      },
    },
    signalProtocolStore,
  } as unknown as HeadlessProtocolStores;
  const transport = new FakeTransport();
  const receiver = new HeadlessMessageReceiver(transport, {
    decryptEnvelope: async envelope => {
      decryptCount += 1;
      if (decryptError) throw decryptError;
      return {
        envelope: { ...envelope, sourceServiceId: SENDER_ACI },
        plaintext,
        wasEncrypted,
      };
    },
    serverTrustRoots: [],
  });
  const sql = {
    read: async () => undefined,
  } as unknown as HeadlessSql;
  return {
    get decryptCount() {
      return decryptCount;
    },
    receiver,
    saved,
    sql,
    staged,
    stores,
    transport,
  };
}

async function start(harness: ReturnType<typeof makeHarness>): Promise<void> {
  await harness.receiver.start({
    items: {},
    protocolStores: harness.stores,
    sql: harness.sql,
  });
}

function request(body = makeEnvelope()) {
  const statuses = new Array<number>();
  return {
    incoming: {
      body,
      respond: (status: number) => statuses.push(status),
      type: 'message' as const,
    },
    statuses,
  };
}

void test('acknowledges only after direct text is durably saved', async () => {
  const harness = makeHarness();
  await start(harness);
  const { incoming, statuses } = request();
  await harness.transport.emit(incoming);
  assert.deepEqual(statuses, [200]);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0]?.body, 'hello');
  assert.equal(harness.staged.size, 0);
  await harness.receiver.stop();
});

void test('retries persistence from staged plaintext without decrypting twice', async () => {
  const harness = makeHarness({ saveFailureCount: 1 });
  await start(harness);
  const first = request();
  await harness.transport.emit(first.incoming);
  assert.deepEqual(first.statuses, [500]);
  assert.equal(harness.staged.size, 1);

  const retry = request();
  await harness.transport.emit(retry.incoming);
  assert.deepEqual(retry.statuses, [200]);
  assert.equal(harness.decryptCount, 1);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.staged.size, 0);
  await harness.receiver.stop();
});

void test('acknowledges unsupported decrypted content and retains it for upgrade', async () => {
  const harness = makeHarness({ plaintext: makePlaintext() });
  await start(harness);
  const { incoming, statuses } = request();
  await harness.transport.emit(incoming);
  assert.deepEqual(statuses, [200]);
  assert.equal(harness.saved.length, 0);
  assert.equal(harness.staged.size, 1);
  await harness.receiver.stop();
});

void test('acknowledges unsupported ciphertext and retains its envelope for upgrade', async () => {
  const harness = makeHarness({
    decryptError: new UnsupportedIncomingContentError(
      'Unsupported Signal ciphertext type: undefined'
    ),
  });
  await start(harness);
  const { incoming, statuses } = request();
  await harness.transport.emit(incoming);
  assert.deepEqual(statuses, [200]);
  assert.equal(harness.saved.length, 0);
  assert.equal(harness.staged.size, 1);
  const [staged] = harness.staged.values();
  assert.equal(staged?.isEncrypted, true);
  assert.deepEqual(
    Uint8Array.from(staged?.content ?? []),
    Uint8Array.from([1, 2, 3])
  );
  await harness.receiver.stop();
});

void test('acknowledges unsupported empty control envelopes without staging null content', async () => {
  const harness = makeHarness({
    decryptError: new UnsupportedIncomingContentError(
      'Unsupported Signal ciphertext type: undefined'
    ),
  });
  await start(harness);
  const { incoming, statuses } = request(makeEnvelope(new Uint8Array()));
  await harness.transport.emit(incoming);
  assert.deepEqual(statuses, [200]);
  assert.equal(harness.saved.length, 0);
  assert.equal(harness.staged.size, 0);
  await harness.receiver.stop();
});

void test('retains disappearing messages without normal persistence or webhook delivery', async () => {
  const plaintext = Proto.Content.encode({
    content: {
      dataMessage: { body: 'temporary', expireTimer: 60, timestamp: 1234n },
    },
  } as never);
  let webhookCount = 0;
  const harness = makeHarness({ plaintext });
  // Recreate the receiver to exercise the callback that feeds the webhook.
  harness.receiver = new HeadlessMessageReceiver(harness.transport, {
    decryptEnvelope: async envelope => ({
      envelope: { ...envelope, sourceServiceId: SENDER_ACI },
      plaintext,
      wasEncrypted: true,
    }),
    onPersistedMessage: () => {
      webhookCount += 1;
    },
    serverTrustRoots: [],
  });
  await start(harness);
  const { incoming, statuses } = request();
  await harness.transport.emit(incoming);
  assert.deepEqual(statuses, [200]);
  assert.equal(harness.saved.length, 0);
  assert.equal(webhookCount, 0);
  assert.equal(harness.staged.size, 1);
  await harness.receiver.stop();
});

for (const [name, dataMessage] of [
  ['missing', { body: 'hello' }],
  ['mismatched', { body: 'hello', timestamp: 1235n }],
] as const) {
  void test(`retains a data message with a ${name} inner timestamp`, async () => {
    const harness = makeHarness({
      plaintext: Proto.Content.encode({ content: { dataMessage } } as never),
    });
    await start(harness);
    const { incoming, statuses } = request();
    await harness.transport.emit(incoming);
    assert.deepEqual(statuses, [200]);
    assert.equal(harness.saved.length, 0);
    assert.equal(harness.staged.size, 1);
    await harness.receiver.stop();
  });
}

void test('does not materialize plaintext content as a normal data message', async () => {
  const harness = makeHarness({ wasEncrypted: false });
  await start(harness);
  const { incoming, statuses } = request();
  await harness.transport.emit(incoming);
  assert.deepEqual(statuses, [200]);
  assert.equal(harness.saved.length, 0);
  assert.equal(harness.staged.size, 1);
  assert.equal(
    [...harness.staged.values()][0]?.type,
    Proto.Envelope.Type.PLAINTEXT_CONTENT
  );
  await harness.receiver.stop();
});

void test('queue-empty is an ordered drain barrier and needs no acknowledgement', async () => {
  const harness = makeHarness();
  await start(harness);
  let responded = false;
  await harness.transport.emit({
    respond: () => {
      responded = true;
    },
    type: 'queue-empty',
  });
  assert.equal(responded, false);
  await harness.receiver.stop();
});

void test('cleans partial receiver state when transport startup fails', async () => {
  const harness = makeHarness();
  harness.transport.failStart = true;
  await assert.rejects(start(harness), /connect failed/);
  assert.equal(harness.transport.stopCount, 1);
  await assert.rejects(
    harness.transport.emit({ respond: () => undefined, type: 'queue-empty' })
  );
});

void test('persists a received text through the real SQLCipher schema', async () => {
  const fixture = fileURLToPath(
    new URL('./receive_fixture.node.ts', import.meta.url)
  );
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import=tsx', fixture], {
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 0);
});
