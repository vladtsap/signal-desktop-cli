// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CiphertextMessage,
  SessionRecord,
} from '@signalapp/libsignal-client';

import { SendStatus } from '../messages/MessageSendState.std.ts';
import type { signal } from '../protobuf/compiled.std.js';
import { sessionStructureToBytes } from '../util/sessionTranslation.node.ts';
import { createHeadlessDataInterfaces } from './client_sql.node.ts';
import { openHeadlessProtocolStores } from './protocol_stores.node.ts';
import {
  HeadlessSendError,
  HeadlessSendService,
  hasCurrentSendSession,
  type HeadlessSendCrypto,
} from './send.node.ts';
import { openHeadlessSql } from './sql.node.ts';
import type { HeadlessSendTransport } from './transport.node.ts';

const OUR_ACI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THEIR_ACI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEYS_BODY = Buffer.from(
  JSON.stringify({
    devices: [
      {
        deviceId: 1,
        pqPreKey: { keyId: 3, publicKey: 'AA==', signature: 'AA==' },
        registrationId: 7,
        signedPreKey: { keyId: 2, publicKey: 'AA==', signature: 'AA==' },
      },
    ],
    identityKey: 'AA==',
  })
);

function randomPrivateKey(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(32));
}

function randomPublicKey(): Uint8Array<ArrayBuffer> {
  const key = Uint8Array.from(randomBytes(33));
  key[0] = 5;
  return key;
}

function createCurrentSessionRecord(): SessionRecord {
  return SessionRecord.deserialize(
    sessionStructureToBytes({
      currentSession: {
        aliceBaseKey: randomPublicKey(),
        localIdentityPublic: randomPublicKey(),
        localRegistrationId: 435,
        previousCounter: 1,
        receiverChains: null,
        remoteIdentityPublic: randomPublicKey(),
        remoteRegistrationId: 243,
        rootKey: randomPrivateKey(),
        senderChain: {
          chainKey: null,
          messageKeys: null,
          senderRatchetKey: null,
          senderRatchetKeyPrivate: null,
        },
        sessionVersion: 3,
      } as signal.proto.storage.SessionStructure.Params,
      previousSessions: [],
    })
  );
}

async function createHarness() {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-send-sql-'));
  const sql = openHeadlessSql({
    appVersion: '8.21.0-alpha.1',
    key: 'cd'.repeat(32),
    storagePath,
  });
  const { dataReader, dataWriter } = createHeadlessDataInterfaces(sql);
  await dataWriter.createOrUpdateItem({ id: 'uuid_id', value: `${OUR_ACI}.2` });
  await dataWriter.createOrUpdateItem({
    id: 'number_id',
    value: '+12025550123.2',
  });
  await dataWriter.createOrUpdateItem({ id: 'password', value: 'secret' });
  const stores = await openHeadlessProtocolStores(sql);
  const recipient = stores.conversationController.getOrCreate(
    THEIR_ACI,
    'private',
    { e164: '+12025550124' }
  );
  await recipient.initialPromise;

  const calls = { archive: 0, encrypt: 0, establish: 0, fetch: 0, send: 0 };
  let sendError: Error | undefined;
  let hasSessions = false;
  let pauseSend = false;
  let releaseSend: (() => void) | undefined;
  let sendEntered: (() => void) | undefined;
  const transport: HeadlessSendTransport = {
    connected: true,
    async fetchAuthenticated() {
      calls.fetch += 1;
      return {
        body: Uint8Array.from(KEYS_BODY),
        headers: [],
        message: 'OK',
        status: 200,
      };
    },
    async sendMessage() {
      calls.send += 1;
      if (pauseSend) {
        sendEntered?.();
        await new Promise<void>(resolve => {
          releaseSend = resolve;
        });
        pauseSend = false;
        releaseSend = undefined;
      }
      if (sendError) throw sendError;
    },
  };
  const crypto: HeadlessSendCrypto = {
    async establishSessions() {
      calls.establish += 1;
      hasSessions = true;
    },
    async encrypt() {
      calls.encrypt += 1;
      return [
        {
          contents: {} as CiphertextMessage,
          deviceId: 1,
          registrationId: 7,
        },
      ];
    },
    async hasSessions() {
      return hasSessions;
    },
  };
  const originalArchiveAllSessions =
    stores.signalProtocolStore.archiveAllSessions.bind(
      stores.signalProtocolStore
    );
  stores.signalProtocolStore.archiveAllSessions = async destination => {
    calls.archive += 1;
    hasSessions = false;
    await originalArchiveAllSessions(destination);
  };
  return {
    calls,
    cleanup: async () => {
      await sql.close();
      await rm(storagePath, { force: true, recursive: true });
    },
    dataReader,
    pauseNextSend() {
      pauseSend = true;
      return new Promise<void>(resolve => {
        sendEntered = resolve;
      });
    },
    recipient,
    service: new HeadlessSendService(transport, stores, crypto, {
      maxPending: 2,
      now: () => 1_700_000_000_000,
    }),
    setSendError(value?: Error) {
      sendError = value;
    },
    releaseSend() {
      releaseSend?.();
    },
    stores,
  };
}

async function testArchivedSessionIsNotCurrent(): Promise<void> {
  const record = createCurrentSessionRecord();
  assert.equal(hasCurrentSendSession(record), true);
  record.archiveCurrentState();
  assert.equal(hasCurrentSendSession(record), false);
}

async function testConcurrentIdempotencyClaim(): Promise<void> {
  const harness = await createHarness();
  try {
    const entered = harness.pauseNextSend();
    const first = harness.service.sendText({
      body: 'first body',
      destination: THEIR_ACI,
      idempotencyKey: 'concurrent-key',
    });
    await entered;
    const conflicting = harness.service.sendText({
      body: 'conflicting body',
      destination: '+12025550124',
      idempotencyKey: 'concurrent-key',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(harness.calls.send, 1);
    harness.releaseSend();
    await first;
    await assert.rejects(conflicting, {
      code: 'invalid-request',
      retryable: false,
    });
    assert.equal(harness.calls.send, 1);
  } finally {
    harness.releaseSend();
    await harness.cleanup();
  }
}

async function testDurableIdempotentSend(): Promise<void> {
  const harness = await createHarness();
  try {
    const request = {
      body: 'hello from headless',
      destination: THEIR_ACI,
      idempotencyKey: 'request-1',
    };
    const first = await harness.service.sendText(request);
    const second = await harness.service.sendText(request);
    assert.deepEqual(second, first);
    await harness.service.sendText({
      ...request,
      body: 'second message',
      idempotencyKey: 'request-2',
    });
    assert.deepEqual(harness.calls, {
      archive: 0,
      encrypt: 2,
      establish: 1,
      fetch: 1,
      send: 2,
    });
    const persisted = await harness.dataReader.getMessageById(first.messageId);
    assert.equal(persisted?.body, request.body);
    assert.equal(
      persisted?.sendStateByConversationId?.[harness.recipient.id]?.status,
      SendStatus.Sent
    );
  } finally {
    await harness.cleanup();
  }
}

async function testE164Resolution(): Promise<void> {
  const harness = await createHarness();
  try {
    const result = await harness.service.sendText({
      body: 'hello',
      destination: '+12025550124',
      idempotencyKey: 'request-e164',
    });
    assert.equal(result.destination, THEIR_ACI);
    await assert.rejects(
      harness.service.sendText({
        body: 'hello',
        destination: '+12025550999',
        idempotencyKey: 'unknown-e164',
      }),
      (error: unknown) =>
        error instanceof HeadlessSendError &&
        error.code === 'recipient-not-found'
    );
  } finally {
    await harness.cleanup();
  }
}

async function testRetryableFailure(): Promise<void> {
  const harness = await createHarness();
  try {
    harness.setSendError(
      new Error('Signal transport is not connected (state: reconnecting)')
    );
    const request = {
      body: 'retry me',
      destination: THEIR_ACI,
      idempotencyKey: 'retry-1',
    };
    await assert.rejects(harness.service.sendText(request), {
      code: 'not-connected',
      retryable: true,
    });
    harness.setSendError();
    const result = await harness.service.sendText(request);
    assert.equal(result.timestamp, 1_700_000_000_000);
    assert.equal(harness.calls.send, 2);
  } finally {
    await harness.cleanup();
  }
}

async function testDeviceMismatchRecovery(): Promise<void> {
  const harness = await createHarness();
  try {
    harness.setSendError(
      new HeadlessSendError('device list changed', 'device-mismatch', true)
    );
    const request = {
      body: 'recover me',
      destination: THEIR_ACI,
      idempotencyKey: 'mismatch-1',
    };
    await assert.rejects(harness.service.sendText(request), {
      code: 'device-mismatch',
      retryable: true,
    });
    assert.equal(harness.calls.archive, 1);
    harness.setSendError();
    await harness.service.sendText(request);
    assert.equal(harness.calls.fetch, 2);
    assert.equal(harness.calls.establish, 2);
  } finally {
    await harness.cleanup();
  }
}

async function testTerminalFailure(): Promise<void> {
  const harness = await createHarness();
  try {
    harness.setSendError(
      new HeadlessSendError('identity changed', 'identity', false)
    );
    const request = {
      body: 'fail me',
      destination: THEIR_ACI,
      idempotencyKey: 'fail-1',
    };
    await assert.rejects(harness.service.sendText(request), {
      code: 'identity',
      retryable: false,
    });
    await assert.rejects(
      async () =>
        harness.service.sendText({
          ...request,
          attachments: [{}],
          idempotencyKey: 'attachment',
        }),
      (error: unknown) =>
        error instanceof HeadlessSendError && error.code === 'unsupported'
    );
    const [persisted] =
      await harness.dataReader.getMessagesBySentAt(1_700_000_000_000);
    assert.equal(
      persisted?.sendStateByConversationId?.[harness.recipient.id]?.status,
      SendStatus.Failed
    );
  } finally {
    await harness.cleanup();
  }
}

async function main(): Promise<void> {
  await testArchivedSessionIsNotCurrent();
  await testConcurrentIdempotencyClaim();
  await testDurableIdempotentSend();
  await testE164Resolution();
  await testRetryableFailure();
  await testDeviceMismatchRecovery();
  await testTerminalFailure();
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
