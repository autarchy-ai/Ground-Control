#!/usr/bin/python3
"""Publish and fetch the sandbox guest template through an OCI registry."""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath

if __package__:
    from .config import SandboxConfig, load_config
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from config import SandboxConfig, load_config


class RegistryError(RuntimeError):
    """The caller requested a registry transfer outside the closed boundary."""


_INCUS = "/usr/bin/incus"
_CONFIG_PATH = Path("/etc/gc-incus-sandbox/config.json")
_DEFAULT_REFERENCE = "ghcr.io/autarchy-ai/gc-sandbox-template:latest"
_REFERENCE = re.compile(r"^(ghcr\.io)/([a-z0-9][a-z0-9._/-]{0,127}):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$")
_FINGERPRINT = re.compile(r"^[0-9a-f]{64}$")
_ALIAS = "gc-sandbox-template"
_LAYER_TYPE = "application/vnd.incus.image.layer.v1.tar+gzip"
_CONFIG_TYPE = "application/vnd.incus.image.config.v1+json"
_MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json"
_ARTIFACT_TYPE = "application/vnd.incus.image.v1"
_CHUNK_BYTES = 8 * 1024 * 1024
_MAX_IMAGE_BYTES = 8 * 1024 * 1024 * 1024
_TIMEOUT_SECONDS = 900
_SOURCE_REPOSITORY = "https://github.com/autarchy-ai/Ground-Control"
# Incus publishes these microarchitecture names but refuses to import them, so a
# distributed artifact records the architecture family its own import accepts.
_ARCHITECTURES = {"x86_64_v2": "x86_64", "x86_64_v3": "x86_64", "x86_64_v4": "x86_64"}
_METADATA_ENTRY = "metadata.yaml"


def parse_reference(reference: str) -> tuple[str, str, str]:
    """Split a closed registry reference into registry, repository, and tag."""
    match = _REFERENCE.fullmatch(reference)
    if match is None:
        raise RegistryError("reference must be ghcr.io/<repository>:<tag>")
    return match.group(1), match.group(2), match.group(3)


def _request(url: str, *, token: str | None = None, method: str = "GET", data: object = None,
             headers: dict[str, str] | None = None) -> tuple[bytes, dict[str, str]]:
    """Perform one bounded registry request and return its body and headers."""
    request = urllib.request.Request(url, method=method, data=data)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
        return response.read(), dict(response.headers)


def registry_token(registry: str, repository: str, actions: str, credential: str | None) -> str:
    """Exchange an optional credential for a scoped registry token."""
    url = f"https://{registry}/token?service={registry}&scope=repository:{repository}:{actions}"
    headers = {}
    if credential:
        basic = base64.b64encode(f"x-access-token:{credential}".encode("utf-8")).decode("ascii")
        headers["Authorization"] = f"Basic {basic}"
    body, _ = _request(url, headers=headers)
    token = json.loads(body).get("token")
    if not isinstance(token, str) or not token:
        raise RegistryError("registry did not issue a token")
    return token


def manifest_document(layer_digest: str, layer_size: int, config_digest: str, config_size: int,
                      annotations: dict[str, str]) -> dict[str, object]:
    """Build the OCI manifest that carries one Incus image tarball."""
    return {
        "schemaVersion": 2,
        "mediaType": _MANIFEST_TYPE,
        "artifactType": _ARTIFACT_TYPE,
        "config": {"mediaType": _CONFIG_TYPE, "digest": config_digest, "size": config_size},
        "layers": [{"mediaType": _LAYER_TYPE, "digest": layer_digest, "size": layer_size,
                    "annotations": {"org.opencontainers.image.title": "incus-image.tar.gz"}}],
        "annotations": annotations,
    }


def layer_descriptor(manifest: dict[str, object]) -> tuple[str, int]:
    """Return the one image layer this artifact carries, refusing anything else."""
    layers = manifest.get("layers")
    if not isinstance(layers, list) or len(layers) != 1:
        raise RegistryError("artifact must carry exactly one image layer")
    layer = layers[0]
    if not isinstance(layer, dict) or layer.get("mediaType") != _LAYER_TYPE:
        raise RegistryError("artifact layer is not an Incus image")
    size = layer.get("size")
    digest = layer.get("digest")
    if not isinstance(digest, str) or not digest.startswith("sha256:") or not isinstance(size, int):
        raise RegistryError("artifact layer descriptor is invalid")
    if size <= 0 or size > _MAX_IMAGE_BYTES:
        raise RegistryError("artifact layer exceeds the transfer limit")
    return digest, size


def _digest(path: Path) -> tuple[str, int]:
    """Return the sha256 digest and size of a local file."""
    total = 0
    checksum = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK_BYTES), b""):
            checksum.update(chunk)
            total += len(chunk)
    return f"sha256:{checksum.hexdigest()}", total


def _upload_blob(registry: str, repository: str, token: str, path: Path, digest: str, size: int) -> None:
    """Upload one blob unless the registry already holds it."""
    try:
        _request(f"https://{registry}/v2/{repository}/blobs/{digest}", token=token, method="HEAD")
        return
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    _, headers = _request(f"https://{registry}/v2/{repository}/blobs/uploads/", token=token, method="POST",
                          headers={"Content-Length": "0"})
    location = headers.get("Location")
    if not location:
        raise RegistryError("registry did not open a blob upload")
    if location.startswith("/"):
        location = f"https://{registry}{location}"
    separator = "&" if "?" in location else "?"
    with path.open("rb") as handle:
        _request(f"{location}{separator}digest={digest}", token=token, method="PUT", data=handle,
                 headers={"Content-Type": "application/octet-stream", "Content-Length": str(size)})


def _download_blob(registry: str, repository: str, token: str, digest: str, target: Path) -> None:
    """Stream one blob to disk rather than holding a guest image in memory."""
    request = urllib.request.Request(f"https://{registry}/v2/{repository}/blobs/{digest}")
    request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response, target.open("wb") as handle:
        for chunk in iter(lambda: response.read(_CHUNK_BYTES), b""):
            handle.write(chunk)


def normalized_metadata(document: str) -> str:
    """Rewrite an image architecture Incus publishes but will not import."""
    for published, accepted in _ARCHITECTURES.items():
        document = document.replace(f"architecture: {published}", f"architecture: {accepted}")
    return document


def safe_entry(member: tarfile.TarInfo) -> None:
    """Refuse an archive entry that could escape its directory or is not image content."""
    name = PurePosixPath(member.name)
    if name.is_absolute() or ".." in name.parts or member.name.startswith("/"):
        raise RegistryError("image archive entry escapes the image directory")
    if not (member.isfile() or member.isdir()):
        raise RegistryError("image archive entry is not a file or directory")


def normalize_image(source: Path, target: Path) -> None:
    """Copy an exported image, rewriting only its metadata architecture.

    The copy is reproducible: the same template always produces the same artifact
    bytes, so a republished template keeps the digest hosts already pinned.
    """
    compressed = gzip.GzipFile(filename="", mode="wb", fileobj=target.open("wb"), mtime=0)
    with tarfile.open(source, "r:gz") as original, tarfile.open(fileobj=compressed, mode="w|") as rewritten:
        for member in original:
            safe_entry(member)
            if member.name != _METADATA_ENTRY:
                rewritten.addfile(member, original.extractfile(member) if member.isfile() else None)
                continue
            handle = original.extractfile(member)
            document = normalized_metadata(handle.read().decode("utf-8")).encode("utf-8")
            member.size = len(document)
            rewritten.addfile(member, io.BytesIO(document))
    compressed.close()


def push(config: SandboxConfig, reference: str, fingerprint: str, credential: str) -> dict[str, str]:
    """Export the published template and store it in the registry as one artifact."""
    registry, repository, tag = parse_reference(reference)
    if not _FINGERPRINT.fullmatch(fingerprint):
        raise RegistryError("template fingerprint is invalid")
    token = registry_token(registry, repository, "pull,push", credential)
    with tempfile.TemporaryDirectory(prefix="gc-incus-registry-") as directory:
        export = Path(directory) / "image"
        subprocess.run([_INCUS, "image", "export", fingerprint, str(export), "--project", config.project],
                       check=True, timeout=_TIMEOUT_SECONDS)
        exported = Path(f"{export}.tar.gz")
        if not exported.exists():
            raise RegistryError("Incus did not export a unified image tarball")
        tarball = Path(directory) / "normalized.tar.gz"
        normalize_image(exported, tarball)
        exported.unlink()
        layer_digest, layer_size = _digest(tarball)
        settings = json.dumps({"fingerprint": fingerprint, "alias": _ALIAS}).encode("utf-8")
        config_path = Path(directory) / "config.json"
        config_path.write_bytes(settings)
        config_digest, config_size = _digest(config_path)
        _upload_blob(registry, repository, token, tarball, layer_digest, layer_size)
        _upload_blob(registry, repository, token, config_path, config_digest, config_size)
        # The source annotation links the package to the repository that builds it,
        # which is what gives the package its repository-inherited visibility.
        manifest = manifest_document(layer_digest, layer_size, config_digest, config_size,
                                     {"org.opencontainers.image.source": _SOURCE_REPOSITORY,
                                      "incus.image.fingerprint": fingerprint})
        body = json.dumps(manifest).encode("utf-8")
        _request(f"https://{registry}/v2/{repository}/manifests/{tag}", token=token, method="PUT",
                 data=body, headers={"Content-Type": _MANIFEST_TYPE, "Content-Length": str(len(body))})
    return {"schema": "gc.incus-sandbox.template/v1", "reference": reference,
            "fingerprint": fingerprint, "layer": layer_digest}


def imported_fingerprint(output: str) -> str:
    """Return the fingerprint Incus reports for an imported image."""
    match = re.search(r"\b([0-9a-f]{64})\b", output)
    if match is None:
        raise RegistryError("Incus did not report an imported image fingerprint")
    return match.group(1)


def pull(config: SandboxConfig, reference: str, credential: str | None = None) -> dict[str, str]:
    """Fetch the published template from the registry and import it for this project."""
    registry, repository, tag = parse_reference(reference)
    token = registry_token(registry, repository, "pull", credential)
    manifest_body, _ = _request(f"https://{registry}/v2/{repository}/manifests/{tag}", token=token,
                                headers={"Accept": _MANIFEST_TYPE})
    digest, size = layer_descriptor(json.loads(manifest_body))
    with tempfile.TemporaryDirectory(prefix="gc-incus-registry-") as directory:
        tarball = Path(directory) / "image.tar.gz"
        _download_blob(registry, repository, token, digest, tarball)
        # The registry is a transport, not an authority: the artifact must hash to its digest.
        if _digest(tarball) != (digest, size):
            raise RegistryError("downloaded image does not match its digest")
        imported = subprocess.run([_INCUS, "image", "import", str(tarball), "--project", config.project,
                                   "--alias", _ALIAS], check=False, capture_output=True, text=True,
                                  timeout=_TIMEOUT_SECONDS)
    if imported.returncode != 0:
        # Incus' own reason is the only actionable detail; keep it, bounded.
        raise RegistryError(f"Incus refused the image: {imported.stderr.strip()[:200]}")
    fingerprint = imported_fingerprint(imported.stdout)
    return {"schema": "gc.incus-sandbox.template/v1", "reference": reference, "layer": digest,
            "fingerprint": fingerprint, "image": f"local:{fingerprint}"}


def main(argv: list[str]) -> int:
    """Fetch or publish the template as root, then report the value to pin."""
    if os.geteuid() != 0:
        raise RegistryError("registry transfers need root; run this through sudo")
    if not argv or argv[0] not in {"pull", "push"}:
        raise RegistryError("usage: registry-image.py {pull [REFERENCE]|push REFERENCE FINGERPRINT}")
    config = load_config(_CONFIG_PATH)
    if argv[0] == "pull":
        if len(argv) > 2:
            raise RegistryError("usage: registry-image.py pull [REFERENCE]")
        result = pull(config, argv[1] if len(argv) == 2 else _DEFAULT_REFERENCE)
        print(json.dumps(result, indent=2))
        print(f"\nPin this template in {_CONFIG_PATH}:\n  \"image\": \"{result['image']}\"", file=sys.stderr)
        return 0
    if len(argv) != 3:
        raise RegistryError("usage: registry-image.py push REFERENCE FINGERPRINT")
    # The credential arrives on standard input, never in argv, the environment, or a file.
    credential = sys.stdin.read().strip()
    if not credential:
        raise RegistryError("push needs a registry credential on standard input")
    print(json.dumps(push(config, argv[1], argv[2], credential), indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except RegistryError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
