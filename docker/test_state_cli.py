#!/usr/bin/env python3
# Copyright 2026 Signal Desktop CLI contributors
# SPDX-License-Identifier: AGPL-3.0-only

import fcntl
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import state_cli


class StateCliTest(unittest.TestCase):
    def test_snapshot_keys_are_versioned_and_prefixed(self) -> None:
        created = state_cli.dt.datetime(2026, 7, 13, 12, 30, tzinfo=state_cli.dt.timezone.utc)
        key = state_cli.snapshot_key("profiles/main", created, "snapshot-id")
        self.assertEqual(
            key, "profiles/main/20260713T123000Z-snapshot-id.tar.zst.age"
        )
        self.assertEqual(
            state_cli.snapshot_key_from_descriptor(state_cli.descriptor_key(key)), key
        )

    def test_prefix_rejects_parent_components(self) -> None:
        with self.assertRaisesRegex(state_cli.StateError, "must not contain"):
            state_cli.normalize_prefix("safe/../unsafe")

    def test_resolve_latest_and_explicit_snapshot(self) -> None:
        items = [
            {"snapshotId": "old", "createdAt": "2026-01-01T00:00:00Z"},
            {"snapshotId": "new", "createdAt": "2026-02-01T00:00:00Z"},
        ]
        self.assertEqual(state_cli.resolve_snapshot("latest", items)["snapshotId"], "new")
        self.assertEqual(state_cli.resolve_snapshot("old", items)["snapshotId"], "old")
        with self.assertRaisesRegex(state_cli.StateError, "not found"):
            state_cli.resolve_snapshot("missing", items)

    def test_manifest_detects_content_changes(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            profile = Path(name)
            (profile / "config.json").write_text("original", encoding="utf-8")
            manifest = {
                "formatVersion": state_cli.FORMAT_VERSION,
                "files": state_cli.profile_entries(profile),
            }
            state_cli.validate_profile(profile, manifest)
            (profile / "config.json").write_text("changed", encoding="utf-8")
            with self.assertRaisesRegex(state_cli.StateError, "does not match"):
                state_cli.validate_profile(profile, manifest)

    def test_manifest_rejects_all_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            profile = Path(name) / "profile"
            profile.mkdir()
            (profile / "escape").symlink_to("../../outside")
            with self.assertRaisesRegex(state_cli.StateError, "Symlinks are not supported"):
                state_cli.profile_entries(profile)

    def test_manifest_rejects_hardlinks(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            profile = Path(name)
            original = profile / "original"
            original.write_text("data", encoding="utf-8")
            os.link(original, profile / "hardlink")
            with self.assertRaisesRegex(state_cli.StateError, "Hardlinks are not supported"):
                state_cli.profile_entries(profile)

    def test_manifest_rejects_fifo(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            profile = Path(name)
            os.mkfifo(profile / "pipe")
            with self.assertRaisesRegex(state_cli.StateError, "Unsupported profile entry"):
                state_cli.profile_entries(profile)

    def test_archive_member_validation(self) -> None:
        self.assertTrue(state_cli.safe_archive_member("profile/sql/db.sqlite"))
        self.assertFalse(state_cli.safe_archive_member("/etc/passwd"))
        self.assertFalse(state_cli.safe_archive_member("profile/../../etc/passwd"))

    def test_archive_rejects_links_devices_and_fifo_before_extraction(self) -> None:
        unsafe_types = (
            tarfile.SYMTYPE,
            tarfile.LNKTYPE,
            tarfile.FIFOTYPE,
            tarfile.CHRTYPE,
            tarfile.BLKTYPE,
        )
        for entry_type in unsafe_types:
            with self.subTest(entry_type=entry_type), tempfile.TemporaryDirectory() as name:
                archive_path = Path(name) / "malicious.tar"
                with tarfile.open(archive_path, "w") as archive:
                    root = tarfile.TarInfo("profile")
                    root.type = tarfile.DIRTYPE
                    archive.addfile(root)
                    unsafe = tarfile.TarInfo("profile/link")
                    unsafe.type = entry_type
                    unsafe.linkname = "../../outside"
                    archive.addfile(unsafe)
                    # A later regular member under the link demonstrates the
                    # classic traversal sequence the metadata check must stop.
                    payload = b"malicious"
                    nested = tarfile.TarInfo("profile/link/payload")
                    nested.size = len(payload)
                    archive.addfile(nested, io.BytesIO(payload))
                with self.assertRaisesRegex(
                    state_cli.StateError, "unsupported archive entry"
                ):
                    state_cli.inspect_archive(archive_path, "profile")

    def test_descriptor_must_match_its_object_key(self) -> None:
        value = {
            "formatVersion": state_cli.FORMAT_VERSION,
            "snapshotId": "id",
            "createdAt": "2026-07-13T12:00:00Z",
            "objectKey": "prefix/snapshot.tar.zst.age",
            "objectSize": 12,
            "objectSha256": "a" * 64,
        }
        state_cli.validate_descriptor(value, "prefix/snapshot.metadata.json")
        with self.assertRaisesRegex(state_cli.StateError, "key mismatch"):
            state_cli.validate_descriptor(value, "prefix/different.metadata.json")

    def test_pull_refuses_nonempty_profile_before_download(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            profile = root / "profile"
            profile.mkdir()
            (profile / "existing").write_text("data", encoding="utf-8")
            config = mock.Mock(profile=profile, lock=root / ".lock")
            with mock.patch.object(state_cli, "download_snapshot") as download:
                with self.assertRaisesRegex(state_cli.StateError, "not empty"):
                    state_cli.command_pull(config, "latest", False)
                download.assert_not_called()

    def test_profile_lock_refuses_concurrent_user(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            lock = Path(name) / ".lock"
            config = mock.Mock(profile=Path(name) / "profile", lock=lock)
            with lock.open("a+") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(state_cli.StateError, "already in use"):
                    with state_cli.profile_lock(config):
                        pass

    def test_activate_profile_rolls_back_failed_activation(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            profile = root / "profile"
            profile.mkdir()
            (profile / "old").write_text("old", encoding="utf-8")
            with self.assertRaises(FileNotFoundError):
                state_cli.activate_profile(profile, root / "missing-restored")
            self.assertEqual((profile / "old").read_text(encoding="utf-8"), "old")

    def test_config_does_not_require_age_for_list(self) -> None:
        environment = {
            "R2_ACCOUNT_ID": "account",
            "R2_BUCKET": "bucket",
            "R2_ACCESS_KEY_ID": "key",
            "R2_SECRET_ACCESS_KEY": "secret",
        }
        with mock.patch.dict(os.environ, environment, clear=True):
            config = state_cli.Config()
        self.assertEqual(config.endpoint, "https://account.r2.cloudflarestorage.com")

    @unittest.skipUnless(
        all(shutil.which(tool) for tool in ("age", "age-keygen", "tar", "zstd")),
        "archive tools are installed in the state container",
    )
    def test_encrypted_push_pull_round_trip_with_local_object_store(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            volume = root / "volume"
            profile = volume / "profile"
            objects = root / "objects"
            profile.mkdir(parents=True)
            objects.mkdir()
            (profile / "config.json").write_text("linked-profile", encoding="utf-8")
            identity = root / "identity.txt"
            subprocess.run(
                ["age-keygen", "--output", str(identity)],
                check=True,
                capture_output=True,
                text=True,
            )
            recipient = subprocess.run(
                ["age-keygen", "--y", str(identity)],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            config = mock.Mock(
                profile=profile,
                lock=volume / ".lock",
                bucket="bucket",
                prefix="snapshots",
                recipient=recipient,
                identity=str(identity),
                aws_env=lambda: os.environ.copy(),
            )

            def local_aws(_config, arguments, **_kwargs):
                if arguments[:2] == ["s3api", "list-objects-v2"]:
                    keys = [
                        path.relative_to(objects).as_posix()
                        for path in objects.rglob("*")
                        if path.is_file()
                    ]
                    return subprocess.CompletedProcess(
                        arguments,
                        0,
                        stdout=json.dumps({"Contents": [{"Key": key} for key in keys]}),
                    )
                self.assertEqual(arguments[:2], ["s3", "cp"])
                source, destination = arguments[2:4]

                def path_for(value):
                    if value.startswith("s3://bucket/"):
                        return objects / value.removeprefix("s3://bucket/")
                    return Path(value)

                source_path = path_for(source)
                destination_path = path_for(destination)
                destination_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source_path, destination_path)
                return subprocess.CompletedProcess(arguments, 0)

            with mock.patch.object(state_cli, "aws", side_effect=local_aws):
                with mock.patch("builtins.print") as output:
                    state_cli.command_push(config)
                    snapshot_id = output.call_args.args[0]
                shutil.rmtree(profile)
                state_cli.command_pull(config, snapshot_id, False)
            self.assertEqual(
                (profile / "config.json").read_text(encoding="utf-8"),
                "linked-profile",
            )


if __name__ == "__main__":
    unittest.main()
