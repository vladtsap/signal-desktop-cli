// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionType } from '../sql/Interface.std.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import { createHeadlessDataInterfaces } from './client_sql.node.ts';
import { openHeadlessProtocolStores } from './protocol_stores.node.ts';
import { openHeadlessSql } from './sql.node.ts';

const OUR_ACI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as AciString;
const THEIR_ACI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as AciString;

async function main(): Promise<void> {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-daemon-sql-'));
  const sql = openHeadlessSql({
    appVersion: '8.21.0-alpha.1',
    key: 'ab'.repeat(32),
    storagePath,
  });
  try {
    const { dataReader, dataWriter } = createHeadlessDataInterfaces(sql);
    const profileKey = Uint8Array.from([1, 2, 3, 255]);
    await dataWriter.createOrUpdateItem({
      id: 'profileKey',
      value: profileKey,
    });
    await dataWriter.createOrUpdateItem({
      id: 'number_id',
      value: '+12025550123.2',
    });
    await dataWriter.createOrUpdateItem({ id: 'password', value: 'secret' });
    await dataWriter.saveConversation({
      expireTimerVersion: 1,
      id: 'remote-conversation',
      serviceId: THEIR_ACI,
      type: 'private',
      version: 2,
    });
    await dataWriter.saveConversation({
      expireTimerVersion: 1,
      groupId: 'group-id',
      id: 'group-conversation',
      type: 'group',
      version: 2,
    });
    const sessions = Array.from({ length: 260 }, (_, index) => {
      const deviceId = index + 1;
      return {
        conversationId: 'remote-conversation',
        deviceId,
        id: `${OUR_ACI}:${THEIR_ACI}.${deviceId}`,
        ourServiceId: OUR_ACI,
        record: Uint8Array.from([1, 2, 3]),
        serviceId: THEIR_ACI,
      } satisfies SessionType;
    });
    await dataWriter.createOrUpdateSessions(sessions);

    const stored = await sql.read('getItemById', 'profileKey');
    assert.equal(stored?.value, 'AQID/w==');
    const hydratedProfileKey = (await dataReader.getItemById('profileKey'))
      ?.value as Uint8Array<ArrayBuffer> | undefined;
    assert.deepEqual(
      Array.from(hydratedProfileKey ?? []),
      Array.from(profileKey)
    );

    const stores = await openHeadlessProtocolStores(sql);
    assert.equal(stores.itemStorage.get('password'), 'secret');
    assert.deepEqual(
      Array.from(stores.itemStorage.get('profileKey') ?? []),
      Array.from(profileKey)
    );
    assert.equal(stores.signalProtocolStore.identityKeys?.size, 0);
    assert.equal(stores.signalProtocolStore.sessions?.size, 0);
    assert.equal(
      await stores.signalProtocolStore.hasSessionWith(THEIR_ACI),
      true
    );
    assert.equal(stores.signalProtocolStore.sessions?.size, 256);
    const session = sessions[0];
    assert.ok(session);
    const loadedSession = await dataReader.getSessionById(session.id);
    assert.deepEqual(
      loadedSession
        ? { ...loadedSession, record: [...loadedSession.record] }
        : null,
      { ...session, record: [...session.record] }
    );
    assert.equal(
      stores.conversationController.getOurConversation()?.get('e164'),
      '+12025550123'
    );
    assert.equal(stores.conversationController.getAll().length, 2);
    assert.equal(
      stores.conversationController.isGroupConversation('group-conversation'),
      true
    );
  } finally {
    await sql.close();
    await rm(storagePath, { force: true, recursive: true });
  }
}

async function run(): Promise<void> {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  }
}

void run();
