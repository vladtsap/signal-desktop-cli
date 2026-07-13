#!/usr/bin/env bash
# Copyright 2026 Signal Desktop CLI contributors
# SPDX-License-Identifier: AGPL-3.0-only

set -Eeuo pipefail
umask 077

: "${SIGNAL_STORAGE_PATH:=/var/lib/signal-state/profile}"
: "${SIGNAL_PROFILE_LOCK_PATH:=/var/lib/signal-state/.signal-desktop-cli.lock}"

mkdir -p "${SIGNAL_STORAGE_PATH}"
chmod 0700 "${SIGNAL_STORAGE_PATH}"
if [[ ! -w "${SIGNAL_STORAGE_PATH}" ]]; then
  echo "Signal profile is not writable: ${SIGNAL_STORAGE_PATH}" >&2
  exit 73
fi

# This is the same advisory lock acquired by the UI and state containers. The
# descriptor remains open across exec, so the lease lasts for the Node process.
exec 9>"${SIGNAL_PROFILE_LOCK_PATH}"
if ! flock --nonblock 9; then
  echo "Signal profile is already in use: ${SIGNAL_STORAGE_PATH}" >&2
  exit 73
fi

exec node /opt/signal-desktop/bundles/daemon.js "$@"
