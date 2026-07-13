// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  SignalProtocolStore,
  type ProtocolConversationController,
} from '../SignalProtocolStore.node.ts';
import { Storage } from '../textsecure/Storage.node.ts';
import { createHeadlessDataInterfaces } from './client_sql.node.ts';
import type { HeadlessSql } from './sql.node.ts';

export type HeadlessProtocolStores = Readonly<{
  itemStorage: Storage;
  signalProtocolStore: SignalProtocolStore;
}>;

function unavailableConversationController(): ProtocolConversationController {
  return new Proxy(Object.create(null) as ProtocolConversationController, {
    get(_target, name) {
      return () => {
        throw new Error(
          `Headless conversation controller is not initialized (${String(name)})`
        );
      };
    },
  });
}

/** Initializes the persisted item and libsignal key/session caches. */
export async function openHeadlessProtocolStores(
  sql: HeadlessSql
): Promise<HeadlessProtocolStores> {
  const { dataReader, dataWriter } = createHeadlessDataInterfaces(sql);
  const itemStorage = new Storage({ dataReader, dataWriter });
  await itemStorage.fetch();

  const signalProtocolStore = new SignalProtocolStore({
    conversationController: unavailableConversationController(),
    dataReader,
    dataWriter,
    // Until RemoteConfig is extracted, preserve its safe default: do not
    // probabilistically archive non-PQ sessions.
    getRequirePqRatio: () => 0,
    itemStorage,
  });
  await signalProtocolStore.hydrateCaches();

  return { itemStorage, signalProtocolStore };
}
