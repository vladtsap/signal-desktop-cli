// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable signal-desktop/enforce-file-suffix -- Node daemon boundary consumes shared duration constants

import { DAY } from '../util/durations/index.std.ts';

export const FORK_BUILD_VALIDITY_DAYS = 90;

export type BuildExpirationStatus = Readonly<{
  createdAt: number;
  createdAtIso: string;
  daysRemaining: number;
  expired: boolean;
  expiresAt: number;
  expiresAtIso: string;
  validityDays: 90;
}>;

export function getBuildExpirationStatus(
  createdAt: number,
  expiresAt: number,
  now: number
): BuildExpirationStatus {
  for (const [name, value] of Object.entries({ createdAt, expiresAt, now })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative finite timestamp`);
    }
  }
  if (expiresAt !== createdAt + FORK_BUILD_VALIDITY_DAYS * DAY) {
    throw new Error('Daemon build expiration must be exactly 90 days');
  }

  const remainingMs = Math.max(0, expiresAt - now);
  return {
    createdAt,
    createdAtIso: new Date(createdAt).toISOString(),
    daysRemaining: remainingMs / DAY,
    expired: now >= expiresAt,
    expiresAt,
    expiresAtIso: new Date(expiresAt).toISOString(),
    validityDays: FORK_BUILD_VALIDITY_DAYS,
  };
}
