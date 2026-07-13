// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

const booleanValue = z
  .enum(['0', '1', 'false', 'true'])
  .default('true')
  .transform(value => value === '1' || value === 'true');

const environmentSchema = z.object({
  SIGNAL_DAEMON_CONNECT: booleanValue,
  SIGNAL_DAEMON_LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),
  SIGNAL_DAEMON_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(30_000),
  SIGNAL_PROFILE_LOCK_PATH: z.string().min(1).optional(),
  SIGNAL_STORAGE_PATH: z
    .string()
    .min(1)
    .default('/var/lib/signal-state/profile'),
});

export type DaemonConfig = Readonly<{
  connect: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  profileLockPath: string;
  shutdownTimeoutMs: number;
  storagePath: string;
}>;

export function loadDaemonConfig(
  environment: NodeJS.ProcessEnv = process.env
): DaemonConfig {
  const parsed = environmentSchema.parse(environment);
  const storagePath = resolve(parsed.SIGNAL_STORAGE_PATH);
  if (!isAbsolute(parsed.SIGNAL_STORAGE_PATH)) {
    throw new Error('SIGNAL_STORAGE_PATH must be an absolute path');
  }

  const profileLockPath = resolve(
    parsed.SIGNAL_PROFILE_LOCK_PATH ??
      `${storagePath}/../.signal-desktop-cli.lock`
  );
  if (
    parsed.SIGNAL_PROFILE_LOCK_PATH != null &&
    !isAbsolute(parsed.SIGNAL_PROFILE_LOCK_PATH)
  ) {
    throw new Error('SIGNAL_PROFILE_LOCK_PATH must be an absolute path');
  }

  return {
    connect: parsed.SIGNAL_DAEMON_CONNECT,
    logLevel: parsed.SIGNAL_DAEMON_LOG_LEVEL,
    profileLockPath,
    shutdownTimeoutMs: parsed.SIGNAL_DAEMON_SHUTDOWN_TIMEOUT_MS,
    storagePath,
  };
}
