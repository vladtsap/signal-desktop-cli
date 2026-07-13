// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { SignalProtocolStore } from '../SignalProtocolStore.node.ts';
import { Storage } from '../textsecure/Storage.node.ts';
import { createHeadlessDataInterfaces } from './client_sql.node.ts';
import { HeadlessConversationController } from './conversations.node.ts';
import { HeadlessMessageCache } from './message_cache.node.ts';
import type { HeadlessSql } from './sql.node.ts';

export type HeadlessProtocolStores = Readonly<{
  itemStorage: Storage;
  conversationController: HeadlessConversationController;
  messageCache: HeadlessMessageCache;
  signalProtocolStore: SignalProtocolStore;
}>;

/** Initializes the persisted item and libsignal key/session caches. */
export async function openHeadlessProtocolStores(
  sql: HeadlessSql
): Promise<HeadlessProtocolStores> {
  const { dataReader, dataWriter } = createHeadlessDataInterfaces(sql);
  const itemStorage = new Storage({ dataReader, dataWriter });
  await itemStorage.fetch();

  const conversationController = new HeadlessConversationController({
    dataReader,
    dataWriter,
    itemStorage,
  });
  await conversationController.load();
  await conversationController.establishOurConversation();

  const messageCache = new HeadlessMessageCache({
    dataReader,
    dataWriter,
    itemStorage,
  });

  const signalProtocolStore = new SignalProtocolStore({
    conversationController,
    dataReader,
    dataWriter,
    // Until RemoteConfig is extracted, preserve its safe default: do not
    // probabilistically archive non-PQ sessions.
    getRequirePqRatio: () => 0,
    itemStorage,
    loadProtocolRecordsOnDemand: true,
    protocolRecordCacheLimit: 256,
  });
  await signalProtocolStore.hydrateCaches();

  return {
    conversationController,
    itemStorage,
    messageCache,
    signalProtocolStore,
  };
}
