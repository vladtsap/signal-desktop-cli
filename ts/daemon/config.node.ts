// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

const booleanValue = z
  .enum(['0', '1', 'false', 'true'])
  .default('true')
  .transform(value => value === '1' || value === 'true');

const emptyAsUndefined = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess(value => (value === '' ? undefined : value), schema.optional());

const environmentSchema = z.object({
  SENTRY_DSN: emptyAsUndefined(z.string().url()),
  SIGNAL_API_HOST: z.string().min(1).default('127.0.0.1'),
  SIGNAL_API_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  SIGNAL_API_TOKEN: emptyAsUndefined(z.string().min(16)),
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
  SIGNAL_WEBHOOK_MAX_PENDING: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(1_000),
  SIGNAL_WEBHOOK_SECRET: emptyAsUndefined(z.string().min(16)),
  SIGNAL_WEBHOOK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(10_000),
  SIGNAL_WEBHOOK_URL: emptyAsUndefined(
    z
      .string()
      .url()
      .refine(value => ['http:', 'https:'].includes(new URL(value).protocol), {
        message: 'SIGNAL_WEBHOOK_URL must use http or https',
      })
  ),
});

export type DaemonConfig = Readonly<{
  apiHost: string;
  apiPort: number;
  apiToken?: string;
  connect: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  profileLockPath: string;
  sentryDsn?: string;
  shutdownTimeoutMs: number;
  storagePath: string;
  webhookMaxPending: number;
  webhookSecret?: string;
  webhookTimeoutMs: number;
  webhookUrl?: string;
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
    apiHost: parsed.SIGNAL_API_HOST,
    apiPort: parsed.SIGNAL_API_PORT,
    ...(parsed.SIGNAL_API_TOKEN ? { apiToken: parsed.SIGNAL_API_TOKEN } : {}),
    connect: parsed.SIGNAL_DAEMON_CONNECT,
    logLevel: parsed.SIGNAL_DAEMON_LOG_LEVEL,
    profileLockPath,
    ...(parsed.SENTRY_DSN ? { sentryDsn: parsed.SENTRY_DSN } : {}),
    shutdownTimeoutMs: parsed.SIGNAL_DAEMON_SHUTDOWN_TIMEOUT_MS,
    storagePath,
    webhookMaxPending: parsed.SIGNAL_WEBHOOK_MAX_PENDING,
    ...(parsed.SIGNAL_WEBHOOK_SECRET
      ? { webhookSecret: parsed.SIGNAL_WEBHOOK_SECRET }
      : {}),
    webhookTimeoutMs: parsed.SIGNAL_WEBHOOK_TIMEOUT_MS,
    ...(parsed.SIGNAL_WEBHOOK_URL
      ? { webhookUrl: parsed.SIGNAL_WEBHOOK_URL }
      : {}),
  };
}
