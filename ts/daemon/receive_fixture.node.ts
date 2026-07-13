// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SignalService as Proto } from '../protobuf/index.std.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import { createHeadlessDataInterfaces } from './client_sql.node.ts';
import { openHeadlessProtocolStores } from './protocol_stores.node.ts';
import { HeadlessMessageReceiver } from './receive.node.ts';
import { openHeadlessSql } from './sql.node.ts';
import type {
  HeadlessIncomingRequest,
  HeadlessTransportRuntime,
} from './transport.node.ts';

const OUR_ACI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as AciString;
const SENDER_ACI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as AciString;

class FixtureTransport implements HeadlessTransportRuntime {
  public connected = false;
  public pendingRequestCount = 0;
  public state = 'idle' as const;
  #handler:
    | ((request: HeadlessIncomingRequest) => Promise<void> | void)
    | undefined;

  public setRequestHandler(
    handler: ((request: HeadlessIncomingRequest) => Promise<void> | void) | null
  ): void {
    this.#handler = handler ?? undefined;
  }

  public async start(): Promise<void> {
    this.connected = true;
  }

  public async stop(): Promise<void> {
    this.connected = false;
  }

  public async emit(request: HeadlessIncomingRequest): Promise<void> {
    assert.ok(this.#handler);
    await this.#handler(request);
  }
}

async function main(): Promise<void> {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-receive-sql-'));
  const sql = openHeadlessSql({
    appVersion: '8.21.0-alpha.1',
    key: 'cd'.repeat(32),
    storagePath,
  });
  try {
    const { dataWriter } = createHeadlessDataInterfaces(sql);
    await dataWriter.createOrUpdateItem({
      id: 'uuid_id',
      value: `${OUR_ACI}.1`,
    });
    await dataWriter.createOrUpdateItem({
      id: 'number_id',
      value: '+12025550123.1',
    });
    await dataWriter.createOrUpdateItem({ id: 'password', value: 'secret' });
    const stores = await openHeadlessProtocolStores(sql);
    const transport = new FixtureTransport();
    const plaintext = Proto.Content.encode({
      content: {
        dataMessage: {
          body: 'persisted through SQLCipher',
          timestamp: 1234n,
        },
      },
    } as never);
    const receiver = new HeadlessMessageReceiver(transport, {
      decryptEnvelope: async envelope => ({
        envelope: { ...envelope, sourceServiceId: SENDER_ACI },
        plaintext,
        wasEncrypted: true,
      }),
      serverTrustRoots: [],
    });
    await receiver.start({ items: {}, protocolStores: stores, sql });

    const body = Proto.Envelope.encode({
      clientTimestamp: 1234n,
      content: Uint8Array.from([9, 8, 7]),
      destinationServiceId: OUR_ACI,
      serverGuid: 'fixture-guid',
      serverTimestamp: 1300n,
      sourceDeviceId: 2,
      sourceServiceId: SENDER_ACI,
      type: Proto.Envelope.Type.DOUBLE_RATCHET,
    } as never);
    const statuses = new Array<number>();
    await transport.emit({
      body,
      respond: status => statuses.push(status),
      type: 'message',
    });
    assert.deepEqual(statuses, [200]);
    const messages = await sql.read('_getAllMessages');
    assert.equal(messages.length, 1, receiver.unsupportedReason);
    assert.equal(messages[0]?.body, 'persisted through SQLCipher');
    assert.equal(messages[0]?.sourceServiceId, SENDER_ACI);
    assert.equal(await sql.read('getUnprocessedCount'), 0);
    await receiver.stop();
  } finally {
    await sql.close();
    await rm(storagePath, { force: true, recursive: true });
  }
}

async function run(): Promise<void> {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  }
}

void run();
