// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { MessageAttributesType } from '../model-types.d.ts';
import type { StoredJob } from '../jobs/types.std.ts';
import type {
  ClientReadableInterface,
  ClientWritableInterface,
} from '../sql/Interface.std.ts';
import type { Storage } from '../textsecure/Storage.node.ts';
import { HeadlessMessageModel } from './models.node.ts';

export class HeadlessMessageCache {
  readonly #dataReader: Pick<
    ClientReadableInterface,
    'getMessageById' | 'getMessagesBySentAt'
  >;
  readonly #dataWriter: Pick<ClientWritableInterface, 'saveMessage'>;
  readonly #itemStorage: Storage;
  readonly #postSaveUpdates: () => Promise<void>;
  readonly #now: () => number;
  readonly #onChanged?: (message: HeadlessMessageModel) => void;
  readonly #messages = new Map<string, HeadlessMessageModel>();
  readonly #idsBySentAt = new Map<number, Set<string>>();
  readonly #lastAccessedAt = new Map<string, number>();

  public constructor({
    dataReader,
    dataWriter,
    itemStorage,
    postSaveUpdates = async () => undefined,
    now = Date.now,
    onChanged,
  }: Readonly<{
    dataReader: Pick<
      ClientReadableInterface,
      'getMessageById' | 'getMessagesBySentAt'
    >;
    dataWriter: Pick<ClientWritableInterface, 'saveMessage'>;
    itemStorage: Storage;
    postSaveUpdates?: () => Promise<void>;
    now?: () => number;
    onChanged?: (message: HeadlessMessageModel) => void;
  }>) {
    this.#dataReader = dataReader;
    this.#dataWriter = dataWriter;
    this.#itemStorage = itemStorage;
    this.#postSaveUpdates = postSaveUpdates;
    this.#now = now;
    this.#onChanged = onChanged;
  }

  public create(attributes: MessageAttributesType): HeadlessMessageModel {
    return new HeadlessMessageModel(attributes);
  }

  #trackChanges(message: HeadlessMessageModel): void {
    message.onChange((model, previous) => {
      if (this.#messages.get(model.id) === model) {
        this.#removeSentAt(previous.sent_at, previous.id);
        this.#addSentAt(model.attributes.sent_at, model.id);
        this.#lastAccessedAt.set(model.id, this.#now());
        this.#onChanged?.(model);
      }
    });
  }

  public register(message: HeadlessMessageModel): HeadlessMessageModel {
    if (!message.id) {
      throw new Error('MessageCache.register: message id is required');
    }
    const existing = this.getById(message.id);
    if (existing) {
      return existing;
    }
    this.#trackChanges(message);
    this.#messages.set(message.id, message);
    this.#addSentAt(message.attributes.sent_at, message.id);
    this.#lastAccessedAt.set(message.id, this.#now());
    return message;
  }

  public getById(id: string): HeadlessMessageModel | undefined {
    const message = this.#messages.get(id);
    if (message) {
      this.#lastAccessedAt.set(id, this.#now());
    }
    return message;
  }

  public async getOrLoadById(
    id: string
  ): Promise<HeadlessMessageModel | undefined> {
    const cached = this.getById(id);
    if (cached) return cached;
    const attributes = await this.#dataReader.getMessageById(id);
    return attributes ? this.register(this.create(attributes)) : undefined;
  }

  public async findBySentAt(
    sentAt: number,
    predicate: (model: HeadlessMessageModel) => boolean
  ): Promise<HeadlessMessageModel | undefined> {
    for (const id of this.#idsBySentAt.get(sentAt) ?? []) {
      const model = this.getById(id);
      if (model && predicate(model)) return model;
    }
    const records = await this.#dataReader.getMessagesBySentAt(sentAt);
    return records
      .map(record => this.register(this.create(record)))
      .find(predicate);
  }

  public async saveMessage(
    message: MessageAttributesType | HeadlessMessageModel,
    options: Readonly<{
      forceSave?: boolean;
      jobToInsert?: Readonly<StoredJob>;
    }> = {}
  ): Promise<string> {
    const attributes =
      message instanceof HeadlessMessageModel ? message.attributes : message;
    return this.#dataWriter.saveMessage(attributes, {
      ...options,
      ourAci: this.#itemStorage.user.getCheckedAci(),
      postSaveUpdates: this.#postSaveUpdates,
    });
  }

  public unregister(id: string): void {
    const message = this.#messages.get(id);
    if (!message) return;
    this.#removeSentAt(message.attributes.sent_at, id);
    this.#messages.delete(id);
    this.#lastAccessedAt.delete(id);
  }

  public deleteExpiredMessages(expiryTime: number): void {
    const now = this.#now();
    for (const id of this.#messages.keys()) {
      if (now - (this.#lastAccessedAt.get(id) ?? 0) > expiryTime) {
        this.unregister(id);
      }
    }
  }

  #addSentAt(sentAt: number, id: string): void {
    const ids = this.#idsBySentAt.get(sentAt) ?? new Set<string>();
    ids.add(id);
    this.#idsBySentAt.set(sentAt, ids);
  }

  #removeSentAt(sentAt: number, id: string): void {
    const ids = this.#idsBySentAt.get(sentAt);
    if (!ids) return;
    ids.delete(id);
    if (!ids.size) this.#idsBySentAt.delete(sentAt);
  }
}
