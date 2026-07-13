// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const daemonModules = [
  'api.node.ts',
  'build_expiration.node.ts',
  'config.node.ts',
  'client_sql.node.ts',
  'conversations.node.ts',
  'lifecycle.node.ts',
  'main.node.ts',
  'message_cache.node.ts',
  'models.node.ts',
  'profile.node.ts',
  'protocol_stores.node.ts',
  'receive.node.ts',
  'send.node.ts',
  'runtime.node.ts',
  'sql.node.ts',
  'transport.node.ts',
  'webhook.node.ts',
  '../SignalProtocolStore.node.ts',
  '../LibSignalStores.node.ts',
  '../textsecure/Storage.node.ts',
  '../textsecure/storage/User.std.ts',
];

void test('daemon entry modules never import Electron or browser globals', async () => {
  const sources = await Promise.all(
    daemonModules.map(moduleName =>
      readFile(join(import.meta.dirname, moduleName), 'utf8')
    )
  );
  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /from ['"]electron['"]|require\(['"]electron['"]\)/
    );
    assert.doesNotMatch(source, /\b(?:document|navigator|window)\b/);
  }
});

void test('daemon container uses the shared profile lease', async () => {
  const source = await readFile(
    join(import.meta.dirname, '../../docker/daemon-entrypoint.sh'),
    'utf8'
  );
  assert.match(source, /flock --nonblock 9/);
  assert.match(source, /SIGNAL_PROFILE_LOCK_PATH/);
});
