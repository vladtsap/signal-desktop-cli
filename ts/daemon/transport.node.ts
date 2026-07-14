// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  ErrorCode,
  Net,
  ServiceId,
  type CiphertextMessage,
} from '@signalapp/libsignal-client';
import type {
  AuthenticatedChatConnection,
  ChatServerMessageAck,
  ChatServiceListener,
} from '@signalapp/libsignal-client/dist/net/Chat.js';

import { getUserAgent } from '../util/getUserAgent.node.ts';
import type { ProtocolRuntime } from './runtime.node.ts';
import { captureDaemonError } from './monitoring.node.ts';

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
  fetch?: AuthenticatedChatConnection['fetch'];
  keepalive?: (signal: AbortSignal, timeoutMs: number) => Promise<void> | void;
  localPort?: number;
  sendMessage?: AuthenticatedChatConnection['sendMessage'];
}>;

export type HeadlessOutboundMessage = Readonly<{
  contents: CiphertextMessage;
  deviceId: number;
  registrationId: number;
}>;

export type HeadlessSendTransport = Readonly<{
  connected: boolean;
  fetchAuthenticated: (
    request: Parameters<AuthenticatedChatConnection['fetch']>[0],
    options?: Parameters<AuthenticatedChatConnection['fetch']>[1]
  ) => ReturnType<AuthenticatedChatConnection['fetch']>;
  sendMessage: (
    request: Readonly<{
      destination: string;
      messages: ReadonlyArray<HeadlessOutboundMessage>;
      onlineOnly?: boolean;
      signal?: AbortSignal;
      timestamp: number;
      urgent?: boolean;
    }>
  ) => Promise<void>;
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
  keepaliveIntervalMs?: number;
  keepaliveTimeoutMs?: number;
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
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 30_000;
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
  readonly #keepaliveIntervalMs: number;
  readonly #keepaliveTimeoutMs: number;
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
  #keepaliveTimer: NodeJS.Timeout | undefined;
  #reconnectAttempt = 0;
  #state: HeadlessTransportState = 'idle';

  constructor(
    connector: HeadlessTransportConnector,
    options: HeadlessTransportOptions = {}
  ) {
    this.#connector = connector;
    this.#keepaliveIntervalMs =
      options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.#keepaliveTimeoutMs =
      options.keepaliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS;
    this.#maxPendingRequests =
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    for (const [name, value] of [
      ['keepaliveIntervalMs', this.#keepaliveIntervalMs],
      ['keepaliveTimeoutMs', this.#keepaliveTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
      }
    }
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

  public async fetchAuthenticated(
    request: Parameters<AuthenticatedChatConnection['fetch']>[0],
    options?: Parameters<AuthenticatedChatConnection['fetch']>[1]
  ): ReturnType<AuthenticatedChatConnection['fetch']> {
    const connection = this.#getOpenConnection();
    if (!connection.fetch) {
      throw new Error('Authenticated Signal transport does not support fetch');
    }
    return connection.fetch(request, options);
  }

  public async sendMessage({
    destination,
    messages,
    onlineOnly = false,
    signal,
    timestamp,
    urgent = true,
  }: Parameters<HeadlessSendTransport['sendMessage']>[0]): Promise<void> {
    const connection = this.#getOpenConnection();
    if (!connection.sendMessage) {
      throw new Error(
        'Authenticated Signal transport does not support sending'
      );
    }
    await connection.sendMessage(
      {
        destination: ServiceId.parseFromServiceIdString(destination),
        contents: [...messages],
        onlineOnly,
        timestamp,
        urgent,
      },
      { abortSignal: signal }
    );
  }

  #getOpenConnection(): HeadlessTransportConnection {
    if (this.#state !== 'open' || !this.#connection) {
      throw new Error(
        `Signal transport is not connected (state: ${this.#state})`
      );
    }
    return this.#connection;
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
    this.#clearKeepalive();
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
        onRequest: request => this.#onRequest(generation, request),
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
    this.#scheduleKeepalive(generation);
  }

  #onClose(generation: number, close: HeadlessTransportClose): void {
    if (generation !== this.#generation || this.#state === 'stopping') {
      return;
    }
    captureDaemonError(new Error(close.reason), 'transport.close', {
      retry: close.retry,
    });
    this.#clearKeepalive();
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
      captureDaemonError(error, 'transport.reconnect');
      this.#failureReason =
        error instanceof Error ? error.message : String(error);
      void this.#reconnect();
    }
  }

  #onRequest(generation: number, request: HeadlessIncomingRequest): void {
    if (generation !== this.#generation || this.#state === 'stopping') {
      if (request.type === 'message') request.respond(503);
      return;
    }
    this.#scheduleKeepalive(generation);
    if (this.#handler) {
      this.#dispatch(request);
      return;
    }
    if (this.#pendingRequests.length >= this.#maxPendingRequests) {
      const reason = `Incoming Signal request queue exceeded ${this.#maxPendingRequests}`;
      captureDaemonError(new Error(reason), 'transport.incoming-overflow');
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
      captureDaemonError(error, 'transport.request-handler');
      this.#failureReason =
        error instanceof Error ? error.message : String(error);
    }
  }

  #scheduleKeepalive(generation: number): void {
    this.#clearKeepalive();
    if (
      generation !== this.#generation ||
      this.#state !== 'open' ||
      !this.#connection?.keepalive
    ) {
      return;
    }
    this.#keepaliveTimer = setTimeout(() => {
      this.#keepaliveTimer = undefined;
      void this.#runKeepalive(generation);
    }, this.#keepaliveIntervalMs);
    this.#keepaliveTimer.unref();
  }

  #clearKeepalive(): void {
    if (this.#keepaliveTimer) clearTimeout(this.#keepaliveTimer);
    this.#keepaliveTimer = undefined;
  }

  async #runKeepalive(generation: number): Promise<void> {
    const controller = this.#abortController;
    const connection = this.#connection;
    if (
      generation !== this.#generation ||
      !controller ||
      controller.signal.aborted ||
      this.#state !== 'open' ||
      !connection?.keepalive
    ) {
      return;
    }
    try {
      await connection.keepalive(controller.signal, this.#keepaliveTimeoutMs);
      this.#scheduleKeepalive(generation);
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation !== this.#generation ||
        connection !== this.#connection
      ) {
        return;
      }
      captureDaemonError(error, 'transport.keepalive');
      this.#failureReason =
        error instanceof Error ? error.message : String(error);
      this.#clearKeepalive();
      this.#generation += 1;
      this.#connection = undefined;
      this.#state = 'reconnecting';
      try {
        await connection.disconnect();
      } catch (disconnectError) {
        captureDaemonError(disconnectError, 'transport.keepalive-disconnect');
      }
      void this.#reconnect();
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
        fetch: connection.fetch.bind(connection),
        async keepalive(abortSignal, timeoutMs) {
          const response = await connection.fetch(
            {
              headers: [],
              path: '/v1/keepalive',
              timeoutMillis: timeoutMs,
              verb: 'GET',
            },
            { abortSignal }
          );
          if (response.status < 200 || response.status >= 300) {
            throw new Error(
              `Signal transport keepalive returned HTTP ${response.status}`
            );
          }
        },
        localPort: connection.connectionInfo().localPort,
        sendMessage: connection.sendMessage.bind(connection),
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
