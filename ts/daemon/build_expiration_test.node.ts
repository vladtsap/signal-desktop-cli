// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DAY } from '../util/durations/index.std.ts';
import {
  FORK_BUILD_VALIDITY_DAYS,
  getBuildExpirationStatus,
} from './build_expiration.node.ts';
import { isNinetyDayForkBuild } from '../util/buildExpiration.std.ts';

const CREATED_AT = Date.UTC(2026, 6, 1);
const EXPIRES_AT = CREATED_AT + FORK_BUILD_VALIDITY_DAYS * DAY;

void test('fork builds are valid until the exact 90-day boundary', () => {
  const before = getBuildExpirationStatus(
    CREATED_AT,
    EXPIRES_AT,
    EXPIRES_AT - 1
  );
  assert.equal(before.expired, false);
  assert.equal(before.daysRemaining, 1 / DAY);

  const boundary = getBuildExpirationStatus(CREATED_AT, EXPIRES_AT, EXPIRES_AT);
  assert.equal(boundary.expired, true);
  assert.equal(boundary.daysRemaining, 0);
  assert.equal(boundary.validityDays, 90);
});

void test('daemon rejects an expiration outside the 90-day policy', () => {
  assert.throws(
    () => getBuildExpirationStatus(CREATED_AT, EXPIRES_AT + DAY, CREATED_AT),
    /exactly 90 days/
  );
});

void test('only explicit non-updatable 90-day UI builds use the 91-day ceiling', () => {
  assert.equal(
    isNinetyDayForkBuild({
      buildCreation: CREATED_AT,
      buildExpiration: EXPIRES_AT,
      updatesEnabled: false,
    }),
    true
  );
  assert.equal(
    isNinetyDayForkBuild({
      buildCreation: CREATED_AT,
      buildExpiration: EXPIRES_AT,
      updatesEnabled: true,
    }),
    false
  );
});
