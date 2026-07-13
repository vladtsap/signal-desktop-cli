// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import packageJson from '../../package.json' with { type: 'json' };
import productionConfig from '../../config/production.json' with { type: 'json' };
import localProductionConfig from '../../config/local-production.json' with { type: 'json' };

import { loadDaemonConfig } from './config.node.ts';
import { HeadlessControlService } from './api.node.ts';
import { waitForTermination } from './lifecycle.node.ts';
import { DaemonRuntime } from './runtime.node.ts';

async function main(): Promise<void> {
  const config = loadDaemonConfig();
  const transport = (
    await import('./transport.node.ts')
  ).createHeadlessTransportRuntime(packageJson.version);
  const services: {
    control?: HeadlessControlService;
    runtime?: DaemonRuntime;
  } = {};
  const protocolRuntime = (
    await import('./receive.node.ts')
  ).createHeadlessReceiveRuntime(transport, {
    onPersistedMessage: message => {
      if (!services.control) throw new Error('Control service is unavailable');
      return services.control.handleIncoming(message);
    },
    serverTrustRoots: productionConfig.serverTrustRoots,
  });
  const controlService = new HeadlessControlService(config, transport, {
    getStatus: () => {
      if (!services.runtime) throw new Error('Daemon runtime is unavailable');
      return services.runtime.getStatus();
    },
  });
  const runtime = new DaemonRuntime(config, {
    appVersion: packageJson.version,
    buildCreation: localProductionConfig.buildCreation,
    buildExpiration: localProductionConfig.buildExpiration,
    loadProfile: (await import('./profile.node.ts')).loadPortableProfile,
    openSql: (await import('./sql.node.ts')).openHeadlessSql,
    openProtocolStores: (await import('./protocol_stores.node.ts'))
      .openHeadlessProtocolStores,
    controlService,
    protocolRuntime,
  });
  services.control = controlService;
  services.runtime = runtime;

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
