#!/bin/sh
# Copyright 2024 Signal Messenger, LLC
# SPDX-License-Identifier: AGPL-3.0-only

# Usage:
# ./build.sh [ dev (default) | public (prod and beta builds) | alpha | test | staging ]
# Env vars:
# SKIP_DOCKER_BUILD: To support docker build cache during actions.
# BUILD_TARGETS: Override build targets. Empty default results in deb. Comma separated list.
# BUILD_ARCH: Override build architectures. Empty default results in x64. Comma separated list.

# Examples:
# ./build.sh public

# First we prepare the docker container in which our build scripts will run. This container includes
# all build dependencies at specific versions.
# We set SOURCE_DATE_EPOCH to make system build timestamps deterministic.
if [ -z "${SKIP_DOCKER_BUILD}" ]; then
  docker build -t signal-desktop --build-arg NODE_VERSION=$(cat ../.nvmrc) .
else
  echo "Skipping docker build step because SKIP_DOCKER_BUILD was set"
fi

# Before performing the actual build, go to the project root.
cd ..

# Prepare the timestamp of the actual build based on the latest git commit.
if ! git_timestamp=$(git log -1 --pretty=%ct) || [ -z "${git_timestamp}" ]; then
  echo "Cannot get the latest Git commit timestamp; refusing to build." >&2
  exit 1
fi
case "${git_timestamp}" in
  *[!0-9]* | 0)
    echo "Latest Git commit timestamp is invalid; refusing to build." >&2
    exit 1
    ;;
esac
echo "At commit: $(git log -1 --oneline)"
echo "Setting SOURCE_DATE_EPOCH to latest commit's timestamp."
source_date_epoch="${git_timestamp}"

# Perform the build by mounting the project into the container and passing in the 1st command line
# arg to select the build type (e.g. "public"). The container runs docker-entrypoint.sh.
# After the process is finished, the resulting package is located in the ./release/ directory.
# npm cache set to tmp to fix permissions issues.
docker run --rm \
  -v "$(pwd)":/project \
  -w /project \
  --user "$(id -u):$(id -g)" \
  -e NPM_CONFIG_CACHE=/tmp/.npm-cache \
  -e PNPM_HOME=/tmp/.pnpm-home \
  -e SOURCE_DATE_EPOCH=$source_date_epoch \
  -e BUILD_TARGETS=$BUILD_TARGETS \
  -e BUILD_ARCH=$BUILD_ARCH \
  signal-desktop $1
