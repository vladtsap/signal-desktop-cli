// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  ServerReadableDirectInterface,
  ServerWritableDirectInterface,
  WritableDB,
} from '../sql/Interface.std.ts';
import {
  DataReader as ServerDataReader,
  DataWriter as ServerDataWriter,
  initialize,
} from '../sql/Server.node.ts';
import { consoleLogger } from '../util/consoleLogger.std.ts';

export type HeadlessSql = Readonly<{
  close: () => Promise<void>;
  read: <Method extends keyof ServerReadableDirectInterface>(
    method: Method,
    ...args: Parameters<ServerReadableDirectInterface[Method]>
  ) => Promise<ReturnType<ServerReadableDirectInterface[Method]>>;
  write: <Method extends keyof ServerWritableDirectInterface>(
    method: Method,
    ...args: Parameters<ServerWritableDirectInterface[Method]>
  ) => Promise<ReturnType<ServerWritableDirectInterface[Method]>>;
}>;

/**
 * A single-connection SQL adapter for the daemon. The daemon serializes all
 * access on a promise chain, avoiding Electron IPC and the four-worker desktop
 * pool while retaining the exact same SQLCipher schema and migrations.
 */
export function openHeadlessSql({
  appVersion,
  key,
  storagePath,
}: Readonly<{
  appVersion: string;
  key: string;
  storagePath: string;
}>): HeadlessSql {
  const db = initialize({
    appVersion,
    configDir: storagePath,
    isPrimary: true,
    key,
    logger: consoleLogger,
  });
  let tail = Promise.resolve<unknown>(undefined);
  let closed = false;

  function enqueue<Result>(operation: (database: WritableDB) => Result) {
    if (closed) {
      return Promise.reject(new Error('Headless SQL adapter is closed'));
    }
    // oxlint-disable-next-line promise/prefer-await-to-then, signal-desktop/no-then -- queue tail serialization
    const result = tail.then(() => operation(db));
    // oxlint-disable-next-line promise/prefer-await-to-then -- keep the queue usable after a failed operation
    tail = result.catch(() => undefined);
    return result;
  }

  return {
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await tail;
      // Runs the WAL checkpoint and PRAGMA optimize before closing.
      ServerDataWriter.close(db);
    },
    read(method, ...args) {
      return enqueue(database => {
        const operation = ServerDataReader[method] as (
          target: WritableDB,
          ...parameters: typeof args
        ) => ReturnType<ServerReadableDirectInterface[typeof method]>;
        return operation(database, ...args);
      });
    },
    write(method, ...args) {
      return enqueue(database => {
        const operation = ServerDataWriter[method] as (
          target: WritableDB,
          ...parameters: typeof args
        ) => ReturnType<ServerWritableDirectInterface[typeof method]>;
        return operation(database, ...args);
      });
    },
  };
}
