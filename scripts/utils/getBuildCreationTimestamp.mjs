// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import { readFileSync } from 'node:fs';
import { SECOND } from './durations.mjs';

/**
 * @returns {number}
 */
export function getBuildCreationTimestamp() {
  let value = process.env.SOURCE_DATE_EPOCH;
  if (!value && process.env.SIGNAL_BUILD_EPOCH_FILE) {
    value = readFileSync(process.env.SIGNAL_BUILD_EPOCH_FILE, 'utf8').trim();
  }
  if (!value) {
    value = String(Math.floor(Date.now() / SECOND));
  }
  if (!/^\d+$/.test(value)) {
    throw new Error('Build creation timestamp must be a Unix timestamp');
  }
  const unixTimestamp = Number(value);
  if (!Number.isSafeInteger(unixTimestamp) || unixTimestamp <= 0) {
    throw new Error(
      'Build creation timestamp must be a positive Unix timestamp'
    );
  }
  return unixTimestamp * SECOND;
}
