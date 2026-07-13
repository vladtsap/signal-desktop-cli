// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable signal-desktop/enforce-file-suffix -- Node process signal lifecycle

export type SignalSource = Pick<NodeJS.Process, 'once' | 'removeListener'>;

export async function waitForTermination({
  onSignal,
  shutdownTimeoutMs,
  signalSource = process,
  stop,
}: Readonly<{
  onSignal?: (signal: NodeJS.Signals) => void;
  shutdownTimeoutMs: number;
  signalSource?: SignalSource;
  stop: () => Promise<void>;
}>): Promise<void> {
  const { promise, reject, resolve } = Promise.withResolvers<void>();
  let shuttingDown = false;

  // An unresolved Promise does not keep Node's event loop alive. Keep one
  // explicitly referenced handle until a termination signal has fully drained
  // the runtime.
  const keepAlive = setInterval(() => undefined, 60_000);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    onSignal?.(signal);

    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((_resolve, rejectTimeout) => {
      timeout = setTimeout(() => {
        rejectTimeout(
          new Error(`Graceful shutdown timed out after ${shutdownTimeoutMs}ms`)
        );
      }, shutdownTimeoutMs);
    });

    try {
      await Promise.race([stop(), timeoutPromise]);
      resolve();
    } catch (error) {
      reject(error);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };

  const onSigint = () => void shutdown('SIGINT');
  const onSigterm = () => void shutdown('SIGTERM');
  signalSource.once('SIGINT', onSigint);
  signalSource.once('SIGTERM', onSigterm);

  try {
    await promise;
  } finally {
    clearInterval(keepAlive);
    signalSource.removeListener('SIGINT', onSigint);
    signalSource.removeListener('SIGTERM', onSigterm);
  }
}
