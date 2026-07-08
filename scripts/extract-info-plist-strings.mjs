// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check
import packageJson from '../package.json' with { type: 'json' };
import { writeFile } from 'node:fs/promises';

const {
  NSCameraUsageDescription,
  NSMicrophoneUsageDescription,
} = packageJson.build.mas.extendInfo;

await writeFile('_locales/en/mas-info-plist.json', JSON.stringify({
  smartling: {
    translate_paths: [
      {
        path: '*/messageformat',
        key: '{*}/messageformat',
        character_limit: '*/limit',
        instruction: '*/description'
      }
    ]
  },
  NSCameraUsageDescription: {
    messageformat: NSCameraUsageDescription,
    description: 'Presented to user by macOS when requesting camera permissions',
  },
  NSMicrophoneUsageDescription: {
    messageformat: NSMicrophoneUsageDescription,
    description: 'Presented to user by macOS when requesting camera permissions',
  },
}, null, 2));
