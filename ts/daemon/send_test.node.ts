// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

void test('persists idempotent send states and resolves restored E164 in SQLCipher', async () => {
  const fixture = fileURLToPath(
    new URL('./send_fixture.node.ts', import.meta.url)
  );
  const child = spawn(process.execPath, ['--import=tsx', fixture], {
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const [code, signal] = await new Promise<
    [number | null, NodeJS.Signals | null]
  >(resolve =>
    child.once('close', (exitCode, exitSignal) =>
      resolve([exitCode, exitSignal])
    )
  );
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
});
