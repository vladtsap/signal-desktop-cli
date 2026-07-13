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
import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';

import { Sessions, IdentityKeys } from '../LibSignalStores.node.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import { SendStatus } from '../messages/MessageSendState.std.ts';
import { SignalService as Proto } from '../protobuf/index.std.ts';
import { Address } from '../types/Address.std.ts';
import { QualifiedAddress } from '../types/QualifiedAddress.std.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import { isAciString } from '../util/isAciString.std.ts';
import type { HeadlessProtocolStores } from './protocol_stores.node.ts';
import type {
  HeadlessOutboundMessage,
  HeadlessSendTransport,
} from './transport.node.ts';

const MESSAGE_ID_NAMESPACE = 'b6028cf2-4d9b-55ad-8a55-48c36f34704c';
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
}>;

export function hasCurrentSendSession(record: SessionRecord | null): boolean {
  return record?.hasCurrentState(DEFAULT_REQUIRE_PQ_RATIO) ?? false;
}

export type SendTextRequest = Readonly<{
  attachments?: ReadonlyArray<unknown>;
  body: string;
  destination: string;
  groupId?: string;
  idempotencyKey: string;
  story?: boolean;
}>;

export type SendTextResult = Readonly<{
  destination: AciString;
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

export function createLibsignalSendCrypto(
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
      return existing.every(session => session != null);
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
  readonly #idempotencyQueues = new Map<string, Promise<unknown>>();
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
    const maxPending = this.#options.maxPending ?? 100;
    if (this.#pending >= maxPending) {
      throw new HeadlessSendError(
        'Outgoing send queue is full',
        'rate-limited',
        true
      );
    }
    this.#pending += 1;
    const messageId = uuidV5(request.idempotencyKey, MESSAGE_ID_NAMESPACE);
    const previousIdempotency =
      this.#idempotencyQueues.get(messageId) ?? Promise.resolve();
    const previousDestination =
      this.#destinationQueues.get(request.destination) ?? Promise.resolve();
    const operation = this.#runQueued(
      previousIdempotency,
      previousDestination,
      request,
      signal
    );
    this.#idempotencyQueues.set(messageId, operation);
    this.#destinationQueues.set(request.destination, operation);
    return this.#completeQueued(operation, messageId, request.destination);
  }

  async #runQueued(
    previousIdempotency: Promise<unknown>,
    previousDestination: Promise<unknown>,
    request: SendTextRequest,
    signal?: AbortSignal
  ): Promise<SendTextResult> {
    await Promise.allSettled([previousIdempotency, previousDestination]);
    return this.#send(request, signal);
  }

  async #completeQueued(
    operation: Promise<SendTextResult>,
    messageId: string,
    destination: string
  ): Promise<SendTextResult> {
    try {
      return await operation;
    } finally {
      this.#pending -= 1;
      if (this.#idempotencyQueues.get(messageId) === operation) {
        this.#idempotencyQueues.delete(messageId);
      }
      if (this.#destinationQueues.get(destination) === operation) {
        this.#destinationQueues.delete(destination);
      }
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
    if (!request.body || !request.idempotencyKey) {
      throw new HeadlessSendError(
        'body and idempotencyKey are required',
        'invalid-request',
        false
      );
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

  async #send(
    request: SendTextRequest,
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

    const messageId = uuidV5(request.idempotencyKey, MESSAGE_ID_NAMESPACE);
    let model = await this.#stores.messageCache.getOrLoadById(messageId);
    if (model) {
      if (
        model.get('body') !== request.body ||
        model.get('conversationId') !== conversation.id
      ) {
        throw new HeadlessSendError(
          'idempotencyKey was already used for another message',
          'invalid-request',
          false
        );
      }
      if (
        model.get('sendStateByConversationId')?.[conversation.id]?.status ===
        SendStatus.Sent
      ) {
        return {
          destination,
          messageId,
          status: 'sent',
          timestamp: model.get('timestamp'),
        };
      }
    }

    if (!model) {
      const timestamp = (this.#options.now ?? Date.now)();
      const attributes: MessageAttributesType = {
        body: request.body,
        conversationId: conversation.id,
        id: messageId,
        received_at: timestamp,
        received_at_ms: timestamp,
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
      model = this.#stores.messageCache.register(candidate);
      if (model !== candidate) {
        if (
          model.get('body') !== request.body ||
          model.get('conversationId') !== conversation.id
        ) {
          throw new HeadlessSendError(
            'idempotencyKey was already used for another message',
            'invalid-request',
            false
          );
        }
        if (
          model.get('sendStateByConversationId')?.[conversation.id]?.status ===
          SendStatus.Sent
        ) {
          return {
            destination,
            messageId,
            status: 'sent',
            timestamp: model.get('timestamp'),
          };
        }
      } else {
        await this.#stores.messageCache.saveMessage(model, { forceSave: true });
      }
    }
    const timestamp = model.get('timestamp');

    try {
      if (!(await this.#crypto.hasSessions(destination))) {
        const keys = await this.#fetchKeys(destination, signal);
        await this.#crypto.establishSessions({ destination, keys });
      }
      const dataMessage = {
        body: request.body,
        timestamp: BigInt(timestamp),
      } as Proto.DataMessage.Params;
      const content = Proto.Content.encode({
        content: { dataMessage },
        pniSignatureMessage: null,
        senderKeyDistributionMessage: null,
      });
      const messages = await this.#crypto.encrypt({
        destination,
        plaintext: padMessage(content),
      });
      if (messages.length === 0)
        throw new Error('Signal recipient has no devices');
      await this.#transport.sendMessage({
        destination,
        messages,
        signal,
        timestamp,
        urgent: true,
      });
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
      if (classified.code === 'device-mismatch') {
        await this.#stores.signalProtocolStore.archiveAllSessions(destination);
      }
      if (!classified.retryable) {
        model.set({
          sendStateByConversationId: {
            [conversation.id]: {
              status: SendStatus.Failed,
              updatedAt: Date.now(),
            },
          },
        });
        await this.#stores.messageCache.saveMessage(model);
      }
      throw classified;
    }
  }
}
