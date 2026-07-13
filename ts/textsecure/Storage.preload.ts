// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { DataReader, DataWriter } from '../sql/Client.preload.ts';
import { Storage } from './Storage.node.ts';

export { DEFAULT_AUTO_DOWNLOAD_ATTACHMENT, Storage } from './Storage.node.ts';

export const itemStorage = new Storage({
  dataReader: DataReader,
  dataWriter: DataWriter,
  onItemChanged(key, value) {
    if (value === undefined) {
      window.reduxActions?.items.removeItemExternal(key);
    } else {
      window.reduxActions?.items.putItemExternal(key, value);
    }
  },
  onUserChanged() {
    window.Whisper.events.emit('userChanged', true);
  },
});
