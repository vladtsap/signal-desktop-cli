// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHeadlessDataInterfaces } from './client_sql.node.ts';
import { openHeadlessProtocolStores } from './protocol_stores.node.ts';
import { openHeadlessSql } from './sql.node.ts';

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
