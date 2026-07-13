// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ConversationAttributesType,
  MessageAttributesType,
} from '../model-types.d.ts';
import type {
  ClientReadableInterface,
  ClientWritableInterface,
} from '../sql/Interface.std.ts';
import type { Storage } from '../textsecure/Storage.node.ts';
import type { AciString, PniString } from '../types/ServiceId.std.ts';
import { HeadlessConversationController } from './conversations.node.ts';
import { HeadlessMessageCache } from './message_cache.node.ts';

const OUR_ACI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as AciString;
const OUR_PNI = 'PNI:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as PniString;

function fakeStorage(): Storage {
  return {
    user: {
      getAci: () => OUR_ACI,
      getCheckedAci: () => OUR_ACI,
      getNumber: () => '+12025550123',
      getPni: () => OUR_PNI,
    },
  } as unknown as Storage;
}

void test('conversation repository loads identifiers and establishes our conversation', async () => {
  const updates = new Array<ConversationAttributesType>();
  const existing: ConversationAttributesType = {
    e164: '+12025550123',
    expireTimerVersion: 1,
    id: 'our-local-id',
    type: 'private',
    version: 2,
  };
  const controller = new HeadlessConversationController({
    dataReader: {
      getAllGroupConversationIds: async () => ['group-id'],
      getAllPrivateConversations: async () => [existing],
    } as Pick<
      ClientReadableInterface,
      'getAllGroupConversationIds' | 'getAllPrivateConversations'
    >,
    dataWriter: {
      saveConversation: async () => undefined,
      updateConversation: async attributes => {
        updates.push(attributes);
      },
    } as Pick<
      ClientWritableInterface,
      'saveConversation' | 'updateConversation'
    >,
    generateId: () => 'generated-id',
    itemStorage: fakeStorage(),
  });

  await controller.load();
  const ours = await controller.establishOurConversation();

  assert.equal(ours?.id, 'our-local-id');
  assert.equal(controller.get(OUR_ACI), ours);
  assert.equal(controller.get(OUR_PNI), ours);
  assert.equal(controller.get('+12025550123'), ours);
  assert.equal(controller.getOurConversationIdOrThrow(), 'our-local-id');
  assert.equal(controller.isGroupConversation('group-id'), true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.serviceId, OUR_ACI);
  assert.equal(updates[0]?.pni, OUR_PNI);
});

void test('conversation repository creates and persists protocol contacts', async () => {
  const saved = new Array<ConversationAttributesType>();
  const controller = new HeadlessConversationController({
    dataReader: {
      getAllGroupConversationIds: async () => [],
      getAllPrivateConversations: async () => [],
    } as Pick<
      ClientReadableInterface,
      'getAllGroupConversationIds' | 'getAllPrivateConversations'
    >,
    dataWriter: {
      saveConversation: async attributes => {
        saved.push(attributes);
      },
      updateConversation: async () => undefined,
    } as Pick<
      ClientWritableInterface,
      'saveConversation' | 'updateConversation'
    >,
    generateId: () => 'new-contact-id',
    itemStorage: fakeStorage(),
  });
  await controller.load();

  const contact = controller.lookupOrCreate({
    e164: '+12025550124',
    reason: 'test',
    serviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as AciString,
  });
  await contact?.initialPromise;

  assert.equal(contact?.id, 'new-contact-id');
  assert.equal(contact?.get('e164'), '+12025550124');
  assert.equal(controller.get('+12025550124'), contact);
  assert.equal(saved.length, 1);
});

void test('message cache reuses models, queries disk, and updates sent-at indexes', async () => {
  let now = 10;
  const diskMessage = {
    conversationId: 'conversation-id',
    id: 'message-id',
    received_at: 1,
    sent_at: 20,
    timestamp: 20,
    type: 'incoming',
  } as MessageAttributesType;
  const cache = new HeadlessMessageCache({
    dataReader: {
      getMessageById: async () => diskMessage,
      getMessagesBySentAt: async sentAt =>
        sentAt === diskMessage.sent_at ? [diskMessage] : [],
    } as Pick<
      ClientReadableInterface,
      'getMessageById' | 'getMessagesBySentAt'
    >,
    dataWriter: {
      saveMessage: async attributes => attributes.id,
    } as Pick<ClientWritableInterface, 'saveMessage'>,
    itemStorage: fakeStorage(),
    now: () => now,
  });

  const loaded = await cache.findBySentAt(20, () => true);
  assert.ok(loaded);
  assert.equal(loaded?.id, 'message-id');
  assert.equal(await cache.getOrLoadById('message-id'), loaded);

  loaded?.set({ sent_at: 21 });
  assert.equal(await cache.findBySentAt(21, () => true), loaded);
  assert.equal(await cache.saveMessage(loaded), 'message-id');

  now = 100;
  cache.deleteExpiredMessages(50);
  assert.equal(cache.getById('message-id'), undefined);
});
