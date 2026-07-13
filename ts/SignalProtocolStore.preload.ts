// Copyright 2016 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { DataReader, DataWriter } from './sql/Client.preload.ts';
import { itemStorage } from './textsecure/Storage.preload.ts';
import { getRequirePqRatio } from './util/getRequirePqRatio.dom.ts';
import { SignalProtocolStore as CoreSignalProtocolStore } from './SignalProtocolStore.node.ts';
import type { ProtocolConversationController } from './SignalProtocolStore.node.ts';

export { GLOBAL_ZONE } from './SignalProtocolStore.node.ts';

// ConversationController imports this module, so it does not exist yet when
// the singleton below is constructed. Resolve it lazily to avoid capturing an
// undefined controller during that import cycle.
const conversationController: ProtocolConversationController = {
  get: id => window.ConversationController.get(id),
  getAll: () => window.ConversationController.getAll(),
  getConversationId: address =>
    window.ConversationController.getConversationId(address),
  getOrCreate: (identifier, type) =>
    window.ConversationController.getOrCreate(identifier, type),
  load: () => window.ConversationController.load(),
  lookupOrCreate: options =>
    window.ConversationController.lookupOrCreate(options),
  reset: () => window.ConversationController.reset(),
};

export class SignalProtocolStore extends CoreSignalProtocolStore {
  constructor() {
    super({
      conversationController,
      dataReader: DataReader,
      dataWriter: DataWriter,
      getRequirePqRatio,
      itemStorage,
    });
  }
}

export const signalProtocolStore = new SignalProtocolStore();
