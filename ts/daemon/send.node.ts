// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable eslint/max-classes-per-file -- colocated public service error

import {
  ErrorCode,
  type IdentityKeyStore,
  KEMPublicKey,
  LibSignalErrorBase,
  PreKeyBundle,
  ProtocolAddress,
  PublicKey,
  type SessionRecord,
  type SessionStore,
  processPreKeyBundle,
  signalEncrypt,
} from '@signalapp/libsignal-client';
import { v4 as uuidV4 } from 'uuid';
import { z } from 'zod';

import { Emoji } from '../axo/emoji.std.ts';
import { Sessions, IdentityKeys } from '../LibSignalStores.node.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import { SendStatus } from '../messages/MessageSendState.std.ts';
import { SignalService as Proto } from '../protobuf/index.std.ts';
import { Address } from '../types/Address.std.ts';
import { QualifiedAddress } from '../types/QualifiedAddress.std.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import { isAciString } from '../util/isAciString.std.ts';
import type { HeadlessProtocolStores } from './protocol_stores.node.ts';
import { parseMarkdownBody } from './markdown.std.ts';
import type {
  HeadlessOutboundMessage,
  HeadlessSendTransport,
} from './transport.node.ts';

const PADDING_BLOCK = 80;
const DEFAULT_REQUIRE_PQ_RATIO = 0;

const serverKeysSchema = z.object({
  devices: z.array(
    z.object({
      deviceId: z.number().int().positive(),
      registrationId: z.number().int().nonnegative(),
      preKey: z
        .object({ keyId: z.number().int(), publicKey: z.string() })
        .nullish(),
      signedPreKey: z.object({
        keyId: z.number().int(),
        publicKey: z.string(),
        signature: z.string(),
      }),
      pqPreKey: z.object({
        keyId: z.number().int(),
        publicKey: z.string(),
        signature: z.string(),
      }),
    })
  ),
  identityKey: z.string(),
});

export type HeadlessServerKeys = z.infer<typeof serverKeysSchema>;

export type HeadlessSendCrypto = Readonly<{
  establishSessions: (
    options: Readonly<{
      destination: AciString;
      keys: HeadlessServerKeys;
    }>
  ) => Promise<void>;
  encrypt: (
    options: Readonly<{
      destination: AciString;
      plaintext: Uint8Array<ArrayBuffer>;
    }>
  ) => Promise<ReadonlyArray<HeadlessOutboundMessage>>;
  hasSessions: (destination: AciString) => Promise<boolean>;
  repairSessions: (
    options: Readonly<{
      destination: AciString;
      extraDevices: ReadonlyArray<number>;
      keys: HeadlessServerKeys;
      staleDevices: ReadonlyArray<number>;
    }>
  ) => Promise<void>;
}>;

export function hasCurrentSendSession(record: SessionRecord | null): boolean {
  return record?.hasCurrentState(DEFAULT_REQUIRE_PQ_RATIO) ?? false;
}

export type SendTextRequest = Readonly<{
  attachments?: ReadonlyArray<unknown>;
  body: string;
  destination: string;
  groupId?: string;
  parseMode?: 'Markdown';
  quoteMessageId?: string;
  story?: boolean;
}>;

export type SendTextResult = Readonly<{
  destination: AciString;
  messageId: string;
  status: 'sent';
  timestamp: number;
}>;

export type SendReactionRequest = Readonly<{
  destination: string;
  emoji: string;
  messageId: string;
}>;

export type SendReactionResult = Readonly<{
  destination: AciString;
  emoji: Emoji.Variant;
  messageId: string;
  status: 'sent';
  timestamp: number;
}>;

export class HeadlessSendError extends Error {
  public readonly code:
    | 'invalid-request'
    | 'not-connected'
    | 'recipient-not-found'
    | 'identity'
    | 'rate-limited'
    | 'network'
    | 'device-mismatch'
    | 'unsupported'
    | 'send-failed';

  public readonly retryable: boolean;

  public constructor(
    message: string,
    code: HeadlessSendError['code'],
    retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'HeadlessSendError';
    this.code = code;
    this.retryable = retryable;
  }
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

function padMessage(message: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const targetLength =
    Math.ceil((message.byteLength + 1) / PADDING_BLOCK) * PADDING_BLOCK;
  const result = new Uint8Array(targetLength);
  result.set(message);
  result[message.byteLength] = 0x80;
  return result;
}

function createLibsignalSendCrypto(
  stores: HeadlessProtocolStores
): HeadlessSendCrypto {
  const ourAci = stores.itemStorage.user.getCheckedAci();
  const ourDeviceId = stores.itemStorage.user.getCheckedDeviceId();
  const sessions: SessionStore = new Sessions({
    ourServiceId: ourAci,
    signalProtocolStore: stores.signalProtocolStore,
  });
  const identities: IdentityKeyStore = new IdentityKeys({
    ourServiceId: ourAci,
    signalProtocolStore: stores.signalProtocolStore,
  });
  const localAddress = ProtocolAddress.new(ourAci, ourDeviceId);

  return {
    async establishSessions({ destination, keys }) {
      const identityKey = PublicKey.deserialize(fromBase64(keys.identityKey));
      await Promise.all(
        keys.devices.map(async device => {
          const remoteAddress = ProtocolAddress.new(
            destination,
            device.deviceId
          );
          if (hasCurrentSendSession(await sessions.getSession(remoteAddress))) {
            // Never replace an active ratchet with a newly fetched pre-key.
            return;
          }
          const preKey = device.preKey;
          const signed = device.signedPreKey;
          const pq = device.pqPreKey;
          const bundle = PreKeyBundle.new(
            device.registrationId,
            device.deviceId,
            preKey?.keyId ?? null,
            preKey ? PublicKey.deserialize(fromBase64(preKey.publicKey)) : null,
            signed.keyId,
            PublicKey.deserialize(fromBase64(signed.publicKey)),
            fromBase64(signed.signature),
            identityKey,
            pq.keyId,
            KEMPublicKey.deserialize(fromBase64(pq.publicKey)),
            fromBase64(pq.signature)
          );
          const qualifiedAddress = new QualifiedAddress(
            ourAci,
            new Address(destination, device.deviceId)
          );
          await stores.signalProtocolStore.enqueueSessionJob(
            qualifiedAddress,
            () =>
              processPreKeyBundle(
                bundle,
                remoteAddress,
                localAddress,
                sessions,
                identities
              )
          );
        })
      );
    },
    async encrypt({ destination, plaintext }) {
      const deviceIds = await stores.signalProtocolStore.getDeviceIds({
        ourServiceId: ourAci,
        serviceId: destination,
      });
      return Promise.all(
        deviceIds.map(async deviceId => {
          const remoteAddress = ProtocolAddress.new(destination, deviceId);
          const qualifiedAddress = new QualifiedAddress(
            ourAci,
            new Address(destination, deviceId)
          );
          return stores.signalProtocolStore.enqueueSessionJob(
            qualifiedAddress,
            async () => {
              const session = await sessions.getSession(remoteAddress);
              if (!session) {
                throw new Error(
                  `No Signal session for ${destination}.${deviceId}`
                );
              }
              return {
                contents: await signalEncrypt(
                  plaintext,
                  remoteAddress,
                  localAddress,
                  sessions,
                  identities
                ),
                deviceId,
                registrationId: session.remoteRegistrationId(),
              };
            }
          );
        })
      );
    },
    async hasSessions(destination) {
      const deviceIds = await stores.signalProtocolStore.getDeviceIds({
        ourServiceId: ourAci,
        serviceId: destination,
      });
      if (deviceIds.length === 0) {
        return false;
      }
      const existing = await Promise.all(
        deviceIds.map(deviceId =>
          sessions.getSession(ProtocolAddress.new(destination, deviceId))
        )
      );
      return existing.every(hasCurrentSendSession);
    },
    async repairSessions({ destination, extraDevices, keys, staleDevices }) {
      const extra = new Set(extraDevices);
      const stale = new Set(staleDevices);
      await Promise.all(
        [...extra, ...stale].map(deviceId =>
          stores.signalProtocolStore.archiveSession(
            new QualifiedAddress(ourAci, Address.create(destination, deviceId))
          )
        )
      );
      await Promise.all(
        keys.devices.map(async device => {
          if (extra.has(device.deviceId) || stale.has(device.deviceId)) return;
          const session = await sessions.getSession(
            ProtocolAddress.new(destination, device.deviceId)
          );
          if (
            hasCurrentSendSession(session) &&
            session?.remoteRegistrationId() !== device.registrationId
          ) {
            await stores.signalProtocolStore.archiveSession(
              new QualifiedAddress(
                ourAci,
                Address.create(destination, device.deviceId)
              )
            );
          }
        })
      );
      await this.establishSessions({
        destination,
        keys: {
          ...keys,
          devices: keys.devices.filter(device => !extra.has(device.deviceId)),
        },
      });
    },
  };
}

function classifySendError(error: unknown): HeadlessSendError {
  if (error instanceof HeadlessSendError) return error;
  if (
    error instanceof Error &&
    /transport is not connected|does not support sending/i.test(error.message)
  ) {
    return new HeadlessSendError(error.message, 'not-connected', true, {
      cause: error,
    });
  }
  if (LibSignalErrorBase.is(error, ErrorCode.UntrustedIdentity)) {
    return new HeadlessSendError(error.message, 'identity', false, {
      cause: error,
    });
  }
  if (LibSignalErrorBase.is(error, ErrorCode.ServiceIdNotFound)) {
    return new HeadlessSendError(error.message, 'recipient-not-found', false, {
      cause: error,
    });
  }
  if (LibSignalErrorBase.is(error, ErrorCode.RateLimitedError)) {
    return new HeadlessSendError(error.message, 'rate-limited', true, {
      cause: error,
    });
  }
  if (LibSignalErrorBase.is(error, ErrorCode.MismatchedDevices)) {
    return new HeadlessSendError(error.message, 'device-mismatch', true, {
      cause: error,
    });
  }
  if (
    LibSignalErrorBase.is(error, ErrorCode.IoError) ||
    LibSignalErrorBase.is(error, ErrorCode.ChatServiceInactive) ||
    LibSignalErrorBase.is(error, ErrorCode.Cancelled)
  ) {
    return new HeadlessSendError(
      error.message,
      error.code === ErrorCode.ChatServiceInactive
        ? 'not-connected'
        : 'network',
      true,
      { cause: error }
    );
  }
  return new HeadlessSendError(
    error instanceof Error ? error.message : String(error),
    'send-failed',
    false,
    { cause: error }
  );
}

export class HeadlessSendService {
  readonly #destinationQueues = new Map<string, Promise<unknown>>();
  readonly #transport: HeadlessSendTransport;
  readonly #stores: HeadlessProtocolStores;
  readonly #crypto: HeadlessSendCrypto;
  readonly #options: Readonly<{ maxPending?: number; now?: () => number }>;
  #pending = 0;

  public constructor(
    transport: HeadlessSendTransport,
    stores: HeadlessProtocolStores,
    crypto: HeadlessSendCrypto = createLibsignalSendCrypto(stores),
    options: Readonly<{ maxPending?: number; now?: () => number }> = {}
  ) {
    this.#transport = transport;
    this.#stores = stores;
    this.#crypto = crypto;
    this.#options = options;
  }

  public sendText(
    request: SendTextRequest,
    signal?: AbortSignal
  ): Promise<SendTextResult> {
    this.#validate(request);
    const messageId = uuidV4();
    return this.#enqueue(request.destination, () =>
      this.#send(request, messageId, signal)
    );
  }

  public sendReaction(
    request: SendReactionRequest,
    signal?: AbortSignal
  ): Promise<SendReactionResult> {
    if (!request.messageId) {
      throw new HeadlessSendError(
        'messageId is required',
        'invalid-request',
        false
      );
    }
    if (!Emoji.isEmoji(request.emoji)) {
      throw new HeadlessSendError(
        'emoji must be one supported emoji',
        'invalid-request',
        false
      );
    }
    return this.#enqueue(request.destination, () =>
      this.#sendReaction(
        { ...request, emoji: request.emoji as Emoji.Variant },
        signal
      )
    );
  }

  #enqueue<Result>(
    destination: string,
    send: () => Promise<Result>
  ): Promise<Result> {
    const maxPending = this.#options.maxPending ?? 100;
    if (this.#pending >= maxPending) {
      throw new HeadlessSendError(
        'Outgoing send queue is full',
        'rate-limited',
        true
      );
    }
    this.#pending += 1;
    const previousDestination =
      this.#destinationQueues.get(destination) ?? Promise.resolve();
    const operation = (async () => {
      await Promise.allSettled([previousDestination]);
      return send();
    })();
    this.#destinationQueues.set(destination, operation);
    return this.#completeQueued(operation, destination);
  }

  async #completeQueued<Result>(
    operation: Promise<Result>,
    destination: string
  ): Promise<Result> {
    try {
      return await operation;
    } finally {
      this.#pending -= 1;
      if (this.#destinationQueues.get(destination) === operation) {
        this.#destinationQueues.delete(destination);
      }
    }
  }

  async #sendReaction(
    request: SendReactionRequest & { emoji: Emoji.Variant },
    signal?: AbortSignal
  ): Promise<SendReactionResult> {
    if (!this.#transport.connected) {
      throw new HeadlessSendError(
        'Signal transport is not connected',
        'not-connected',
        true
      );
    }
    const destination = this.#resolveDestination(request.destination);
    const conversation = this.#stores.conversationController.lookupOrCreate({
      reason: 'HeadlessSendService.reaction',
      serviceId: destination,
    });
    if (!conversation) {
      throw new HeadlessSendError(
        'Could not create recipient',
        'send-failed',
        false
      );
    }
    await conversation.initialPromise;
    const target = await this.#stores.messageCache.getOrLoadById(
      request.messageId
    );
    if (!target || target.get('conversationId') !== conversation.id) {
      throw new HeadlessSendError(
        'Reaction target was not found in the destination conversation',
        'invalid-request',
        false
      );
    }
    const targetAuthorAci =
      target.get('type') === 'outgoing'
        ? this.#stores.itemStorage.user.getCheckedAci()
        : target.get('sourceServiceId');
    if (!targetAuthorAci || !isAciString(targetAuthorAci)) {
      throw new HeadlessSendError(
        'Reaction target has no Signal author',
        'invalid-request',
        false
      );
    }
    const timestamp = (this.#options.now ?? Date.now)();
    try {
      if (!(await this.#crypto.hasSessions(destination))) {
        const keys = await this.#fetchKeys(destination, signal);
        await this.#crypto.establishSessions({ destination, keys });
      }
      const content = Proto.Content.encode({
        content: {
          dataMessage: {
            reaction: {
              emoji: request.emoji,
              remove: false,
              targetAuthorAci,
              targetSentTimestamp: BigInt(target.get('sent_at')),
            },
            timestamp: BigInt(timestamp),
          } as unknown as Proto.DataMessage.Params,
        },
        pniSignatureMessage: null,
        senderKeyDistributionMessage: null,
      });
      await this.#transmitWithDeviceRepair(
        destination,
        padMessage(content),
        timestamp,
        signal
      );
      const ourConversationId =
        this.#stores.conversationController.getOurConversationIdOrThrow();
      target.set({
        reactions: [
          ...(target.get('reactions') ?? []).filter(
            reaction => reaction.fromId !== ourConversationId
          ),
          {
            emoji: request.emoji,
            fromId: ourConversationId,
            isSentByConversationId: { [conversation.id]: true },
            targetTimestamp: target.get('sent_at'),
            timestamp,
          },
        ],
      });
      await this.#stores.messageCache.saveMessage(target);
      return {
        destination,
        emoji: request.emoji,
        messageId: request.messageId,
        status: 'sent',
        timestamp,
      };
    } catch (error) {
      throw classifySendError(error);
    }
  }

  #validate(request: SendTextRequest): void {
    if (
      request.groupId ||
      request.story ||
      (request.attachments?.length ?? 0) > 0
    ) {
      throw new HeadlessSendError(
        'Groups, attachments, and stories are not supported by headless send',
        'unsupported',
        false
      );
    }
    if (!request.body) {
      throw new HeadlessSendError('body is required', 'invalid-request', false);
    }
  }

  #resolveDestination(value: string): AciString {
    if (isAciString(value)) return value;
    const conversation = this.#stores.conversationController.get(value);
    const serviceId = conversation?.get('serviceId');
    if (serviceId && isAciString(serviceId)) return serviceId;
    throw new HeadlessSendError(
      'Destination must be an ACI or an E164 already resolved in the restored profile',
      'recipient-not-found',
      false
    );
  }

  async #fetchKeys(
    destination: AciString,
    signal?: AbortSignal
  ): Promise<HeadlessServerKeys> {
    const response = await this.#transport.fetchAuthenticated(
      {
        headers: [['Accept', 'application/json']],
        path: `/v2/keys/${destination}/*`,
        verb: 'GET',
      },
      { abortSignal: signal }
    );
    if (response.status === 404) {
      throw new HeadlessSendError(
        'Signal recipient is not registered',
        'recipient-not-found',
        false
      );
    }
    if (response.status < 200 || response.status >= 300 || !response.body) {
      throw new HeadlessSendError(
        `Signal pre-key request failed with status ${response.status}`,
        response.status === 429 ? 'rate-limited' : 'network',
        response.status === 429 || response.status >= 500
      );
    }
    return serverKeysSchema.parse(
      JSON.parse(Buffer.from(response.body).toString('utf8'))
    );
  }

  async #transmit(
    destination: AciString,
    plaintext: Uint8Array<ArrayBuffer>,
    timestamp: number,
    signal?: AbortSignal
  ): Promise<void> {
    const messages = await this.#crypto.encrypt({ destination, plaintext });
    if (messages.length === 0)
      throw new Error('Signal recipient has no devices');
    await this.#transport.sendMessage({
      destination,
      messages,
      signal,
      timestamp,
      urgent: true,
    });
  }

  async #transmitWithDeviceRepair(
    destination: AciString,
    plaintext: Uint8Array<ArrayBuffer>,
    timestamp: number,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await this.#transmit(destination, plaintext, timestamp, signal);
      return;
    } catch (error) {
      if (!LibSignalErrorBase.is(error, ErrorCode.MismatchedDevices)) {
        throw error;
      }
      const entry = error.entries.find(
        candidate => candidate.account.getServiceIdString() === destination
      );
      if (!entry) throw error;
      const keys = await this.#fetchKeys(destination, signal);
      await this.#crypto.repairSessions({
        destination,
        extraDevices: entry.extraDevices,
        keys,
        staleDevices: entry.staleDevices,
      });
      await this.#transmit(destination, plaintext, timestamp, signal);
    }
  }

  async #send(
    request: SendTextRequest,
    messageId: string,
    signal?: AbortSignal
  ): Promise<SendTextResult> {
    if (!this.#transport.connected) {
      throw new HeadlessSendError(
        'Signal transport is not connected',
        'not-connected',
        true
      );
    }
    const destination = this.#resolveDestination(request.destination);
    const conversation = this.#stores.conversationController.lookupOrCreate({
      reason: 'HeadlessSendService',
      serviceId: destination,
    });
    if (!conversation)
      throw new HeadlessSendError(
        'Could not create recipient',
        'send-failed',
        false
      );
    await conversation.initialPromise;

    const timestamp = (this.#options.now ?? Date.now)();
    const formatted =
      request.parseMode === 'Markdown'
        ? parseMarkdownBody(request.body)
        : { body: request.body, bodyRanges: [] };
    let quote: MessageAttributesType['quote'];
    if (request.quoteMessageId) {
      const quotedMessage = await this.#stores.messageCache.getOrLoadById(
        request.quoteMessageId
      );
      if (!quotedMessage) {
        throw new HeadlessSendError(
          'Quoted message was not found',
          'invalid-request',
          false
        );
      }
      if (quotedMessage.get('conversationId') !== conversation.id) {
        throw new HeadlessSendError(
          'Quoted message belongs to a different conversation',
          'invalid-request',
          false
        );
      }
      const authorAci =
        quotedMessage.get('type') === 'outgoing'
          ? this.#stores.itemStorage.user.getCheckedAci()
          : quotedMessage.get('sourceServiceId');
      if (!authorAci || !isAciString(authorAci)) {
        throw new HeadlessSendError(
          'Quoted message has no Signal author',
          'invalid-request',
          false
        );
      }
      quote = {
        attachments: [],
        authorAci,
        id: quotedMessage.get('sent_at'),
        isViewOnce: false,
        messageId: quotedMessage.id,
        referencedMessageNotFound: false,
        text: quotedMessage.get('body') ?? '',
      };
    }
    const attributes: MessageAttributesType = {
      body: formatted.body,
      ...(formatted.bodyRanges.length > 0
        ? { bodyRanges: formatted.bodyRanges }
        : {}),
      conversationId: conversation.id,
      id: messageId,
      received_at: timestamp,
      received_at_ms: timestamp,
      ...(formatted.bodyRanges.length > 0
        ? {
            requiredProtocolVersion: Proto.DataMessage.ProtocolVersion.MENTIONS,
          }
        : {}),
      ...(quote ? { quote } : {}),
      sendStateByConversationId: {
        [conversation.id]: {
          status: SendStatus.Pending,
          updatedAt: timestamp,
        },
      },
      sent_at: timestamp,
      timestamp,
      type: 'outgoing',
    };
    const candidate = this.#stores.messageCache.create(attributes);
    const model = this.#stores.messageCache.register(candidate);
    if (model !== candidate) {
      throw new HeadlessSendError(
        'Could not allocate a unique outgoing message ID',
        'send-failed',
        false
      );
    }
    await this.#stores.messageCache.saveMessage(model, { forceSave: true });

    try {
      if (!(await this.#crypto.hasSessions(destination))) {
        const keys = await this.#fetchKeys(destination, signal);
        await this.#crypto.establishSessions({ destination, keys });
      }
      const dataMessage = {
        body: formatted.body,
        bodyRanges: formatted.bodyRanges.map(range => ({
          associatedValue: { style: range.style },
          length: range.length,
          start: range.start,
        })),
        requiredProtocolVersion:
          formatted.bodyRanges.length > 0
            ? Proto.DataMessage.ProtocolVersion.MENTIONS
            : 0,
        ...(quote
          ? {
              quote: {
                attachments: [],
                authorAci: quote.authorAci,
                bodyRanges: [],
                id: BigInt(quote.id ?? 0),
                text: quote.text ?? '',
                type: Proto.DataMessage.Quote.Type.NORMAL,
              },
            }
          : {}),
        timestamp: BigInt(timestamp),
      } as unknown as Proto.DataMessage.Params;
      const content = Proto.Content.encode({
        content: { dataMessage },
        pniSignatureMessage: null,
        senderKeyDistributionMessage: null,
      });
      await this.#transmitWithDeviceRepair(
        destination,
        padMessage(content),
        timestamp,
        signal
      );
      model.set({
        sendStateByConversationId: {
          [conversation.id]: { status: SendStatus.Sent, updatedAt: Date.now() },
        },
      });
      await this.#stores.messageCache.saveMessage(model);
      return {
        destination,
        messageId,
        status: 'sent',
        timestamp,
      };
    } catch (error) {
      const classified = classifySendError(error);
      model.set({
        sendStateByConversationId: {
          [conversation.id]: {
            status: SendStatus.Failed,
            updatedAt: Date.now(),
          },
        },
      });
      await this.#stores.messageCache.saveMessage(model);
      throw classified;
    }
  }
}
