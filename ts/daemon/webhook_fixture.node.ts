// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageAttributesType } from '../model-types.d.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import { createHeadlessDataInterfaces } from './client_sql.node.ts';
import { openHeadlessProtocolStores } from './protocol_stores.node.ts';
import { openHeadlessSql } from './sql.node.ts';
import { DurableWebhookOutbox } from './webhook.node.ts';

const OUR_ACI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as AciString;
const SENDER_ACI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as AciString;

async function main(): Promise<void> {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-webhook-sql-'));
  const profileKey = '12'.repeat(32);
  const sql = openHeadlessSql({
    appVersion: '8.21.0-alpha.1',
    key: profileKey,
    storagePath,
  });
  try {
    const { dataWriter } = createHeadlessDataInterfaces(sql);
    await dataWriter.createOrUpdateItem({
      id: 'uuid_id',
      value: `${OUR_ACI}.1`,
    });
    await dataWriter.createOrUpdateItem({
      id: 'number_id',
      value: '+12025550123.1',
    });
    await dataWriter.createOrUpdateItem({ id: 'password', value: 'secret' });
    const stores = await openHeadlessProtocolStores(sql);
    const options = {
      maxPending: 10,
      profileKey,
      storagePath,
      timeoutMs: 1_000,
      url: 'http://127.0.0.1:1/hook',
    } as const;
    const initial = new DurableWebhookOutbox(sql, options);
    await initial.prepare();
    await initial.stop();

    const conversation = stores.conversationController.lookupOrCreate({
      reason: 'webhook fixture',
      serviceId: SENDER_ACI,
    });
    assert.ok(conversation);
    await conversation.initialPromise;
    const attributes: MessageAttributesType = {
      attachments: [],
      body: 'SQLCipher crash-gap payload',
      conversationId: conversation.id,
      id: 'fixture-incoming-message',
      received_at: 7,
      received_at_ms: 7,
      sent_at: 7,
      sourceDevice: 1,
      sourceServiceId: SENDER_ACI,
      timestamp: 7,
      type: 'incoming',
    };
    const model = stores.messageCache.register(
      stores.messageCache.create(attributes)
    );
    await stores.messageCache.saveMessage(model, { forceSave: true });

    const restarted = new DurableWebhookOutbox(sql, options);
    await restarted.prepare();
    assert.equal(restarted.pendingCount, 1);
    const encrypted = await readFile(
      join(storagePath, 'headless-webhook-outbox.enc'),
      'utf8'
    );
    assert.doesNotMatch(encrypted, /SQLCipher crash-gap payload/);
    await restarted.stop();
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
