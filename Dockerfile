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
      /var/lib/signal-desktop \
      /home/signal/.cache

COPY --chmod=0755 docker/ui-entrypoint.sh /usr/local/bin/signal-ui-entrypoint

ENV DISPLAY=:99 \
    HOME=/home/signal \
    SIGNAL_STORAGE_PATH=/var/lib/signal-desktop \
    SIGNAL_PROFILE_LOCK_PATH=/var/lib/signal-desktop/.signal-desktop-cli.lock \
    SIGNAL_UI_LISTEN_ADDRESS=0.0.0.0 \
    SIGNAL_UI_PORT=6080 \
    SIGNAL_VNC_PORT=5900 \
    SIGNAL_UI_RESOLUTION=1440x900 \
    XDG_CACHE_HOME=/home/signal/.cache \
    XDG_RUNTIME_DIR=/tmp/runtime-signal

EXPOSE 6080
VOLUME ["/var/lib/signal-desktop"]

USER signal
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/signal-ui-entrypoint"]
