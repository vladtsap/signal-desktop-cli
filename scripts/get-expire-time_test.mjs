// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check

import { assert } from 'chai';
import { readFileSync } from 'node:fs';

import { DAY } from './utils/durations.mjs';

describe('current build expiration metadata', () => {
  it('has an exact 90-day time to live', () => {
    const config = JSON.parse(
      readFileSync(
        new URL('../config/local-production.json', import.meta.url),
        'utf8'
      )
    );

    assert.isAbove(config.buildCreation, 0);
    assert.strictEqual(config.buildExpiration - config.buildCreation, 90 * DAY);
    assert.strictEqual(config.updatesEnabled, false);
  });
});
