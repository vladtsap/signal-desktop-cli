<!-- Copyright 2014 Signal Messenger, LLC -->
<!-- Copyright 2026 Signal Desktop CLI contributors -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Signal Desktop CLI

Signal Desktop CLI is a focused fork of Signal Desktop for one portable linked-device profile. It uses the normal Signal Desktop UI for linking and occasional interactive use, then runs the same profile in a smaller Node.js daemon without Electron or a display server.

For a visual, task-oriented setup and operations guide, open [README.html](README.html) in a browser.

The initial feature set is intentionally narrow:

- link and inspect the account through Signal Desktop over a password-protected noVNC UI;
- receive one-to-one text messages and deliver Telegram-like HTTP webhooks;
- send one-to-one text messages through an authenticated HTTP endpoint;
- store the complete profile in a named Docker volume; and
- move an offline profile between machines using unencrypted Cloudflare R2 snapshots.

This is not `signal-cli`, is not affiliated with that project, and is not an official Signal distribution. It remains a Signal Desktop fork and must be kept current with upstream.

> [!IMPORTANT]
> Never mount, copy, restore, or run the same linked-device profile on two machines at once. The UI, daemon, and state tool share an advisory lock on one machine, but no distributed lock can protect copies on different machines. Always stop the source completely before snapshotting it, and keep the destination stopped until the restore has completed.

## Current status and limitations

Implemented:

- Linux `amd64` Docker images;
- the upstream Signal Desktop linking UI in Xvfb/fluxbox/noVNC;
- a headless authenticated Signal transport with reconnect handling;
- automatic ACI/PNI prekey replenishment and signed/PQ key rotation;
- direct encrypted text receive, SQLCipher persistence, and durable webhooks;
- direct encrypted text send with durable local status and existing-session reuse;
- unencrypted, immutable, checksummed R2 snapshots with staged restore; and
- a 90-day reproducible build lifetime with expiration visible at `/readyz`.

Not implemented:

- registration without the mobile Signal app;
- groups, attachments, previews, quotes, reactions, deletes, stories, or calls;
- sync transcripts or general multi-device history synchronization;
- group/sender-key receive processing;
- a public-internet API gateway, webhook management API, or polling API; and
- concurrent replicas, failover, or profile merging.

E164 destinations can only be used when the restored profile already maps the number to a Signal ACI. A lowercase ACI can be supplied directly. Unsupported incoming content is not exposed as a normal message or webhook. When a supported envelope decrypts but its data message contains unsupported fields, that decrypted record is retained in the encrypted profile's `unprocessed` store for future support. Unsupported ciphertext envelopes with a payload are likewise retained; empty unsupported control envelopes are acknowledged without staging because they contain no payload to preserve.

Incoming disappearing messages are deliberately treated as unsupported: they remain in encrypted staging and are acknowledged, but are never persisted as ordinary messages or sent to the webhook. This prevents the headless subset from silently retaining time-limited content forever.

The automated daemon, state, build, and static checks pass, but a real mobile-device link and live Signal interoperability test have deliberately not been performed yet. Treat the first end-to-end linked-device run as a controlled acceptance test before depending on this fork in production.

## Architecture

All three services mount the same named volume at `/var/lib/signal-state`. The portable Signal profile lives at `/var/lib/signal-state/profile`; the sibling `.signal-desktop-cli.lock` serializes profile access.

| Service     | Compose profile | Purpose                                                           | Typical lifetime                             |
| ----------- | --------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| `signal-ui` | `ui`            | Full Signal Desktop plus noVNC for linking and occasional GUI use | On demand, never with the daemon             |
| `signal`    | default         | Node-only transport, receive/send API, and webhook outbox         | Long-running                                 |
| `state`     | `tools`         | Offline `push`, `list`, `verify`, and `pull` commands             | One command, while both runtimes are stopped |

The daemon image contains only the recursively reachable daemon bundles and required native Signal/SQLCipher runtime packages. It runs as UID/GID `10001`, drops all Linux capabilities, uses a read-only root filesystem and `no-new-privileges`, and writes only to the profile volume and bounded `/tmp` tmpfs. The API and UI ports bind to host loopback by default.

While connected, the daemon checks ACI and PNI server prekey inventories at startup and every two days, coalesces low-key notifications, and rotates signed and post-quantum last-resort keys using Signal's 14-day stale-key boundary. Failed maintenance retries after five minutes; shutdown cancels and drains it before closing the Signal transport.

## Prerequisites

- Docker Engine with Docker Compose v2;
- a Signal account on the Android or iOS mobile app;
- enough CPU, memory, and disk to compile Signal Desktop for the first image build;
- an `amd64` Docker host, or a Docker environment capable of `linux/amd64` emulation; and
- for machine-to-machine state transfer, a private Cloudflare R2 bucket and R2 S3 API credentials.

Clone this repository on every machine that will use the profile. Commands below run from the repository root.

## Configuration

Create a local `.env` from the tracked, sanitized template. `.env` and its variants are ignored by Git, while `.env.example` remains tracked:

```sh
cp .env.example .env
chmod 600 .env
```

For a linked daemon with R2 transfer, the minimum useful file is:

```dotenv
SIGNAL_UI_PASSWORD=vncpass8
SIGNAL_API_TOKEN=replace-with-at-least-16-random-characters
SIGNAL_WEBHOOK_URL=https://example.com/signal/webhook
SIGNAL_WEBHOOK_SECRET=replace-with-at-least-16-random-characters

R2_ACCOUNT_ID=your-cloudflare-account-id
R2_BUCKET=your-private-bucket
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_PREFIX=signal-state
```

`SIGNAL_UI_PASSWORD` is limited by the VNC/RFB protocol to eight characters. The noVNC port is restricted to `127.0.0.1`, so access it locally or through an SSH tunnel; do not publish it directly to an untrusted network. For unattended use, prefer a Compose override that mounts a secret file and sets `SIGNAL_UI_PASSWORD_FILE` rather than retaining the password in `.env`.

R2 may use either `R2_ACCOUNT_ID`, which derives `https://ACCOUNT_ID.r2.cloudflarestorage.com`, or an explicit `R2_ENDPOINT_URL`. The credentials should be scoped to the selected private bucket.

> [!WARNING]
> Snapshot objects are intentionally **not encrypted by this tool**. A snapshot contains the complete portable Signal Desktop profile, including the material needed to open its SQLCipher database. Anyone who can read the R2 objects can read the profile. Use a private bucket, narrowly scoped credentials, and appropriate R2 access controls. SHA-256 and the file manifest detect corruption during normal transfer, but they are not authentication against an attacker who can replace both the snapshot and its descriptor.

## First setup: link locally

Build and start only the UI service:

```sh
docker compose --profile ui up --build signal-ui
```

Open <http://127.0.0.1:6080/> and enter `SIGNAL_UI_PASSWORD`. In Signal Desktop, choose the linked-device flow and scan the QR code with the mobile app. Wait for linking and initial setup to finish.

Stop Signal Desktop cleanly before touching the state:

```sh
docker compose --profile ui stop --timeout 150 signal-ui
docker compose ps
```

Confirm `signal-ui` and `signal` are not running. Do not use `docker compose down -v`: `-v` deletes the profile volume.

### Option A: keep the profile on this machine

R2 is optional when the daemon will use the same local named volume. After stopping the UI, start the daemon directly:

```sh
docker compose up --build -d signal
docker compose logs -f signal
```

No state-tool variables are required for this local-only flow. Stop the daemon before the next UI session:

```sh
docker compose stop --timeout 45 signal
docker compose --profile ui up signal-ui
```

### Option B: upload the offline profile to R2

With both runtimes stopped and the R2 variables configured:

```sh
docker compose --profile tools run --rm --build state push
```

The command prints the new snapshot UUID. `push` inventories the profile, creates an unencrypted `.tar.zst` archive, uploads it first, and publishes its descriptor last. Snapshots are immutable; a later push creates another object rather than overwriting the previous one. Upload is not tied to the original linking machine: whichever stopped machine currently owns the live profile can push it to R2.

List and fully verify the uploaded snapshot before migration:

```sh
docker compose --profile tools run --rm state list
docker compose --profile tools run --rm state verify latest
```

`verify` downloads the archive, verifies its size and SHA-256, decompresses it in temporary storage, rejects unsafe archive entries, and compares every restored file with the included manifest. It does not activate the profile.

The unencrypted archive is snapshot format 2. Earlier format-1 descriptors under the same R2 prefix are ignored by `list`, `verify`, and `pull`; create a new snapshot with this version before relying on restore.

## First setup: restore remotely and start headless

On the destination, clone the same revision, create its protected `.env` with the same R2 configuration, and keep the source stopped.

The state command can create the Compose volume without starting Signal. This is the preferred order—restore first, daemon second:

```sh
docker compose --profile tools run --rm --build state pull latest
docker compose up --build -d signal
```

An explicit `docker volume create` or an initial empty daemon start is unnecessary. On a fresh volume, `pull` stages and validates the complete snapshot before renaming it into place and syncing the volume directory. It refuses to overwrite a non-empty profile unless `--replace` is supplied.

Follow startup and check liveness/readiness:

```sh
docker compose logs -f signal
curl --fail http://127.0.0.1:8080/healthz
curl --fail http://127.0.0.1:8080/readyz
```

`/healthz` reports that the local control process is alive. `/readyz` returns HTTP 200 only when the linked profile and runtime are ready; otherwise it returns HTTP 503 with status details. Its JSON includes `phase`, `linked`, `databaseReady`, `connected`, `ready`, an optional `reason`, and the build creation/expiration timestamps and remaining days.

If `SIGNAL_DAEMON_CONNECT=false`, the daemon opens the offline profile and API without connecting to Signal. In that mode `ready` can be true while `connected` is false, but sends still fail because there is no transport.

## Send a text message

The only authenticated endpoint is `POST /v1/messages`. Health endpoints do not require authentication. When `SIGNAL_DAEMON_CONNECT=true`, startup requires `SIGNAL_API_TOKEN` with at least 16 characters.

```sh
curl --fail-with-body \
  -H "Authorization: Bearer ${SIGNAL_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{
    "destination": "+12025550123",
    "body": "**hello** from the headless client",
    "parse_mode": "Markdown",
    "quote_message_id": "incoming-message-uuid"
  }' \
  http://127.0.0.1:8080/v1/messages
```

Compose reads `.env` for container interpolation but does not export it into the current shell. Export `SIGNAL_API_TOKEN` before this command, or replace `${SIGNAL_API_TOKEN}` with the configured token without saving it in shell history.

A successful response has this shape:

```json
{
  "destination": "00000000-0000-0000-0000-000000000000",
  "messageId": "00000000-0000-0000-0000-000000000000",
  "status": "sent",
  "timestamp": 1783960000000
}
```

`destination` accepts an international E164 number (`+...`) or a lowercase Signal ACI. `body` must contain 1–32,768 characters. To send a Signal quoted reply, set optional `quote_message_id` to the opaque ID from an earlier webhook's `message.message_id`; the referenced message must still exist locally and belong to the destination conversation.

Set optional `parse_mode` to the exact value `Markdown` to turn `**bold**`, `_italic_`, `~~strikethrough~~`, `` `monospace` ``, and `||spoiler||` into native Signal formatting ranges. Formatting markers are removed from the sent text, nesting is supported, and a backslash escapes the following character. Unmatched markers remain literal. Without `parse_mode`, the body is sent exactly as provided. No other request fields are accepted, and request bodies are limited to 64 KiB.

Each accepted POST creates a fresh outgoing message ID and performs one logical send operation. There is no application-level deduplication: sending an identical request again can produce a duplicate message. If Signal explicitly rejects the encrypted payload because the recipient device list changed, the daemon preserves unaffected sessions, repairs only missing, extra, stale, or registration-changed devices, and retransmits once inside the same POST. This bounded retry is safe because Signal rejected the first transmission before accepting it. A second device mismatch is returned as retryable HTTP 502. Other transport failures are never retried automatically: if the connection closes before the response arrives, the outcome is ambiguous.

To react to a locally retained message, call the authenticated `POST /v1/reactions` endpoint with the same destination, the webhook's opaque `message.message_id`, and one supported emoji:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer ${SIGNAL_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{
    "destination": "+12025550123",
    "message_id": "incoming-message-id",
    "emoji": "👍"
  }' \
  http://127.0.0.1:8080/v1/reactions
```

The target must exist locally and belong to the destination conversation. Sending another reaction from this account replaces its locally stored reaction after Signal accepts the new reaction. Reaction removal is not currently exposed by the API.

The API is bound to host loopback by Compose. To call it from another container, attach both services to a private Compose network with an override and use the service name; keep bearer authentication and do not publish the endpoint publicly without a separate TLS/authentication gateway and network controls.

## Incoming webhooks

Set `SIGNAL_WEBHOOK_URL` to an HTTP or HTTPS endpoint. During every daemon startup, before the Signal transport and control API become ready, the daemon sends a bodyless GET request to that exact URL. Startup continues only for an exact HTTP 200 response. Redirects are not followed; timeouts, network errors, and every other status fail startup. The GET carries no webhook HMAC signature. With Compose's `restart: unless-stopped`, Docker keeps restarting a failed daemon until the endpoint returns 200. No startup check is made when `SIGNAL_WEBHOOK_URL` is unset.

After the startup check succeeds, each newly persisted, supported direct text message is delivered as one JSON POST:

```json
{
  "update_id": "7484932459384721",
  "message": {
    "message_id": "incoming-message-uuid",
    "date": 1783960000000,
    "text": "hello",
    "from": { "id": "sender-aci" },
    "chat": { "id": "sender-aci", "type": "private" },
    "reply_to_message": {
      "message_id": "1783959000000",
      "date": 1783959000000,
      "text": "quoted text",
      "from": { "id": "quoted-author-aci" },
      "chat": { "id": "sender-aci", "type": "private" }
    }
  }
}
```

The IDs are strings. `date` is Signal's exact sent time in Unix milliseconds, matching the timestamp shown by Signal Desktop. Because only direct messages are supported, `chat.id` and `from.id` are both the sender's stable Signal ACI; that ACI can also be used as the send API's `destination`. `update_id` is a separate value deterministically derived from `message_id`, so consumers can deduplicate retries without relying on timestamps, which are not guaranteed to be unique.

For a quoted reply, `reply_to_message` contains Signal's quoted author, text, and target sent timestamp. Signal's quote protocol identifies the target by author and sent timestamp rather than by the receiving daemon's local message UUID, so the nested `message_id` is the target timestamp encoded as a string and `date` is the same value as a number. The field is omitted for messages without a quote. Quoted attachments and quoted formatting are not yet supported by the headless receiver.

When `SIGNAL_WEBHOOK_SECRET` is set, the request includes:

```text
X-Signal-Webhook-Signature: sha256=HEX_HMAC_SHA256
```

Verify the HMAC over the exact raw HTTP body with `SIGNAL_WEBHOOK_SECRET` and compare it in constant time before parsing or acting on the update.

Delivery is ordered and at least once. Only a 2xx response marks the incoming message read locally and removes the oldest entry. Failed or retrying deliveries remain unread. The read update is durable before the outbox entry is removed; if that final outbox commit fails, the already-read message can be delivered again. This local transition does not send a read receipt to the contact or a read sync to another linked device. Network errors, redirects, timeouts, and non-2xx responses retry with exponential delays from 1 second to 5 minutes. The timeout defaults to 10 seconds. The encrypted outbox is stored as `headless-webhook-outbox.enc` in the profile, uses AES-256-GCM with a key derived from the SQLCipher profile key, and survives restarts and R2 transfers.

The first daemon initialization creates a cursor at the newest existing incoming message, so linking/restoring historical messages does not flood a newly configured webhook. Subsequent startup reconciliation closes the crash window between SQL message persistence and outbox enqueue. If no webhook URL is configured, incoming text remains in Signal's encrypted database and the webhook cursor advances without accumulating deliveries. `SIGNAL_WEBHOOK_MAX_PENDING` is the maximum number of durable, undelivered webhook updates, not the number of messages retained in Signal's database. When the outbox reaches it, the daemon stops acknowledging newly received supported messages until space is available, causing Signal to retry them; startup reconciliation also pauses at the full queue. No queued update is silently evicted. The encrypted outbox file is additionally capped at 128 MiB.

Consumers must still be idempotent: a crash after accepting a POST but before the daemon records the 2xx can cause the same `update_id` to be sent again.

## Moving the profile again

The same stop/snapshot/restore sequence applies in either direction—including remote back to the original computer—and for every later migration. The current profile owner is always the source; the stopped machine that will take ownership is the destination:

1. Stop the daemon or UI on the current owner and wait for it to exit.
2. Run `state push` there, record the UUID, and preferably run `state verify UUID`.
3. Ensure the other machine's daemon and UI are stopped.
4. Run `state pull UUID --replace` on the destination.
5. Start exactly one destination runtime.

Example source commands:

```sh
docker compose stop --timeout 45 signal
docker compose --profile ui stop --timeout 150 signal-ui
SNAPSHOT_ID=$(docker compose --profile tools run --rm state push)
docker compose --profile tools run --rm state verify "$SNAPSHOT_ID"
```

Copy the printed UUID through your deployment process rather than relying on `latest` when multiple machines or operators may push to the same prefix. On the stopped destination:

```sh
docker compose stop --timeout 45 signal
docker compose --profile ui stop --timeout 150 signal-ui
docker compose --profile tools run --rm state pull "$SNAPSHOT_ID" --replace
docker compose up -d signal
```

`pull` accepts `latest`, a snapshot UUID, or the full snapshot object key. Without `--replace`, it only restores into an empty profile. With `--replace`, the downloaded snapshot is fully verified in staging, then Linux `renameat2(RENAME_EXCHANGE)` atomically swaps it with the current profile and the parent directory is synced. Download, decompression, inventory, or exchange failures leave the current profile active. The profile volume filesystem must support atomic exchange; the command fails closed when it does not.

Available state commands:

```text
signal-state push
signal-state list
signal-state verify [latest|SNAPSHOT_ID|OBJECT_KEY]
signal-state pull [latest|SNAPSHOT_ID|OBJECT_KEY] [--replace]
```

Run them through `docker compose --profile tools run --rm state ...`; do not invoke them while either runtime is active. All commands acquire the same nonblocking profile lock.

## Backup, rollback, and recovery

- Keep several immutable snapshot UUIDs. R2 bucket versioning/lifecycle policy is separate from this tool; configure retention to match your recovery needs.
- Run `verify` periodically and before deleting any older snapshot.
- Treat R2 read access as full access to the linked Signal Desktop profile. Keep the bucket private, scope credentials narrowly, and rotate credentials if they leak.
- To roll back, stop all profile users, verify the chosen older UUID, `pull UUID --replace`, and start one runtime. Messages and protocol state newer than that snapshot are discarded locally and may not be replayable by Signal.
- If daemon startup says the profile is unlinked, restore a known-good linked snapshot or relink through a fresh UI profile. Do not edit `config.json`, the SQLCipher database, or protocol sessions manually.
- If readiness remains green but incoming webhooks stop, check `docker compose logs signal` for `HeadlessMessageReceiver: failed to process incoming Signal envelope`. Failed envelopes are rejected to Signal for retry rather than acknowledged; investigate the logged decrypt or persistence error. A recipient device-list mismatch during an API send is repaired selectively and must not reset unaffected inbound sessions.
- If the profile lock is busy, find and stop the owning UI, daemon, or state container. Do not delete the lock file to bypass an active owner.
- Never run `docker compose down -v` unless permanent deletion of the local profile is intended.

Before every ownership transfer, verify: source stopped; snapshot UUID recorded; snapshot verified; destination stopped; correct R2 bucket and prefix selected; restore completed; only then destination started.

## Environment reference

### Shared and build settings

| Variable             | Default               | Meaning                                                                                           |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `SIGNAL_DATA_VOLUME` | `signal-desktop-data` | Docker named volume used by all three services. Use a unique name per independent linked profile. |
| `TZ`                 | `UTC`                 | UI and daemon timezone.                                                                           |

`SIGNAL_STORAGE_PATH` and `SIGNAL_PROFILE_LOCK_PATH` are fixed by Compose to the shared volume paths. Do not give the services different values.

### Daemon, API, and webhook

| Variable                            | Default | Constraints/effect                                                                   |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `SIGNAL_API_PORT`                   | `8080`  | Container and loopback host API port, 1–65535.                                       |
| `SIGNAL_API_TOKEN`                  | unset   | Bearer token, minimum 16 characters; required when connecting.                       |
| `SIGNAL_DAEMON_CONNECT`             | `true`  | `true`/`false` or `1`/`0`; controls Signal network connection.                       |
| `SIGNAL_DAEMON_LOG_LEVEL`           | `info`  | Parsed values: `debug`, `info`, `warn`, `error`. Reserved for daemon logging policy. |
| `SIGNAL_DAEMON_SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful internal shutdown deadline, 1,000–120,000 ms.                               |
| `SIGNAL_WEBHOOK_URL`                | unset   | HTTP(S) destination; exact GET 200 required at startup when set.                     |
| `SIGNAL_WEBHOOK_SECRET`             | unset   | HMAC secret, minimum 16 characters.                                                  |
| `SIGNAL_WEBHOOK_TIMEOUT_MS`         | `10000` | Startup GET and POST attempt timeout, 1,000–120,000 ms.                              |
| `SIGNAL_WEBHOOK_MAX_PENDING`        | `1000`  | Durable undelivered updates, 1–10,000; a full queue applies receive backpressure.    |
| `SIGNAL_MEMORY_LIMIT`               | `512m`  | Hard Compose daemon memory limit.                                                    |
| `SIGNAL_PIDS_LIMIT`                 | `128`   | Compose daemon process limit.                                                        |

Compose sets `SIGNAL_API_HOST=0.0.0.0` inside the container but publishes it only on host `127.0.0.1`.

If the daemon exceeds `SIGNAL_MEMORY_LIMIT`, the container's cgroup OOM-kills it (commonly reported as exit code 137). Because the service uses `restart: unless-stopped`, Docker then restarts it. The database and webhook outbox are durable, but an API send interrupted at that exact moment can have an ambiguous outcome and there is no deduplication key for safely replaying it. Increase the limit or override/remove `mem_limit` in a private Compose override if normal workloads repeatedly reach it.

### UI

| Variable                 | Default    | Constraints/effect                                 |
| ------------------------ | ---------- | -------------------------------------------------- |
| `SIGNAL_UI_PASSWORD`     | unset      | Required noVNC/RFB password, at most 8 characters. |
| `SIGNAL_UI_PORT`         | `6080`     | Container and loopback host noVNC port, 1–65535.   |
| `SIGNAL_UI_RESOLUTION`   | `1440x900` | Virtual desktop in `WIDTHxHEIGHT` form.            |
| `SIGNAL_UI_DISABLE_GPU`  | `1`        | `1` adds Electron's `--disable-gpu`.               |
| `SIGNAL_UI_CPU_LIMIT`    | `2.0`      | Compose UI CPU limit.                              |
| `SIGNAL_UI_MEMORY_LIMIT` | `2g`       | Compose UI memory limit.                           |
| `SIGNAL_UI_PIDS_LIMIT`   | `512`      | Compose UI process limit.                          |

The entrypoint also supports `SIGNAL_UI_PASSWORD_FILE`, but the stock Compose file does not mount or set it; provide both through a private override if used.

### State transfer

| Variable                    | Default        | Constraints/effect                                                    |
| --------------------------- | -------------- | --------------------------------------------------------------------- |
| `R2_BUCKET`                 | none           | Required bucket name.                                                 |
| `R2_ACCOUNT_ID`             | none           | Derives the standard R2 S3 endpoint when no explicit endpoint is set. |
| `R2_ENDPOINT_URL`           | derived        | Explicit S3-compatible endpoint; takes precedence over account ID.    |
| `R2_ACCESS_KEY_ID`          | none           | Required R2 S3 access key ID.                                         |
| `R2_SECRET_ACCESS_KEY`      | none           | Required R2 S3 secret.                                                |
| `R2_PREFIX`                 | `signal-state` | Object-key prefix; `.` and `..` path components are rejected.         |
| `SIGNAL_STATE_CPU_LIMIT`    | `1.0`          | Compose one-shot state-tool CPU limit.                                |
| `SIGNAL_STATE_MEMORY_LIMIT` | `512m`         | Compose state-tool memory limit.                                      |
| `SIGNAL_STATE_PIDS_LIMIT`   | `128`          | Compose state-tool process limit.                                     |

All state commands need R2 configuration. R2 operations use region `auto`, disable EC2 metadata lookup, and use the AWS CLI against the selected endpoint.

## Published container image

Every push to `main` automatically runs the project linters plus the daemon and state-tool tests, builds and smoke-tests the Linux `amd64` daemon target, and publishes it to GitHub Container Registry as `ghcr.io/vladtsap/signal-desktop-cli` only if every preceding step succeeds. The tested local image is pushed without rebuilding it. The moving `latest` tag and an immutable tag containing the full commit SHA are published together:

```sh
docker pull ghcr.io/vladtsap/signal-desktop-cli:latest
docker pull ghcr.io/vladtsap/signal-desktop-cli:FULL_COMMIT_SHA
```

The publish job exposes `image` (the immutable `name@sha256:digest` reference), `image_name`, `latest_tag`, `commit_tag`, and `digest` outputs for later jobs, and writes the reusable references to the workflow summary. This package contains only the `signal-daemon` target; the linking UI and state-transfer tool continue to build locally through Compose. GitHub controls package visibility separately from repository visibility. If the package is private, authenticate Docker to `ghcr.io` with a GitHub token that has `read:packages` permission before pulling it.

## Build expiration and upstream maintenance

Both packaged runtimes are valid for exactly 90 days from the image build time. The build generates this timestamp automatically and shares it between the UI and daemon build stages; there is no timestamp, revision, or expiration field to update in `compose.yaml`, `.env`, or `.env.example`. The daemon reports `createdAt`, `expiresAt`, ISO timestamps, `daysRemaining`, and `expired` under `/readyz`. If it starts expired, it opens the profile and control API offline, returns readiness 503, and does not start Signal transport. If it expires while running, it stops Signal transport and keeps health/readiness available for diagnosis. Sending is gated on readiness.

The GUI keeps Signal's remote expiration behavior, so Signal can shorten its effective lifetime. The official fork policy is a 90-day build lifetime, and a rebuild is therefore required **at least** every 90 days and may be required sooner. The correct maintenance operation is to merge current upstream and rebuild.

Configure an `upstream` remote for `signalapp/Signal-Desktop` once. The normal update workflow is only fetch, merge, resolve any conflicts, and rebuild:

```sh
git remote add upstream https://github.com/signalapp/Signal-Desktop.git # once
git fetch upstream
git merge upstream/main
# Resolve conflicts, if any, and complete the merge commit.
docker compose build signal signal-ui state
docker compose up -d signal
curl --fail http://127.0.0.1:8080/readyz
```

No metadata edits or timestamp arguments are required. Docker automatically recalculates the build creation time when the merged source changes invalidate the source-build layer. The separate upstream reproducible-build script derives its timestamp from the latest Git commit, accepts no timestamp override, and fails instead of guessing when Git metadata is unavailable.

This automation cannot prove that an operator actually fetched upstream before rebuilding. Keeping the fork current remains an operational responsibility, but it requires no synchronized timestamp or revision bookkeeping.

## Development and verification

The upstream project uses Node.js and pnpm versions pinned by the repository. A typical focused workflow is:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run generate
pnpm run test-daemon
python3 -m unittest discover -s docker -p 'test_state_cli.py'
pnpm run check:types
pnpm exec oxlint ts/daemon scripts/copy-daemon-runtime.mjs
pnpm exec prettier --check README.md compose.yaml Dockerfile docker ts/daemon scripts/copy-daemon-runtime.mjs
docker compose config
docker compose build signal state
```

Run the broader upstream suites when upstream or shared Signal code changes:

```sh
pnpm test
pnpm run lint
pnpm run build-linux
```

Building an image does not link an account or launch its entrypoint. Automated tests should continue using fixtures; reserve real authentication and live send/receive checks for an explicit acceptance environment with an isolated linked profile. Never copy a developer's normal Signal Desktop profile into this fork: portability depends on the container UI creating `config.json` with `--password-store=basic` and a portable SQLCipher key.

When adding features, preserve the Node-only daemon boundary: no Electron, DOM, renderer/preload global, or GUI bundle may become reachable from `bundles/daemon.js`. Keep protocol and SQL dependencies injectable, retain durable inbound staging before server acknowledgement, preserve the one-request/one-outgoing-message send contract, and extend both daemon unit tests and the runtime-bundle audit.

## License and cryptography notice

Copyright 2013-2026 Signal Messenger, LLC and contributors.

Licensed under the [GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html).

This distribution includes cryptographic software. Your jurisdiction may restrict its import, possession, use, or re-export. Check the laws and policies applicable to you before use. See the [Wassenaar Arrangement](https://www.wassenaar.org/) for additional context.
