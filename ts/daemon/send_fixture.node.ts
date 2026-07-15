// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Aci,
  type CiphertextMessage,
  LibSignalErrorBase,
  MismatchedDevicesEntry,
  SessionRecord,
} from '@signalapp/libsignal-client';

import { SeenStatus } from '../MessageSeenStatus.std.ts';
import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import { SendStatus } from '../messages/MessageSendState.std.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import { SignalService as Proto } from '../protobuf/index.std.ts';
import type { AciString } from '../types/ServiceId.std.ts';
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
const THEIR_ACI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as AciString;
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
  await dataWriter.createOrUpdateItem({
    id: 'read-receipt-setting',
    value: true,
  });
  const stores = await openHeadlessProtocolStores(sql);
  const saveMessage = stores.messageCache.saveMessage.bind(stores.messageCache);
  let nextSaveError: Error | undefined;
  Object.defineProperty(stores.messageCache, 'saveMessage', {
    configurable: true,
    value: async (...args: Parameters<typeof saveMessage>) => {
      if (nextSaveError) {
        const error = nextSaveError;
        nextSaveError = undefined;
        throw error;
      }
      return saveMessage(...args);
    },
  });
  const recipient = stores.conversationController.getOrCreate(
    THEIR_ACI,
    'private',
    { e164: '+12025550124', profileSharing: true }
  );
  await recipient.initialPromise;

  const calls = { encrypt: 0, establish: 0, fetch: 0, repair: 0, send: 0 };
  const repairs = new Array<
    Parameters<HeadlessSendCrypto['repairSessions']>[0]
  >();
  const plaintexts = new Array<Uint8Array<ArrayBuffer>>();
  let sendError: Error | undefined;
  let nextSendError: Error | undefined;
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
      if (nextSendError) {
        const error = nextSendError;
        nextSendError = undefined;
        throw error;
      }
      if (sendError) throw sendError;
    },
  };
  const crypto: HeadlessSendCrypto = {
    async establishSessions() {
      calls.establish += 1;
      hasSessions = true;
    },
    async encrypt({ plaintext }) {
      calls.encrypt += 1;
      plaintexts.push(plaintext);
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
    async repairSessions(options) {
      calls.repair += 1;
      repairs.push(options);
      hasSessions = true;
    },
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
    plaintexts,
    service: new HeadlessSendService(transport, stores, crypto, {
      maxPending: 2,
      now: () => 1_700_000_000_000,
    }),
    setSendError(value?: Error) {
      sendError = value;
    },
    setNextSendError(value: Error) {
      nextSendError = value;
    },
    setNextSaveError(value: Error) {
      nextSaveError = value;
    },
    releaseSend() {
      releaseSend?.();
    },
    repairs,
    stores,
  };
}

async function storeMessage(
  harness: Awaited<ReturnType<typeof createHarness>>,
  attributes: MessageAttributesType
): Promise<void> {
  const model = harness.stores.messageCache.register(
    harness.stores.messageCache.create(attributes)
  );
  await harness.stores.messageCache.saveMessage(model, { forceSave: true });
}

function incomingMessage(
  harness: Awaited<ReturnType<typeof createHarness>>,
  id: string,
  overrides: Partial<MessageAttributesType> = {}
): MessageAttributesType {
  return {
    body: 'incoming target',
    conversationId: harness.recipient.id,
    id,
    received_at: 1_699_999_998_000,
    sent_at: 1_699_999_998_000,
    sourceServiceId: THEIR_ACI,
    timestamp: 1_699_999_998_000,
    type: 'incoming',
    ...overrides,
  } as MessageAttributesType;
}

function decodeContent(plaintext: Uint8Array<ArrayBuffer>): Proto.Content {
  let paddingStart = plaintext.length - 1;
  while (paddingStart >= 0 && plaintext[paddingStart] === 0) paddingStart -= 1;
  assert.equal(plaintext[paddingStart], 0x80);
  return Proto.Content.decode(plaintext.slice(0, paddingStart));
}

async function testArchivedSessionIsNotCurrent(): Promise<void> {
  const record = createCurrentSessionRecord();
  assert.equal(hasCurrentSendSession(record), true);
  record.archiveCurrentState();
  assert.equal(hasCurrentSendSession(record), false);
}

async function testConcurrentSendsAreSerialized(): Promise<void> {
  const harness = await createHarness();
  try {
    const entered = harness.pauseNextSend();
    const first = harness.service.sendText({
      body: 'first body',
      destination: THEIR_ACI,
    });
    await entered;
    const second = harness.service.sendText({
      body: 'second body',
      destination: THEIR_ACI,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(harness.calls.send, 1);
    harness.releaseSend();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.notEqual(firstResult.messageId, secondResult.messageId);
    assert.equal(harness.calls.send, 2);
  } finally {
    harness.releaseSend();
    await harness.cleanup();
  }
}

async function testRepeatedRequestsCreateDistinctDurableSends(): Promise<void> {
  const harness = await createHarness();
  try {
    const request = {
      body: 'hello from headless',
      destination: THEIR_ACI,
    };
    const first = await harness.service.sendText(request);
    const second = await harness.service.sendText(request);
    assert.notEqual(second.messageId, first.messageId);
    assert.deepEqual(harness.calls, {
      encrypt: 2,
      establish: 1,
      fetch: 1,
      repair: 0,
      send: 2,
    });
    const persisted = await harness.dataReader.getMessageById(first.messageId);
    const secondPersisted = await harness.dataReader.getMessageById(
      second.messageId
    );
    assert.equal(persisted?.body, request.body);
    assert.equal(secondPersisted?.body, request.body);
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
    });
    assert.equal(result.destination, THEIR_ACI);
    await assert.rejects(
      harness.service.sendText({
        body: 'hello',
        destination: '+12025550999',
      }),
      (error: unknown) =>
        error instanceof HeadlessSendError &&
        error.code === 'recipient-not-found'
    );
  } finally {
    await harness.cleanup();
  }
}

async function testQuotedReply(): Promise<void> {
  const harness = await createHarness();
  const quotedMessageId = '11111111-1111-4111-8111-111111111111';
  try {
    const quoted: MessageAttributesType = {
      body: 'the original message',
      conversationId: harness.recipient.id,
      id: quotedMessageId,
      received_at: 1_699_999_999_000,
      sent_at: 1_699_999_999_000,
      sourceServiceId: THEIR_ACI,
      timestamp: 1_699_999_999_000,
      type: 'incoming',
    };
    const model = harness.stores.messageCache.register(
      harness.stores.messageCache.create(quoted)
    );
    await harness.stores.messageCache.saveMessage(model, { forceSave: true });

    const result = await harness.service.sendText({
      body: 'reply body',
      destination: THEIR_ACI,
      quoteMessageId: quotedMessageId,
    });
    const persisted = await harness.dataReader.getMessageById(result.messageId);
    assert.deepEqual(persisted?.quote, {
      attachments: [],
      authorAci: THEIR_ACI,
      id: 1_699_999_999_000,
      isViewOnce: false,
      messageId: quotedMessageId,
      referencedMessageNotFound: false,
      text: 'the original message',
    });
    const dataMessage = decodeContent(harness.plaintexts[0] ?? new Uint8Array())
      .content?.dataMessage;
    assert.equal(dataMessage?.quote?.id, 1_699_999_999_000n);
    assert.equal(dataMessage?.quote?.authorAci, THEIR_ACI);
    assert.equal(dataMessage?.quote?.text, 'the original message');
  } finally {
    await harness.cleanup();
  }
}

async function testQuotedReplyValidation(): Promise<void> {
  const harness = await createHarness();
  try {
    await assert.rejects(
      harness.service.sendText({
        body: 'missing quote',
        destination: THEIR_ACI,
        quoteMessageId: 'missing-message',
      }),
      { code: 'invalid-request' }
    );

    await storeMessage(
      harness,
      incomingMessage(harness, 'quote-other-conversation', {
        conversationId: 'other-conversation',
      })
    );
    await assert.rejects(
      harness.service.sendText({
        body: 'wrong conversation',
        destination: THEIR_ACI,
        quoteMessageId: 'quote-other-conversation',
      }),
      { code: 'invalid-request' }
    );

    await storeMessage(
      harness,
      incomingMessage(harness, 'quote-invalid-author', {
        sourceServiceId: undefined,
      })
    );
    await assert.rejects(
      harness.service.sendText({
        body: 'invalid author',
        destination: THEIR_ACI,
        quoteMessageId: 'quote-invalid-author',
      }),
      { code: 'invalid-request' }
    );
    assert.equal(harness.calls.send, 0);
  } finally {
    await harness.cleanup();
  }
}

async function testQuotesOutgoingMessageWithOurAci(): Promise<void> {
  const harness = await createHarness();
  try {
    const original = await harness.service.sendText({
      body: 'our original',
      destination: THEIR_ACI,
    });
    const reply = await harness.service.sendText({
      body: 'our follow-up',
      destination: THEIR_ACI,
      quoteMessageId: original.messageId,
    });
    const persisted = await harness.dataReader.getMessageById(reply.messageId);
    assert.equal(persisted?.quote?.authorAci, OUR_ACI);
    const quote = decodeContent(harness.plaintexts[1] ?? new Uint8Array())
      .content?.dataMessage?.quote;
    assert.equal(quote?.authorAci, OUR_ACI);
    assert.equal(quote?.id, BigInt(original.timestamp));
  } finally {
    await harness.cleanup();
  }
}

async function testReaction(): Promise<void> {
  const harness = await createHarness();
  const targetMessageId = '22222222-2222-4222-8222-222222222222';
  try {
    const target: MessageAttributesType = {
      body: 'react to this',
      conversationId: harness.recipient.id,
      id: targetMessageId,
      received_at: 1_699_999_998_000,
      sent_at: 1_699_999_998_000,
      sourceServiceId: THEIR_ACI,
      timestamp: 1_699_999_998_000,
      type: 'incoming',
    };
    const model = harness.stores.messageCache.register(
      harness.stores.messageCache.create(target)
    );
    await harness.stores.messageCache.saveMessage(model, { forceSave: true });

    const result = await harness.service.sendReaction({
      destination: THEIR_ACI,
      emoji: '👍',
      messageId: targetMessageId,
    });
    assert.equal(result.emoji, '👍');
    const persisted = await harness.dataReader.getMessageById(targetMessageId);
    assert.equal(persisted?.reactions?.length, 1);
    assert.equal(persisted?.reactions?.[0]?.emoji, '👍');
    assert.equal(persisted?.reactions?.[0]?.targetTimestamp, 1_699_999_998_000);
    const reaction = decodeContent(harness.plaintexts[0] ?? new Uint8Array())
      .content?.dataMessage?.reaction;
    assert.equal(reaction?.emoji, '👍');
    assert.equal(reaction?.remove, false);
    assert.equal(reaction?.targetAuthorAci, THEIR_ACI);
    assert.equal(reaction?.targetSentTimestamp, 1_699_999_998_000n);
    assert.equal(harness.calls.fetch, 1);
    assert.equal(harness.calls.establish, 1);
    await assert.rejects(
      async () =>
        harness.service.sendReaction({
          destination: THEIR_ACI,
          emoji: 'not an emoji',
          messageId: targetMessageId,
        }),
      { code: 'invalid-request' }
    );
  } finally {
    await harness.cleanup();
  }
}

async function testWebhookReadReceiptAndSync(): Promise<void> {
  const harness = await createHarness();
  const messageId = '33333333-3333-4333-8333-333333333333';
  try {
    await storeMessage(harness, incomingMessage(harness, messageId));

    await harness.service.markReadAfterWebhook(messageId);

    const persisted = await harness.dataReader.getMessageById(messageId);
    assert.equal(persisted?.readStatus, ReadStatus.Read);
    assert.equal(persisted?.seenStatus, SeenStatus.Seen);
    assert.equal(harness.calls.send, 2);

    const contents = harness.plaintexts.map(decodeContent);
    const receipt = contents.find(content => content.content?.receiptMessage)
      ?.content?.receiptMessage;
    assert.equal(receipt?.type, Proto.ReceiptMessage.Type.READ);
    assert.deepEqual(receipt?.timestamp, [1_699_999_998_000n]);

    const sync = contents.find(content => content.content?.syncMessage)?.content
      ?.syncMessage;
    assert.equal(sync?.read.length, 1);
    assert.equal(sync?.read[0]?.timestamp, 1_699_999_998_000n);
    assert.deepEqual(
      sync?.read[0]?.senderAciBinary,
      Aci.fromUuid(THEIR_ACI).getRawUuidBytes()
    );
  } finally {
    await harness.cleanup();
  }
}

async function testWebhookReadReceiptSetting(): Promise<void> {
  const harness = await createHarness();
  const messageId = '44444444-4444-4444-8444-444444444444';
  try {
    await harness.stores.itemStorage.put('read-receipt-setting', false);
    await storeMessage(harness, incomingMessage(harness, messageId));

    await harness.service.markReadAfterWebhook(messageId);

    assert.equal(harness.calls.send, 1);
    const content = decodeContent(harness.plaintexts[0] ?? new Uint8Array());
    assert.equal(content.content?.receiptMessage, undefined);
    assert.equal(content.content?.syncMessage?.read.length, 1);
  } finally {
    await harness.cleanup();
  }
}

async function testWebhookReadReceiptRequiresAcceptedConversation(): Promise<void> {
  const harness = await createHarness();
  const messageId = '55555555-5555-4555-8555-555555555555';
  try {
    harness.recipient.set({ profileSharing: false });
    await storeMessage(harness, incomingMessage(harness, messageId));

    await harness.service.markReadAfterWebhook(messageId);

    assert.equal(harness.calls.send, 1);
    const content = decodeContent(harness.plaintexts[0] ?? new Uint8Array());
    assert.equal(content.content?.receiptMessage, undefined);
    assert.equal(content.content?.syncMessage?.read.length, 1);
  } finally {
    await harness.cleanup();
  }
}

async function testReactionValidation(): Promise<void> {
  const harness = await createHarness();
  try {
    assert.throws(
      () =>
        harness.service.sendReaction({
          destination: THEIR_ACI,
          emoji: '👍',
          messageId: '',
        }),
      { code: 'invalid-request' }
    );
    await assert.rejects(
      harness.service.sendReaction({
        destination: THEIR_ACI,
        emoji: '👍',
        messageId: 'missing-reaction-target',
      }),
      { code: 'invalid-request' }
    );

    await storeMessage(
      harness,
      incomingMessage(harness, 'reaction-other-conversation', {
        conversationId: 'other-conversation',
      })
    );
    await assert.rejects(
      harness.service.sendReaction({
        destination: THEIR_ACI,
        emoji: '👍',
        messageId: 'reaction-other-conversation',
      }),
      { code: 'invalid-request' }
    );

    await storeMessage(
      harness,
      incomingMessage(harness, 'reaction-invalid-author', {
        sourceServiceId: undefined,
      })
    );
    await assert.rejects(
      harness.service.sendReaction({
        destination: THEIR_ACI,
        emoji: '👍',
        messageId: 'reaction-invalid-author',
      }),
      { code: 'invalid-request' }
    );
    assert.equal(harness.calls.send, 0);
  } finally {
    await harness.cleanup();
  }
}

async function testReactionReplacementOnOutgoingMessage(): Promise<void> {
  const harness = await createHarness();
  try {
    const target = await harness.service.sendText({
      body: 'our reaction target',
      destination: THEIR_ACI,
    });
    await harness.service.sendReaction({
      destination: THEIR_ACI,
      emoji: '👍',
      messageId: target.messageId,
    });
    await harness.service.sendReaction({
      destination: THEIR_ACI,
      emoji: '❤️',
      messageId: target.messageId,
    });
    const persisted = await harness.dataReader.getMessageById(target.messageId);
    assert.deepEqual(
      persisted?.reactions?.map(reaction => reaction.emoji),
      ['❤️']
    );
    for (const index of [1, 2]) {
      const reaction = decodeContent(
        harness.plaintexts[index] ?? new Uint8Array()
      ).content?.dataMessage?.reaction;
      assert.equal(reaction?.targetAuthorAci, OUR_ACI);
      assert.equal(reaction?.targetSentTimestamp, BigInt(target.timestamp));
    }
  } finally {
    await harness.cleanup();
  }
}

async function testReactionDeviceRepairAndFailures(): Promise<void> {
  const repairHarness = await createHarness();
  try {
    await storeMessage(
      repairHarness,
      incomingMessage(repairHarness, 'reaction-device-repair')
    );
    repairHarness.setNextSendError(
      new LibSignalErrorBase(
        'reaction device list changed',
        'MismatchedDevices',
        'test',
        {
          entries: [
            new MismatchedDevicesEntry({
              account: Aci.fromUuid(THEIR_ACI),
              extraDevices: [3],
              missingDevices: [2],
              staleDevices: [4],
            }),
          ],
        }
      )
    );
    await repairHarness.service.sendReaction({
      destination: THEIR_ACI,
      emoji: '👍',
      messageId: 'reaction-device-repair',
    });
    assert.equal(repairHarness.calls.repair, 1);
    assert.equal(repairHarness.calls.send, 2);
  } finally {
    await repairHarness.cleanup();
  }

  const transportHarness = await createHarness();
  try {
    await storeMessage(
      transportHarness,
      incomingMessage(transportHarness, 'reaction-transport-failure')
    );
    transportHarness.setSendError(
      new HeadlessSendError('identity changed', 'identity', false)
    );
    await assert.rejects(
      transportHarness.service.sendReaction({
        destination: THEIR_ACI,
        emoji: '👍',
        messageId: 'reaction-transport-failure',
      }),
      { code: 'identity', retryable: false }
    );
    const persisted = await transportHarness.dataReader.getMessageById(
      'reaction-transport-failure'
    );
    assert.equal(persisted?.reactions, undefined);
  } finally {
    await transportHarness.cleanup();
  }

  const persistenceHarness = await createHarness();
  try {
    await storeMessage(
      persistenceHarness,
      incomingMessage(persistenceHarness, 'reaction-persistence-failure')
    );
    persistenceHarness.setNextSaveError(new Error('simulated save failure'));
    await assert.rejects(
      persistenceHarness.service.sendReaction({
        destination: THEIR_ACI,
        emoji: '👍',
        messageId: 'reaction-persistence-failure',
      }),
      { code: 'send-failed', retryable: false }
    );
    assert.equal(persistenceHarness.calls.send, 1);
    const persisted = await persistenceHarness.dataReader.getMessageById(
      'reaction-persistence-failure'
    );
    assert.equal(persisted?.reactions, undefined);
  } finally {
    await persistenceHarness.cleanup();
  }
}

async function testMixedQueueOrderingAndSaturation(): Promise<void> {
  const harness = await createHarness();
  try {
    await storeMessage(
      harness,
      incomingMessage(harness, 'queued-reaction-target')
    );
    const entered = harness.pauseNextSend();
    const text = harness.service.sendText({
      body: 'first queued send',
      destination: THEIR_ACI,
    });
    await entered;
    const reaction = harness.service.sendReaction({
      destination: THEIR_ACI,
      emoji: '👍',
      messageId: 'queued-reaction-target',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(harness.calls.send, 1);
    assert.throws(
      () =>
        harness.service.sendText({
          body: 'queue overflow',
          destination: THEIR_ACI,
        }),
      { code: 'rate-limited', retryable: true }
    );
    harness.releaseSend();
    await Promise.all([text, reaction]);
    assert.equal(harness.calls.send, 2);
    assert.equal(
      decodeContent(harness.plaintexts[1] ?? new Uint8Array()).content
        ?.dataMessage?.reaction?.emoji,
      '👍'
    );
  } finally {
    harness.releaseSend();
    await harness.cleanup();
  }
}

async function testMarkdownFormatting(): Promise<void> {
  const harness = await createHarness();
  try {
    const result = await harness.service.sendText({
      body: '**bold** and ||secret||',
      destination: THEIR_ACI,
      parseMode: 'Markdown',
    });
    const persisted = await harness.dataReader.getMessageById(result.messageId);
    assert.equal(persisted?.body, 'bold and secret');
    assert.deepEqual(persisted?.bodyRanges, [
      { length: 4, start: 0, style: Proto.BodyRange.Style.BOLD },
      { length: 6, start: 9, style: Proto.BodyRange.Style.SPOILER },
    ]);
    const dataMessage = decodeContent(harness.plaintexts[0] ?? new Uint8Array())
      .content?.dataMessage;
    assert.equal(dataMessage?.body, 'bold and secret');
    assert.deepEqual(
      dataMessage?.bodyRanges.map(range => ({
        length: range.length,
        start: range.start,
        style: range.associatedValue?.style,
      })),
      [
        { length: 4, start: 0, style: Proto.BodyRange.Style.BOLD },
        { length: 6, start: 9, style: Proto.BodyRange.Style.SPOILER },
      ]
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
    };
    await assert.rejects(harness.service.sendText(request), {
      code: 'not-connected',
      retryable: true,
    });
    const [failed] =
      await harness.dataReader.getMessagesBySentAt(1_700_000_000_000);
    assert.equal(
      failed?.sendStateByConversationId?.[harness.recipient.id]?.status,
      SendStatus.Failed
    );
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
    harness.setNextSendError(
      new LibSignalErrorBase(
        'device list changed',
        'MismatchedDevices',
        'test',
        {
          entries: [
            new MismatchedDevicesEntry({
              account: Aci.fromUuid(THEIR_ACI),
              extraDevices: [3],
              missingDevices: [2],
              staleDevices: [4],
            }),
          ],
        }
      )
    );
    const request = {
      body: 'recover me',
      destination: THEIR_ACI,
    };
    await harness.service.sendText(request);
    assert.equal(harness.calls.fetch, 2);
    assert.equal(harness.calls.establish, 1);
    assert.equal(harness.calls.repair, 1);
    assert.equal(harness.calls.send, 2);
    assert.deepEqual(harness.repairs[0]?.extraDevices, [3]);
    assert.deepEqual(harness.repairs[0]?.staleDevices, [4]);
  } finally {
    await harness.cleanup();
  }
}

async function testDeviceMismatchRetryIsBounded(): Promise<void> {
  const harness = await createHarness();
  try {
    const mismatch = new LibSignalErrorBase(
      'device list changed again',
      'MismatchedDevices',
      'test',
      {
        entries: [
          new MismatchedDevicesEntry({
            account: Aci.fromUuid(THEIR_ACI),
            missingDevices: [2],
          }),
        ],
      }
    );
    harness.setNextSendError(mismatch);
    harness.setSendError(mismatch);
    await assert.rejects(
      harness.service.sendText({
        body: 'bounded repair',
        destination: THEIR_ACI,
      }),
      { code: 'device-mismatch', retryable: true }
    );
    assert.equal(harness.calls.repair, 1);
    assert.equal(harness.calls.send, 2);
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
  await testConcurrentSendsAreSerialized();
  await testRepeatedRequestsCreateDistinctDurableSends();
  await testE164Resolution();
  await testQuotedReply();
  await testQuotedReplyValidation();
  await testQuotesOutgoingMessageWithOurAci();
  await testReaction();
  await testWebhookReadReceiptAndSync();
  await testWebhookReadReceiptSetting();
  await testWebhookReadReceiptRequiresAcceptedConversation();
  await testReactionValidation();
  await testReactionReplacementOnOutgoingMessage();
  await testReactionDeviceRepairAndFailures();
  await testMixedQueueOrderingAndSaturation();
  await testMarkdownFormatting();
  await testRetryableFailure();
  await testDeviceMismatchRecovery();
  await testDeviceMismatchRetryIsBounded();
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
