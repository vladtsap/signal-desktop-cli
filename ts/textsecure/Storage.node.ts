// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable signal-desktop/enforce-file-suffix -- shared headless storage core

import type {
  StorageAccessType as Access,
  StorageInterface,
} from '../types/Storage.d.ts';
import { User } from './storage/User.std.ts';
import { Blocked } from './storage/Blocked.std.ts';

import { createLogger } from '../logging/log.std.ts';
import type {
  ClientReadableInterface,
  ClientWritableInterface,
} from '../sql/Interface.std.ts';

const log = createLogger('Storage');

export const DEFAULT_AUTO_DOWNLOAD_ATTACHMENT = {
  photos: true,
  videos: true,
  audio: true,
  documents: true,
};

export class Storage implements StorageInterface {
  public readonly user: User;

  public readonly blocked: Blocked;

  #ready = false;
  #readyCallbacks: Array<() => void> = [];
  #items: Partial<Access> = Object.create(null);

  readonly #dataReader: Pick<ClientReadableInterface, 'getAllItems'>;
  readonly #dataWriter: Pick<
    ClientWritableInterface,
    'createOrUpdateItem' | 'removeItemById'
  >;
  readonly #onItemChanged?: (key: keyof Access, value: unknown) => void;

  constructor({
    dataReader,
    dataWriter,
    onItemChanged,
    onUserChanged,
  }: Readonly<{
    dataReader: Pick<ClientReadableInterface, 'getAllItems'>;
    dataWriter: Pick<
      ClientWritableInterface,
      'createOrUpdateItem' | 'removeItemById'
    >;
    onItemChanged?: (key: keyof Access, value: unknown) => void;
    onUserChanged?: () => void;
  }>) {
    this.#dataReader = dataReader;
    this.#dataWriter = dataWriter;
    this.#onItemChanged = onItemChanged;
    this.user = new User(this, onUserChanged);
    this.blocked = new Blocked(this);
  }

  // `StorageInterface` implementation

  public get<K extends keyof Access, V extends Access[K]>(
    key: K
  ): V | undefined;

  public get<K extends keyof Access>(
    key: K,
    defaultValue: Exclude<Access[K], undefined>
  ): Exclude<Access[K], undefined>;

  public get<K extends keyof Access>(
    key: K,
    defaultValue?: Access[K]
  ): Access[K] | undefined {
    if (!this.#ready) {
      log.warn('Called storage.get before storage is ready. key:', key);
    }

    const item = this.#items[key];
    if (item === undefined) {
      return defaultValue;
    }

    return item;
  }

  public async put<K extends keyof Access>(
    key: K,
    value: Access[K]
  ): Promise<void> {
    if (!this.#ready) {
      log.warn('Called storage.put before storage is ready. key:', key);
    }

    this.#items[key] = value;
    this.#onItemChanged?.(key, value);
    await this.#dataWriter.createOrUpdateItem({ id: key, value });
  }

  public async remove<K extends keyof Access>(key: K): Promise<void> {
    if (!this.#ready) {
      log.warn('Called storage.remove before storage is ready. key:', key);
    }

    delete this.#items[key];
    await this.#dataWriter.removeItemById(key);
    this.#onItemChanged?.(key, undefined);
  }

  // Regular methods

  public onready(callback: () => void): void {
    if (this.#ready) {
      callback();
    } else {
      this.#readyCallbacks.push(callback);
    }
  }

  public async fetch(): Promise<void> {
    this.reset();

    Object.assign(this.#items, await this.#dataReader.getAllItems());

    this.#ready = true;
    this.#callListeners();
  }

  public reset(): void {
    this.#ready = false;
    this.#items = Object.create(null);
  }

  public getItemsState(): Partial<Access> {
    if (!this.#ready) {
      log.warn('Called getItemsState before storage is ready');
    }

    log.info('getItemsState: now preparing copy of items...');

    const state = Object.create(null);

    const items = this.#items;
    const allKeys = Object.keys(items) as Array<keyof typeof items>;

    for (const key of allKeys) {
      state[key] = items[key];
    }

    return state;
  }

  #callListeners(): void {
    if (!this.#ready) {
      return;
    }
    const callbacks = this.#readyCallbacks;
    this.#readyCallbacks = [];
    callbacks.forEach(callback => callback());
  }
}
