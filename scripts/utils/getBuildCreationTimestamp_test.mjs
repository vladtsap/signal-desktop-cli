// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check

import { assert } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getBuildCreationTimestamp } from './getBuildCreationTimestamp.mjs';

describe('getBuildCreationTimestamp', () => {
  const previous = process.env.SOURCE_DATE_EPOCH;
  const previousFile = process.env.SIGNAL_BUILD_EPOCH_FILE;
  /** @type {Array<string>} */
  const temporaryDirectories = [];

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.SOURCE_DATE_EPOCH;
    } else {
      process.env.SOURCE_DATE_EPOCH = previous;
    }
    if (previousFile === undefined) {
      delete process.env.SIGNAL_BUILD_EPOCH_FILE;
    } else {
      process.env.SIGNAL_BUILD_EPOCH_FILE = previousFile;
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('automatically uses the current build time without an override', () => {
    delete process.env.SOURCE_DATE_EPOCH;
    delete process.env.SIGNAL_BUILD_EPOCH_FILE;
    const before = Date.now();
    const actual = getBuildCreationTimestamp();
    const after = Date.now();
    assert.isAtLeast(actual, Math.floor(before / 1000) * 1000);
    assert.isAtMost(actual, Math.floor(after / 1000) * 1000);
  });

  it('uses the shared automatic Docker build timestamp file', () => {
    delete process.env.SOURCE_DATE_EPOCH;
    const directory = mkdtempSync(join(tmpdir(), 'signal-build-epoch-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'epoch');
    writeFileSync(path, '1783615919\n');
    process.env.SIGNAL_BUILD_EPOCH_FILE = path;
    assert.strictEqual(getBuildCreationTimestamp(), 1783615919000);
  });

  it('converts the explicit Unix timestamp to milliseconds', () => {
    process.env.SOURCE_DATE_EPOCH = '1783615919';
    assert.strictEqual(getBuildCreationTimestamp(), 1783615919000);
  });
});
