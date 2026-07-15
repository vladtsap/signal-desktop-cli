// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as Errors from '../types/errors.std.ts';
import type { LoggerType } from '../types/Logging.std.ts';

type DaemonLogScalar = boolean | number | string | null;

export type DaemonLogObject = Readonly<{
  [key: string]: DaemonLogValue;
}>;

export type DaemonLogValue =
  | DaemonLogScalar
  | ReadonlyArray<DaemonLogValue>
  | DaemonLogObject
  | undefined;

export type DaemonLogFields = Readonly<Record<string, DaemonLogValue>>;

export type DaemonLogLevel = 'debug' | 'error' | 'info' | 'warn';

function compact(
  fields: DaemonLogFields
): Record<string, Exclude<DaemonLogValue, undefined>> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, Exclude<DaemonLogValue, undefined>] =>
        entry[1] !== undefined
    )
  );
}

export function logDaemonEvent(
  level: DaemonLogLevel,
  event: string,
  fields: DaemonLogFields = {}
): void {
  const line = JSON.stringify({
    ...compact(fields),
    event,
    level,
    timestamp: new Date().toISOString(),
  });
  switch (level) {
    case 'debug':
    case 'info':
      // oxlint-disable-next-line no-console -- daemon diagnostics are written to container stdout
      console.info(line);
      return;
    case 'warn':
      // oxlint-disable-next-line no-console -- daemon diagnostics are written to container stderr
      console.warn(line);
      return;
    case 'error':
      // oxlint-disable-next-line no-console -- daemon diagnostics are written to container stderr
      console.error(line);
      return;
    default:
      throw new Error(`Unknown daemon log level: ${level}`);
  }
}

export function logDaemonError(
  event: string,
  error: unknown,
  fields: DaemonLogFields = {}
): void {
  logDaemonEvent('error', event, {
    ...fields,
    error: Errors.toLogFormat(error),
    errorName: error instanceof Error ? error.name : undefined,
  });
}

export function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

const COMPONENT_NAMES: Readonly<Record<string, string>> = {
  AuthenticatedHeadlessTransport: 'transport',
  DurableWebhookOutbox: 'webhook',
  HeadlessMessageReceiver: 'receiver',
  'signal-daemon': 'daemon',
};

const EVENT_NAMES: Readonly<Record<string, string>> = {
  'AuthenticatedHeadlessTransport: buffered incoming request':
    'transport.request.buffered',
  'AuthenticatedHeadlessTransport: connected': 'transport.connected',
  'AuthenticatedHeadlessTransport: connecting': 'transport.connecting',
  'AuthenticatedHeadlessTransport: connection closed':
    'transport.connection.closed',
  'AuthenticatedHeadlessTransport: connection is terminal':
    'transport.connection.failed',
  'AuthenticatedHeadlessTransport: connection opened':
    'transport.connection.opened',
  'AuthenticatedHeadlessTransport: incoming request queue overflow':
    'transport.request-queue.overflow',
  'AuthenticatedHeadlessTransport: initial connection failed':
    'transport.connect.failed',
  'AuthenticatedHeadlessTransport: keepalive failed; reconnecting':
    'transport.keepalive.failed',
  'AuthenticatedHeadlessTransport: keepalive succeeded':
    'transport.keepalive.succeeded',
  'AuthenticatedHeadlessTransport: received Signal envelope':
    'transport.envelope.received',
  'AuthenticatedHeadlessTransport: reconnect attempt failed':
    'transport.reconnect.failed',
  'AuthenticatedHeadlessTransport: reconnecting': 'transport.reconnect.started',
  'AuthenticatedHeadlessTransport: rejected stale incoming request':
    'transport.request.rejected',
  'AuthenticatedHeadlessTransport: request handler failed':
    'transport.handler.failed',
  'AuthenticatedHeadlessTransport: request handler updated':
    'transport.handler.updated',
  'AuthenticatedHeadlessTransport: running keepalive':
    'transport.keepalive.started',
  'AuthenticatedHeadlessTransport: stopped': 'transport.stopped',
  'AuthenticatedHeadlessTransport: stopping': 'transport.stopping',
  'DurableWebhookOutbox: checking webhook endpoint':
    'webhook.startup-check.started',
  'DurableWebhookOutbox: delivery loop failed; retrying in 1000ms':
    'webhook.delivery-loop.failed',
  'DurableWebhookOutbox: delivering webhook': 'webhook.delivery.started',
  'DurableWebhookOutbox: initialized durable state':
    'webhook.state.initialized',
  'DurableWebhookOutbox: loaded durable state': 'webhook.state.loaded',
  'DurableWebhookOutbox: post-webhook read action failed':
    'webhook.read-action.failed',
  'DurableWebhookOutbox: post-webhook read action succeeded':
    'webhook.read-action.succeeded',
  'DurableWebhookOutbox: queued webhook delivery': 'webhook.enqueue.succeeded',
  'DurableWebhookOutbox: reconciled durable state': 'webhook.state.reconciled',
  'DurableWebhookOutbox: reconciled incoming messages':
    'webhook.reconciliation.completed',
  'DurableWebhookOutbox: scheduled webhook retry': 'webhook.retry.scheduled',
  'DurableWebhookOutbox: skipped already-cursored message':
    'webhook.enqueue.skipped',
  'DurableWebhookOutbox: skipped duplicate webhook enqueue':
    'webhook.enqueue.skipped',
  'DurableWebhookOutbox: skipped post-webhook read action':
    'webhook.read-action.skipped',
  'DurableWebhookOutbox: skipped webhook enqueue': 'webhook.enqueue.skipped',
  'DurableWebhookOutbox: started': 'webhook.started',
  'DurableWebhookOutbox: started post-webhook read action':
    'webhook.read-action.started',
  'DurableWebhookOutbox: stopped': 'webhook.stopped',
  'DurableWebhookOutbox: stopping': 'webhook.stopping',
  'DurableWebhookOutbox: waiting before webhook retry': 'webhook.retry.waiting',
  'DurableWebhookOutbox: webhook delivery failed; keeping update for retry':
    'webhook.delivery.failed',
  'DurableWebhookOutbox: webhook delivery is disabled': 'webhook.disabled',
  'DurableWebhookOutbox: webhook delivery succeeded':
    'webhook.delivery.succeeded',
  'DurableWebhookOutbox: webhook endpoint is ready':
    'webhook.startup-check.succeeded',
  'DurableWebhookOutbox: webhook endpoint startup check failed':
    'webhook.startup-check.failed',
  'DurableWebhookOutbox: webhook outbox is full': 'webhook.outbox.full',
  'DurableWebhookOutbox: webhook response received':
    'webhook.delivery.response',
  'HeadlessMessageReceiver: acknowledged Signal envelope':
    'receiver.envelope.acknowledged',
  'HeadlessMessageReceiver: acknowledged unsupported empty Signal envelope':
    'receiver.envelope.unsupported-acknowledged',
  'HeadlessMessageReceiver: completed envelope persistence':
    'receiver.persistence.completed',
  'HeadlessMessageReceiver: decrypted Signal envelope':
    'receiver.decrypt.succeeded',
  'HeadlessMessageReceiver: decrypting Signal envelope':
    'receiver.decrypt.started',
  'HeadlessMessageReceiver: failed to process incoming Signal envelope':
    'receiver.envelope.failed',
  'HeadlessMessageReceiver: failed to start': 'receiver.start.failed',
  'HeadlessMessageReceiver: found duplicate message':
    'receiver.message.duplicate',
  'HeadlessMessageReceiver: handed message to webhook outbox':
    'webhook.handoff.completed',
  'HeadlessMessageReceiver: handled queue-empty event':
    'receiver.queue-empty.handled',
  'HeadlessMessageReceiver: persisted incoming text message':
    'receiver.message.persisted',
  'HeadlessMessageReceiver: queued Signal envelope': 'receiver.envelope.queued',
  'HeadlessMessageReceiver: received queue-empty event':
    'receiver.queue-empty.received',
  'HeadlessMessageReceiver: rejected Signal envelope':
    'receiver.envelope.rejected',
  'HeadlessMessageReceiver: resumed staged envelope':
    'receiver.envelope.resumed',
  'HeadlessMessageReceiver: skipped Signal envelope':
    'receiver.envelope.skipped',
  'HeadlessMessageReceiver: skipped staged envelope':
    'receiver.envelope.staged-skipped',
  'HeadlessMessageReceiver: staged unsupported Signal envelope':
    'receiver.envelope.staged',
  'HeadlessMessageReceiver: started': 'receiver.started',
  'HeadlessMessageReceiver: starting': 'receiver.starting',
  'HeadlessMessageReceiver: stopped': 'receiver.stopped',
  'HeadlessMessageReceiver: stopping': 'receiver.stopping',
};

function legacyEventName(message: string, fallbackComponent: string): string {
  const namedEvent = EVENT_NAMES[message];
  if (namedEvent) return namedEvent;
  const [component] = message.split(': ', 1);
  return `${COMPONENT_NAMES[component] ?? fallbackComponent}.legacy`;
}

const REDACTED = '[REDACTED]';
const MAX_COLLECTION_ENTRIES = 100;
const MAX_LOG_STRING_LENGTH = 4_096;
const SENSITIVE_FIELD =
  /(?:authorization|body|content|credential|hmac|message|password|payload|secret|signature|text|token)/i;

function sanitizeLogValue(value: unknown, depth = 0): DaemonLogValue {
  if (
    value == null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > MAX_LOG_STRING_LENGTH
      ? `${value.slice(0, MAX_LOG_STRING_LENGTH)}…`
      : value;
  }
  if (value instanceof Error) {
    return {
      error: Errors.toLogFormat(value),
      errorName: value.name,
    };
  }
  if (depth >= 4) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return [
      ...value
        .slice(0, MAX_COLLECTION_ENTRIES)
        .map(item => sanitizeLogValue(item, depth + 1)),
      ...(value.length > MAX_COLLECTION_ENTRIES ? ['[TRUNCATED]'] : []),
    ];
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      [
        ...Object.entries(value).slice(0, MAX_COLLECTION_ENTRIES),
        ...(Object.keys(value).length > MAX_COLLECTION_ENTRIES
          ? [['[TRUNCATED]', '[TRUNCATED]']]
          : []),
      ].map(([key, item]) => [
        key,
        SENSITIVE_FIELD.test(key)
          ? REDACTED
          : sanitizeLogValue(item, depth + 1),
      ])
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.description ?? 'Symbol';
  return '[UNSUPPORTED]';
}

function legacyFields(args: Array<unknown>): DaemonLogFields {
  const fields: Record<string, DaemonLogValue> = {};
  for (const argument of args) {
    if (typeof argument === 'string') {
      fields.error = argument;
    } else if (argument instanceof Error) {
      fields.error = Errors.toLogFormat(argument);
      fields.errorName = argument.name;
    } else if (Array.isArray(argument)) {
      fields.details = sanitizeLogValue(argument);
    } else if (argument && typeof argument === 'object') {
      for (const [key, value] of Object.entries(argument)) {
        fields[key] = SENSITIVE_FIELD.test(key)
          ? REDACTED
          : sanitizeLogValue(value);
      }
    }
  }
  return fields;
}

export type DaemonLoggerIssue = Readonly<{
  error: Error;
  event: string;
  level: Extract<DaemonLogLevel, 'error' | 'warn'>;
}>;

export type DaemonLoggerOptions = Readonly<{
  fallbackComponent?: string;
  onIssue?: (issue: DaemonLoggerIssue) => void;
}>;

function issueError(message: string, args: Array<unknown>): Error {
  const error = args.find(argument => argument instanceof Error);
  return error instanceof Error ? error : new Error(message);
}

function logLegacy(
  level: DaemonLogLevel,
  message: string,
  args: Array<unknown>,
  options: DaemonLoggerOptions
): void {
  const event = legacyEventName(message, options.fallbackComponent ?? 'daemon');
  const fields = legacyFields(args);
  logDaemonEvent(level, event, {
    ...fields,
    message,
  });
  if (level === 'error' || (level === 'warn' && fields.error)) {
    options.onIssue?.({ error: issueError(message, args), event, level });
  }
}

export function createDaemonLogger(
  options: DaemonLoggerOptions = {}
): LoggerType {
  const logger: LoggerType = {
    child() {
      return logger;
    },
    debug(message, ...args) {
      logLegacy('debug', message, args, options);
    },
    error(message, ...args) {
      logLegacy('error', message, args, options);
    },
    fatal(message, ...args) {
      logLegacy('error', message, args, options);
    },
    info(message, ...args) {
      logLegacy('info', message, args, options);
    },
    trace(message, ...args) {
      logLegacy('debug', message, args, options);
    },
    warn(message, ...args) {
      logLegacy('warn', message, args, options);
    },
  };
  return logger;
}

export const daemonLogger = createDaemonLogger();
