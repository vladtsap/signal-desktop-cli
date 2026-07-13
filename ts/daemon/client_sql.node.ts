// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable signal-desktop/enforce-file-suffix -- Node daemon SQL boundary

import type { ObjectMappingSpecType } from '../util/mapObjectWithSpec.std.ts';
import { mapObjectWithSpec } from '../util/mapObjectWithSpec.std.ts';
import * as Bytes from '../Bytes.std.ts';
import type {
  AllItemsType,
  ClientReadableInterface,
  ClientWritableInterface,
  IdentityKeyType,
  ItemKeyType,
  ItemType,
  KyberPreKeyType,
  PreKeyType,
  SignedPreKeyType,
  StoredIdentityKeyType,
  StoredItemType,
  StoredKyberPreKeyType,
  StoredPreKeyType,
  StoredSignedPreKeyType,
} from '../sql/Interface.std.ts';
import type { HeadlessSql } from './sql.node.ts';

const IDENTITY_KEY_SPEC = ['publicKey'];
const KYBER_PRE_KEY_SPEC = ['data'];
const PRE_KEY_SPEC = ['privateKey', 'publicKey'];

const ITEM_SPECS: Partial<Record<ItemKeyType, ObjectMappingSpecType>> = {
  defaultWallpaperPhotoPointer: ['value'],
  identityKeyMap: {
    key: 'value',
    valueSpec: { isMap: true, valueSpec: ['privKey', 'pubKey'] },
  },
  profileKey: ['value'],
  senderCertificate: ['value.serialized'],
  senderCertificateNoE164: ['value.serialized'],
  subscriberId: ['value'],
  backupsSubscriberId: ['value'],
  backupEphemeralKey: ['value'],
  backupMediaRootKey: ['value'],
  manifestRecordIkm: ['value'],
  usernameLink: ['value.entropy', 'value.serverId'],
  lastDistinguishedTreeHead: ['value'],
  payments: ['value.entropy'],
};

function fromBytes<Input, Output>(
  spec: ObjectMappingSpecType,
  data: Input
): Output {
  return mapObjectWithSpec<Uint8Array<ArrayBuffer>, string>(spec, data, value =>
    Bytes.toBase64(value)
  );
}

function toBytes<Input, Output>(
  spec: ObjectMappingSpecType,
  data: Input
): Output {
  return mapObjectWithSpec<string, Uint8Array<ArrayBuffer>>(spec, data, value =>
    Bytes.fromBase64(value)
  );
}

/**
 * Presents the same hydrated, promise-based interfaces as sql/Client.preload,
 * but calls the daemon's serialized SQL connection directly.
 */
export function createHeadlessDataInterfaces(sql: HeadlessSql): Readonly<{
  dataReader: ClientReadableInterface;
  dataWriter: ClientWritableInterface;
}> {
  const readableOverrides: Partial<ClientReadableInterface> = {
    async getIdentityKeyById(id) {
      const value = await sql.read('getIdentityKeyById', id);
      return toBytes(IDENTITY_KEY_SPEC, value);
    },
    async getAllIdentityKeys() {
      const values = await sql.read('getAllIdentityKeys');
      return values.map(value =>
        toBytes<StoredIdentityKeyType, IdentityKeyType>(
          IDENTITY_KEY_SPEC,
          value
        )
      );
    },
    async getKyberPreKeyById(id) {
      const value = await sql.read('getKyberPreKeyById', id);
      return toBytes(KYBER_PRE_KEY_SPEC, value);
    },
    async getAllKyberPreKeys() {
      const values = await sql.read('getAllKyberPreKeys');
      return values.map(value =>
        toBytes<StoredKyberPreKeyType, KyberPreKeyType>(
          KYBER_PRE_KEY_SPEC,
          value
        )
      );
    },
    async getPreKeyById(id) {
      const value = await sql.read('getPreKeyById', id);
      return toBytes(PRE_KEY_SPEC, value);
    },
    async getAllPreKeys() {
      const values = await sql.read('getAllPreKeys');
      return values.map(value =>
        toBytes<StoredPreKeyType, PreKeyType>(PRE_KEY_SPEC, value)
      );
    },
    async getSignedPreKeyById(id) {
      const value = await sql.read('getSignedPreKeyById', id);
      return toBytes(PRE_KEY_SPEC, value);
    },
    async getAllSignedPreKeys() {
      const values = await sql.read('getAllSignedPreKeys');
      return values.map(value =>
        toBytes<StoredSignedPreKeyType, SignedPreKeyType>(PRE_KEY_SPEC, value)
      );
    },
    async getItemById<K extends ItemKeyType>(id: K) {
      const value = await sql.read('getItemById', id);
      const spec = ITEM_SPECS[id];
      return spec
        ? toBytes<StoredItemType<K> | undefined, ItemType<K> | undefined>(
            spec,
            value as StoredItemType<K> | undefined
          )
        : (value as unknown as ItemType<K> | undefined);
    },
    async getAllItems() {
      const items = await sql.read('getAllItems');
      const result: Record<string, unknown> = Object.create(null);
      for (const id of Object.keys(items) as Array<ItemKeyType>) {
        const value = items[id];
        const spec = ITEM_SPECS[id];
        result[id] = spec
          ? (toBytes(spec, { value }) as ItemType<typeof id>).value
          : value;
      }
      return result as AllItemsType;
    },
  };

  const writableOverrides: Partial<ClientWritableInterface> = {
    async createOrUpdateIdentityKey(value) {
      await sql.write(
        'createOrUpdateIdentityKey',
        fromBytes<IdentityKeyType, StoredIdentityKeyType>(
          IDENTITY_KEY_SPEC,
          value
        )
      );
    },
    async bulkAddIdentityKeys(values) {
      await sql.write(
        'bulkAddIdentityKeys',
        values.map(value =>
          fromBytes<IdentityKeyType, StoredIdentityKeyType>(
            IDENTITY_KEY_SPEC,
            value
          )
        )
      );
    },
    async createOrUpdateKyberPreKey(value) {
      await sql.write(
        'createOrUpdateKyberPreKey',
        fromBytes<KyberPreKeyType, StoredKyberPreKeyType>(
          KYBER_PRE_KEY_SPEC,
          value
        )
      );
    },
    async bulkAddKyberPreKeys(values) {
      await sql.write(
        'bulkAddKyberPreKeys',
        values.map(value =>
          fromBytes<KyberPreKeyType, StoredKyberPreKeyType>(
            KYBER_PRE_KEY_SPEC,
            value
          )
        )
      );
    },
    async createOrUpdatePreKey(value) {
      await sql.write(
        'createOrUpdatePreKey',
        fromBytes<PreKeyType, StoredPreKeyType>(PRE_KEY_SPEC, value)
      );
    },
    async bulkAddPreKeys(values) {
      await sql.write(
        'bulkAddPreKeys',
        values.map(value =>
          fromBytes<PreKeyType, StoredPreKeyType>(PRE_KEY_SPEC, value)
        )
      );
    },
    async createOrUpdateSignedPreKey(value) {
      await sql.write(
        'createOrUpdateSignedPreKey',
        fromBytes<SignedPreKeyType, StoredSignedPreKeyType>(PRE_KEY_SPEC, value)
      );
    },
    async bulkAddSignedPreKeys(values) {
      await sql.write(
        'bulkAddSignedPreKeys',
        values.map(value =>
          fromBytes<SignedPreKeyType, StoredSignedPreKeyType>(
            PRE_KEY_SPEC,
            value
          )
        )
      );
    },
    async createOrUpdateItem<K extends ItemKeyType>(value: ItemType<K>) {
      if (!value.id) {
        throw new Error('createOrUpdateItem: item id is required');
      }
      const spec = ITEM_SPECS[value.id];
      await sql.write(
        'createOrUpdateItem',
        spec
          ? fromBytes<ItemType<K>, StoredItemType<K>>(spec, value)
          : (value as unknown as StoredItemType<K>)
      );
    },
  };

  const dynamicRead = sql.read as unknown as (
    method: PropertyKey,
    ...args: ReadonlyArray<unknown>
  ) => Promise<unknown>;
  const dynamicWrite = sql.write as unknown as (
    method: PropertyKey,
    ...args: ReadonlyArray<unknown>
  ) => Promise<unknown>;
  const dataReader = new Proxy(readableOverrides as ClientReadableInterface, {
    get(target, name) {
      if (Reflect.has(target, name)) {
        return Reflect.get(target, name);
      }
      return (...args: ReadonlyArray<unknown>) => dynamicRead(name, ...args);
    },
  });
  const dataWriter = new Proxy(writableOverrides as ClientWritableInterface, {
    get(target, name) {
      if (Reflect.has(target, name)) {
        return Reflect.get(target, name);
      }
      return (...args: ReadonlyArray<unknown>) => dynamicWrite(name, ...args);
    },
  });

  return { dataReader, dataWriter };
}
