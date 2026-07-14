// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { MessageAttributesType } from '../model-types.d.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import type { HeadlessSql } from './sql.node.ts';
import { DurableWebhookOutbox, type WebhookUpdate } from './webhook.node.ts';

function message(id: string, receivedAt: number): MessageAttributesType {
  return {
    attachments: [],
    body: `text-${id}`,
    conversationId: 'direct-conversation',
    id,
    received_at: receivedAt,
    sent_at: receivedAt * 1_000,
    sourceServiceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as AciString,
    timestamp: receivedAt * 1_000,
    type: 'incoming',
  } as MessageAttributesType;
}

function quotedMessage(id: string, receivedAt: number): MessageAttributesType {
  return {
    ...message(id, receivedAt),
    quote: {
      attachments: [],
      authorAci: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as AciString,
      id: 999_000,
      isViewOnce: false,
      referencedMessageNotFound: false,
      text: 'original text',
    },
  };
}

function fakeSql(messages: Array<MessageAttributesType>): HeadlessSql {
  return {
    close: async () => undefined,
    read: (async method => {
      if (method === '_getAllMessages') return messages;
      if (method === 'getAllConversations') {
        return [{ id: 'direct-conversation', type: 'private' }];
      }
      throw new Error(`Unexpected SQL read: ${method}`);
    }) as HeadlessSql['read'],
    write: (async () => {
      throw new Error('Unexpected SQL write');
    }) as HeadlessSql['write'],
  };
}

void test('startup endpoint check requires an exact HTTP 200 GET', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-webhook-check-'));
  const requests = new Array<RequestInit>();
  let status = 200;
  const outbox = new DurableWebhookOutbox(fakeSql([]), {
    fetch: async (_input, init) => {
      requests.push(init ?? {});
      return new Response(null, { status });
    },
    maxPending: 10,
    profileKey: 'ab'.repeat(32),
    storagePath,
    timeoutMs: 1_000,
    url: 'https://example.com/signal-webhook',
  });
  try {
    await outbox.checkEndpoint();
    assert.equal(requests[0]?.method, 'GET');
    assert.equal(requests[0]?.redirect, 'manual');

    status = 204;
    await assert.rejects(outbox.checkEndpoint(), /HTTP 204; expected 200/);
  } finally {
    await outbox.stop();
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('startup endpoint check fails on network errors', async () => {
  const storagePath = await mkdtemp(
    join(tmpdir(), 'signal-webhook-check-error-')
  );
  const outbox = new DurableWebhookOutbox(fakeSql([]), {
    fetch: async () => {
      throw new Error('offline');
    },
    maxPending: 10,
    profileKey: 'ab'.repeat(32),
    storagePath,
    timeoutMs: 1_000,
    url: 'https://example.com/signal-webhook',
  });
  try {
    await assert.rejects(
      outbox.checkEndpoint(),
      /Webhook startup check failed/
    );
  } finally {
    await outbox.stop();
    await rm(storagePath, { force: true, recursive: true });
  }
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for webhook');
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling must be sequential
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function encryptLegacyOutbox(profileKey: string): string {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(profileKey, 'utf8'),
      Buffer.alloc(0),
      'signal-desktop-cli/webhook-outbox/v1',
      32
    )
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = JSON.stringify({
    cursor: { id: 'legacy-message', receivedAt: 1 },
    entries: [
      {
        attempts: 0,
        nextAttemptAt: 0,
        update: {
          message: {
            chat: { id: 'sender-aci', type: 'private' },
            date: 1_000,
            from: { id: 'sender-aci' },
            message_id: 'legacy-message',
            text: 'legacy text',
          },
          update_id: '1234',
        },
      },
    ],
    version: 1,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return JSON.stringify({
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    version: 1,
  });
}

void test('legacy outbox IDs migrate to webhook_update_id', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-webhook-legacy-'));
  const profileKey = '12'.repeat(32);
  const bodies = new Array<string>();
  await writeFile(
    join(storagePath, 'headless-webhook-outbox.enc'),
    encryptLegacyOutbox(profileKey)
  );
  const outbox = new DurableWebhookOutbox(fakeSql([]), {
    fetch: async (_input, init) => {
      const body = init?.body;
      if (typeof body !== 'string') throw new Error('Expected string body');
      bodies.push(body);
      return new Response(null, { status: 204 });
    },
    maxPending: 10,
    profileKey,
    storagePath,
    timeoutMs: 1_000,
    url: 'https://example.com/signal-webhook',
  });
  try {
    await outbox.prepare();
    assert.equal(outbox.pendingCount, 1);
    outbox.start();
    await waitFor(() => bodies.length === 1 && outbox.pendingCount === 0);
    assert.deepEqual(JSON.parse(bodies[0] ?? ''), {
      message: {
        chat: { id: 'sender-aci', type: 'private' },
        date: 1_000,
        from: { id: 'sender-aci' },
        message_id: 'legacy-message',
        text: 'legacy text',
      },
      webhook_update_id: '1234',
    });
  } finally {
    await outbox.stop();
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('outbox encrypts, signs, retries, and delivers in order', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-webhook-'));
  const requests = new Array<{ body: string; signature?: string }>();
  const markedRead = new Array<string>();
  let responseCount = 0;
  const server = createServer((request, response) => {
    const chunks = new Array<Buffer<ArrayBuffer>>();
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requests.push({
        body: Buffer.concat(chunks).toString('utf8'),
        ...(typeof request.headers['x-signal-webhook-signature'] === 'string'
          ? { signature: request.headers['x-signal-webhook-signature'] }
          : {}),
      });
      responseCount += 1;
      response.writeHead(responseCount === 1 ? 500 : 204).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const messages = new Array<MessageAttributesType>();
  const outbox = new DurableWebhookOutbox(fakeSql(messages), {
    maxPending: 10,
    markRead: messageId => {
      markedRead.push(messageId);
    },
    profileKey: 'ab'.repeat(32),
    secret: 'webhook-secret-at-least-sixteen',
    storagePath,
    timeoutMs: 1_000,
    url: `http://127.0.0.1:${address.port}/hook`,
  });
  try {
    await outbox.prepare();
    const firstMessage = message('message-one', 1);
    messages.push(firstMessage);
    await outbox.enqueue(firstMessage);
    outbox.start();
    await waitFor(() => requests.length === 2 && outbox.pendingCount === 0);
    assert.equal(requests[0]?.body, requests[1]?.body);
    assert.deepEqual(markedRead, ['message-one']);
    assert.match(requests[0]?.signature ?? '', /^sha256=[0-9a-f]{64}$/);
    const update = JSON.parse(requests[1]?.body ?? '') as Record<
      string,
      unknown
    >;
    assert.equal(typeof update.webhook_update_id, 'string');
    assert.ok(!('update_id' in update));
    assert.equal(
      (update.message as { message_id: string }).message_id,
      'message-one'
    );
    assert.deepEqual(update.message, {
      chat: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        type: 'private',
      },
      date: 1_000,
      from: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      message_id: 'message-one',
      text: 'text-message-one',
    });
    const encrypted = await readFile(
      join(storagePath, 'headless-webhook-outbox.enc'),
      'utf8'
    );
    assert.doesNotMatch(encrypted, /text-message-one/);
  } finally {
    await outbox.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('startup reconciliation closes the save-to-enqueue crash gap', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-webhook-gap-'));
  const messages = new Array<MessageAttributesType>();
  const options = {
    maxPending: 10,
    profileKey: 'cd'.repeat(32),
    storagePath,
    timeoutMs: 1_000,
    url: 'http://127.0.0.1:1/hook',
  } as const;
  try {
    const beforeCrash = new DurableWebhookOutbox(fakeSql(messages), options);
    await beforeCrash.prepare();
    await beforeCrash.stop();
    messages.push(message('saved-before-crash', 2));

    const restarted = new DurableWebhookOutbox(fakeSql(messages), options);
    await restarted.prepare();
    assert.equal(restarted.pendingCount, 1);
    await restarted.stop();
  } finally {
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('webhook includes quoted reply context', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-webhook-quote-'));
  const messages = new Array<MessageAttributesType>();
  let delivered: WebhookUpdate | undefined;
  const outbox = new DurableWebhookOutbox(fakeSql(messages), {
    fetch: async (_input, init) => {
      const body = init?.body;
      if (typeof body !== 'string') throw new Error('Expected string body');
      delivered = JSON.parse(body) as WebhookUpdate;
      return new Response(null, { status: 204 });
    },
    maxPending: 10,
    profileKey: '12'.repeat(32),
    storagePath,
    timeoutMs: 1_000,
    url: 'https://example.com/signal-webhook',
  });
  try {
    await outbox.prepare();
    const value = quotedMessage('quoted-reply', 3);
    messages.push(value);
    await outbox.enqueue(value);
    outbox.start();
    await waitFor(() => delivered != null && outbox.pendingCount === 0);
    assert.deepEqual(delivered?.message.reply_to_message, {
      chat: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        type: 'private',
      },
      date: 999_000,
      from: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      message_id: '999000',
      text: 'original text',
    });
  } finally {
    await outbox.stop();
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('enqueue persistence failure rolls back cursor and in-memory entry', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-webhook-rollback-'));
  const messages = new Array<MessageAttributesType>();
  let failNextPersist = false;
  const outbox = new DurableWebhookOutbox(fakeSql(messages), {
    beforePersist() {
      if (failNextPersist) {
        failNextPersist = false;
        throw new Error('simulated fsync failure');
      }
    },
    maxPending: 10,
    profileKey: '34'.repeat(32),
    storagePath,
    timeoutMs: 1_000,
    url: 'http://127.0.0.1:1/hook',
  });
  try {
    await outbox.prepare();
    const value = message('retry-after-persist-failure', 4);
    messages.push(value);
    failNextPersist = true;
    await assert.rejects(outbox.enqueue(value), /simulated fsync failure/);
    assert.equal(outbox.pendingCount, 0);
    await outbox.enqueue(value);
    assert.equal(outbox.pendingCount, 1);
  } finally {
    await outbox.stop();
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('delivery commit failure retains and redelivers the entry', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-webhook-delivery-'));
  const messages = new Array<MessageAttributesType>();
  let deliveries = 0;
  const server = createServer((_request, response) => {
    deliveries += 1;
    response.writeHead(204).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const markedRead = new Array<string>();
  let failNextPersist = false;
  const outbox = new DurableWebhookOutbox(fakeSql(messages), {
    beforePersist() {
      if (failNextPersist) {
        failNextPersist = false;
        throw new Error('simulated delivery commit failure');
      }
    },
    maxPending: 10,
    markRead: messageId => {
      markedRead.push(messageId);
    },
    profileKey: '56'.repeat(32),
    storagePath,
    timeoutMs: 1_000,
    url: `http://127.0.0.1:${address.port}/hook`,
  });
  try {
    await outbox.prepare();
    const value = message('redeliver-after-commit-failure', 5);
    messages.push(value);
    await outbox.enqueue(value);
    failNextPersist = true;
    outbox.start();
    await waitFor(() => deliveries >= 1);
    assert.equal(outbox.pendingCount, 1);
    await waitFor(() => deliveries >= 2 && outbox.pendingCount === 0);
    await waitFor(() => markedRead.length === 1);
    assert.deepEqual(markedRead, ['redeliver-after-commit-failure']);
  } finally {
    await outbox.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('an active webhook POST does not block durable enqueue', async () => {
  const storagePath = await mkdtemp(
    join(tmpdir(), 'signal-webhook-concurrent-')
  );
  const messages = new Array<MessageAttributesType>();
  let deliveries = 0;
  let releaseFirstDelivery: (() => void) | undefined;
  const firstDelivery = new Promise<void>(resolve => {
    releaseFirstDelivery = resolve;
  });
  const outbox = new DurableWebhookOutbox(fakeSql(messages), {
    fetch: async () => {
      deliveries += 1;
      if (deliveries === 1) await firstDelivery;
      return new Response(null, { status: 204 });
    },
    maxPending: 10,
    profileKey: '66'.repeat(32),
    storagePath,
    timeoutMs: 1_000,
    url: 'https://example.com/signal-webhook',
  });
  try {
    await outbox.prepare();
    const first = message('slow-post', 6);
    messages.push(first);
    await outbox.enqueue(first);
    outbox.start();
    await waitFor(() => deliveries === 1);

    const second = message('enqueue-during-post', 7);
    messages.push(second);
    await Promise.race([
      outbox.enqueue(second),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('enqueue was blocked by POST')), 250);
      }),
    ]);
    assert.equal(outbox.pendingCount, 2);

    releaseFirstDelivery?.();
    await waitFor(() => deliveries === 2 && outbox.pendingCount === 0);
  } finally {
    releaseFirstDelivery?.();
    await outbox.stop();
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('read-marking failures do not redeliver successful webhooks', async () => {
  const storagePath = await mkdtemp(
    join(tmpdir(), 'signal-webhook-read-failure-')
  );
  const messages = new Array<MessageAttributesType>();
  let deliveries = 0;
  let markReadCalls = 0;
  const outbox = new DurableWebhookOutbox(fakeSql(messages), {
    fetch: async () => {
      deliveries += 1;
      return new Response(null, { status: 204 });
    },
    markRead: () => {
      markReadCalls += 1;
      throw new Error('simulated read failure');
    },
    maxPending: 10,
    profileKey: '67'.repeat(32),
    storagePath,
    timeoutMs: 1_000,
    url: 'https://example.com/signal-webhook',
  });
  try {
    await outbox.prepare();
    const value = message('redeliver-after-read-failure', 6);
    messages.push(value);
    await outbox.enqueue(value);
    outbox.start();
    await waitFor(
      () => deliveries === 1 && markReadCalls === 1 && outbox.pendingCount === 0
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(deliveries, 1);
    assert.equal(markReadCalls, 1);
  } finally {
    await outbox.stop();
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('stop aborts active post-webhook read actions', async () => {
  const storagePath = await mkdtemp(
    join(tmpdir(), 'signal-webhook-stop-read-')
  );
  const messages = new Array<MessageAttributesType>();
  let deliveries = 0;
  let markReadStarted = false;
  const outbox = new DurableWebhookOutbox(fakeSql(messages), {
    fetch: async () => {
      deliveries += 1;
      return new Response(null, { status: 204 });
    },
    markRead: async (_messageId, signal) => {
      markReadStarted = true;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
    maxPending: 10,
    profileKey: '68'.repeat(32),
    storagePath,
    timeoutMs: 1_000,
    url: 'https://example.com/signal-webhook',
  });
  try {
    await outbox.prepare();
    const value = message('abort-read-on-stop', 7);
    messages.push(value);
    await outbox.enqueue(value);
    outbox.start();
    await waitFor(() => markReadStarted);
    const next = message('deliver-while-read-action-is-pending', 8);
    messages.push(next);
    await outbox.enqueue(next);
    await waitFor(() => deliveries === 2 && outbox.pendingCount === 0);
    await outbox.stop();
    assert.equal(outbox.pendingCount, 0);
  } finally {
    await outbox.stop();
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('disabled webhook advances its cursor without accumulating entries', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'signal-webhook-off-'));
  const messages = new Array<MessageAttributesType>();
  const options = {
    maxPending: 1,
    profileKey: 'ef'.repeat(32),
    storagePath,
    timeoutMs: 1_000,
  } as const;
  try {
    const outbox = new DurableWebhookOutbox(fakeSql(messages), options);
    await outbox.prepare();
    for (let index = 1; index <= 3; index += 1) {
      const value = message(`disabled-${index}`, index);
      messages.push(value);
      // oxlint-disable-next-line eslint/no-await-in-loop -- verifies ordered cursor writes
      await outbox.enqueue(value);
    }
    assert.equal(outbox.pendingCount, 0);
    await outbox.stop();

    const restarted = new DurableWebhookOutbox(fakeSql(messages), options);
    await restarted.prepare();
    assert.equal(restarted.pendingCount, 0);
    await restarted.stop();
  } finally {
    await rm(storagePath, { force: true, recursive: true });
  }
});

void test('outbox reconciles a real SQLCipher message fixture', async () => {
  const fixture = fileURLToPath(
    new URL('./webhook_fixture.node.ts', import.meta.url)
  );
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import=tsx', fixture], {
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 0);
});
