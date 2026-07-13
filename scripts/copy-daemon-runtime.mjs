// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check

import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const sourceRoot = resolve(process.argv[2] ?? 'bundles');
const destinationRoot = resolve(process.argv[3] ?? 'daemon-runtime/bundles');
const queue = [join(sourceRoot, 'daemon.js')];
const copied = new Set();
const relativeRequire = /require\(\s*(["'`])(\.[^"'`]+)\1\s*\)/g;

await rm(destinationRoot, { force: true, recursive: true });

while (queue.length > 0) {
  const source = queue.pop();
  if (!source || copied.has(source)) continue;

  const sourceRelative = relative(sourceRoot, source);
  if (
    isAbsolute(sourceRelative) ||
    sourceRelative === '..' ||
    sourceRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`Daemon bundle import escapes bundle root: ${source}`);
  }
  // eslint-disable-next-line no-await-in-loop
  const contents = await readFile(source, 'utf8');
  const destination = join(destinationRoot, sourceRelative);
  // eslint-disable-next-line no-await-in-loop
  await mkdir(dirname(destination), { recursive: true });
  // eslint-disable-next-line no-await-in-loop
  await copyFile(source, destination);
  copied.add(source);

  for (const match of contents.matchAll(relativeRequire)) {
    const specifier = match[2];
    if (!specifier) throw new Error(`Invalid relative import in ${source}`);
    const dependency = resolve(dirname(source), specifier);
    queue.push(dependency);
  }
}

console.log(`Copied ${copied.size} files in the daemon bundle closure`);
