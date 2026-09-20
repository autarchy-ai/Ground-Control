"""Boundary tests for publishing and fetching the sandbox template image."""

from __future__ import annotations

import hashlib
import io
import tarfile
from contextlib import nullcontext
import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.incus_sandbox import registry_image
from tools.incus_sandbox.registry_image import (
    RegistryError,
    imported_fingerprint,
    layer_descriptor,
    manifest_document,
    parse_reference,
    registry_token,
)


def config() -> SimpleNamespace:
    return SimpleNamespace(project="gc-sandbox")


def manifest(digest: str = "sha256:" + "a" * 64, size: int = 64) -> dict[str, object]:
    return manifest_document(digest, size, "sha256:" + "b" * 64, 2, {})


class ReferenceBoundaryTest(unittest.TestCase):
    def test_accepts_only_a_closed_registry_reference(self) -> None:
        self.assertEqual(parse_reference("ghcr.io/autarchy-ai/gc-sandbox-template:latest"),
                         ("ghcr.io", "autarchy-ai/gc-sandbox-template", "latest"))
        for reference in ("docker.io/library/alpine:latest", "ghcr.io/owner/name",
                          "ghcr.io/owner/name:tag;rm", "https://ghcr.io/owner/name:tag",
                          "ghcr.io/../escape:latest"):
            with self.assertRaises(RegistryError):
                parse_reference(reference)

    def test_an_artifact_must_carry_exactly_one_incus_image_layer(self) -> None:
        self.assertEqual(layer_descriptor(manifest()), ("sha256:" + "a" * 64, 64))
        oversized = manifest(size=16 * 1024 * 1024 * 1024)
        for document in ({"layers": []}, {"layers": [{"mediaType": "application/octet-stream"}]},
                         {"layers": [{"mediaType": "application/vnd.incus.image.layer.v1.tar+gzip"}]},
                         oversized, manifest(size=0)):
            with self.assertRaises(RegistryError):
                layer_descriptor(document)

    def test_a_credential_is_exchanged_for_a_scoped_token_and_never_sent_as_a_url(self) -> None:
        seen: dict[str, object] = {}

        def request(url: str, **kwargs: object) -> tuple[bytes, dict[str, str]]:
            seen["url"] = url
            seen["extra"] = kwargs.get("extra")
            return json.dumps({"token": "scoped"}).encode("utf-8"), {}

        with patch("tools.incus_sandbox.registry_image._request", side_effect=request):
            self.assertEqual(registry_token("ghcr.io", "owner/name", "pull,push", "secret-canary"), "scoped")
        self.assertNotIn("secret-canary", str(seen["url"]))
        self.assertIn("Basic ", seen["extra"]["Authorization"])
        self.assertIn("repository:owner/name:pull,push", str(seen["url"]))

    def test_a_registry_without_a_token_is_refused(self) -> None:
        with patch("tools.incus_sandbox.registry_image._request", return_value=(b"{}", {})):
            with self.assertRaises(RegistryError):
                registry_token("ghcr.io", "owner/name", "pull", None)

    def test_the_imported_fingerprint_is_read_from_the_incus_result(self) -> None:
        self.assertEqual(imported_fingerprint(f"Image imported with fingerprint: {'c' * 64}"), "c" * 64)
        with self.assertRaises(RegistryError):
            imported_fingerprint("Image imported with fingerprint: none")


class RegistryTransferTest(unittest.TestCase):
    def test_a_pull_verifies_the_digest_before_importing_the_image(self) -> None:
        payload = b"incus image tarball"
        digest = f"sha256:{hashlib.sha256(payload).hexdigest()}"

        def download(_registry: str, _repository: str, _token: str, _digest: str, target: Path) -> None:
            target.write_bytes(payload)

        with patch("tools.incus_sandbox.registry_image.registry_token", return_value="scoped"), \
             patch("tools.incus_sandbox.registry_image._request",
                   return_value=(json.dumps(manifest(digest, len(payload))).encode("utf-8"), {})), \
             patch("tools.incus_sandbox.registry_image._download_blob", side_effect=download), \
             patch("tools.incus_sandbox.registry_image.subprocess.run",
                   return_value=SimpleNamespace(returncode=0, stderr="",
                                                stdout=f"fingerprint: {'c' * 64}")) as run:
            result = registry_image.pull(config(), "ghcr.io/autarchy-ai/gc-sandbox-template:latest")
        self.assertEqual(result["image"], f"local:{'c' * 64}")
        self.assertEqual(run.call_args.args[0][:3], ["/usr/bin/incus", "image", "import"])

    def test_a_pull_refuses_an_artifact_that_does_not_match_its_digest(self) -> None:
        def download(_registry: str, _repository: str, _token: str, _digest: str, target: Path) -> None:
            target.write_bytes(b"substituted image")

        with patch("tools.incus_sandbox.registry_image.registry_token", return_value="scoped"), \
             patch("tools.incus_sandbox.registry_image._request",
                   return_value=(json.dumps(manifest()).encode("utf-8"), {})), \
             patch("tools.incus_sandbox.registry_image._download_blob", side_effect=download), \
             patch("tools.incus_sandbox.registry_image.subprocess.run") as run:
            with self.assertRaises(RegistryError):
                registry_image.pull(config(), "ghcr.io/autarchy-ai/gc-sandbox-template:latest")
        run.assert_not_called()

    def test_a_push_uploads_the_exported_image_and_its_manifest(self) -> None:
        requests: list[tuple[str, str]] = []

        with tempfile.TemporaryDirectory() as directory:
            def export(argv: list[str], **_: object) -> SimpleNamespace:
                metadata = b"architecture: x86_64_v2\nproperties:\n  os: almalinux\n"
                with tarfile.open(f"{argv[4]}.tar.gz", "w:gz") as archive:
                    entry = tarfile.TarInfo("metadata.yaml")
                    entry.size = len(metadata)
                    archive.addfile(entry, io.BytesIO(metadata))
                    rootfs = tarfile.TarInfo("rootfs.img")
                    rootfs.size = len(b"disk")
                    archive.addfile(rootfs, io.BytesIO(b"disk"))
                return SimpleNamespace(returncode=0)

            def request(url: str, **kwargs: object) -> tuple[bytes, dict[str, str]]:
                requests.append((str(kwargs.get("method", "GET")), url))
                if kwargs.get("method") == "HEAD":
                    raise registry_image.urllib.error.HTTPError(url, 404, "absent", {}, None)
                return b"{}", {"Location": f"https://ghcr.io/v2/owner/name/blobs/uploads/{len(requests)}"}

            with patch("tools.incus_sandbox.registry_image.registry_token", return_value="scoped"), \
                 patch("tools.incus_sandbox.registry_image.tempfile.TemporaryDirectory",
                       return_value=nullcontext(directory)), \
                 patch("tools.incus_sandbox.registry_image.subprocess.run", side_effect=export), \
                 patch("tools.incus_sandbox.registry_image._request", side_effect=request):
                result = registry_image.push(config(), "ghcr.io/autarchy-ai/gc-sandbox-template:latest",
                                             "d" * 64, "secret-canary")
        self.assertEqual(result["fingerprint"], "d" * 64)
        self.assertEqual(requests[-1][0], "PUT")
        self.assertTrue(requests[-1][1].endswith("/manifests/latest"))
        self.assertNotIn("secret-canary", json.dumps(requests))

    def test_a_push_refuses_a_fingerprint_outside_the_closed_grammar(self) -> None:
        with patch("tools.incus_sandbox.registry_image.registry_token", return_value="scoped"):
            with self.assertRaises(RegistryError):
                registry_image.push(config(), "ghcr.io/autarchy-ai/gc-sandbox-template:latest",
                                    "not-a-fingerprint", "secret-canary")


class ArtifactNormalizationTest(unittest.TestCase):
    def _image(self, directory: Path, architecture: str) -> Path:
        source = directory / "exported.tar.gz"
        metadata = f"architecture: {architecture}\nproperties:\n  architecture: {architecture}\n"
        with tarfile.open(source, "w:gz") as archive:
            for name, payload in (("metadata.yaml", metadata.encode("utf-8")), ("rootfs.img", b"disk")):
                entry = tarfile.TarInfo(name)
                entry.size = len(payload)
                archive.addfile(entry, io.BytesIO(payload))
        return source

    def test_an_architecture_incus_cannot_import_is_rewritten_to_the_family(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "normalized.tar.gz"
            registry_image.normalize_image(self._image(root, "x86_64_v2"), target)
            with tarfile.open(target, "r:gz") as archive:
                document = archive.extractfile("metadata.yaml").read().decode("utf-8")
                self.assertEqual(sorted(archive.getnames()), ["metadata.yaml", "rootfs.img"])
            self.assertIn("architecture: x86_64\n", document)
            self.assertNotIn("x86_64_v2", document)

    def test_the_published_artifact_is_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self._image(root, "x86_64_v2")
            digests = []
            for name in ("first.tar.gz", "second.tar.gz"):
                registry_image.normalize_image(source, root / name)
                digests.append(hashlib.sha256((root / name).read_bytes()).hexdigest())
        # A republished template keeps the digest hosts already pinned.
        self.assertEqual(digests[0], digests[1])

    def test_an_import_refusal_keeps_the_reason_incus_gave(self) -> None:
        payload = b"incus image tarball"
        digest = f"sha256:{hashlib.sha256(payload).hexdigest()}"

        def download(_registry: str, _repository: str, _token: str, _digest: str, target: Path) -> None:
            target.write_bytes(payload)

        with patch("tools.incus_sandbox.registry_image.registry_token", return_value="scoped"), \
             patch("tools.incus_sandbox.registry_image._request",
                   return_value=(json.dumps(manifest(digest, len(payload))).encode("utf-8"), {})), \
             patch("tools.incus_sandbox.registry_image._download_blob", side_effect=download), \
             patch("tools.incus_sandbox.registry_image.subprocess.run",
                   return_value=SimpleNamespace(returncode=1, stdout="",
                                                stderr="Error: Architecture isn't supported: x86_64_v2")):
            with self.assertRaises(RegistryError) as result:
                registry_image.pull(config(), "ghcr.io/autarchy-ai/gc-sandbox-template:latest")
        self.assertIn("Architecture isn't supported", str(result.exception))


class RegistryEntryPointTest(unittest.TestCase):
    def test_the_entry_point_needs_root_and_a_closed_verb(self) -> None:
        with patch("tools.incus_sandbox.registry_image.os.geteuid", return_value=1000):
            with self.assertRaises(RegistryError):
                registry_image.main(["pull"])
        with patch("tools.incus_sandbox.registry_image.os.geteuid", return_value=0), \
             patch("tools.incus_sandbox.registry_image.load_config", return_value=config()):
            with self.assertRaises(RegistryError):
                registry_image.main(["fetch"])

    def test_a_pull_reports_the_value_to_pin_and_a_push_reads_its_credential_from_stdin(self) -> None:
        pulled = {"schema": "gc.incus-sandbox.template/v1", "reference": "ghcr.io/owner/name:latest",
                  "layer": "sha256:" + "a" * 64, "fingerprint": "c" * 64, "image": f"local:{'c' * 64}"}
        with patch("tools.incus_sandbox.registry_image.os.geteuid", return_value=0), \
             patch("tools.incus_sandbox.registry_image.load_config", return_value=config()), \
             patch("tools.incus_sandbox.registry_image.pull", return_value=pulled), \
             patch("sys.stdout", new_callable=io.StringIO) as reported:
            self.assertEqual(registry_image.main(["pull"]), 0)
        self.assertIn(f"local:{'c' * 64}", reported.getvalue())
        with patch("tools.incus_sandbox.registry_image.os.geteuid", return_value=0), \
             patch("tools.incus_sandbox.registry_image.load_config", return_value=config()), \
             patch("sys.stdin", io.StringIO("")):
            with self.assertRaises(RegistryError):
                registry_image.main(["push", "ghcr.io/owner/name:latest", "d" * 64])

    def test_cli_reports_invalid_arguments(self) -> None:
        with patch.object(sys, "argv", ["registry-image.py"]):
            with self.assertRaises(SystemExit) as result:
                runpy.run_module("tools.incus_sandbox.registry_image", run_name="__main__")
        self.assertEqual(result.exception.code, 64)


if __name__ == "__main__":
    unittest.main()
