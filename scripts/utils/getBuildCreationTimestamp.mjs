// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import { SECOND } from './durations.mjs';

/**
 * @returns {number}
 */
export function getBuildCreationTimestamp() {
  const value = process.env.SOURCE_DATE_EPOCH;
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(
      'SOURCE_DATE_EPOCH must be the reviewed upstream Signal commit timestamp'
    );
  }
  const unixTimestamp = Number(value);
  if (!Number.isSafeInteger(unixTimestamp) || unixTimestamp <= 0) {
    throw new Error('SOURCE_DATE_EPOCH must be a positive Unix timestamp');
  }
  return unixTimestamp * SECOND;
}
