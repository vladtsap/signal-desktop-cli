// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable signal-desktop/enforce-file-suffix -- Node daemon lifecycle boundary

import type { DaemonConfig } from './config.node.ts';
import type { HeadlessSql } from './sql.node.ts';
import type { HeadlessProtocolStores } from './protocol_stores.node.ts';

export type DaemonPhase =
  | 'created'
  | 'opening-profile'
  | 'database-ready'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type DaemonStatus = Readonly<{
  buildExpiration: Readonly<{
    days: 90;
    managedExternally: true;
  }>;
  connected: boolean;
  databaseReady: boolean;
  linked: boolean;
  phase: DaemonPhase;
  ready: boolean;
  reason?: string;
}>;

export type ProtocolRuntime = Readonly<{
  connected: boolean;
  start: (
    context: Readonly<{
      items: Record<string, unknown>;
      protocolStores: HeadlessProtocolStores;
      sql: HeadlessSql;
    }>
  ) => Promise<void> | void;
  stop: () => Promise<void> | void;
}>;

export type RuntimeServiceContext = Readonly<{
  items: Record<string, unknown>;
  profileSqlKey: string;
  protocolStores: HeadlessProtocolStores;
  sql: HeadlessSql;
}>;

export type RuntimeService = Readonly<{
  prepare: (context: RuntimeServiceContext) => Promise<void> | void;
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
}>;

export type RuntimeDependencies = Readonly<{
  appVersion: string;
  loadProfile: (storagePath: string) => Promise<{
    sqlKey: string;
    storagePath: string;
  }>;
  openSql: (
    options: Readonly<{
      appVersion: string;
      key: string;
      storagePath: string;
    }>
  ) => HeadlessSql;
  openProtocolStores: (sql: HeadlessSql) => Promise<HeadlessProtocolStores>;
  controlService?: RuntimeService;
  protocolRuntime?: ProtocolRuntime;
}>;

export class DaemonRuntime {
  readonly #config: DaemonConfig;
  readonly #dependencies: RuntimeDependencies;
  #phase: DaemonPhase = 'created';
  #linked = false;
  #reason: string | undefined;
  #sql: HeadlessSql | undefined;
  #protocolStores: HeadlessProtocolStores | undefined;

  constructor(config: DaemonConfig, dependencies: RuntimeDependencies) {
    this.#config = config;
    this.#dependencies = dependencies;
  }

  public getStatus(): DaemonStatus {
    const protocol = this.#dependencies.protocolRuntime;
    const ready = this.#phase === 'ready';
    return {
      buildExpiration: { days: 90, managedExternally: true },
      connected:
        ready && this.#config.connect && (protocol?.connected ?? false),
      databaseReady: this.#sql != null,
      linked: this.#linked,
      phase: this.#phase,
      ready,
      ...(this.#reason ? { reason: this.#reason } : {}),
    };
  }

  public async start(): Promise<void> {
    if (this.#phase !== 'created') {
      throw new Error(`Cannot start daemon from phase ${this.#phase}`);
    }

    try {
      this.#phase = 'opening-profile';
      const profile = await this.#dependencies.loadProfile(
        this.#config.storagePath
      );
      this.#sql = this.#dependencies.openSql({
        appVersion: this.#dependencies.appVersion,
        key: profile.sqlKey,
        storagePath: profile.storagePath,
      });
      this.#phase = 'database-ready';

      this.#protocolStores = await this.#dependencies.openProtocolStores(
        this.#sql
      );

      const items = this.#protocolStores.itemStorage.getItemsState() as Record<
        string,
        unknown
      >;
      this.#linked =
        typeof (items.uuid_id ?? items.number_id) === 'string' &&
        typeof items.password === 'string';
      if (!this.#linked) {
        throw new Error('Signal profile exists but is not a linked device');
      }

      const serviceContext = {
        items,
        profileSqlKey: profile.sqlKey,
        protocolStores: this.#protocolStores,
        sql: this.#sql,
      };
      await this.#dependencies.controlService?.prepare(serviceContext);

      if (this.#config.connect) {
        const protocolRuntime = this.#dependencies.protocolRuntime;
        if (!protocolRuntime) {
          throw new Error(
            'Headless protocol bootstrap is unavailable: upstream MessageReceiver and protocol stores still depend on the Electron preload global runtime'
          );
        }
        await protocolRuntime.start(serviceContext);
      }

      await this.#dependencies.controlService?.start();

      this.#phase = 'ready';
    } catch (error) {
      this.#reason = error instanceof Error ? error.message : String(error);
      this.#phase = 'failed';
      try {
        await this.#cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Daemon startup and cleanup both failed'
        );
      }
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#phase === 'stopped') {
      return;
    }
    this.#phase = 'stopping';
    try {
      await this.#cleanup();
    } finally {
      this.#phase = 'stopped';
    }
  }

  async #cleanup(): Promise<void> {
    const errors = new Array<unknown>();
    for (const operation of [
      () => this.#dependencies.controlService?.stop(),
      () => this.#dependencies.protocolRuntime?.stop(),
      () => this.#sql?.close(),
    ]) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- shutdown order is security-sensitive
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#sql = undefined;
    this.#protocolStores = undefined;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Multiple daemon services failed to stop'
      );
    }
  }
}
