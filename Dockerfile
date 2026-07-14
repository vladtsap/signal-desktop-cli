# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.17.0

FROM node:${NODE_VERSION}-bookworm AS source-build

ARG TARGETARCH
ENV CI=true \
    SIGNAL_ENV=production \
    SIGNAL_BUILD_EPOCH_FILE=/tmp/signal-build-epoch

RUN test "${TARGETARCH}" = "amd64"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      curl \
      g++ \
      git \
      make \
      python3 \
      rpm \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && corepack prepare pnpm@11.5.2 --activate

WORKDIR /src

# Keep dependency resolution independent from the application source. Pending
# lifecycle scripts are rebuilt below after all source files are present.
COPY .pnpmfile.mjs package.json package.schema.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY sticker-creator ./sticker-creator
COPY patches ./patches

RUN --mount=type=cache,id=pnpm-store-amd64,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store

COPY . .

RUN date +%s > "${SIGNAL_BUILD_EPOCH_FILE}"

RUN --mount=type=cache,id=pnpm-store-amd64,target=/pnpm/store,sharing=locked \
    pnpm rebuild --pending --recursive --store-dir /pnpm/store \
    && pnpm rebuild --pending --workspace-root --store-dir /pnpm/store

FROM source-build AS ui-build

RUN pnpm run build-linux

FROM debian:bookworm-slim AS signal-ui

ARG TARGETARCH
ARG SIGNAL_UID=10001
ARG SIGNAL_GID=10001

RUN test "${TARGETARCH}" = "amd64"

COPY --from=ui-build /src/release/*.deb /tmp/

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      /tmp/*.deb \
      bash \
      dbus-x11 \
      fluxbox \
      novnc \
      tini \
      util-linux \
      websockify \
      x11-utils \
      x11vnc \
      xvfb \
    && rm -f /tmp/*.deb \
    && rm -rf /var/lib/apt/lists/* \
    && if [ ! -e /usr/share/novnc/index.html ]; then \
      ln -s vnc.html /usr/share/novnc/index.html; \
    fi \
    && groupadd --gid "${SIGNAL_GID}" signal \
    && useradd --uid "${SIGNAL_UID}" --gid signal --create-home --shell /bin/bash signal \
    && install -d --owner signal --group signal --mode 0700 \
      /var/lib/signal-state \
      /var/lib/signal-state/profile \
      /home/signal/.cache

COPY --chmod=0755 docker/ui-entrypoint.sh /usr/local/bin/signal-ui-entrypoint

ENV DISPLAY=:99 \
    HOME=/home/signal \
    SIGNAL_STORAGE_PATH=/var/lib/signal-state/profile \
    SIGNAL_PROFILE_LOCK_PATH=/var/lib/signal-state/.signal-desktop-cli.lock \
    SIGNAL_UI_LISTEN_ADDRESS=0.0.0.0 \
    SIGNAL_UI_PORT=6080 \
    SIGNAL_VNC_PORT=5900 \
    SIGNAL_UI_RESOLUTION=1440x900 \
    XDG_CACHE_HOME=/home/signal/.cache \
    XDG_RUNTIME_DIR=/tmp/runtime-signal

EXPOSE 6080
VOLUME ["/var/lib/signal-state"]

USER signal
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/signal-ui-entrypoint"]

FROM debian:bookworm-slim AS signal-state

ARG SIGNAL_UID=10001
ARG SIGNAL_GID=10001

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      awscli \
      ca-certificates \
      python3 \
      tar \
      util-linux \
      zstd \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${SIGNAL_GID}" signal \
    && useradd --uid "${SIGNAL_UID}" --gid signal --create-home --shell /bin/bash signal \
    && install -d --owner signal --group signal --mode 0700 \
      /var/lib/signal-state \
      /var/lib/signal-state/profile \
      /opt/signal-state/ts/sql/migrations

COPY --chmod=0755 docker/state_cli.py /usr/local/bin/signal-state
COPY package.json /opt/signal-state/package.json
COPY ts/sql/migrations/index.node.ts /opt/signal-state/ts/sql/migrations/index.node.ts

ENV HOME=/home/signal \
    SIGNAL_STORAGE_PATH=/var/lib/signal-state/profile \
    SIGNAL_PROFILE_LOCK_PATH=/var/lib/signal-state/.signal-desktop-cli.lock

VOLUME ["/var/lib/signal-state"]
USER signal
ENTRYPOINT ["/usr/local/bin/signal-state"]

FROM source-build AS daemon-runtime

RUN pnpm run build:protobuf \
    && pnpm run build:emoji-data \
    && pnpm run get-expire-time \
    && pnpm run build:rolldown:prod

RUN node scripts/copy-daemon-runtime.mjs bundles /daemon-runtime/bundles \
    && install -d /daemon-runtime/node_modules/@signalapp \
    && cp -aL node_modules/@signalapp/libsignal-client \
      /daemon-runtime/node_modules/@signalapp/libsignal-client \
    && cp -aL node_modules/@signalapp/sqlcipher \
      /daemon-runtime/node_modules/@signalapp/sqlcipher \
    && cp -aL node_modules/@signalapp/ringrtc \
      /daemon-runtime/node_modules/@signalapp/ringrtc \
    && cp -aL node_modules/.pnpm/node-gyp-build@4.8.4/node_modules/node-gyp-build \
      /daemon-runtime/node_modules/node-gyp-build \
    && find /daemon-runtime/node_modules/@signalapp/libsignal-client/prebuilds \
      -mindepth 1 -maxdepth 1 -type d ! -name linux-x64 -exec rm -rf {} + \
    && find /daemon-runtime/node_modules/@signalapp/sqlcipher/prebuilds \
      -mindepth 1 -maxdepth 1 -type d ! -name linux-x64 -exec rm -rf {} + \
    && find /daemon-runtime/node_modules/@signalapp/ringrtc/build \
      -mindepth 1 -maxdepth 1 -type d ! -name linux -exec rm -rf {} + \
    && find /daemon-runtime/node_modules/@signalapp/ringrtc/build/linux \
      -type f ! -name 'libringrtc-x64.node' -delete \
    && rm -rf /daemon-runtime/node_modules/@signalapp/ringrtc/scripts \
    && find /daemon-runtime -type f \( -name '*.d.ts' -o -name '*.map' \) -delete

FROM node:${NODE_VERSION}-bookworm-slim AS signal-daemon

ARG SIGNAL_UID=10001
ARG SIGNAL_GID=10001

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      libpulse0 \
      tini \
      util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${SIGNAL_GID}" signal \
    && useradd --uid "${SIGNAL_UID}" --gid signal --create-home --shell /bin/bash signal \
    && install -d --owner signal --group signal --mode 0700 \
      /var/lib/signal-state \
      /var/lib/signal-state/profile \
      /opt/signal-desktop

COPY --from=daemon-runtime /daemon-runtime/ /opt/signal-desktop/
COPY --chmod=0755 docker/daemon-entrypoint.sh /usr/local/bin/signal-daemon-entrypoint

ENV HOME=/home/signal \
    NODE_ENV=production \
    SIGNAL_API_HOST=127.0.0.1 \
    SIGNAL_API_PORT=8080 \
    SIGNAL_DAEMON_CONNECT=true \
    SIGNAL_DAEMON_SHUTDOWN_TIMEOUT_MS=30000 \
    SIGNAL_PROFILE_LOCK_PATH=/var/lib/signal-state/.signal-desktop-cli.lock \
    SIGNAL_STORAGE_PATH=/var/lib/signal-state/profile

EXPOSE 8080
VOLUME ["/var/lib/signal-state"]
USER signal
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/signal-daemon-entrypoint"]
