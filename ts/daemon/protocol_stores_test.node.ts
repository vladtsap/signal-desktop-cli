// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

void test('headless client adapter hydrates real SQLCipher protocol data', async () => {
  const fixture = fileURLToPath(
    new URL('./protocol_stores_fixture.node.ts', import.meta.url)
  );
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import=tsx', fixture], {
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 0);
});
