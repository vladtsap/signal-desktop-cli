// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { MessageAttributesType } from '../model-types.d.ts';
import { z } from 'zod';
import type { HeadlessSql } from './sql.node.ts';

const FORMAT_VERSION = 1;
const OUTBOX_FILE = 'headless-webhook-outbox.enc';
const MAX_ENCRYPTED_FILE_BYTES = 128 * 1024 * 1024;

type Cursor = Readonly<{ id: string; receivedAt: number }>;

export type WebhookUpdate = Readonly<{
  message: Readonly<{
    chat: Readonly<{ id: string; type: 'private' }>;
    date: number;
    from: Readonly<{ id: string }>;
    message_id: string;
    reply_to_message?: Readonly<{
      chat: Readonly<{ id: string; type: 'private' }>;
      date: number;
      from: Readonly<{ id: string }>;
      message_id: string;
      text: string;
    }>;
    text: string;
  }>;
  webhook_update_id: string;
}>;

type Entry = Readonly<{
  attempts: number;
  nextAttemptAt: number;
  update: WebhookUpdate;
}>;

type State = Readonly<{
  cursor?: Cursor;
  entries: ReadonlyArray<Entry>;
  version: 1;
}>;

type EncryptedState = Readonly<{
  ciphertext: string;
  nonce: string;
  tag: string;
  version: 1;
}>;

const encryptedStateSchema = z.object({
  ciphertext: z.string().max(MAX_ENCRYPTED_FILE_BYTES),
  nonce: z.string().min(16).max(32),
  tag: z.string().min(16).max(32),
  version: z.literal(FORMAT_VERSION),
});

const messageSchema = z.object({
  chat: z.object({ id: z.string(), type: z.literal('private') }),
  date: z.number().safe().int(),
  from: z.object({ id: z.string() }),
  message_id: z.string().min(1).max(256),
  reply_to_message: z
    .object({
      chat: z.object({ id: z.string(), type: z.literal('private') }),
      date: z.number().safe().int(),
      from: z.object({ id: z.string() }),
      message_id: z.string().min(1).max(256),
      text: z.string().max(1024 * 1024),
    })
    .optional(),
  text: z.string().max(1024 * 1024),
});

const updateIdSchema = z.string().regex(/^\d{1,20}$/);

const webhookUpdateSchema = z.union([
  z.object({
    message: messageSchema,
    webhook_update_id: updateIdSchema,
  }),
  z
    .object({
      message: messageSchema,
      update_id: updateIdSchema,
    })
    .transform(({ message, update_id }) => ({
      message,
      webhook_update_id: update_id,
    })),
]);

const stateSchema = z.object({
  cursor: z
    .object({
      id: z.string().min(1).max(256),
      receivedAt: z.number().safe().int(),
    })
    .optional(),
  entries: z.array(
    z.object({
      attempts: z.number().safe().int().nonnegative(),
      nextAttemptAt: z.number().safe().int().nonnegative(),
      update: webhookUpdateSchema,
    })
  ),
  version: z.literal(FORMAT_VERSION),
});

export type WebhookOutboxOptions = Readonly<{
  beforePersist?: () => Promise<void> | void;
  fetch?: typeof fetch;
  maxPending: number;
  isGroupConversation?: (conversationId: string) => boolean;
  markRead?: (messageId: string, signal: AbortSignal) => Promise<void> | void;
  now?: () => number;
  profileKey: string;
  secret?: string;
  storagePath: string;
  timeoutMs: number;
  url?: string;
}>;

function compareCursor(left: Cursor, right: Cursor): number {
  return left.receivedAt - right.receivedAt || left.id.localeCompare(right.id);
}

function cursorFor(message: MessageAttributesType): Cursor | undefined {
  if (!message.id || !Number.isSafeInteger(message.received_at))
    return undefined;
  return { id: message.id, receivedAt: message.received_at };
}

function isSupportedIncoming(
  message: MessageAttributesType
): message is MessageAttributesType & { body: string; id: string } {
  return (
    message.type === 'incoming' &&
    typeof message.id === 'string' &&
    typeof message.body === 'string' &&
    message.body.length > 0 &&
    (message.attachments?.length ?? 0) === 0
  );
}

function stableUpdateId(messageId: string): string {
  const digest = createHash('sha256').update(messageId).digest();
  return (digest.readBigUInt64BE() % 0x8000_0000_0000_0000n).toString();
}

function toWebhookUpdate(
  message: MessageAttributesType
): WebhookUpdate | undefined {
  if (!isSupportedIncoming(message) || !message.sourceServiceId)
    return undefined;
  return {
    message: {
      chat: { id: message.sourceServiceId, type: 'private' },
      date: message.sent_at,
      from: { id: message.sourceServiceId },
      message_id: message.id,
      ...(message.quote?.authorAci && message.quote.id != null
        ? {
            reply_to_message: {
              chat: { id: message.sourceServiceId, type: 'private' as const },
              date: message.quote.id,
              from: { id: message.quote.authorAci },
              message_id: String(message.quote.id),
              text: message.quote.text ?? '',
            },
          }
        : {}),
      text: message.body,
    },
    webhook_update_id: stableUpdateId(message.id),
  };
}

function retryDelay(attempts: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.min(attempts - 1, 8));
}

export class DurableWebhookOutbox {
  readonly #beforePersist: (() => Promise<void> | void) | undefined;
  readonly #filePath: string;
  readonly #fetch: typeof fetch;
  readonly #key: Buffer<ArrayBuffer>;
  readonly #maxPending: number;
  readonly #isGroupConversation:
    | ((conversationId: string) => boolean)
    | undefined;
  readonly #markRead:
    | ((messageId: string, signal: AbortSignal) => Promise<void> | void)
    | undefined;
  readonly #now: () => number;
  readonly #secret: string | undefined;
  readonly #sql: HeadlessSql;
  readonly #timeoutMs: number;
  readonly #url: string | undefined;
  readonly #groupConversationIds = new Set<string>();
  #abortController: AbortController | undefined;
  #state: State = { entries: [], version: FORMAT_VERSION };
  #tail = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  public constructor(sql: HeadlessSql, options: WebhookOutboxOptions) {
    this.#beforePersist = options.beforePersist;
    this.#sql = sql;
    this.#filePath = join(options.storagePath, OUTBOX_FILE);
    this.#fetch = options.fetch ?? fetch;
    this.#key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(options.profileKey, 'utf8'),
        Buffer.alloc(0),
        'signal-desktop-cli/webhook-outbox/v1',
        32
      )
    );
    this.#maxPending = options.maxPending;
    this.#isGroupConversation = options.isGroupConversation;
    this.#markRead = options.markRead;
    this.#now = options.now ?? Date.now;
    this.#secret = options.secret;
    this.#timeoutMs = options.timeoutMs;
    this.#url = options.url;
  }

  public get pendingCount(): number {
    return this.#state.entries.length;
  }

  public async checkEndpoint(): Promise<void> {
    if (!this.#url) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(this.#url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        throw new Error('Webhook startup check failed', { cause: error });
      }
      await response.body?.cancel().catch(() => undefined);
      if (response.status !== 200) {
        throw new Error(
          `Webhook startup check returned HTTP ${response.status}; expected 200`
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  public async prepare(): Promise<void> {
    let exists = true;
    try {
      const metadata = await stat(this.#filePath);
      if (metadata.size > MAX_ENCRYPTED_FILE_BYTES) {
        throw new Error('Webhook outbox exceeds the maximum encrypted size');
      }
      this.#state = this.#decrypt(await readFile(this.#filePath, 'utf8'));
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        throw new Error('Webhook outbox cannot be decrypted', { cause: error });
      }
      exists = false;
    }
    if (!exists) {
      const messages = await this.#allMessages();
      const cursor = messages.at(-1)?.cursor;
      await this.#commit({
        ...(cursor ? { cursor } : {}),
        entries: [],
        version: FORMAT_VERSION,
      });
      return;
    }
    await this.#reconcile();
  }

  public start(): void {
    if (!this.#url || this.#running) return;
    this.#running = true;
    this.#schedule(0);
  }

  public async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#abortController?.abort();
    await this.#tail;
  }

  public enqueue(message: MessageAttributesType): Promise<void> {
    return this.#serialize(async () => {
      const cursor = cursorFor(message);
      if (!cursor) throw new Error('Incoming message has no durable cursor');
      if (
        this.#state.cursor &&
        compareCursor(cursor, this.#state.cursor) <= 0
      ) {
        return;
      }
      const update = toWebhookUpdate(message);
      if (!update || !this.#url || this.#isGroup(message.conversationId)) {
        await this.#commit({ ...this.#state, cursor });
        return;
      }
      if (this.#state.entries.length >= this.#maxPending) {
        throw new Error('Webhook outbox is full');
      }
      if (
        this.#state.entries.some(
          entry => entry.update.message.message_id === message.id
        )
      ) {
        return;
      }
      await this.#commit({
        cursor,
        entries: [
          ...this.#state.entries,
          { attempts: 0, nextAttemptAt: this.#now(), update },
        ],
        version: FORMAT_VERSION,
      });
      this.#schedule(0);
    });
  }

  async #allMessages(): Promise<
    Array<{ cursor: Cursor; message: MessageAttributesType }>
  > {
    const records = await this.#sql.read('_getAllMessages');
    if (!this.#isGroupConversation) {
      const conversations = await this.#sql.read('getAllConversations');
      this.#groupConversationIds.clear();
      for (const conversation of conversations) {
        if (conversation.type === 'group') {
          this.#groupConversationIds.add(conversation.id);
        }
      }
    }
    return records
      .map(message => ({ cursor: cursorFor(message), message }))
      .filter(
        (value): value is { cursor: Cursor; message: MessageAttributesType } =>
          value.cursor != null && value.message.type === 'incoming'
      )
      .sort((left, right) => compareCursor(left.cursor, right.cursor));
  }

  async #reconcile(): Promise<void> {
    let nextState = this.#state;
    for (const { cursor, message } of await this.#allMessages()) {
      if (nextState.cursor && compareCursor(cursor, nextState.cursor) <= 0) {
        continue;
      }
      if (
        this.#url &&
        toWebhookUpdate(message) &&
        !this.#isGroup(message.conversationId) &&
        nextState.entries.length >= this.#maxPending
      ) {
        break;
      }
      const update =
        this.#url && !this.#isGroup(message.conversationId)
          ? toWebhookUpdate(message)
          : undefined;
      nextState = {
        cursor,
        entries: update
          ? [
              ...nextState.entries,
              { attempts: 0, nextAttemptAt: this.#now(), update },
            ]
          : nextState.entries,
        version: FORMAT_VERSION,
      };
    }
    await this.#commit(nextState);
  }

  #isGroup(conversationId: string): boolean {
    return (
      this.#isGroupConversation?.(conversationId) ??
      this.#groupConversationIds.has(conversationId)
    );
  }

  #schedule(delayMs: number): void {
    if (!this.#running || !this.#url || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      // oxlint-disable-next-line promise/prefer-await-to-then -- timer must contain delivery failures
      void this.#serialize(() => this.#deliverOne()).catch(() => {
        this.#schedule(1_000);
      });
    }, delayMs);
    this.#timer.unref();
  }

  async #deliverOne(): Promise<void> {
    if (!this.#running || !this.#url) return;
    const entry = this.#state.entries[0];
    if (!entry) {
      await this.#reconcile();
      if (this.#state.entries.length > 0) this.#schedule(0);
      return;
    }
    const wait = entry.nextAttemptAt - this.#now();
    if (wait > 0) {
      this.#schedule(wait);
      return;
    }
    const body = JSON.stringify(entry.update);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.#secret) {
      headers['x-signal-webhook-signature'] =
        `sha256=${createHmac('sha256', this.#secret).update(body).digest('hex')}`;
    }
    const controller = new AbortController();
    this.#abortController = controller;
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let succeeded = false;
    try {
      const response = await this.#fetch(this.#url, {
        body,
        headers,
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
      });
      succeeded = response.status >= 200 && response.status < 300;
    } catch {
      // Network errors and timeouts remain durable and are retried.
    } finally {
      clearTimeout(timeout);
    }
    try {
      if (!this.#running) return;
      if (succeeded) {
        try {
          await this.#markRead?.(
            entry.update.message.message_id,
            controller.signal
          );
        } catch {
          if (this.#running) await this.#retry(entry);
          return;
        }
        await this.#commit({
          ...this.#state,
          entries: this.#state.entries.slice(1),
        });
        await this.#reconcile();
        this.#schedule(0);
        return;
      }
      await this.#retry(entry);
    } finally {
      if (this.#abortController === controller) {
        this.#abortController = undefined;
      }
    }
  }

  async #retry(entry: Entry): Promise<void> {
    const attempts = entry.attempts + 1;
    const delay = retryDelay(attempts);
    await this.#commit({
      ...this.#state,
      entries: [
        { ...entry, attempts, nextAttemptAt: this.#now() + delay },
        ...this.#state.entries.slice(1),
      ],
    });
    this.#schedule(delay);
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    // oxlint-disable-next-line promise/prefer-await-to-then, signal-desktop/no-then -- ordered durability tail
    const result = this.#tail.then(operation);
    // oxlint-disable-next-line promise/prefer-await-to-then -- keep the outbox tail usable after failure
    this.#tail = result.catch(() => undefined);
    return result;
  }

  #encrypt(state: State): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state), 'utf8'),
      cipher.final(),
    ]);
    return JSON.stringify({
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      version: FORMAT_VERSION,
    } satisfies EncryptedState);
  }

  #decrypt(value: string): State {
    const envelope = encryptedStateSchema.parse(
      JSON.parse(value)
    ) as EncryptedState;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key,
      Buffer.from(envelope.nonce, 'base64')
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const state = stateSchema.parse(JSON.parse(plaintext)) as State;
    if (state.entries.length > this.#maxPending)
      throw new Error('Outbox has too many entries');
    return state;
  }

  async #commit(nextState: State): Promise<void> {
    if (nextState === this.#state) return;
    await this.#persist(nextState);
    this.#state = nextState;
  }

  async #persist(state: State): Promise<void> {
    const temporary = `${this.#filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const encrypted = this.#encrypt(state);
    if (Buffer.byteLength(encrypted) > MAX_ENCRYPTED_FILE_BYTES) {
      throw new Error('Webhook outbox exceeds the maximum encrypted size');
    }
    await this.#beforePersist?.();
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(encrypted, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.#filePath);
    const directory = await open(dirname(this.#filePath), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
