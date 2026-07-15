// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import packageJson from '../../package.json' with { type: 'json' };
import productionConfig from '../../config/production.json' with { type: 'json' };
import localProductionConfig from '../../config/local-production.json' with { type: 'json' };

import { loadDaemonConfig } from './config.node.ts';
import { HeadlessControlService } from './api.node.ts';
import { waitForTermination } from './lifecycle.node.ts';
import { logDaemonError, logDaemonEvent } from './logging.std.ts';
import {
  captureDaemonError,
  closeDaemonMonitoring,
  initializeDaemonMonitoring,
} from './monitoring.node.ts';
import { DaemonRuntime } from './runtime.node.ts';

async function main(
  config: ReturnType<typeof loadDaemonConfig>
): Promise<void> {
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
  const prekeys = await import('./prekeys.node.ts');
  const maintainedProtocolRuntime = new prekeys.PreKeyMaintainedProtocolRuntime(
    protocolRuntime,
    context =>
      new prekeys.LibsignalPreKeyUpdater(
        context.protocolStores.itemStorage,
        context.protocolStores.signalProtocolStore,
        transport
      )
  );
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
    protocolRuntime: maintainedProtocolRuntime,
  });
  services.control = controlService;
  services.runtime = runtime;

  await runtime.start();
  const status = runtime.getStatus();
  logDaemonEvent('info', 'daemon.ready', {
    connected: status.connected,
    databaseReady: status.databaseReady,
    linked: status.linked,
    phase: status.phase,
    ready: status.ready,
  });
  await waitForTermination({
    onSignal(signal) {
      logDaemonEvent('info', 'daemon.shutdown.requested', { signal });
    },
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    stop: () => runtime.stop(),
  });
}

async function run(): Promise<void> {
  try {
    const config = loadDaemonConfig();
    initializeDaemonMonitoring({
      ...(config.sentryDsn ? { dsn: config.sentryDsn } : {}),
      release: `signal-desktop-cli@${packageJson.version}`,
    });
    await main(config);
  } catch (error) {
    captureDaemonError(error, 'daemon.run');
    logDaemonError('daemon.run.failed', error);
    process.exitCode = 1;
  } finally {
    await closeDaemonMonitoring();
  }
}

void run();
