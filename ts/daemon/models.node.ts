// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable signal-desktop/enforce-file-suffix -- Node daemon model seam
// oxlint-disable eslint/max-classes-per-file -- colocated minimal model seam

import type {
  ConversationAttributesType,
  MessageAttributesType,
} from '../model-types.d.ts';
import type { CallbackResultType } from '../textsecure/Types.d.ts';

type StringKey<T> = keyof T & string;

export class HeadlessConversationModel {
  private _attributes: ConversationAttributesType;
  readonly #onChange?: (
    model: HeadlessConversationModel,
    previous: ConversationAttributesType
  ) => void;

  public initialPromise: Promise<HeadlessConversationModel> =
    Promise.resolve(this);

  public constructor(
    attributes: ConversationAttributesType,
    onChange?: (
      model: HeadlessConversationModel,
      previous: ConversationAttributesType
    ) => void
  ) {
    this._attributes = attributes;
    this.#onChange = onChange;
  }

  public get id(): string {
    return this._attributes.id;
  }

  public get attributes(): ConversationAttributesType {
    return this._attributes;
  }

  public get<K extends StringKey<ConversationAttributesType>>(
    key: K
  ): ConversationAttributesType[K] {
    return this._attributes[key];
  }

  public set(attributes: Partial<ConversationAttributesType>): void {
    const previous = this._attributes;
    this._attributes = { ...previous, ...attributes };
    this.#onChange?.(this, previous);
  }
}

export class HeadlessMessageModel {
  private _attributes: MessageAttributesType;
  public doNotSave?: boolean;
  public doNotSendSyncMessage?: boolean;
  public deletingForEveryone?: boolean;
  public pendingMarkRead?: number;
  public syncPromise?: Promise<CallbackResultType | void>;

  readonly #changeListeners = new Set<
    (model: HeadlessMessageModel, previous: MessageAttributesType) => void
  >();

  public constructor(
    attributes: MessageAttributesType,
    onChange?: (
      model: HeadlessMessageModel,
      previous: MessageAttributesType
    ) => void
  ) {
    this._attributes = attributes;
    if (onChange) {
      this.#changeListeners.add(onChange);
    }
  }

  public get id(): string {
    return this._attributes.id;
  }

  public get attributes(): Readonly<MessageAttributesType> {
    return this._attributes;
  }

  public get<K extends StringKey<MessageAttributesType>>(
    key: K
  ): MessageAttributesType[K] {
    return this._attributes[key];
  }

  public set(attributes: Partial<MessageAttributesType>): void {
    const previous = this._attributes;
    this._attributes = { ...previous, ...attributes };
    this.#notifyChange(previous);
  }

  public resetAllAttributes(attributes: MessageAttributesType): void {
    const previous = this._attributes;
    this._attributes = { ...attributes };
    this.#notifyChange(previous);
  }

  public onChange(
    listener: (
      model: HeadlessMessageModel,
      previous: MessageAttributesType
    ) => void
  ): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  #notifyChange(previous: MessageAttributesType): void {
    for (const listener of this.#changeListeners) {
      listener(this, previous);
    }
  }
}
