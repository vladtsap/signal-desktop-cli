# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.17.0

FROM node:${NODE_VERSION}-bookworm AS ui-build

ARG TARGETARCH
ARG SOURCE_DATE_EPOCH=1783615919
ENV CI=true \
    SIGNAL_ENV=production \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}

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
COPY . .

RUN pnpm install --frozen-lockfile
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
      age \
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

ARG SIGNAL_BUILD_CREATED_AT=2026-07-09T16:51:59Z
ARG SIGNAL_GIT_REVISION=a3661965bc6e240dadb851f5c57472b25c8aa189

ENV HOME=/home/signal \
    SIGNAL_BUILD_CREATED_AT=${SIGNAL_BUILD_CREATED_AT} \
    SIGNAL_GIT_REVISION=${SIGNAL_GIT_REVISION} \
    SIGNAL_STORAGE_PATH=/var/lib/signal-state/profile \
    SIGNAL_PROFILE_LOCK_PATH=/var/lib/signal-state/.signal-desktop-cli.lock

VOLUME ["/var/lib/signal-state"]
USER signal
ENTRYPOINT ["/usr/local/bin/signal-state"]
