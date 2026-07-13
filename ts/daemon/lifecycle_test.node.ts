// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { type SignalSource, waitForTermination } from './lifecycle.node.ts';

void test('waitForTermination drains runtime on SIGTERM', async () => {
  const signalSource = new EventEmitter() as SignalSource & EventEmitter;
  const events = new Array<string>();
  const waiting = waitForTermination({
    onSignal: signal => events.push(signal),
    shutdownTimeoutMs: 1_000,
    signalSource,
    async stop() {
      events.push('stop');
    },
  });

  signalSource.emit('SIGTERM');
  await waiting;

  assert.deepEqual(events, ['SIGTERM', 'stop']);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});

void test('waitForTermination propagates shutdown failures', async () => {
  const signalSource = new EventEmitter() as SignalSource & EventEmitter;
  const waiting = waitForTermination({
    shutdownTimeoutMs: 1_000,
    signalSource,
    async stop() {
      throw new Error('checkpoint failed');
    },
  });

  signalSource.emit('SIGINT');
  await assert.rejects(waiting, /checkpoint failed/);
});
