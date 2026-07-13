// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable eslint/max-classes-per-file -- key generation and its lifecycle adapter

import { randomInt } from 'node:crypto';

import type {
  KEMPublicKey,
  KyberPreKeyRecord,
  PublicKey,
} from '@signalapp/libsignal-client';
import { z } from 'zod';

import {
  generateKyberPreKey,
  generatePreKey,
  generateSignedPreKey,
} from '../Curve.node.ts';
import type { SignalProtocolStore } from '../SignalProtocolStore.node.ts';
import type { Storage } from '../textsecure/Storage.node.ts';
import {
  KYBER_KEY_ID_KEY,
  SIGNED_PRE_KEY_ID_KEY,
} from '../textsecure/ProtocolStorageKeys.std.ts';
import type {
  CompatPreKeyType,
  CompatSignedPreKeyType,
  KeyPairType,
  KyberPreKeyType,
} from '../textsecure/Types.d.ts';
import type { StorageAccessType } from '../types/Storage.d.ts';
import { ServiceIdKind, type ServiceIdString } from '../types/ServiceId.std.ts';
import { wrappingAdd24 } from '../util/wrappingAdd.std.ts';
import type { ProtocolRuntime } from './runtime.node.ts';
import type { HeadlessSendTransport } from './transport.node.ts';

const DAY = 24 * 60 * 60 * 1_000;
const DEFAULT_PERIODIC_INTERVAL = 2 * DAY;
const DEFAULT_RETRY_INTERVAL = 5 * 60 * 1_000;
const DEFAULT_LOW_KEYS_DELAY = 60 * 1_000;
const KEY_TOO_OLD_THRESHOLD = 14 * DAY;
const KEY_ROTATION_AGE = 1.5 * DAY;
const PRE_KEY_BATCH_SIZE = 100;
const PRE_KEY_MINIMUM = 10;
const PRE_KEY_MAXIMUM = 200;
const KEY_REQUEST_TIMEOUT = 30_000;

type StorageKey = keyof StorageAccessType;
type KindStorageKeys = Record<ServiceIdKind, StorageKey>;

const PRE_KEY_ID_KEY = {
  [ServiceIdKind.ACI]: 'maxPreKeyId',
  [ServiceIdKind.Unknown]: 'maxPreKeyId',
  [ServiceIdKind.PNI]: 'maxPreKeyIdPNI',
} as const satisfies KindStorageKeys;
const SIGNED_UPDATE_KEY = {
  [ServiceIdKind.ACI]: 'signedKeyUpdateTime',
  [ServiceIdKind.Unknown]: 'signedKeyUpdateTime',
  [ServiceIdKind.PNI]: 'signedKeyUpdateTimePNI',
} as const satisfies KindStorageKeys;
const LAST_RESORT_UPDATE_KEY = {
  [ServiceIdKind.ACI]: 'lastResortKeyUpdateTime',
  [ServiceIdKind.Unknown]: 'lastResortKeyUpdateTime',
  [ServiceIdKind.PNI]: 'lastResortKeyUpdateTimePNI',
} as const satisfies KindStorageKeys;

const keyCountSchema = z.object({ count: z.number(), pqCount: z.number() });

type UploadPreKey = Readonly<{ keyId: number; publicKey: PublicKey }>;
type UploadSignedKey = Readonly<{
  keyId: number;
  publicKey: PublicKey | KEMPublicKey;
  signature: Uint8Array<ArrayBuffer>;
}>;
type UploadKeys = Readonly<{
  preKeys?: ReadonlyArray<UploadPreKey>;
  pqPreKeys?: ReadonlyArray<UploadSignedKey>;
  pqLastResortPreKey?: UploadSignedKey;
  signedPreKey?: UploadSignedKey;
}>;

export type HeadlessPreKeyUpdater = Readonly<{
  areKeysOutOfDate: (kind: ServiceIdKind) => boolean;
  update: (kind: ServiceIdKind, signal: AbortSignal) => Promise<void>;
}>;

function nextId(storage: Storage, key: StorageKey): number {
  const existing = storage.get(key);
  return typeof existing === 'number' ? existing : randomInt(0x1000000);
}

function toBase64(value: Uint8Array<ArrayBuffer>): string {
  return Buffer.from(value).toString('base64');
}

function serializeSignedKey(key: UploadSignedKey | undefined) {
  return key
    ? {
        keyId: key.keyId,
        publicKey: toBase64(key.publicKey.serialize()),
        signature: toBase64(key.signature),
      }
    : undefined;
}

function kyberToUpload(record: KyberPreKeyRecord): UploadSignedKey {
  return {
    keyId: record.id(),
    publicKey: record.publicKey(),
    signature: record.signature(),
  };
}

export class LibsignalPreKeyUpdater implements HeadlessPreKeyUpdater {
  readonly #storage: Storage;
  readonly #store: SignalProtocolStore;
  readonly #transport: HeadlessSendTransport;
  readonly #now: () => number;

  public constructor(
    storage: Storage,
    store: SignalProtocolStore,
    transport: HeadlessSendTransport,
    now: () => number = Date.now
  ) {
    this.#storage = storage;
    this.#store = store;
    this.#transport = transport;
    this.#now = now;
  }

  public areKeysOutOfDate(kind: ServiceIdKind): boolean {
    const signed = this.#storage.get(SIGNED_UPDATE_KEY[kind], 0);
    const lastResort = this.#storage.get(LAST_RESORT_UPDATE_KEY[kind], 0);
    return (
      this.#now() - signed >= KEY_TOO_OLD_THRESHOLD ||
      this.#now() - lastResort >= KEY_TOO_OLD_THRESHOLD
    );
  }

  public async update(kind: ServiceIdKind, signal: AbortSignal): Promise<void> {
    let serviceId: ServiceIdString;
    try {
      serviceId = this.#storage.user.getCheckedServiceId(kind);
    } catch (error) {
      if (kind === ServiceIdKind.PNI) return;
      throw error;
    }
    const identityKey = this.#store.getIdentityKeyPair(serviceId);
    if (!identityKey) {
      if (kind === ServiceIdKind.PNI) return;
      throw new Error('Missing ACI identity key for pre-key maintenance');
    }
    const counts = await this.#fetchCounts(kind, signal);
    const upload: {
      preKeys?: Array<UploadPreKey>;
      pqPreKeys?: Array<UploadSignedKey>;
      pqLastResortPreKey?: UploadSignedKey;
      signedPreKey?: UploadSignedKey;
    } = {};
    if (counts.count < PRE_KEY_MINIMUM || counts.count > PRE_KEY_MAXIMUM) {
      upload.preKeys = await this.#generatePreKeys(kind, serviceId);
    }
    if (counts.pqCount < PRE_KEY_MINIMUM || counts.pqCount > PRE_KEY_MAXIMUM) {
      upload.pqPreKeys = await this.#generateKyberPreKeys(
        kind,
        serviceId,
        identityKey
      );
    }
    upload.signedPreKey = await this.#maybeGenerateSignedKey(
      kind,
      serviceId,
      identityKey
    );
    upload.pqLastResortPreKey = await this.#maybeGenerateLastResortKey(
      kind,
      serviceId,
      identityKey
    );
    if (
      !upload.preKeys &&
      !upload.pqPreKeys &&
      !upload.signedPreKey &&
      !upload.pqLastResortPreKey
    ) {
      return;
    }
    await this.#upload(kind, upload, signal);
    const updatedAt = this.#now();
    if (upload.signedPreKey) {
      await this.#store.confirmSignedPreKey(
        serviceId,
        upload.signedPreKey.keyId
      );
      await this.#storage.put(SIGNED_UPDATE_KEY[kind], updatedAt);
    }
    if (upload.pqLastResortPreKey) {
      await this.#store.confirmKyberPreKey(
        serviceId,
        upload.pqLastResortPreKey.keyId
      );
      await this.#storage.put(LAST_RESORT_UPDATE_KEY[kind], updatedAt);
    }
  }

  async #fetchCounts(kind: ServiceIdKind, signal: AbortSignal) {
    const response = await this.#transport.fetchAuthenticated(
      {
        headers: [['Accept', 'application/json']],
        path: `/v2/keys?identity=${kind === ServiceIdKind.ACI ? 'aci' : 'pni'}`,
        timeoutMillis: KEY_REQUEST_TIMEOUT,
        verb: 'GET',
      },
      { abortSignal: signal }
    );
    if (response.status < 200 || response.status >= 300 || !response.body) {
      throw new Error(`Signal key count request failed (${response.status})`);
    }
    return keyCountSchema.parse(
      JSON.parse(Buffer.from(response.body).toString('utf8'))
    );
  }

  async #upload(
    kind: ServiceIdKind,
    keys: UploadKeys,
    signal: AbortSignal
  ): Promise<void> {
    const body = {
      preKeys: keys.preKeys?.map(key => ({
        keyId: key.keyId,
        publicKey: toBase64(key.publicKey.serialize()),
      })),
      pqPreKeys: keys.pqPreKeys?.map(serializeSignedKey),
      pqLastResortPreKey: serializeSignedKey(keys.pqLastResortPreKey),
      signedPreKey: serializeSignedKey(keys.signedPreKey),
    };
    const response = await this.#transport.fetchAuthenticated(
      {
        body: Buffer.from(JSON.stringify(body)),
        headers: [
          ['Accept', 'application/json'],
          ['Content-Type', 'application/json'],
        ],
        path: `/v2/keys?identity=${kind === ServiceIdKind.ACI ? 'aci' : 'pni'}`,
        timeoutMillis: KEY_REQUEST_TIMEOUT,
        verb: 'PUT',
      },
      { abortSignal: signal }
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Signal key upload failed (${response.status})`);
    }
  }

  async #generatePreKeys(
    kind: ServiceIdKind,
    serviceId: ServiceIdString
  ): Promise<Array<UploadPreKey>> {
    const start = nextId(this.#storage, PRE_KEY_ID_KEY[kind]);
    const keys = new Array<CompatPreKeyType>();
    for (let offset = 0; offset < PRE_KEY_BATCH_SIZE; offset += 1) {
      keys.push(generatePreKey(wrappingAdd24(start, offset)));
    }
    await Promise.all([
      this.#store.storePreKeys(serviceId, keys),
      this.#storage.put(
        PRE_KEY_ID_KEY[kind],
        Math.max(1, wrappingAdd24(start, PRE_KEY_BATCH_SIZE))
      ),
    ]);
    return keys.map(key => ({
      keyId: key.keyId,
      publicKey: key.keyPair.publicKey,
    }));
  }

  async #generateKyberPreKeys(
    kind: ServiceIdKind,
    serviceId: ServiceIdString,
    identityKey: KeyPairType
  ): Promise<Array<UploadSignedKey>> {
    const start = nextId(this.#storage, KYBER_KEY_ID_KEY[kind]);
    const stored = new Array<Omit<KyberPreKeyType, 'id'>>();
    const upload = new Array<UploadSignedKey>();
    for (let offset = 0; offset < PRE_KEY_BATCH_SIZE; offset += 1) {
      const record = generateKyberPreKey(
        identityKey,
        wrappingAdd24(start, offset)
      );
      stored.push({
        createdAt: this.#now(),
        data: record.serialize(),
        isConfirmed: false,
        isLastResort: false,
        keyId: record.id(),
        ourServiceId: serviceId,
      });
      upload.push(kyberToUpload(record));
    }
    await Promise.all([
      this.#store.storeKyberPreKeys(serviceId, stored),
      this.#storage.put(
        KYBER_KEY_ID_KEY[kind],
        Math.max(1, wrappingAdd24(start, PRE_KEY_BATCH_SIZE))
      ),
    ]);
    return upload;
  }

  async #maybeGenerateSignedKey(
    kind: ServiceIdKind,
    serviceId: ServiceIdString,
    identityKey: KeyPairType
  ): Promise<UploadSignedKey | undefined> {
    const recent = this.#store
      .loadSignedPreKeys(serviceId)
      .filter(key => key.confirmed)
      .sort((left, right) => right.created_at - left.created_at)[0];
    if (recent && this.#now() - recent.created_at < KEY_ROTATION_AGE) {
      if (!this.#storage.get(SIGNED_UPDATE_KEY[kind])) {
        await this.#storage.put(SIGNED_UPDATE_KEY[kind], recent.created_at);
      }
      return undefined;
    }
    const keyId = nextId(this.#storage, SIGNED_PRE_KEY_ID_KEY[kind]);
    const key: CompatSignedPreKeyType = generateSignedPreKey(
      identityKey,
      keyId
    );
    await Promise.all([
      this.#store.storeSignedPreKey(serviceId, keyId, key.keyPair),
      this.#storage.put(
        SIGNED_PRE_KEY_ID_KEY[kind],
        Math.max(1, wrappingAdd24(keyId, 1))
      ),
    ]);
    return {
      keyId,
      publicKey: key.keyPair.publicKey,
      signature: key.signature,
    };
  }

  async #maybeGenerateLastResortKey(
    kind: ServiceIdKind,
    serviceId: ServiceIdString,
    identityKey: KeyPairType
  ): Promise<UploadSignedKey | undefined> {
    const recent = this.#store
      .loadKyberPreKeys(serviceId, { isLastResort: true })
      .filter(key => key.isConfirmed)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (recent && this.#now() - recent.createdAt < KEY_ROTATION_AGE) {
      if (!this.#storage.get(LAST_RESORT_UPDATE_KEY[kind])) {
        await this.#storage.put(LAST_RESORT_UPDATE_KEY[kind], recent.createdAt);
      }
      return undefined;
    }
    const keyId = nextId(this.#storage, KYBER_KEY_ID_KEY[kind]);
    const record = generateKyberPreKey(identityKey, keyId);
    await Promise.all([
      this.#store.storeKyberPreKeys(serviceId, [
        {
          createdAt: this.#now(),
          data: record.serialize(),
          isConfirmed: false,
          isLastResort: true,
          keyId,
          ourServiceId: serviceId,
        },
      ]),
      this.#storage.put(
        KYBER_KEY_ID_KEY[kind],
        Math.max(1, wrappingAdd24(keyId, 1))
      ),
    ]);
    return kyberToUpload(record);
  }
}

export type PreKeyMaintenanceOptions = Readonly<{
  lowKeysDelayMs?: number;
  periodicIntervalMs?: number;
  retryIntervalMs?: number;
}>;

type CreatePreKeyUpdater = (
  context: Parameters<ProtocolRuntime['start']>[0]
) => HeadlessPreKeyUpdater;

export class PreKeyMaintainedProtocolRuntime implements ProtocolRuntime {
  readonly #protocol: ProtocolRuntime;
  readonly #createUpdater: CreatePreKeyUpdater;
  readonly #options: Required<PreKeyMaintenanceOptions>;
  #abortController: AbortController | undefined;
  #currentRun: Promise<void> = Promise.resolve();
  #lowKeysTimer: NodeJS.Timeout | undefined;
  #periodicTimer: NodeJS.Timeout | undefined;
  #protocolStarted = false;
  #stopped = true;
  #store: SignalProtocolStore | undefined;
  #updater: HeadlessPreKeyUpdater | undefined;

  public constructor(
    protocol: ProtocolRuntime,
    createUpdater: CreatePreKeyUpdater,
    options: PreKeyMaintenanceOptions = {}
  ) {
    this.#protocol = protocol;
    this.#createUpdater = createUpdater;
    this.#options = {
      lowKeysDelayMs: options.lowKeysDelayMs ?? DEFAULT_LOW_KEYS_DELAY,
      periodicIntervalMs:
        options.periodicIntervalMs ?? DEFAULT_PERIODIC_INTERVAL,
      retryIntervalMs: options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL,
    };
  }

  public get connected(): boolean {
    return this.#protocol.connected;
  }

  public get failureReason(): string | undefined {
    return this.#protocol.failureReason;
  }

  public async start(
    context: Parameters<ProtocolRuntime['start']>[0]
  ): Promise<void> {
    await this.#protocol.start(context);
    this.#protocolStarted = true;
    this.#stopped = false;
    this.#abortController = new AbortController();
    this.#store = context.protocolStores.signalProtocolStore;
    this.#updater = this.#createUpdater(context);
    this.#store.on('lowKeys', this.#onLowKeys);
    await this.#runAndReschedule('startup');
  }

  public async stop(): Promise<void> {
    if (this.#stopped) {
      if (this.#protocolStarted) {
        this.#protocolStarted = false;
        await this.#protocol.stop();
      }
      return;
    }
    this.#stopped = true;
    this.#store?.off('lowKeys', this.#onLowKeys);
    this.#store = undefined;
    if (this.#lowKeysTimer) clearTimeout(this.#lowKeysTimer);
    if (this.#periodicTimer) clearTimeout(this.#periodicTimer);
    this.#lowKeysTimer = undefined;
    this.#periodicTimer = undefined;
    this.#abortController?.abort(new Error('Pre-key maintenance stopped'));
    await this.#currentRun;
    this.#updater = undefined;
    this.#abortController = undefined;
    if (this.#protocolStarted) {
      this.#protocolStarted = false;
      await this.#protocol.stop();
    }
  }

  readonly #onLowKeys = (): void => {
    if (this.#stopped || this.#lowKeysTimer) return;
    this.#lowKeysTimer = setTimeout(() => {
      this.#lowKeysTimer = undefined;
      void this.#runAndReschedule('low-keys');
    }, this.#options.lowKeysDelayMs);
    this.#lowKeysTimer.unref();
  };

  async #runAndReschedule(reason: string): Promise<void> {
    if (this.#stopped) return;
    const updater = this.#updater;
    const signal = this.#abortController?.signal;
    if (!updater || !signal) return;
    // Serialize and coalesce all key-update triggers.
    const previous = this.#currentRun;
    this.#currentRun = (async () => {
      await previous;
      if (this.#stopped || signal.aborted) return;
      try {
        await updater.update(ServiceIdKind.ACI, signal);
        if (this.#stopped || signal.aborted) return;
        await updater.update(ServiceIdKind.PNI, signal);
        this.#schedule(this.#options.periodicIntervalMs);
      } catch (error) {
        if (!signal.aborted) {
          // oxlint-disable-next-line no-console
          console.error(
            `signal-daemon: pre-key ${reason} update failed`,
            error
          );
          this.#schedule(this.#options.retryIntervalMs);
        }
      }
    })();
    await this.#currentRun;
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    if (this.#periodicTimer) clearTimeout(this.#periodicTimer);
    this.#periodicTimer = setTimeout(() => {
      this.#periodicTimer = undefined;
      const updater = this.#updater;
      // The 14-day check provides an explicit forced safety trigger; the normal
      // two-day run also replenishes depleted one-time server key inventories.
      const stale =
        updater?.areKeysOutOfDate(ServiceIdKind.ACI) ||
        updater?.areKeysOutOfDate(ServiceIdKind.PNI);
      void this.#runAndReschedule(stale ? 'stale-keys' : 'periodic');
    }, delay);
    this.#periodicTimer.unref();
  }
}
