// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

const portableConfigSchema = z
  .object({
    key: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    encryptedKey: z.string().optional(),
    safeStorageBackend: z.string().optional(),
  })
  .passthrough();

export type PortableProfile = Readonly<{
  sqlKey: string;
  storagePath: string;
}>;

/**
 * Load the SQLCipher key produced by the UI container's
 * `--password-store=basic` mode. We intentionally do not try to decrypt a key
 * protected by a host keychain: that profile is not portable by definition.
 */
export async function loadPortableProfile(
  storagePath: string
): Promise<PortableProfile> {
  const configPath = join(storagePath, 'config.json');
  let contents: string;
  try {
    contents = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Signal profile is not linked: missing ${configPath}. Link it with the UI container first.`
      );
    }
    throw error;
  }

  const config = portableConfigSchema.parse(JSON.parse(contents));
  if (!config.key) {
    const detail = config.encryptedKey
      ? ` (encryptedKey uses ${config.safeStorageBackend ?? 'an unknown host keychain'})`
      : '';
    throw new Error(
      `Signal profile has no portable plaintext SQLCipher key${detail}. Start the UI container with --password-store=basic.`
    );
  }

  return { sqlKey: config.key, storagePath };
}
