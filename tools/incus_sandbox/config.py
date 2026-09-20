"""Strict root-owned configuration for the local Incus sandbox."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


class ConfigError(RuntimeError):
    """Configuration is unsafe or does not describe the supported sandbox."""


@dataclass(frozen=True)
class VmLimits(object):
    """The fixed resource allocation for one sandbox VM."""

    cpu: int
    memory_mib: int
    disk_gib: int


@dataclass(frozen=True)
class HostLimits(object):
    """Host reserves and aggregate capacity permitted for sandbox VMs."""

    reserve_memory_mib: int
    reserve_disk_gib: int
    max_cpu: int
    max_memory_mib: int
    max_disk_gib: int
    overhead_disk_gib: int


@dataclass(frozen=True)
class SandboxConfig(object):
    """Validated host policy used by the root-side lifecycle helper."""

    project: str
    profile: str
    pool: str
    bridge: str
    image: str
    state_dir: Path
    event_log: Path
    event_max_bytes: int
    observation_max_age_seconds: int
    operator_uid: int
    vm: VmLimits
    host: HostLimits


_TOP_LEVEL = {
    "schema", "project", "profile", "pool", "bridge", "image", "state_dir",
    "event_log", "event_max_bytes", "observation_max_age_seconds", "operator_uid",
    "vm", "host",
}
_VM_FIELDS = ("cpu", "memory_mib", "disk_gib")
_HOST_FIELDS = (
    "reserve_memory_mib", "reserve_disk_gib", "max_cpu", "max_memory_mib",
    "max_disk_gib", "overhead_disk_gib",
)
_MIN_EVENT_BYTES = 512


def _positive(value: object, field: str) -> int:
    """Return a positive integer configuration value."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ConfigError(f"{field} must be a positive integer")
    return value


def _name(doc: dict[str, object], field: str) -> str:
    """Read one bounded lower-case Incus resource name."""
    value = doc.get(field)
    if not isinstance(value, str) or not value or len(value) > 63:
        raise ConfigError(f"{field} must be a non-empty bounded string")
    if any(char not in "abcdefghijklmnopqrstuvwxyz0123456789-" for char in value):
        raise ConfigError(f"{field} has an unsupported character")
    return value


def _owned_regular(path: Path, expected_uid: int) -> None:
    """Require a root-owned non-symlink configuration file."""
    try:
        stat_result = path.lstat()
    except OSError as exc:
        raise ConfigError(f"cannot inspect configuration: {exc}") from exc
    if not path.is_file() or path.is_symlink():
        raise ConfigError("configuration must be a regular non-symlink file")
    if stat_result.st_uid != expected_uid:
        raise ConfigError("configuration has the wrong owner")
    if stat_result.st_mode & 0o022:
        raise ConfigError("configuration must not be writable by group or other")


def _path(doc: dict[str, object], field: str) -> Path:
    """Read an absolute host-controlled filesystem path."""
    value = doc.get(field)
    if not isinstance(value, str) or not value.startswith("/"):
        raise ConfigError(f"{field} must be an absolute path")
    return Path(value)


def _read_document(path: Path) -> dict[str, object]:
    """Decode the previously ownership-checked JSON policy document."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ConfigError(f"configuration is not valid JSON: {exc}") from exc
    if not isinstance(document, dict) or not all(isinstance(key, str) for key in document):
        raise ConfigError("configuration must be a JSON object")
    return document


def _check_top_level(doc: dict[str, object]) -> None:
    """Verify the closed versioned configuration vocabulary."""
    if set(doc) != _TOP_LEVEL:
        raise ConfigError("configuration keys do not match gc.incus-sandbox/v1")
    if doc["schema"] != "gc.incus-sandbox/v1":
        raise ConfigError("unsupported configuration schema")


def _image(doc: dict[str, object]) -> str:
    """Return a non-placeholder pinned image digest."""
    image = doc["image"]
    if not isinstance(image, str) or len(image) != 71 or not image.startswith("sha256:"):
        raise ConfigError("image must be a pinned sha256 digest")
    digest = image[7:]
    if any(char not in "0123456789abcdef" for char in digest) or digest == "0" * 64:
        raise ConfigError("image digest is malformed or a template placeholder")
    return image


def _limits(doc: dict[str, object], fields: tuple[str, ...], label: str) -> tuple[int, ...]:
    """Validate a closed resource-limit subsection and return its values."""
    section = doc.get(label)
    if not isinstance(section, dict) or set(section) != set(fields):
        raise ConfigError(f"{label} limits have unexpected fields")
    return tuple(_positive(section[field], f"{label}.{field}") for field in fields)


def _build_config(doc: dict[str, object]) -> SandboxConfig:
    """Build the typed policy object after individual fields are validated."""
    vm = VmLimits(*_limits(doc, _VM_FIELDS, "vm"))
    host = HostLimits(*_limits(doc, _HOST_FIELDS, "host"))
    if vm.cpu > host.max_cpu or vm.memory_mib > host.max_memory_mib or vm.disk_gib > host.max_disk_gib:
        raise ConfigError("one VM exceeds configured aggregate capacity")
    event_max_bytes = _positive(doc["event_max_bytes"], "event_max_bytes")
    if event_max_bytes < _MIN_EVENT_BYTES:
        raise ConfigError(f"event_max_bytes must be at least {_MIN_EVENT_BYTES}")
    return SandboxConfig(
        project=_name(doc, "project"), profile=_name(doc, "profile"),
        pool=_name(doc, "pool"), bridge=_name(doc, "bridge"), image=_image(doc),
        state_dir=_path(doc, "state_dir"), event_log=_path(doc, "event_log"),
        event_max_bytes=event_max_bytes,
        observation_max_age_seconds=_positive(
            doc["observation_max_age_seconds"], "observation_max_age_seconds"
        ),
        operator_uid=_positive(doc["operator_uid"], "operator_uid"), vm=vm, host=host,
    )


def load_config(path: Path, *, expected_uid: int = 0) -> SandboxConfig:
    """Load the fixed host policy; caller input is never configuration."""
    _owned_regular(path, expected_uid)
    document = _read_document(path)
    _check_top_level(document)
    return _build_config(document)
