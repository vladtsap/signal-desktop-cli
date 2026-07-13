// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadPortableProfile } from './profile.node.ts';

void test('loadPortableProfile reads the basic-text SQLCipher key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'signal-daemon-profile-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const key = 'ab'.repeat(32);
  await writeFile(join(directory, 'config.json'), JSON.stringify({ key }));

  assert.deepEqual(await loadPortableProfile(directory), {
    sqlKey: key,
    storagePath: directory,
  });
});

void test('loadPortableProfile rejects a host-keychain-only profile', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'signal-daemon-profile-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(
    join(directory, 'config.json'),
    JSON.stringify({ encryptedKey: 'abcd', safeStorageBackend: 'kwallet6' })
  );

  await assert.rejects(
    loadPortableProfile(directory),
    /no portable plaintext SQLCipher key.*kwallet6/
  );
});
