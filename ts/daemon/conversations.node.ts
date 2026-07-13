// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { v4 as generateUuid } from 'uuid';

import type {
  ConversationAttributesType,
  SettableConversationAttributesType,
} from '../model-types.d.ts';
import type {
  ClientReadableInterface,
  ClientWritableInterface,
} from '../sql/Interface.std.ts';
import type { Storage } from '../textsecure/Storage.node.ts';
import type { ServiceIdString } from '../types/ServiceId.std.ts';
import {
  isServiceIdString,
  normalizeServiceId,
} from '../types/ServiceId.std.ts';
import { unencodeNumber } from '../util/unencodeNumber.std.ts';
import { HeadlessConversationModel } from './models.node.ts';

export type HeadlessConversationEvents = Readonly<{
  added?: (conversation: HeadlessConversationModel) => void;
  changed?: (
    conversation: HeadlessConversationModel,
    previous: ConversationAttributesType
  ) => void;
  loaded?: (conversations: ReadonlyArray<HeadlessConversationModel>) => void;
}>;

export class HeadlessConversationController {
  readonly #dataReader: Pick<ClientReadableInterface, 'getAllConversations'>;
  readonly #dataWriter: Pick<
    ClientWritableInterface,
    'saveConversation' | 'updateConversation'
  >;
  readonly #itemStorage: Storage;
  readonly #events: HeadlessConversationEvents;
  readonly #generateId: () => string;

  #loadPromise: Promise<void> | undefined;
  #loaded = false;
  #conversations: Array<HeadlessConversationModel> = [];
  readonly #byId = new Map<string, HeadlessConversationModel>();
  readonly #byE164 = new Map<string, HeadlessConversationModel>();
  readonly #byServiceId = new Map<string, HeadlessConversationModel>();
  readonly #byPni = new Map<string, HeadlessConversationModel>();
  readonly #byGroupId = new Map<string, HeadlessConversationModel>();

  public constructor({
    dataReader,
    dataWriter,
    itemStorage,
    events = {},
    generateId = generateUuid,
  }: Readonly<{
    dataReader: Pick<ClientReadableInterface, 'getAllConversations'>;
    dataWriter: Pick<
      ClientWritableInterface,
      'saveConversation' | 'updateConversation'
    >;
    itemStorage: Storage;
    events?: HeadlessConversationEvents;
    generateId?: () => string;
  }>) {
    this.#dataReader = dataReader;
    this.#dataWriter = dataWriter;
    this.#itemStorage = itemStorage;
    this.#events = events;
    this.#generateId = generateId;
  }

  public async load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    this.#loadPromise ??= this.#doLoad();
    await this.#loadPromise;
  }

  public reset(): void {
    this.#loaded = false;
    this.#loadPromise = undefined;
    this.#conversations = [];
    this.#clearLookups();
  }

  public get(id?: string | null): HeadlessConversationModel | undefined {
    this.#assertLoaded();
    if (!id) {
      return undefined;
    }
    return (
      this.#byE164.get(id) ??
      this.#byE164.get(`+${id}`) ??
      this.#byServiceId.get(id) ??
      this.#byPni.get(id) ??
      this.#byGroupId.get(id) ??
      this.#byId.get(id)
    );
  }

  public getAll(): Array<HeadlessConversationModel> {
    this.#assertLoaded();
    return [...this.#conversations];
  }

  public getConversationId(address: string | null): string | null {
    if (!address) {
      return null;
    }
    return this.get(unencodeNumber(address)[0])?.id ?? null;
  }

  public getOrCreate(
    identifier: string | null,
    type: ConversationAttributesType['type'],
    additionalInitialProps: Partial<SettableConversationAttributesType> = {}
  ): HeadlessConversationModel {
    this.#assertLoaded();
    if (typeof identifier !== 'string') {
      throw new TypeError("'id' must be a string");
    }
    if (type !== 'private' && type !== 'group') {
      throw new TypeError(
        `'type' must be 'private' or 'group'; got: '${type}'`
      );
    }
    const existing = this.get(identifier);
    if (existing) {
      return existing;
    }

    const common = {
      id: this.#generateId(),
      type,
      version: 2,
      expireTimerVersion: 1,
      unreadCount: 0,
      verified: 0,
      messageCount: 0,
      sentMessageCount: 0,
      ...additionalInitialProps,
    } as ConversationAttributesType;
    let attributes: ConversationAttributesType;
    if (type === 'group') {
      attributes = { ...common, groupId: identifier };
    } else if (isServiceIdString(identifier)) {
      attributes = { ...common, serviceId: identifier };
    } else {
      attributes = { ...common, e164: identifier };
    }
    const conversation = this.#makeModel(attributes);
    this.#add(conversation);
    conversation.initialPromise = (async () => {
      await this.#dataWriter.saveConversation(conversation.attributes);
      return conversation;
    })();
    return conversation;
  }

  public async getOrCreateAndWait(
    identifier: string | null,
    type: ConversationAttributesType['type'],
    additionalInitialProps: Partial<SettableConversationAttributesType> = {}
  ): Promise<HeadlessConversationModel> {
    await this.load();
    const conversation = this.getOrCreate(
      identifier,
      type,
      additionalInitialProps
    );
    await conversation.initialPromise;
    return conversation;
  }

  public lookupOrCreate({
    e164,
    serviceId,
  }: Readonly<{
    e164?: string | null;
    serviceId?: ServiceIdString | null;
    reason: string;
  }>): HeadlessConversationModel | undefined {
    const normalizedServiceId = serviceId
      ? normalizeServiceId(serviceId, 'HeadlessConversationController')
      : undefined;
    const identifier = normalizedServiceId ?? e164;
    if (!identifier) {
      return undefined;
    }
    const byServiceId = this.get(normalizedServiceId);
    const byE164 = this.get(e164);
    const conversation = byServiceId ?? byE164;
    if (conversation) {
      let changed = false;
      if (normalizedServiceId && !conversation.get('serviceId')) {
        conversation.set({ serviceId: normalizedServiceId });
        changed = true;
      }
      if (e164 && !conversation.get('e164')) {
        conversation.set({ e164 });
        changed = true;
      }
      if (changed) {
        this.#persistUpdate(conversation);
      }
      return conversation;
    }
    const created = this.getOrCreate(identifier, 'private');
    if (normalizedServiceId && e164) {
      created.set({ e164 });
      this.#persistUpdate(created);
    }
    return created;
  }

  public async establishOurConversation(): Promise<
    HeadlessConversationModel | undefined
  > {
    await this.load();
    const aci = this.#itemStorage.user.getAci();
    const pni = this.#itemStorage.user.getPni();
    const e164 = this.#itemStorage.user.getNumber();
    const identifier = aci ?? pni ?? e164;
    if (!identifier) {
      return undefined;
    }
    const conversation =
      this.get(aci) ??
      this.get(pni) ??
      this.get(e164) ??
      this.getOrCreate(identifier, 'private');
    const updates: Partial<ConversationAttributesType> = {};
    if (aci && conversation.get('serviceId') !== aci) {
      updates.serviceId = aci;
    }
    if (pni && conversation.get('pni') !== pni) {
      updates.pni = pni;
    }
    if (e164 && conversation.get('e164') !== e164) {
      updates.e164 = e164;
    }
    if (Object.keys(updates).length) {
      conversation.set(updates);
      this.#persistUpdate(conversation);
    }
    await conversation.initialPromise;
    return conversation;
  }

  public getOurConversation(): HeadlessConversationModel | undefined {
    const aci = this.#itemStorage.user.getAci();
    const pni = this.#itemStorage.user.getPni();
    const e164 = this.#itemStorage.user.getNumber();
    return this.get(aci) ?? this.get(pni) ?? this.get(e164);
  }

  public getOurConversationId(): string | undefined {
    return this.getOurConversation()?.id;
  }

  public getOurConversationOrThrow(): HeadlessConversationModel {
    const conversation = this.getOurConversation();
    if (!conversation) {
      throw new Error('Failed to find our own conversation');
    }
    return conversation;
  }

  public getOurConversationIdOrThrow(): string {
    return this.getOurConversationOrThrow().id;
  }

  public areWePrimaryDevice(): boolean {
    return this.#itemStorage.user.getDeviceId() === 1;
  }

  public doWeHaveOtherDevices(): boolean {
    return !this.areWePrimaryDevice();
  }

  #assertLoaded(): void {
    if (!this.#loaded) {
      throw new Error('Conversation repository needs complete initial fetch');
    }
  }

  async #doLoad(): Promise<void> {
    const records = await this.#dataReader.getAllConversations();
    this.#conversations = records
      .filter(record => !record.isTemporary)
      .map(record => this.#makeModel(record));
    this.#loaded = true;
    this.#generateLookups();
    this.#events.loaded?.(this.getAll());
  }

  #makeModel(attributes: ConversationAttributesType) {
    return new HeadlessConversationModel(attributes, (model, previous) => {
      this.#removeFromLookups(previous);
      this.#addToLookups(model);
      this.#events.changed?.(model, previous);
    });
  }

  #add(conversation: HeadlessConversationModel): void {
    this.#conversations.push(conversation);
    this.#addToLookups(conversation);
    this.#events.added?.(conversation);
  }

  #persistUpdate(conversation: HeadlessConversationModel): void {
    const model = conversation;
    const previousSave = model.initialPromise;
    model.initialPromise = (async () => {
      await previousSave;
      await this.#dataWriter.updateConversation(model.attributes);
      return model;
    })();
  }

  #generateLookups(): void {
    this.#clearLookups();
    for (const conversation of this.#conversations) {
      this.#addToLookups(conversation);
    }
  }

  #clearLookups(): void {
    this.#byId.clear();
    this.#byE164.clear();
    this.#byServiceId.clear();
    this.#byPni.clear();
    this.#byGroupId.clear();
  }

  #addToLookups(conversation: HeadlessConversationModel): void {
    this.#byId.set(conversation.id, conversation);
    const { e164, serviceId, pni, groupId } = conversation.attributes;
    if (e164) this.#byE164.set(e164, conversation);
    if (serviceId) this.#byServiceId.set(serviceId, conversation);
    if (pni) this.#byPni.set(pni, conversation);
    if (groupId) this.#byGroupId.set(groupId, conversation);
  }

  #removeFromLookups(attributes: ConversationAttributesType): void {
    this.#deleteIfMatching(this.#byId, attributes.id, attributes.id);
    if (attributes.e164) {
      this.#deleteIfMatching(this.#byE164, attributes.e164, attributes.id);
    }
    if (attributes.serviceId) {
      this.#deleteIfMatching(
        this.#byServiceId,
        attributes.serviceId,
        attributes.id
      );
    }
    if (attributes.pni) {
      this.#deleteIfMatching(this.#byPni, attributes.pni, attributes.id);
    }
    if (attributes.groupId) {
      this.#deleteIfMatching(
        this.#byGroupId,
        attributes.groupId,
        attributes.id
      );
    }
  }

  #deleteIfMatching(
    lookup: Map<string, HeadlessConversationModel>,
    key: string,
    id: string
  ): void {
    if (lookup.get(key)?.id === id) {
      lookup.delete(key);
    }
  }
}
