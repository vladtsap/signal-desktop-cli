// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable eslint/max-classes-per-file -- private typed receive error

import { createHash } from 'node:crypto';

import {
  CiphertextMessageType,
  PlaintextContent,
  PreKeySignalMessage,
  ProtocolAddress,
  PublicKey,
  sealedSenderDecryptToUsmc,
  signalDecrypt,
  signalDecryptPreKey,
  SignalMessage,
} from '@signalapp/libsignal-client';
import type { SenderCertificate } from '@signalapp/libsignal-client';
import {
  ReceivedTimestampMs,
  SentTimestampMs,
  ServerTimestampMs,
} from '@signalapp/types';

import * as Bytes from '../Bytes.std.ts';
import {
  IdentityKeys,
  KyberPreKeys,
  PreKeys,
  SenderKeys,
  Sessions,
  SignedPreKeys,
} from '../LibSignalStores.node.ts';
import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import { SeenStatus } from '../MessageSeenStatus.std.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import { SignalService as Proto } from '../protobuf/index.std.ts';
import type { UnprocessedType } from '../textsecure/Types.d.ts';
import { Address } from '../types/Address.std.ts';
import { QualifiedAddress } from '../types/QualifiedAddress.std.ts';
import type { ServiceIdString } from '../types/ServiceId.std.ts';
import { isPniString, normalizeServiceId } from '../types/ServiceId.std.ts';
import { strictAssert } from '../util/assert.std.ts';
import { fromServiceIdBinaryOrString } from '../util/ServiceId.node.ts';
import { bytesToUuid } from '../util/uuidToBytes.std.ts';
import { Zone } from '../util/Zone.std.ts';
import type { HeadlessProtocolStores } from './protocol_stores.node.ts';
import type { ProtocolRuntime } from './runtime.node.ts';
import type {
  HeadlessIncomingRequest,
  HeadlessTransportRuntime,
} from './transport.node.ts';

const DEFAULT_MAX_PENDING = 100;

type DecodedEnvelope = Readonly<{
  content: Uint8Array<ArrayBuffer>;
  destinationServiceId: ServiceIdString;
  id: string;
  receivedAtCounter: number;
  receivedAtDate: ReceivedTimestampMs;
  serverGuid: string;
  serverTimestamp: ServerTimestampMs;
  sourceDevice: number;
  sourceServiceId?: ServiceIdString;
  timestamp: SentTimestampMs;
  type: number;
}>;

type DecryptedEnvelope = Readonly<{
  envelope: DecodedEnvelope & { sourceServiceId: ServiceIdString };
  plaintext: Uint8Array<ArrayBuffer>;
  wasEncrypted: boolean;
}>;

export type HeadlessEnvelopeDecryptor = (
  envelope: DecodedEnvelope,
  stores: HeadlessProtocolStores,
  zone: Zone
) => Promise<DecryptedEnvelope>;

export type HeadlessReceiveOptions = Readonly<{
  decryptEnvelope?: HeadlessEnvelopeDecryptor;
  maxPendingRequests?: number;
  onPersistedMessage?: (message: MessageAttributesType) => Promise<void> | void;
  serverTrustRoots: ReadonlyArray<string>;
}>;

class UnsupportedIncomingContentError extends Error {}

function stableEnvelopeId(body: Uint8Array<ArrayBuffer>): string {
  return createHash('sha256').update(body).digest('hex');
}

function decodeEnvelope(
  body: Uint8Array<ArrayBuffer>,
  stores: HeadlessProtocolStores,
  receivedAtCounter: number
): DecodedEnvelope {
  const decoded = Proto.Envelope.decode(body);
  const ourAci = stores.itemStorage.user.getCheckedAci();
  const destinationServiceId =
    fromServiceIdBinaryOrString(
      decoded.destinationServiceIdBinary,
      decoded.destinationServiceId,
      'HeadlessMessageReceiver.destinationServiceId'
    ) ?? ourAci;
  const sourceServiceId = fromServiceIdBinaryOrString(
    decoded.sourceServiceIdBinary,
    decoded.sourceServiceId,
    'HeadlessMessageReceiver.sourceServiceId'
  );
  const id = stableEnvelopeId(body);
  return {
    content: decoded.content ?? new Uint8Array(0),
    destinationServiceId,
    id,
    receivedAtCounter,
    receivedAtDate: ReceivedTimestampMs.now(),
    serverGuid:
      (Bytes.isNotEmpty(decoded.serverGuidBinary)
        ? bytesToUuid(decoded.serverGuidBinary)
        : undefined) ??
      decoded.serverGuid ??
      id,
    serverTimestamp: ServerTimestampMs.fromBigInt(
      decoded.serverTimestamp ?? 0n
    ),
    sourceDevice: decoded.sourceDeviceId ?? 1,
    sourceServiceId,
    timestamp: SentTimestampMs.fromBigInt(decoded.clientTimestamp ?? 0n),
    type: decoded.type ?? Proto.Envelope.Type.UNKNOWN,
  };
}

function toUnprocessed(
  envelope: DecodedEnvelope,
  content: Uint8Array<ArrayBuffer>,
  isEncrypted: boolean,
  sourceServiceId = envelope.sourceServiceId,
  wasEncrypted = true
): UnprocessedType {
  return {
    attempts: 0,
    content,
    destinationServiceId: envelope.destinationServiceId,
    id: envelope.id,
    isEncrypted,
    messageAgeSec: 0,
    receivedAtCounter: envelope.receivedAtCounter,
    receivedAtDate: envelope.receivedAtDate,
    reportingToken: undefined,
    serverGuid: envelope.serverGuid,
    serverTimestamp: envelope.serverTimestamp,
    sourceDevice: envelope.sourceDevice,
    source: undefined,
    sourceServiceId,
    story: false,
    timestamp: envelope.timestamp,
    type: wasEncrypted ? envelope.type : Proto.Envelope.Type.PLAINTEXT_CONTENT,
    updatedPni: undefined,
    urgent: true,
    groupId: undefined,
  };
}

function fromUnprocessed(item: UnprocessedType): DecodedEnvelope {
  strictAssert(item.content, 'Staged envelope has no content');
  strictAssert(item.destinationServiceId, 'Staged envelope has no destination');
  return {
    content: item.content,
    destinationServiceId: normalizeServiceId(
      item.destinationServiceId,
      'HeadlessMessageReceiver.cachedDestination'
    ),
    id: item.id,
    receivedAtCounter: item.receivedAtCounter,
    receivedAtDate: item.receivedAtDate,
    serverGuid: item.serverGuid ?? item.id,
    serverTimestamp: item.serverTimestamp ?? 0,
    sourceDevice: item.sourceDevice ?? 1,
    sourceServiceId: item.sourceServiceId
      ? normalizeServiceId(
          item.sourceServiceId,
          'HeadlessMessageReceiver.cachedSource'
        )
      : undefined,
    timestamp: item.timestamp,
    type: item.type ?? Proto.Envelope.Type.UNKNOWN,
  };
}

function unpad(padded: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  for (let index = padded.length - 1; index >= 0; index -= 1) {
    if (padded[index] === 0x80) return padded.slice(0, index);
    if (padded[index] !== 0) throw new Error('Invalid Signal message padding');
  }
  return padded;
}

function createLockedStores(
  stores: HeadlessProtocolStores,
  ourServiceId: ServiceIdString,
  zone: Zone
) {
  const shared = {
    ourServiceId,
    signalProtocolStore: stores.signalProtocolStore,
    zone,
  };
  return {
    identityKeyStore: new IdentityKeys(shared),
    kyberPreKeyStore: new KyberPreKeys(shared),
    preKeyStore: new PreKeys(shared),
    senderKeyStore: new SenderKeys(shared),
    sessionStore: new Sessions(shared),
    signedPreKeyStore: new SignedPreKeys(shared),
  };
}

function getCiphertextKind(envelope: DecodedEnvelope): number | undefined {
  if (envelope.type === Proto.Envelope.Type.DOUBLE_RATCHET) {
    return CiphertextMessageType.Whisper;
  }
  if (envelope.type === Proto.Envelope.Type.PREKEY_MESSAGE) {
    return CiphertextMessageType.PreKey;
  }
  if (envelope.type === Proto.Envelope.Type.PLAINTEXT_CONTENT) {
    return CiphertextMessageType.Plaintext;
  }
  return undefined;
}

function validateCertificate(
  certificate: SenderCertificate,
  envelope: DecodedEnvelope,
  roots: Array<PublicKey>,
  stores: HeadlessProtocolStores
): void {
  if (envelope.serverTimestamp <= 0) {
    throw new Error('Sealed sender envelope has no server timestamp');
  }
  const localAci = stores.itemStorage.user.getCheckedAci();
  const localDeviceId = stores.itemStorage.user.getCheckedDeviceId();
  if (
    certificate.senderAci()?.getServiceIdString() === localAci &&
    certificate.senderDeviceId() === localDeviceId
  ) {
    throw new Error('Received sealed sender message from this device');
  }
  if (!certificate.validateWithTrustRoots(roots, envelope.serverTimestamp)) {
    throw new Error('Sealed sender certificate validation failed');
  }
}

export function createLibsignalEnvelopeDecryptor(
  serverTrustRoots: ReadonlyArray<string>
): HeadlessEnvelopeDecryptor {
  if (serverTrustRoots.length === 0) {
    throw new Error('At least one Signal server trust root is required');
  }
  const roots = serverTrustRoots.map(value =>
    PublicKey.deserialize(Bytes.fromBase64(value))
  );

  return async (originalEnvelope, stores, zone) => {
    const destination = originalEnvelope.destinationServiceId;
    if (isPniString(destination)) {
      throw new UnsupportedIncomingContentError(
        'PNI-addressed envelopes are not supported by the headless receiver yet'
      );
    }
    const locked = createLockedStores(stores, destination, zone);
    let envelope = originalEnvelope;
    let ciphertext = envelope.content;
    let ciphertextType: number | undefined;

    if (envelope.type === Proto.Envelope.Type.UNIDENTIFIED_SENDER) {
      const content = await sealedSenderDecryptToUsmc(
        ciphertext,
        locked.identityKeyStore
      );
      const certificate = content.senderCertificate();
      validateCertificate(certificate, envelope, roots, stores);
      envelope = {
        ...envelope,
        sourceDevice: certificate.senderDeviceId(),
        sourceServiceId: normalizeServiceId(
          certificate.senderUuid(),
          'HeadlessMessageReceiver.sealedSender'
        ),
      };
      ciphertext = content.contents();
      ciphertextType = content.msgType();
    }

    const sourceServiceId = envelope.sourceServiceId;
    strictAssert(sourceServiceId, 'Incoming envelope has no source service id');
    strictAssert(
      !isPniString(sourceServiceId),
      'Incoming source is not an ACI'
    );
    const sourceAddress = ProtocolAddress.new(
      sourceServiceId,
      envelope.sourceDevice
    );
    const localAddress = ProtocolAddress.new(
      destination,
      stores.itemStorage.user.getCheckedDeviceId()
    );
    const qualifiedAddress = new QualifiedAddress(
      destination,
      Address.create(sourceServiceId, envelope.sourceDevice)
    );

    let plaintext: Uint8Array<ArrayBuffer>;
    let wasEncrypted = true;
    const kind = ciphertextType ?? getCiphertextKind(envelope);

    if (kind === CiphertextMessageType.Plaintext) {
      plaintext = PlaintextContent.deserialize(ciphertext).body();
      wasEncrypted = false;
    } else if (kind === CiphertextMessageType.PreKey) {
      const message = PreKeySignalMessage.deserialize(ciphertext);
      plaintext = await stores.signalProtocolStore.enqueueSessionJob(
        qualifiedAddress,
        () =>
          signalDecryptPreKey(
            message,
            sourceAddress,
            localAddress,
            locked.sessionStore,
            locked.identityKeyStore,
            locked.preKeyStore,
            locked.signedPreKeyStore,
            locked.kyberPreKeyStore
          ),
        zone
      );
    } else if (kind === CiphertextMessageType.Whisper) {
      const message = SignalMessage.deserialize(ciphertext);
      plaintext = await stores.signalProtocolStore.enqueueSessionJob(
        qualifiedAddress,
        () =>
          signalDecrypt(
            message,
            sourceAddress,
            localAddress,
            locked.sessionStore,
            locked.identityKeyStore
          ),
        zone
      );
    } else if (kind === CiphertextMessageType.SenderKey) {
      throw new UnsupportedIncomingContentError(
        'Sender-key/group envelopes are not supported by the headless receiver yet'
      );
    } else {
      throw new UnsupportedIncomingContentError(
        `Unsupported Signal ciphertext type: ${String(kind)}`
      );
    }

    return {
      envelope: { ...envelope, sourceServiceId },
      plaintext: unpad(plaintext),
      wasEncrypted,
    };
  };
}

export class HeadlessMessageReceiver implements ProtocolRuntime {
  readonly #transport: HeadlessTransportRuntime;
  readonly #decryptEnvelope: HeadlessEnvelopeDecryptor;
  readonly #maxPendingRequests: number;
  readonly #onPersistedMessage:
    | ((message: MessageAttributesType) => Promise<void> | void)
    | undefined;
  #stores: HeadlessProtocolStores | undefined;
  #tail = Promise.resolve();
  #pending = 0;
  #receivedAtCounter = Date.now();
  #stopping = false;
  #unsupportedReason: string | undefined;

  public constructor(
    transport: HeadlessTransportRuntime,
    options: HeadlessReceiveOptions
  ) {
    this.#transport = transport;
    this.#maxPendingRequests =
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING;
    this.#onPersistedMessage = options.onPersistedMessage;
    if (
      !Number.isSafeInteger(this.#maxPendingRequests) ||
      this.#maxPendingRequests < 1
    ) {
      throw new Error('maxPendingRequests must be a positive safe integer');
    }
    this.#decryptEnvelope =
      options.decryptEnvelope ??
      createLibsignalEnvelopeDecryptor(options.serverTrustRoots);
  }

  public get connected(): boolean {
    return this.#transport.connected;
  }

  public get unsupportedReason(): string | undefined {
    return this.#unsupportedReason;
  }

  public async start(
    context: Parameters<ProtocolRuntime['start']>[0]
  ): Promise<void> {
    this.#stores = context.protocolStores;
    const maxCounter = await context.sql.read('getMaxMessageCounter');
    if (typeof maxCounter === 'number') this.#receivedAtCounter = maxCounter;
    this.#stopping = false;
    this.#transport.setRequestHandler(request => this.#enqueue(request));
    try {
      await this.#transport.start(context);
    } catch (error) {
      this.#stopping = true;
      this.#transport.setRequestHandler(null);
      try {
        await this.#transport.stop();
      } finally {
        await this.#tail;
        this.#stores = undefined;
      }
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    this.#transport.setRequestHandler(null);
    await this.#transport.stop();
    await this.#tail;
    this.#stores = undefined;
  }

  async #enqueue(request: HeadlessIncomingRequest): Promise<void> {
    if (this.#stopping || this.#pending >= this.#maxPendingRequests) {
      if (request.type === 'message') request.respond(503);
      return;
    }
    this.#pending += 1;
    // oxlint-disable-next-line promise/prefer-await-to-then, signal-desktop/no-then -- ordered receive tail
    const operation = this.#tail.then(() => this.#handle(request));
    // oxlint-disable promise/prefer-await-to-then -- keep receive tail usable after failures
    this.#tail = operation
      .catch(() => undefined)
      .finally(() => {
        this.#pending -= 1;
      });
    // oxlint-enable promise/prefer-await-to-then
    await operation;
  }

  async #handle(request: HeadlessIncomingRequest): Promise<void> {
    if (request.type === 'queue-empty') {
      return;
    }
    if (!request.body) {
      request.respond(400);
      return;
    }
    try {
      await this.#accept(request.body);
      request.respond(200);
    } catch (error) {
      request.respond(500);
    }
  }

  async #accept(body: Uint8Array<ArrayBuffer>): Promise<void> {
    const stores = this.#stores;
    strictAssert(stores, 'Headless receiver is not started');
    const id = stableEnvelopeId(body);
    const cached =
      await stores.signalProtocolStore.getUnprocessedByIdsAndIncrementAttempts([
        id,
      ]);
    let decrypted: DecryptedEnvelope;
    const cachedItem = cached[0];
    if (cachedItem && !cachedItem.isEncrypted) {
      const envelope = fromUnprocessed(cachedItem);
      strictAssert(
        envelope.sourceServiceId,
        'Decrypted staged envelope has no source'
      );
      decrypted = {
        envelope: { ...envelope, sourceServiceId: envelope.sourceServiceId },
        plaintext: envelope.content,
        wasEncrypted: envelope.type !== Proto.Envelope.Type.PLAINTEXT_CONTENT,
      };
    } else {
      this.#receivedAtCounter += 1;
      const envelope = decodeEnvelope(body, stores, this.#receivedAtCounter);
      const zone = new Zone('HeadlessMessageReceiver.decrypt', {
        pendingKyberPreKeysToRemove: true,
        pendingPreKeysToRemove: true,
        pendingSenderKeys: true,
        pendingSessions: true,
        pendingUnprocessed: true,
      });
      decrypted = await stores.signalProtocolStore.withZone(
        zone,
        'HeadlessMessageReceiver.decryptAndStage',
        async () => {
          const result = await this.#decryptEnvelope(envelope, stores, zone);
          await stores.signalProtocolStore.addUnprocessed(
            toUnprocessed(
              result.envelope,
              result.plaintext,
              false,
              result.envelope.sourceServiceId,
              result.wasEncrypted
            ),
            { zone }
          );
          return result;
        }
      );
    }

    try {
      await this.#persistDirectText(decrypted);
      await stores.signalProtocolStore.removeUnprocessed(decrypted.envelope.id);
    } catch (error) {
      if (error instanceof UnsupportedIncomingContentError) {
        // The server may discard an envelope once it receives 200. Preserve
        // unsupported-but-valid plaintext durably so a future implementation
        // can process it without advancing the libsignal session again.
        this.#unsupportedReason = error.message;
        return;
      }
      throw error;
    }
  }

  async #persistDirectText({
    envelope,
    plaintext,
    wasEncrypted,
  }: DecryptedEnvelope): Promise<void> {
    const stores = this.#stores;
    strictAssert(stores, 'Headless receiver is not started');
    const content = Proto.Content.decode(plaintext);
    const message = content.content?.dataMessage;
    if (!wasEncrypted) {
      throw new UnsupportedIncomingContentError(
        'Plaintext content cannot be materialized as a normal message'
      );
    }
    if (!message || typeof message.body !== 'string') {
      throw new UnsupportedIncomingContentError(
        'Incoming content is not a text data message'
      );
    }
    if (
      message.groupV2 ||
      message.attachments.length > 0 ||
      message.preview.length > 0 ||
      message.quote ||
      message.reaction ||
      message.delete ||
      message.storyContext
    ) {
      throw new UnsupportedIncomingContentError(
        'Incoming data message contains unsupported fields'
      );
    }
    const duplicate = await stores.messageCache.findBySentAt(
      envelope.timestamp,
      candidate =>
        candidate.get('sourceServiceId') === envelope.sourceServiceId &&
        candidate.get('sourceDevice') === envelope.sourceDevice
    );
    if (duplicate) {
      await this.#onPersistedMessage?.(duplicate.attributes);
      return;
    }

    const conversation = stores.conversationController.lookupOrCreate({
      reason: `HeadlessMessageReceiver(${envelope.id})`,
      serviceId: envelope.sourceServiceId,
    });
    strictAssert(conversation, 'Could not create sender conversation');
    await conversation.initialPromise;
    const attributes: MessageAttributesType = {
      body: message.body,
      conversationId: conversation.id,
      decrypted_at: Date.now(),
      id: envelope.id,
      readStatus: ReadStatus.Unread,
      received_at: envelope.receivedAtCounter,
      received_at_ms: envelope.receivedAtDate,
      seenStatus: SeenStatus.Unseen,
      sent_at: envelope.timestamp,
      serverGuid: envelope.serverGuid,
      serverTimestamp: envelope.serverTimestamp,
      sourceDevice: envelope.sourceDevice,
      sourceServiceId: envelope.sourceServiceId,
      timestamp: envelope.timestamp,
      type: 'incoming',
    };
    const model = stores.messageCache.register(
      stores.messageCache.create(attributes)
    );
    await stores.messageCache.saveMessage(model, { forceSave: true });
    await this.#onPersistedMessage?.(model.attributes);
  }
}

export function createHeadlessReceiveRuntime(
  transport: HeadlessTransportRuntime,
  options: HeadlessReceiveOptions
): HeadlessMessageReceiver {
  return new HeadlessMessageReceiver(transport, options);
}
