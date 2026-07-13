// Copyright 2017 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { isAbsolute, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { app } from 'electron';

import { start } from './base_config.node.ts';
import config from './config.main.ts';
import * as Errors from '../ts/types/errors.std.ts';
import OS from '../ts/util/os/osMain.node.ts';

let userData: string | undefined;
const environmentStoragePath = process.env.SIGNAL_STORAGE_PATH;

// Containers use an explicit path so the complete profile can live in a named
// volume independently of the host user's home directory. Otherwise, use a
// separate data directory for benchmarks and development when configured.
if (environmentStoragePath !== undefined) {
  if (!environmentStoragePath || !isAbsolute(environmentStoragePath)) {
    throw new Error('SIGNAL_STORAGE_PATH must be an absolute, non-empty path');
  }
  userData = environmentStoragePath;
} else if (config.has('storagePath')) {
  userData = String(config.get('storagePath'));
} else if (config.has('storageProfile')) {
  userData = join(
    app.getPath('appData'),
    // oxlint-disable-next-line typescript/restrict-template-expressions
    `Signal-${config.get('storageProfile')}`
  );
} else if (OS.isAppImage()) {
  userData = join(app.getPath('appData'), `${app.getName()} AppImage`);
}

if (userData !== undefined) {
  try {
    mkdirSync(userData, { recursive: true });
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.error('Failed to create userData', Errors.toLogFormat(error));
  }

  app.setPath('userData', userData);
}

// Use console.log because logger isn't fully initialized yet
// oxlint-disable-next-line no-console
console.log(`userData: ${app.getPath('userData')}`);

const userDataPath = app.getPath('userData');
const targetPath = join(userDataPath, 'config.json');

export const userConfig = start({
  name: 'user',
  targetPath,
  throwOnFilesystemErrors: true,
});

export const get = userConfig.get.bind(userConfig);
export const remove = userConfig.remove.bind(userConfig);
export const set = userConfig.set.bind(userConfig);
