#!/usr/bin/env bash
# Copyright 2026 Signal Desktop CLI contributors
# SPDX-License-Identifier: AGPL-3.0-only

set -Eeuo pipefail
umask 077

: "${DISPLAY:=:99}"
: "${SIGNAL_STORAGE_PATH:=/var/lib/signal-desktop}"
: "${SIGNAL_PROFILE_LOCK_PATH:=${SIGNAL_STORAGE_PATH}/.signal-desktop-cli.lock}"
: "${SIGNAL_UI_LISTEN_ADDRESS:=0.0.0.0}"
: "${SIGNAL_UI_PORT:=6080}"
: "${SIGNAL_VNC_PORT:=5900}"
: "${SIGNAL_UI_RESOLUTION:=1440x900}"
: "${XDG_RUNTIME_DIR:=/tmp/runtime-signal}"

if [[ ! "${SIGNAL_UI_PORT}" =~ ^[0-9]+$ ]] \
  || (( SIGNAL_UI_PORT < 1 || SIGNAL_UI_PORT > 65535 )); then
  echo "SIGNAL_UI_PORT must be an integer between 1 and 65535" >&2
  exit 64
fi

if [[ ! "${SIGNAL_VNC_PORT}" =~ ^[0-9]+$ ]] \
  || (( SIGNAL_VNC_PORT < 1 || SIGNAL_VNC_PORT > 65535 )); then
  echo "SIGNAL_VNC_PORT must be an integer between 1 and 65535" >&2
  exit 64
fi

if [[ ! "${SIGNAL_UI_RESOLUTION}" =~ ^[0-9]+x[0-9]+$ ]]; then
  echo "SIGNAL_UI_RESOLUTION must use WIDTHxHEIGHT format" >&2
  exit 64
fi

ui_password="${SIGNAL_UI_PASSWORD:-}"
if [[ -n "${SIGNAL_UI_PASSWORD_FILE:-}" ]]; then
  if [[ ! -r "${SIGNAL_UI_PASSWORD_FILE}" ]]; then
    echo "SIGNAL_UI_PASSWORD_FILE is not readable" >&2
    exit 66
  fi
  ui_password="$(<"${SIGNAL_UI_PASSWORD_FILE}")"
fi

if [[ -z "${ui_password}" ]]; then
  echo "Set SIGNAL_UI_PASSWORD or SIGNAL_UI_PASSWORD_FILE" >&2
  exit 64
fi

# The RFB protocol only supports eight significant password characters. Reject
# longer values instead of silently weakening a password supplied by the user.
if (( ${#ui_password} > 8 )); then
  echo "SIGNAL_UI_PASSWORD must be at most 8 characters (RFB protocol limit)" >&2
  exit 64
fi

mkdir -p "${SIGNAL_STORAGE_PATH}" "${XDG_RUNTIME_DIR}"
chmod 0700 "${SIGNAL_STORAGE_PATH}" "${XDG_RUNTIME_DIR}"

if [[ ! -w "${SIGNAL_STORAGE_PATH}" ]]; then
  echo "Signal profile is not writable: ${SIGNAL_STORAGE_PATH}" >&2
  exit 73
fi

# Keep this lock path stable: the future daemon and state commands must acquire
# the same advisory lock before accessing the profile.
exec 9>"${SIGNAL_PROFILE_LOCK_PATH}"
if ! flock --nonblock 9; then
  echo "Signal profile is already in use: ${SIGNAL_STORAGE_PATH}" >&2
  exit 73
fi

vnc_password_file="${XDG_RUNTIME_DIR}/x11vnc.pass"
x11vnc -storepasswd "${ui_password}" "${vnc_password_file}" >/dev/null
unset ui_password SIGNAL_UI_PASSWORD

children=()
signal_pid=""

cleanup() {
  local child
  for child in "${children[@]}"; do
    if kill -0 "${child}" 2>/dev/null; then
      kill -TERM "${child}" 2>/dev/null || true
    fi
  done
  wait "${children[@]}" 2>/dev/null || true
  rm -f "${vnc_password_file}"
}
trap cleanup EXIT

forward_shutdown() {
  if [[ -n "${signal_pid}" ]] && kill -0 "${signal_pid}" 2>/dev/null; then
    kill -TERM "${signal_pid}"
  else
    exit 0
  fi
}
trap forward_shutdown INT TERM

Xvfb "${DISPLAY}" -screen 0 "${SIGNAL_UI_RESOLUTION}x24" -nolisten tcp -ac &
children+=("$!")

for _ in {1..100}; do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.05
done
if ! xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
  echo "Xvfb did not become ready" >&2
  exit 70
fi

eval "$(dbus-launch --sh-syntax)"
if [[ -n "${DBUS_SESSION_BUS_PID:-}" ]]; then
  children+=("${DBUS_SESSION_BUS_PID}")
fi

fluxbox -display "${DISPLAY}" >/dev/null 2>&1 &
children+=("$!")

x11vnc \
  -display "${DISPLAY}" \
  -forever \
  -localhost \
  -rfbauth "${vnc_password_file}" \
  -rfbport "${SIGNAL_VNC_PORT}" \
  -shared \
  -quiet &
children+=("$!")

websockify \
  --web /usr/share/novnc \
  "${SIGNAL_UI_LISTEN_ADDRESS}:${SIGNAL_UI_PORT}" \
  "127.0.0.1:${SIGNAL_VNC_PORT}" &
children+=("$!")

signal_args=(
  --disable-dev-shm-usage
  --no-sandbox
  --ozone-platform=x11
  --password-store=basic
  "--user-data-dir=${SIGNAL_STORAGE_PATH}"
)
if [[ "${SIGNAL_UI_DISABLE_GPU:-1}" = "1" ]]; then
  signal_args+=(--disable-gpu)
fi

signal-desktop "${signal_args[@]}" &
signal_pid="$!"
children+=("${signal_pid}")

status=0
while kill -0 "${signal_pid}" 2>/dev/null; do
  wait_status=0
  wait "${signal_pid}" || wait_status="$?"
  if ! kill -0 "${signal_pid}" 2>/dev/null; then
    status="${wait_status}"
  fi
done
exit "${status}"
