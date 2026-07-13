// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { DAY } from './utils/durations.mjs';
import { getBuildCreationTimestamp } from './utils/getBuildCreationTimestamp.mjs';
const buildCreation = getBuildCreationTimestamp();

// NB: Build expirations are also determined via users' auto-update settings; see
// getExpirationTimestamp
// This fork is externally rebuilt from upstream at least every 90 days. Keep
// this below the upstream 91-day safety ceiling in buildExpiration.std.ts.
const validDuration = DAY * 90;
const buildExpiration = buildCreation + validDuration;

const localProductionPath = join(
  import.meta.dirname,
  '../config/local-production.json'
);

const localProductionConfig = {
  buildCreation,
  buildExpiration,
  updatesEnabled: false,
};

writeFileSync(
  localProductionPath,
  `${JSON.stringify(localProductionConfig)}\n`
);
