// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check

import { assert } from 'chai';

import { getBuildCreationTimestamp } from './getBuildCreationTimestamp.mjs';

describe('getBuildCreationTimestamp', () => {
  const previous = process.env.SOURCE_DATE_EPOCH;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.SOURCE_DATE_EPOCH;
    } else {
      process.env.SOURCE_DATE_EPOCH = previous;
    }
  });

  it('requires an explicit reviewed upstream timestamp', () => {
    delete process.env.SOURCE_DATE_EPOCH;
    assert.throws(() => getBuildCreationTimestamp(), /SOURCE_DATE_EPOCH/);
  });

  it('converts the explicit Unix timestamp to milliseconds', () => {
    process.env.SOURCE_DATE_EPOCH = '1783615919';
    assert.strictEqual(getBuildCreationTimestamp(), 1783615919000);
  });
});
