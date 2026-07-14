// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as Sentry from '@sentry/node';

let enabled = false;

export function initializeDaemonMonitoring({
  dsn,
  release,
}: Readonly<{ dsn?: string; release: string }>): void {
  if (!dsn) return;
  Sentry.init({
    beforeBreadcrumb(breadcrumb) {
      return breadcrumb.category?.startsWith('http') ? null : breadcrumb;
    },
    beforeSend(event) {
      // Never attach API headers, webhook payloads, or Signal request details.
      return { ...event, request: undefined };
    },
    dsn,
    release,
    sendDefaultPii: false,
  });
  enabled = true;
}

export function captureDaemonError(
  error: unknown,
  operation: string,
  extra?: Record<string, boolean | number | string | undefined>
): void {
  if (!enabled) return;
  const exception = error instanceof Error ? error : new Error(String(error));
  Sentry.withScope(scope => {
    scope.setTag('daemon.operation', operation);
    if (extra) scope.setExtras(extra);
    Sentry.captureException(exception);
  });
}

export async function closeDaemonMonitoring(timeoutMs = 2_000): Promise<void> {
  if (!enabled) return;
  enabled = false;
  await Sentry.close(timeoutMs);
}
