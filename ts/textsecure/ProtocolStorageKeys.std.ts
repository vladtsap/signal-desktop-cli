// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { StorageAccessType } from '../types/Storage.d.ts';
import { ServiceIdKind } from '../types/ServiceId.std.ts';

type StorageKeyByServiceIdKind = Record<ServiceIdKind, keyof StorageAccessType>;

export const KYBER_KEY_ID_KEY = {
  [ServiceIdKind.ACI]: 'maxKyberPreKeyId',
  [ServiceIdKind.Unknown]: 'maxKyberPreKeyId',
  [ServiceIdKind.PNI]: 'maxKyberPreKeyIdPNI',
} as const satisfies StorageKeyByServiceIdKind;

export const SIGNED_PRE_KEY_ID_KEY = {
  [ServiceIdKind.ACI]: 'signedKeyId',
  [ServiceIdKind.Unknown]: 'signedKeyId',
  [ServiceIdKind.PNI]: 'signedKeyIdPNI',
} as const satisfies StorageKeyByServiceIdKind;
