// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ErrorCode, Net } from '@signalapp/libsignal-client';
import type {
  AuthenticatedChatConnection,
  ChatServerMessageAck,
  ChatServiceListener,
} from '@signalapp/libsignal-client/dist/net/Chat.js';

import { getUserAgent } from '../util/getUserAgent.node.ts';
import type { ProtocolRuntime } from './runtime.node.ts';

export type HeadlessTransportCredentials = Readonly<{
  password: string;
  username: string;
}>;

export type HeadlessIncomingRequest = Readonly<{
  body?: Uint8Array<ArrayBuffer>;
  respond: (status: number) => void;
  timestamp?: number;
  type: 'message' | 'queue-empty';
}>;

export type HeadlessTransportClose = Readonly<{
  reason: string;
  retry: boolean;
}>;

export type HeadlessTransportConnection = Readonly<{
  disconnect: () => Promise<void> | void;
  localPort?: number;
}>;

export type HeadlessTransportConnector = Readonly<{
  connect: (
    credentials: HeadlessTransportCredentials,
    callbacks: Readonly<{
      onClose: (close: HeadlessTransportClose) => void;
      onRequest: (request: HeadlessIncomingRequest) => void;
    }>,
    signal: AbortSignal
  ) => Promise<HeadlessTransportConnection>;
}>;

export type HeadlessTransportState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'failed'
  | 'stopping'
  | 'stopped';

export type HeadlessTransportOptions = Readonly<{
  maxPendingRequests?: number;
  reconnectDelay?: (attempt: number, signal: AbortSignal) => Promise<void>;
}>;

export type HeadlessTransportRuntime = ProtocolRuntime &
  Readonly<{
    failureReason?: string;
    pendingRequestCount: number;
    setRequestHandler: (
      handler:
        | ((request: HeadlessIncomingRequest) => Promise<void> | void)
        | null
    ) => void;
    state: HeadlessTransportState;
  }>;

const DEFAULT_MAX_PENDING_REQUESTS = 1_000;
const RECONNECT_DELAYS = [1_000, 2_000, 3_000, 5_000, 8_000, 13_000, 21_000];

function defaultReconnectDelay(
  attempt: number,
  signal: AbortSignal
): Promise<void> {
  const delay =
    RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Transport reconnect aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getCredentials(
  items: Record<string, unknown>
): HeadlessTransportCredentials {
  const username = items.uuid_id ?? items.number_id;
  const password = items.password;
  if (typeof username !== 'string' || username.length === 0) {
    throw new Error('Linked Signal profile has no network username');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Linked Signal profile has no network password');
  }
  return { password, username };
}

export class AuthenticatedHeadlessTransport implements HeadlessTransportRuntime {
  readonly #connector: HeadlessTransportConnector;
  readonly #maxPendingRequests: number;
  readonly #reconnectDelay: (
    attempt: number,
    signal: AbortSignal
  ) => Promise<void>;
  readonly #pendingRequests = new Array<HeadlessIncomingRequest>();
  #abortController: AbortController | undefined;
  #connection: HeadlessTransportConnection | undefined;
  #credentials: HeadlessTransportCredentials | undefined;
  #failureReason: string | undefined;
  #generation = 0;
  #handler:
    | ((request: HeadlessIncomingRequest) => Promise<void> | void)
    | undefined;
  #reconnectAttempt = 0;
  #state: HeadlessTransportState = 'idle';

  constructor(
    connector: HeadlessTransportConnector,
    options: HeadlessTransportOptions = {}
  ) {
    this.#connector = connector;
    this.#maxPendingRequests =
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    if (
      !Number.isSafeInteger(this.#maxPendingRequests) ||
      this.#maxPendingRequests < 1
    ) {
      throw new Error('maxPendingRequests must be a positive safe integer');
    }
    this.#reconnectDelay = options.reconnectDelay ?? defaultReconnectDelay;
  }

  public get connected(): boolean {
    return this.#state === 'open';
  }

  public get failureReason(): string | undefined {
    return this.#failureReason;
  }

  public get pendingRequestCount(): number {
    return this.#pendingRequests.length;
  }

  public get state(): HeadlessTransportState {
    return this.#state;
  }

  public setRequestHandler(
    handler: ((request: HeadlessIncomingRequest) => Promise<void> | void) | null
  ): void {
    this.#handler = handler ?? undefined;
    if (!this.#handler || this.#pendingRequests.length === 0) {
      return;
    }
    const pending = this.#pendingRequests.splice(0);
    for (const request of pending) {
      this.#dispatch(request);
    }
  }

  public async start({
    items,
  }: Parameters<ProtocolRuntime['start']>[0]): Promise<void> {
    if (this.#state !== 'idle') {
      throw new Error(`Cannot start transport from state ${this.#state}`);
    }
    this.#credentials = getCredentials(items);
    this.#failureReason = undefined;
    this.#abortController = new AbortController();
    this.#state = 'connecting';
    try {
      await this.#connect(false);
    } catch (error) {
      this.#state = 'failed';
      this.#failureReason =
        error instanceof Error ? error.message : String(error);
      this.#abortController.abort(error);
      this.#abortController = undefined;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#state === 'stopped') {
      return;
    }
    this.#state = 'stopping';
    this.#generation += 1;
    this.#abortController?.abort(new Error('Transport stopped'));
    this.#abortController = undefined;
    const connection = this.#connection;
    this.#connection = undefined;
    this.#credentials = undefined;
    this.#pendingRequests.splice(0);
    if (connection) {
      await connection.disconnect();
    }
    this.#state = 'stopped';
  }

  async #connect(isReconnect: boolean): Promise<void> {
    const controller = this.#abortController;
    const credentials = this.#credentials;
    if (!controller || !credentials || controller.signal.aborted) {
      return;
    }
    this.#state = isReconnect ? 'reconnecting' : 'connecting';
    this.#generation += 1;
    const generation = this.#generation;
    const connection = await this.#connector.connect(
      credentials,
      {
        onClose: close => this.#onClose(generation, close),
        onRequest: request => this.#onRequest(request),
      },
      controller.signal
    );
    if (generation !== this.#generation || controller.signal.aborted) {
      await connection.disconnect();
      return;
    }
    this.#connection = connection;
    this.#reconnectAttempt = 0;
    this.#state = 'open';
  }

  #onClose(generation: number, close: HeadlessTransportClose): void {
    if (generation !== this.#generation || this.#state === 'stopping') {
      return;
    }
    this.#connection = undefined;
    if (!close.retry) {
      this.#failureReason = close.reason;
      this.#state = 'failed';
      this.#abortController?.abort(new Error(close.reason));
      this.#abortController = undefined;
      return;
    }
    void this.#reconnect();
  }

  async #reconnect(): Promise<void> {
    const controller = this.#abortController;
    if (!controller || controller.signal.aborted) {
      return;
    }
    this.#state = 'reconnecting';
    const attempt = this.#reconnectAttempt;
    this.#reconnectAttempt += 1;
    try {
      await this.#reconnectDelay(attempt, controller.signal);
      await this.#connect(true);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      this.#failureReason =
        error instanceof Error ? error.message : String(error);
      void this.#reconnect();
    }
  }

  #onRequest(request: HeadlessIncomingRequest): void {
    if (this.#handler) {
      this.#dispatch(request);
      return;
    }
    if (this.#pendingRequests.length >= this.#maxPendingRequests) {
      const reason = `Incoming Signal request queue exceeded ${this.#maxPendingRequests}`;
      this.#failureReason = reason;
      this.#state = 'failed';
      this.#abortController?.abort(new Error(reason));
      this.#abortController = undefined;
      const connection = this.#connection;
      this.#connection = undefined;
      if (connection) {
        void connection.disconnect();
      }
      return;
    }
    this.#pendingRequests.push(request);
  }

  #dispatch(request: HeadlessIncomingRequest): void {
    const handler = this.#handler;
    if (!handler) {
      return;
    }
    void this.#runHandler(handler, request);
  }

  async #runHandler(
    handler: (request: HeadlessIncomingRequest) => Promise<void> | void,
    request: HeadlessIncomingRequest
  ): Promise<void> {
    try {
      await handler(request);
    } catch (error) {
      this.#failureReason =
        error instanceof Error ? error.message : String(error);
    }
  }
}

function classifyInterruption(
  cause: Readonly<{ code: number; message: string }> | null
): HeadlessTransportClose {
  if (cause == null) {
    return { reason: 'Signal chat connection closed', retry: true };
  }
  const retry =
    cause.code !== ErrorCode.ConnectedElsewhere &&
    cause.code !== ErrorCode.DeviceDelinked &&
    cause.code !== ErrorCode.AppExpired;
  return { reason: cause.message, retry };
}

export function createLibsignalTransportConnector({
  appVersion,
  disableIPv6 = false,
  proxyUrl,
}: Readonly<{
  appVersion: string;
  disableIPv6?: boolean;
  proxyUrl?: string;
}>): HeadlessTransportConnector {
  const network = new Net.Net({
    env: Net.Environment.Production,
    userAgent: getUserAgent(appVersion),
  });
  network.setIpv6Enabled(!disableIPv6);
  if (proxyUrl) {
    network.setProxyFromUrl(proxyUrl);
  }

  return {
    async connect(credentials, callbacks, signal) {
      const listener: ChatServiceListener = {
        onConnectionInterrupted(cause) {
          callbacks.onClose(classifyInterruption(cause));
        },
        onIncomingMessage(envelope, timestamp, ack) {
          callbacks.onRequest(
            createIncomingMessageRequest(envelope, timestamp, ack)
          );
        },
        onQueueEmpty() {
          callbacks.onRequest({
            respond() {
              return undefined;
            },
            type: 'queue-empty',
          });
        },
        onReceivedAlerts() {
          return undefined;
        },
      };
      const connection: AuthenticatedChatConnection =
        await network.connectAuthenticatedChat(
          credentials.username,
          credentials.password,
          false,
          listener,
          { abortSignal: signal, languages: ['en'] }
        );
      return {
        async disconnect() {
          await connection.disconnect();
        },
        localPort: connection.connectionInfo().localPort,
      };
    },
  };
}

function createIncomingMessageRequest(
  body: Uint8Array<ArrayBuffer>,
  timestamp: number,
  ack: ChatServerMessageAck
): HeadlessIncomingRequest {
  let responded = false;
  return {
    body,
    respond(status) {
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error(`Invalid Signal acknowledgement status: ${status}`);
      }
      if (responded) {
        throw new Error('Signal request has already been acknowledged');
      }
      responded = true;
      ack.send(status);
    },
    timestamp,
    type: 'message',
  };
}

export function createHeadlessTransportRuntime(
  appVersion: string,
  options: HeadlessTransportOptions = {}
): AuthenticatedHeadlessTransport {
  return new AuthenticatedHeadlessTransport(
    createLibsignalTransportConnector({ appVersion }),
    options
  );
}
