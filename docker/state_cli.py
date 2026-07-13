#!/usr/bin/env python3
# Copyright 2026 Signal Desktop CLI contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Offline, encrypted snapshots of a Signal Desktop profile in Cloudflare R2."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid
from pathlib import Path, PurePosixPath
from typing import Any, Iterator, Sequence


FORMAT_VERSION = 1
SNAPSHOT_SUFFIX = ".tar.zst.age"
DESCRIPTOR_SUFFIX = ".metadata.json"
DEFAULT_PROFILE = Path("/var/lib/signal-state/profile")
DEFAULT_LOCK = Path("/var/lib/signal-state/.signal-desktop-cli.lock")


class StateError(RuntimeError):
    """An expected, user-actionable state command failure."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def normalize_prefix(value: str) -> str:
    parts = [part for part in value.strip("/").split("/") if part]
    if any(part in (".", "..") for part in parts):
        raise StateError("R2_PREFIX must not contain '.' or '..' components")
    return "/".join(parts)


def snapshot_key(prefix: str, created_at: dt.datetime, snapshot_id: str) -> str:
    name = f"{created_at.strftime('%Y%m%dT%H%M%SZ')}-{snapshot_id}{SNAPSHOT_SUFFIX}"
    return f"{prefix}/{name}" if prefix else name


def descriptor_key(object_key: str) -> str:
    if not object_key.endswith(SNAPSHOT_SUFFIX):
        raise StateError(f"Not a snapshot object key: {object_key}")
    return f"{object_key[:-len(SNAPSHOT_SUFFIX)]}{DESCRIPTOR_SUFFIX}"


def snapshot_key_from_descriptor(key: str) -> str:
    if not key.endswith(DESCRIPTOR_SUFFIX):
        raise StateError(f"Not a snapshot descriptor key: {key}")
    return f"{key[:-len(DESCRIPTOR_SUFFIX)]}{SNAPSHOT_SUFFIX}"


def resolve_snapshot(reference: str, descriptors: list[dict[str, Any]]) -> dict[str, Any]:
    if not descriptors:
        raise StateError("No snapshots found")
    ordered = sorted(descriptors, key=lambda item: str(item["createdAt"]), reverse=True)
    if reference == "latest":
        return ordered[0]
    matches = [
        item
        for item in ordered
        if item.get("snapshotId") == reference or item.get("objectKey") == reference
    ]
    if len(matches) != 1:
        raise StateError(f"Snapshot not found: {reference}")
    return matches[0]


def validate_descriptor(value: Any, descriptor_object_key: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise StateError(f"Invalid snapshot descriptor: {descriptor_object_key}")
    required_types = {
        "snapshotId": str,
        "createdAt": str,
        "objectKey": str,
        "objectSize": int,
        "objectSha256": str,
    }
    if value.get("formatVersion") != FORMAT_VERSION or any(
        not isinstance(value.get(name), expected)
        for name, expected in required_types.items()
    ):
        raise StateError(f"Invalid snapshot descriptor: {descriptor_object_key}")
    if descriptor_key(value["objectKey"]) != descriptor_object_key:
        raise StateError(f"Snapshot descriptor key mismatch: {descriptor_object_key}")
    if value["objectSize"] < 1 or not re.fullmatch(
        r"[0-9a-f]{64}", value["objectSha256"]
    ):
        raise StateError(f"Invalid snapshot checksum metadata: {descriptor_object_key}")
    return value


def safe_archive_member(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and ".." not in path.parts


def profile_entries(profile: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for path in sorted(profile.rglob("*")):
        relative = path.relative_to(profile).as_posix()
        mode = path.lstat().st_mode
        if stat.S_ISREG(mode):
            if path.stat().st_nlink != 1:
                raise StateError(f"Hardlinks are not supported in profiles: {relative}")
            entries.append(
                {
                    "path": relative,
                    "size": path.stat().st_size,
                    "sha256": sha256_file(path),
                    "type": "file",
                }
            )
        elif stat.S_ISLNK(mode):
            raise StateError(f"Symlinks are not supported in profiles: {relative}")
        elif stat.S_ISDIR(mode):
            entries.append({"path": relative, "type": "directory"})
        else:
            raise StateError(f"Unsupported profile entry: {relative}")
    return entries


def validate_profile(profile: Path, manifest: dict[str, Any]) -> None:
    if manifest.get("formatVersion") != FORMAT_VERSION:
        raise StateError("Unsupported snapshot format version")
    expected = manifest.get("files")
    if not isinstance(expected, list):
        raise StateError("Snapshot manifest has no file inventory")
    actual = profile_entries(profile)
    if actual != expected:
        raise StateError("Restored profile does not match the encrypted manifest")


def inspect_archive(path: Path, profile_name: str) -> None:
    """Reject entries which could escape staging or create special files."""

    try:
        with tarfile.open(path, mode="r:") as archive:
            members = archive.getmembers()
    except tarfile.TarError as error:
        raise StateError("Snapshot contains an invalid tar archive") from error
    if not members:
        raise StateError("Snapshot tar archive is empty")
    allowed_roots = {profile_name, ".signal-state"}
    for member in members:
        member_path = PurePosixPath(member.name)
        if (
            not safe_archive_member(member.name)
            or not member_path.parts
            or member_path.parts[0] not in allowed_roots
        ):
            raise StateError(f"Snapshot contains an unsafe archive path: {member.name}")
        # This explicitly excludes symlinks, hardlinks, devices, FIFOs, sockets,
        # and unknown extension records. Our snapshot format needs only these two
        # entry types; rejecting everything else makes extraction predictable.
        if not (member.isfile() or member.isdir()):
            raise StateError(
                f"Snapshot contains unsupported archive entry: {member.name}"
            )


def profile_is_empty(profile: Path) -> bool:
    return not profile.exists() or next(profile.iterdir(), None) is None


def load_build_metadata() -> dict[str, Any]:
    package_path = Path(os.getenv("SIGNAL_PACKAGE_JSON", "/opt/signal-state/package.json"))
    migrations_path = Path(
        os.getenv(
            "SIGNAL_MIGRATIONS_SOURCE",
            "/opt/signal-state/ts/sql/migrations/index.node.ts",
        )
    )
    version = os.getenv("SIGNAL_APP_VERSION")
    if not version and package_path.is_file():
        version = json.loads(package_path.read_text(encoding="utf-8")).get("version")
    schema_version: int | None = None
    if migrations_path.is_file():
        versions = [
            int(value)
            for value in re.findall(
                r"(?:version\s*:\s*|toVersion\(\s*)(\d+)",
                migrations_path.read_text(encoding="utf-8"),
            )
        ]
        schema_version = max(versions, default=None)
    return {
        "version": version,
        "gitRevision": os.getenv("SIGNAL_GIT_REVISION"),
        "buildCreatedAt": os.getenv("SIGNAL_BUILD_CREATED_AT"),
        "supportedSchemaVersion": schema_version,
        # SQLCipher prevents safe inspection without starting Signal and obtaining
        # its key. Record that limitation rather than guessing the live DB schema.
        "profileSchemaVersion": None,
    }


class Config:
    def __init__(self, *, require_recipient: bool = False, require_identity: bool = False):
        self.profile = Path(os.getenv("SIGNAL_STORAGE_PATH", str(DEFAULT_PROFILE)))
        self.lock = Path(os.getenv("SIGNAL_PROFILE_LOCK_PATH", str(DEFAULT_LOCK)))
        self.bucket = require_env("R2_BUCKET")
        account_id = os.getenv("R2_ACCOUNT_ID")
        self.endpoint = os.getenv("R2_ENDPOINT_URL") or (
            f"https://{account_id}.r2.cloudflarestorage.com" if account_id else ""
        )
        if not self.endpoint:
            raise StateError("Set R2_ENDPOINT_URL or R2_ACCOUNT_ID")
        self.access_key = require_env("R2_ACCESS_KEY_ID")
        self.secret_key = require_env("R2_SECRET_ACCESS_KEY")
        self.prefix = normalize_prefix(os.getenv("R2_PREFIX", "signal-state"))
        self.recipient = os.getenv("AGE_RECIPIENT")
        self.identity = os.getenv("AGE_IDENTITY_FILE")
        if require_recipient and not self.recipient:
            raise StateError("Set AGE_RECIPIENT for state push")
        if require_identity:
            if not self.identity:
                raise StateError("Set AGE_IDENTITY_FILE for state pull or verify")
            if not Path(self.identity).is_file():
                raise StateError("AGE_IDENTITY_FILE is not readable")

    def aws_env(self) -> dict[str, str]:
        result = os.environ.copy()
        result.update(
            {
                "AWS_ACCESS_KEY_ID": self.access_key,
                "AWS_SECRET_ACCESS_KEY": self.secret_key,
                "AWS_DEFAULT_REGION": "auto",
                "AWS_CLI_AUTO_PROMPT": "off",
                "AWS_PAGER": "",
                "AWS_EC2_METADATA_DISABLED": "true",
            }
        )
        return result


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise StateError(f"Set {name}")
    return value


@contextlib.contextmanager
def profile_lock(config: Config) -> Iterator[None]:
    config.lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with config.lock.open("a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise StateError(f"Signal profile is already in use: {config.profile}") from error
        yield


def run(
    command: Sequence[str], *, config: Config, **kwargs: Any
) -> subprocess.CompletedProcess[Any]:
    try:
        return subprocess.run(command, check=True, env=config.aws_env(), **kwargs)
    except FileNotFoundError as error:
        raise StateError(f"Required executable is missing: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        raise StateError(f"Command failed: {command[0]}") from error


def aws(
    config: Config, arguments: Sequence[str], **kwargs: Any
) -> subprocess.CompletedProcess[Any]:
    return run(
        ["aws", "--endpoint-url", config.endpoint, *arguments],
        config=config,
        **kwargs,
    )


def read_descriptors(config: Config) -> list[dict[str, Any]]:
    prefix = f"{config.prefix}/" if config.prefix else ""
    result = aws(
        config,
        [
            "s3api",
            "list-objects-v2",
            "--bucket",
            config.bucket,
            "--prefix",
            prefix,
            "--output",
            "json",
        ],
        capture_output=True,
        text=True,
    )
    objects = json.loads(result.stdout or "{}").get("Contents", [])
    descriptors: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="signal-state-list-") as temp:
        for item in objects:
            key = item.get("Key", "")
            if not key.endswith(DESCRIPTOR_SUFFIX):
                continue
            target = Path(temp) / f"{len(descriptors)}.json"
            aws(
                config,
                [
                    "s3",
                    "cp",
                    f"s3://{config.bucket}/{key}",
                    str(target),
                    "--only-show-errors",
                ],
            )
            descriptor = validate_descriptor(
                json.loads(target.read_text(encoding="utf-8")), key
            )
            descriptor["descriptorKey"] = key
            descriptors.append(descriptor)
    return descriptors


def create_manifest(profile: Path, snapshot_id: str, created_at: dt.datetime) -> dict[str, Any]:
    manifest = {
        "formatVersion": FORMAT_VERSION,
        "snapshotId": snapshot_id,
        "createdAt": created_at.isoformat().replace("+00:00", "Z"),
        "app": load_build_metadata(),
        "files": profile_entries(profile),
    }
    # Reject unsafe links before tar sees them. Since age authenticates the whole
    # archive, a snapshot that passes this check cannot later be tampered with.
    validate_profile(profile, manifest)
    return manifest


def command_push(config: Config) -> None:
    with profile_lock(config):
        if profile_is_empty(config.profile):
            raise StateError(f"Signal profile is empty: {config.profile}")
        created_at = utc_now()
        snapshot_id = str(uuid.uuid4())
        key = snapshot_key(config.prefix, created_at, snapshot_id)
        with tempfile.TemporaryDirectory(
            prefix=".signal-state-push-", dir=config.profile.parent
        ) as temp_name:
            temp = Path(temp_name)
            metadata_dir = temp / ".signal-state"
            metadata_dir.mkdir()
            manifest = create_manifest(config.profile, snapshot_id, created_at)
            (metadata_dir / "manifest.json").write_text(
                json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            encrypted = temp / Path(key).name
            tar = subprocess.Popen(
                [
                    "tar",
                    "--create",
                    "--format=posix",
                    "--numeric-owner",
                    "--owner=0",
                    "--group=0",
                    "--hard-dereference",
                    "-C",
                    str(config.profile.parent),
                    config.profile.name,
                    "-C",
                    str(temp),
                    ".signal-state",
                ],
                stdout=subprocess.PIPE,
            )
            zstd = subprocess.Popen(
                ["zstd", "--quiet", "--threads=0", "--stdout"],
                stdin=tar.stdout,
                stdout=subprocess.PIPE,
            )
            assert tar.stdout is not None and zstd.stdout is not None
            tar.stdout.close()
            with encrypted.open("wb") as output:
                age = subprocess.run(
                    ["age", "--encrypt", "--recipient", config.recipient or "-"],
                    stdin=zstd.stdout,
                    stdout=output,
                    check=False,
                )
            zstd.stdout.close()
            zstd_status = zstd.wait()
            tar_status = tar.wait()
            if age.returncode or zstd_status or tar_status:
                raise StateError("Failed to create encrypted snapshot")
            descriptor = {
                "formatVersion": FORMAT_VERSION,
                "snapshotId": snapshot_id,
                "createdAt": manifest["createdAt"],
                "objectKey": key,
                "objectSize": encrypted.stat().st_size,
                "objectSha256": sha256_file(encrypted),
                "app": manifest["app"],
            }
            descriptor_path = temp / "metadata.json"
            descriptor_path.write_text(
                json.dumps(descriptor, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            # `aws s3 cp` automatically uses managed multipart uploads for large
            # files. Upload the payload first so a listed descriptor is complete.
            aws(
                config,
                [
                    "s3",
                    "cp",
                    str(encrypted),
                    f"s3://{config.bucket}/{key}",
                    "--only-show-errors",
                    "--no-progress",
                ],
            )
            aws(
                config,
                [
                    "s3",
                    "cp",
                    str(descriptor_path),
                    f"s3://{config.bucket}/{descriptor_key(key)}",
                    "--content-type",
                    "application/json",
                    "--only-show-errors",
                    "--no-progress",
                ],
            )
    print(snapshot_id)


def download_snapshot(config: Config, reference: str, destination: Path) -> dict[str, Any]:
    descriptor = resolve_snapshot(reference, read_descriptors(config))
    aws(
        config,
        [
            "s3",
            "cp",
            f"s3://{config.bucket}/{descriptor['objectKey']}",
            str(destination),
            "--only-show-errors",
            "--no-progress",
        ],
    )
    if destination.stat().st_size != descriptor["objectSize"]:
        raise StateError("Downloaded snapshot size does not match metadata")
    if sha256_file(destination) != descriptor["objectSha256"]:
        raise StateError("Downloaded snapshot checksum does not match metadata")
    return descriptor


def extract_snapshot(config: Config, encrypted: Path, destination: Path) -> dict[str, Any]:
    destination.mkdir(parents=True, mode=0o700)
    plain_tar = destination.parent / "snapshot.tar"
    with plain_tar.open("wb") as output:
        run(
            [
                "bash",
                "-o",
                "pipefail",
                "-c",
                'age --decrypt --identity "$1" "$2" '
                "| zstd --decompress --quiet --stdout",
                "signal-state-decrypt",
                config.identity,
                str(encrypted),
            ],
            config=config,
            stdout=output,
        )
    inspect_archive(plain_tar, config.profile.name)
    run(
        [
            "tar",
            "--extract",
            "--no-same-owner",
            "--no-same-permissions",
            "--file",
            str(plain_tar),
            "--directory",
            str(destination),
        ],
        config=config,
    )
    manifest_path = destination / ".signal-state" / "manifest.json"
    restored_profile = destination / config.profile.name
    if not manifest_path.is_file() or not restored_profile.is_dir():
        raise StateError("Snapshot is missing its profile or encrypted manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    validate_profile(restored_profile, manifest)
    return manifest


def activate_profile(profile: Path, restored: Path) -> None:
    profile.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    previous = profile.parent / f".{profile.name}.previous-{uuid.uuid4()}"
    had_profile = profile.exists()
    try:
        if had_profile:
            profile.rename(previous)
        restored.rename(profile)
    except BaseException:
        if had_profile and previous.exists() and not profile.exists():
            previous.rename(profile)
        raise
    if previous.exists():
        shutil.rmtree(previous)


def command_pull(config: Config, reference: str, replace: bool) -> None:
    with profile_lock(config):
        if not replace and not profile_is_empty(config.profile):
            raise StateError("Signal profile is not empty; pass --replace to overwrite it")
        config.profile.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(
            prefix=".signal-state-restore-", dir=config.profile.parent
        ) as temp_name:
            temp = Path(temp_name)
            encrypted = temp / "snapshot.age"
            descriptor = download_snapshot(config, reference, encrypted)
            extracted = temp / "extracted"
            manifest = extract_snapshot(config, encrypted, extracted)
            if manifest["snapshotId"] != descriptor["snapshotId"]:
                raise StateError("Encrypted manifest does not match snapshot metadata")
            activate_profile(config.profile, extracted / config.profile.name)
    print(manifest["snapshotId"])


def command_verify(config: Config, reference: str) -> None:
    with profile_lock(config):
        config.profile.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(
            prefix=".signal-state-verify-", dir=config.profile.parent
        ) as temp_name:
            temp = Path(temp_name)
            encrypted = temp / "snapshot.age"
            descriptor = download_snapshot(config, reference, encrypted)
            manifest = extract_snapshot(config, encrypted, temp / "extracted")
            if manifest["snapshotId"] != descriptor["snapshotId"]:
                raise StateError("Encrypted manifest does not match snapshot metadata")
    print(json.dumps(manifest, indent=2, sort_keys=True))


def command_list(config: Config) -> None:
    with profile_lock(config):
        descriptors = sorted(
            read_descriptors(config),
            key=lambda item: str(item["createdAt"]),
            reverse=True,
        )
    print(json.dumps(descriptors, indent=2, sort_keys=True))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="signal-state")
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("push", help="encrypt and upload the offline profile")
    commands.add_parser("list", help="list immutable snapshots in R2")
    pull = commands.add_parser("pull", help="download and restore a snapshot")
    pull.add_argument("snapshot", nargs="?", default="latest")
    pull.add_argument("--replace", action="store_true")
    verify = commands.add_parser("verify", help="download and fully verify a snapshot")
    verify.add_argument("snapshot", nargs="?", default="latest")
    return result


def main(arguments: Sequence[str] | None = None) -> int:
    os.umask(0o077)
    args = parser().parse_args(arguments)
    try:
        if args.command == "push":
            command_push(Config(require_recipient=True))
        elif args.command == "pull":
            command_pull(Config(require_identity=True), args.snapshot, args.replace)
        elif args.command == "verify":
            command_verify(Config(require_identity=True), args.snapshot)
        elif args.command == "list":
            command_list(Config())
        return 0
    except (StateError, json.JSONDecodeError, OSError) as error:
        print(f"signal-state: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
