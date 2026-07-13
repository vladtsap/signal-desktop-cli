// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadDaemonConfig } from './config.node.ts';

void test('loadDaemonConfig applies safe container defaults', () => {
  assert.deepEqual(loadDaemonConfig({}), {
    apiHost: '127.0.0.1',
    apiPort: 8080,
    connect: true,
    logLevel: 'info',
    profileLockPath: '/var/lib/signal-state/.signal-desktop-cli.lock',
    shutdownTimeoutMs: 30_000,
    storagePath: '/var/lib/signal-state/profile',
    webhookMaxPending: 1_000,
    webhookTimeoutMs: 10_000,
  });
});

void test('loadDaemonConfig accepts explicit offline and shutdown configuration', () => {
  assert.deepEqual(
    loadDaemonConfig({
      SIGNAL_DAEMON_CONNECT: 'false',
      SIGNAL_DAEMON_LOG_LEVEL: 'debug',
      SIGNAL_DAEMON_SHUTDOWN_TIMEOUT_MS: '45000',
      SIGNAL_PROFILE_LOCK_PATH: '/state/lease',
      SIGNAL_STORAGE_PATH: '/state/profile',
    }),
    {
      apiHost: '127.0.0.1',
      apiPort: 8080,
      connect: false,
      logLevel: 'debug',
      profileLockPath: '/state/lease',
      shutdownTimeoutMs: 45_000,
      storagePath: '/state/profile',
      webhookMaxPending: 1_000,
      webhookTimeoutMs: 10_000,
    }
  );
});

void test('loadDaemonConfig rejects relative profile paths', () => {
  assert.throws(
    () => loadDaemonConfig({ SIGNAL_STORAGE_PATH: 'state/profile' }),
    /must be an absolute path/
  );
});

void test('loadDaemonConfig treats empty optional compose values as absent', () => {
  const config = loadDaemonConfig({
    SIGNAL_API_TOKEN: '',
    SIGNAL_WEBHOOK_SECRET: '',
    SIGNAL_WEBHOOK_URL: '',
  });
  assert.equal(config.apiToken, undefined);
  assert.equal(config.webhookSecret, undefined);
  assert.equal(config.webhookUrl, undefined);
});

void test('loadDaemonConfig rejects non-HTTP webhook URLs', () => {
  assert.throws(
    () => loadDaemonConfig({ SIGNAL_WEBHOOK_URL: 'file:///tmp/hook' }),
    /SIGNAL_WEBHOOK_URL must use http or https/
  );
});
