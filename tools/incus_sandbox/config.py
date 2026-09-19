"""Strict root-owned configuration for the local Incus sandbox."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ConfigError(RuntimeError):
    """Configuration is unsafe or does not describe the supported sandbox."""


@dataclass(frozen=True)
class VmLimits:
    cpu: int
    memory_mib: int
    disk_gib: int


@dataclass(frozen=True)
class HostLimits:
    reserve_memory_mib: int
    reserve_disk_gib: int
    max_cpu: int
    max_memory_mib: int
    max_disk_gib: int
    overhead_disk_gib: int


@dataclass(frozen=True)
class SandboxConfig:
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
    "schema", "project", "profile", "pool", "bridge", "image", "state_dir", "event_log",
    "event_max_bytes", "observation_max_age_seconds", "operator_uid", "vm", "host",
}
_VM = {"cpu", "memory_mib", "disk_gib"}
_HOST = {"reserve_memory_mib", "reserve_disk_gib", "max_cpu", "max_memory_mib",
         "max_disk_gib", "overhead_disk_gib"}
_MIN_EVENT_BYTES = 512


def _positive(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ConfigError(f"{field} must be a positive integer")
    return value


def _name(doc: dict[str, Any], field: str) -> str:
    value = doc.get(field)
    if not isinstance(value, str) or not value or len(value) > 63:
        raise ConfigError(f"{field} must be a non-empty bounded string")
    if any(char not in "abcdefghijklmnopqrstuvwxyz0123456789-" for char in value):
        raise ConfigError(f"{field} has an unsupported character")
    return value


def _owned_regular(path: Path, expected_uid: int) -> None:
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


def _path(doc: dict[str, Any], field: str) -> Path:
    value = doc.get(field)
    if not isinstance(value, str) or not value.startswith("/"):
        raise ConfigError(f"{field} must be an absolute path")
    return Path(value)


def load_config(path: Path, *, expected_uid: int = 0) -> SandboxConfig:
    """Load the fixed host policy; caller input is never configuration."""
    _owned_regular(path, expected_uid)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ConfigError(f"configuration is not valid JSON: {exc}") from exc
    if not isinstance(doc, dict) or set(doc) != _TOP_LEVEL:
        raise ConfigError("configuration keys do not match gc.incus-sandbox/v1")
    if doc["schema"] != "gc.incus-sandbox/v1":
        raise ConfigError("unsupported configuration schema")
    image = doc["image"]
    if not isinstance(image, str) or len(image) != 71 or not image.startswith("sha256:"):
        raise ConfigError("image must be a pinned sha256 digest")
    if any(char not in "0123456789abcdef" for char in image[7:]):
        raise ConfigError("image digest is malformed")
    if image[7:] == "0" * 64:
        raise ConfigError("image digest is a template placeholder, not a pinned image")
    vm_doc, host_doc = doc["vm"], doc["host"]
    if not isinstance(vm_doc, dict) or set(vm_doc) != _VM:
        raise ConfigError("vm limits have unexpected fields")
    if not isinstance(host_doc, dict) or set(host_doc) != _HOST:
        raise ConfigError("host limits have unexpected fields")
    vm = VmLimits(*(_positive(vm_doc[field], f"vm.{field}") for field in
                    ("cpu", "memory_mib", "disk_gib")))
    host = HostLimits(*(_positive(host_doc[field], f"host.{field}") for field in
                         ("reserve_memory_mib", "reserve_disk_gib", "max_cpu", "max_memory_mib",
                          "max_disk_gib", "overhead_disk_gib")))
    if vm.cpu > host.max_cpu or vm.memory_mib > host.max_memory_mib or vm.disk_gib > host.max_disk_gib:
        raise ConfigError("one VM exceeds configured aggregate capacity")
    event_max_bytes = _positive(doc["event_max_bytes"], "event_max_bytes")
    if event_max_bytes < _MIN_EVENT_BYTES:
        raise ConfigError(f"event_max_bytes must be at least {_MIN_EVENT_BYTES}")
    return SandboxConfig(
        project=_name(doc, "project"), profile=_name(doc, "profile"), pool=_name(doc, "pool"),
        bridge=_name(doc, "bridge"), image=image, state_dir=_path(doc, "state_dir"),
        event_log=_path(doc, "event_log"), event_max_bytes=event_max_bytes,
        observation_max_age_seconds=_positive(doc["observation_max_age_seconds"], "observation_max_age_seconds"),
        operator_uid=_positive(doc["operator_uid"], "operator_uid"),
        vm=vm, host=host,
    )
