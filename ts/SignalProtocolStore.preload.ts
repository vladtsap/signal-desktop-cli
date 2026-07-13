// Copyright 2016 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { DataReader, DataWriter } from './sql/Client.preload.ts';
import { itemStorage } from './textsecure/Storage.preload.ts';
import { getRequirePqRatio } from './util/getRequirePqRatio.dom.ts';
import { SignalProtocolStore as CoreSignalProtocolStore } from './SignalProtocolStore.node.ts';

export { GLOBAL_ZONE } from './SignalProtocolStore.node.ts';

export class SignalProtocolStore extends CoreSignalProtocolStore {
  constructor() {
    super({
      conversationController: window.ConversationController,
      dataReader: DataReader,
      dataWriter: DataWriter,
      getRequirePqRatio,
      itemStorage,
    });
  }
}

export const signalProtocolStore = new SignalProtocolStore();
