// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { z } from 'zod';

import { Emoji } from '../axo/emoji.std.ts';
import type { DaemonConfig } from './config.node.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import type { HeadlessProtocolStores } from './protocol_stores.node.ts';
import type { DaemonStatus, RuntimeServiceContext } from './runtime.node.ts';
import { HeadlessSendError, HeadlessSendService } from './send.node.ts';
import type { HeadlessSql } from './sql.node.ts';
import type {
  HeadlessSendTransport,
  HeadlessTransportRuntime,
} from './transport.node.ts';
import { DurableWebhookOutbox } from './webhook.node.ts';
import { isAciString } from '../util/isAciString.std.ts';

const MAX_JSON_BYTES = 64 * 1024;
const destinationSchema = z
  .string()
  .refine(value => /^\+[1-9]\d{6,14}$/.test(value) || isAciString(value), {
    message: 'destination must be an E164 or lowercase ACI',
  });
const sendSchema = z
  .object({
    body: z.string().min(1).max(32_768),
    destination: destinationSchema,
    parse_mode: z.literal('Markdown').optional(),
    quote_message_id: z.string().min(1).max(256).optional(),
  })
  .strict();
const reactionSchema = z
  .object({
    destination: destinationSchema,
    emoji: z.string().refine(Emoji.isEmoji, { message: 'invalid emoji' }),
    message_id: z.string().min(1).max(256),
  })
  .strict();

export type ControlServiceOptions = Readonly<{
  createOutbox?: (
    sql: HeadlessSql,
    context: RuntimeServiceContext
  ) => DurableWebhookOutbox;
  createSendService?: (
    transport: HeadlessSendTransport,
    stores: HeadlessProtocolStores
  ) => Pick<
    HeadlessSendService,
    'markReadAfterWebhook' | 'sendReaction' | 'sendText'
  >;
  getStatus: () => DaemonStatus;
}>;

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function authorized(request: IncomingMessage, expected?: string): boolean {
  if (!expected) return false;
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (
    !request.headers['content-type']
      ?.toLowerCase()
      .startsWith('application/json')
  ) {
    throw new HeadlessSendError(
      'Content-Type must be application/json',
      'invalid-request',
      false
    );
  }
  const chunks = new Array<Buffer<ArrayBuffer>>();
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_JSON_BYTES) {
      throw new HeadlessSendError(
        'Request body is too large',
        'invalid-request',
        false
      );
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new HeadlessSendError(
      'Request body is not valid JSON',
      'invalid-request',
      false,
      {
        cause: error,
      }
    );
  }
}

function sendErrorStatus(error: HeadlessSendError): number {
  switch (error.code) {
    case 'invalid-request':
      return 400;
    case 'unsupported':
      return 422;
    case 'recipient-not-found':
      return 404;
    case 'not-connected':
      return 503;
    case 'rate-limited':
      return 429;
    case 'network':
    case 'device-mismatch':
      return 502;
    case 'identity':
    case 'send-failed':
      return 409;
    default:
      return 500;
  }
}

function publicSendErrorMessage(code: HeadlessSendError['code']): string {
  switch (code) {
    case 'invalid-request':
      return 'Invalid send request';
    case 'unsupported':
      return 'This message type is not supported';
    case 'recipient-not-found':
      return 'Recipient was not found';
    case 'not-connected':
      return 'Signal service is not connected';
    case 'rate-limited':
      return 'Request is rate limited';
    case 'network':
    case 'device-mismatch':
      return 'Signal delivery failed temporarily';
    case 'identity':
    case 'send-failed':
      return 'Signal delivery failed';
    default:
      return 'Signal delivery failed';
  }
}

export class HeadlessControlService {
  readonly #config: DaemonConfig;
  readonly #getStatus: () => DaemonStatus;
  readonly #transport: HeadlessTransportRuntime & HeadlessSendTransport;
  readonly #createOutbox: ControlServiceOptions['createOutbox'];
  readonly #createSendService: ControlServiceOptions['createSendService'];
  readonly #activeHandlers = new Set<Promise<void>>();
  readonly #controllers = new Set<AbortController>();
  #outbox: DurableWebhookOutbox | undefined;
  #sendService:
    | Pick<
        HeadlessSendService,
        'markReadAfterWebhook' | 'sendReaction' | 'sendText'
      >
    | undefined;
  #server: Server | undefined;

  public constructor(
    config: DaemonConfig,
    transport: HeadlessTransportRuntime & HeadlessSendTransport,
    options: ControlServiceOptions
  ) {
    this.#config = config;
    this.#transport = transport;
    this.#getStatus = options.getStatus;
    this.#createOutbox = options.createOutbox;
    this.#createSendService = options.createSendService;
  }

  public async prepare(context: RuntimeServiceContext): Promise<void> {
    if (this.#config.connect && !this.#config.apiToken) {
      throw new Error(
        'SIGNAL_API_TOKEN (at least 16 characters) is required when SIGNAL_DAEMON_CONNECT=true'
      );
    }
    this.#sendService = this.#createSendService
      ? this.#createSendService(this.#transport, context.protocolStores)
      : new HeadlessSendService(this.#transport, context.protocolStores);
    this.#outbox = this.#createOutbox
      ? this.#createOutbox(context.sql, context)
      : new DurableWebhookOutbox(context.sql, {
          isGroupConversation: conversationId =>
            context.protocolStores.conversationController.isGroupConversation(
              conversationId
            ),
          maxPending: this.#config.webhookMaxPending,
          markRead: (messageId, signal) =>
            this.#sendService?.markReadAfterWebhook(messageId, signal),
          profileKey: context.profileSqlKey,
          ...(this.#config.webhookSecret
            ? { secret: this.#config.webhookSecret }
            : {}),
          storagePath: this.#config.storagePath,
          timeoutMs: this.#config.webhookTimeoutMs,
          ...(this.#config.webhookUrl ? { url: this.#config.webhookUrl } : {}),
        });
    await this.#outbox.prepare();
    await this.#outbox.checkEndpoint();
  }

  public async start(): Promise<void> {
    if (!this.#sendService || !this.#outbox) {
      throw new Error('Control service was not prepared');
    }
    const server = createServer((request, response) => {
      this.#trackHandler(request, response);
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#config.apiPort, this.#config.apiHost, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    this.#outbox.start();
  }

  public handleIncoming(message: MessageAttributesType): Promise<void> {
    const outbox = this.#outbox;
    if (!outbox) throw new Error('Webhook outbox is not prepared');
    return outbox.enqueue(message);
  }

  public async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const controller of this.#controllers) controller.abort();
    if (server) {
      server.closeIdleConnections();
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    await Promise.allSettled([...this.#activeHandlers]);
    await this.#outbox?.stop();
    this.#outbox = undefined;
    this.#sendService = undefined;
  }

  #trackHandler(request: IncomingMessage, response: ServerResponse): void {
    const handler = this.#handle(request, response);
    this.#activeHandlers.add(handler);
    void this.#settleHandler(handler);
  }

  async #settleHandler(handler: Promise<void>): Promise<void> {
    try {
      await handler;
    } catch {
      // The request handler normally converts failures to JSON. A socket can
      // still disappear while writing that response during shutdown.
    } finally {
      this.#activeHandlers.delete(handler);
    }
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        json(response, 200, { status: 'ok' });
        return;
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        const status = this.#getStatus();
        json(response, status.ready ? 200 : 503, status);
        return;
      }
      if (
        request.method !== 'POST' ||
        (request.url !== '/v1/messages' && request.url !== '/v1/reactions')
      ) {
        json(response, 404, {
          error: { code: 'not-found', message: 'Not found' },
        });
        return;
      }
      if (!authorized(request, this.#config.apiToken)) {
        response.setHeader('www-authenticate', 'Bearer');
        json(response, 401, {
          error: { code: 'unauthorized', message: 'Authentication required' },
        });
        return;
      }
      const body = await readJson(request);
      const validation =
        request.url === '/v1/reactions'
          ? ({
              kind: 'reaction' as const,
              result: reactionSchema.safeParse(body),
            } as const)
          : ({
              kind: 'message' as const,
              result: sendSchema.safeParse(body),
            } as const);
      if (!validation.result.success) {
        throw new HeadlessSendError(
          'Invalid send request',
          'invalid-request',
          false
        );
      }
      if (!this.#getStatus().ready) {
        throw new HeadlessSendError(
          'Signal service is not ready',
          'not-connected',
          true
        );
      }
      const controller = new AbortController();
      this.#controllers.add(controller);
      request.once('aborted', () => controller.abort());
      try {
        const sendService = this.#sendService;
        if (!sendService) {
          throw new HeadlessSendError(
            'Signal service is not ready',
            'not-connected',
            true
          );
        }
        const result =
          validation.kind === 'reaction'
            ? await sendService.sendReaction(
                {
                  destination: validation.result.data.destination,
                  emoji: validation.result.data.emoji,
                  messageId: validation.result.data.message_id,
                },
                controller.signal
              )
            : await sendService.sendText(
                {
                  body: validation.result.data.body,
                  destination: validation.result.data.destination,
                  ...(validation.result.data.parse_mode
                    ? { parseMode: validation.result.data.parse_mode }
                    : {}),
                  ...(validation.result.data.quote_message_id
                    ? {
                        quoteMessageId: validation.result.data.quote_message_id,
                      }
                    : {}),
                },
                controller.signal
              );
        json(response, 200, result);
      } finally {
        this.#controllers.delete(controller);
      }
    } catch (error) {
      const classified =
        error instanceof HeadlessSendError
          ? error
          : new HeadlessSendError('Send failed', 'send-failed', false);
      json(response, sendErrorStatus(classified), {
        error: {
          code: classified.code,
          message: publicSendErrorMessage(classified.code),
          retryable: classified.retryable,
        },
      });
    }
  }
}
