// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import packageJson from '../../package.json' with { type: 'json' };

import { loadDaemonConfig } from './config.node.ts';
import { waitForTermination } from './lifecycle.node.ts';
import { DaemonRuntime } from './runtime.node.ts';

async function main(): Promise<void> {
  const config = loadDaemonConfig();
  const runtime = new DaemonRuntime(config, {
    appVersion: packageJson.version,
    loadProfile: (await import('./profile.node.ts')).loadPortableProfile,
    openSql: (await import('./sql.node.ts')).openHeadlessSql,
    openProtocolStores: (await import('./protocol_stores.node.ts'))
      .openHeadlessProtocolStores,
  });

  await runtime.start();
  // oxlint-disable-next-line no-console
  console.info('signal-daemon: ready', runtime.getStatus());
  await waitForTermination({
    onSignal(signal) {
      // oxlint-disable-next-line no-console
      console.info(`signal-daemon: received ${signal}; checkpointing database`);
    },
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    stop: () => runtime.stop(),
  });
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.error(
      'signal-daemon: startup failed:',
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  }
}

void run();
