"""Strict root-owned configuration for the local Incus sandbox."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
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
class MigrationLimits(object):
    """Root-owned bounds for dirty-work packets accepted by the transfer helper."""

    max_packet_bytes: int
    max_file_count: int
    max_file_bytes: int
    max_handoff_bytes: int


@dataclass(frozen=True)
class ProviderLocator(object):
    """One root-owned file-provider locator and its closed availability state."""

    path: Path
    state: str


@dataclass(frozen=True)
class TaskEnvironmentPolicy(object):
    """Repository-scoped secret aliases controlled only by the host operator."""

    max_value_bytes: int
    repositories: dict[str, dict[str, ProviderLocator]]


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
    migration: MigrationLimits | None
    task_environment: TaskEnvironmentPolicy


_TOP_LEVEL = {
    "schema", "project", "profile", "pool", "bridge", "image", "state_dir",
    "event_log", "event_max_bytes", "observation_max_age_seconds", "operator_uid",
    "vm", "host",
}
_TOP_LEVEL_V2 = _TOP_LEVEL | {"migration"}
_TOP_LEVEL_V3 = _TOP_LEVEL_V2 | {"task_environment"}
_VM_FIELDS = ("cpu", "memory_mib", "disk_gib")
_HOST_FIELDS = (
    "reserve_memory_mib", "reserve_disk_gib", "max_cpu", "max_memory_mib",
    "max_disk_gib", "overhead_disk_gib",
)
_MIGRATION_FIELDS = ("max_packet_bytes", "max_file_count", "max_file_bytes", "max_handoff_bytes")
_MIN_EVENT_BYTES = 512
_SCHEMA_V1 = "gc.incus-sandbox/v1"
_SCHEMA_V2 = "gc.incus-sandbox/v2"
_SCHEMA_V3 = "gc.incus-sandbox/v3"
_DEFAULT_MIGRATION = {
    "max_packet_bytes": 1024 * 1024 * 1024,
    "max_file_count": 2048,
    "max_file_bytes": 64 * 1024 * 1024,
    "max_handoff_bytes": 64 * 1024,
}
_DEFAULT_TASK_ENVIRONMENT = {"max_value_bytes": 16 * 1024, "repositories": {}}
_REPOSITORY = re.compile(r"^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$")
_ALIAS = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


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
    schema = doc.get("schema")
    expected = {
        _SCHEMA_V1: _TOP_LEVEL, _SCHEMA_V2: _TOP_LEVEL_V2, _SCHEMA_V3: _TOP_LEVEL_V3,
    }.get(schema)
    if expected is None or set(doc) != expected:
        raise ConfigError("configuration keys do not match the declared gc.incus-sandbox schema")


def _image(doc: dict[str, object]) -> str:
    """Return a non-placeholder pinned image reference Incus can launch."""
    image = doc["image"]
    # Only remotes Incus resolves: an images: fingerprint, or a locally published
    # template. A sha256: prefix reads as an unknown remote name and never launches.
    prefixes = {"images:": 71, "local:": 70}
    if not isinstance(image, str) or prefixes.get(image[:image.find(":") + 1]) != len(image):
        raise ConfigError("image must be a pinned images: or local: fingerprint")
    digest = image.split(":", 1)[1]
    if any(char not in "0123456789abcdef" for char in digest) or digest == "0" * 64:
        raise ConfigError("image fingerprint is malformed or a template placeholder")
    return image


def _limits(doc: dict[str, object], fields: tuple[str, ...], label: str) -> tuple[int, ...]:
    """Validate a closed resource-limit subsection and return its values."""
    section = doc.get(label)
    if not isinstance(section, dict) or set(section) != set(fields):
        raise ConfigError(f"{label} limits have unexpected fields")
    return tuple(_positive(section[field], f"{label}.{field}") for field in fields)


def _migration_limits(doc: dict[str, object]) -> MigrationLimits | None:
    """Validate v2/v3 migration bounds against the installed guest validator."""
    if doc["schema"] == _SCHEMA_V1:
        return None
    migration = MigrationLimits(*_limits(doc, _MIGRATION_FIELDS, "migration"))
    limits = (
        migration.max_packet_bytes <= _DEFAULT_MIGRATION["max_packet_bytes"],
        migration.max_file_count <= _DEFAULT_MIGRATION["max_file_count"],
        migration.max_file_bytes <= _DEFAULT_MIGRATION["max_file_bytes"],
        migration.max_handoff_bytes <= _DEFAULT_MIGRATION["max_handoff_bytes"],
        migration.max_file_bytes <= migration.max_packet_bytes,
        migration.max_handoff_bytes <= migration.max_packet_bytes,
    )
    if not all(limits):
        raise ConfigError("migration limits exceed the installed guest validator")
    return migration


def _task_environment_policy(doc: dict[str, object]) -> TaskEnvironmentPolicy:
    """Validate the closed v3 repository-to-provider authority map."""
    if doc["schema"] != _SCHEMA_V3:
        return TaskEnvironmentPolicy(max_value_bytes=16 * 1024, repositories={})
    section = doc.get("task_environment")
    if not isinstance(section, dict) or set(section) != {"max_value_bytes", "repositories"}:
        raise ConfigError("task_environment policy fields are invalid")
    max_value_bytes = _positive(section["max_value_bytes"], "task_environment.max_value_bytes")
    if max_value_bytes > 16 * 1024:
        raise ConfigError("task_environment.max_value_bytes exceeds the guest validator")
    raw_repositories = section["repositories"]
    if not isinstance(raw_repositories, dict) or len(raw_repositories) > 256:
        raise ConfigError("task_environment repositories are invalid")
    repositories: dict[str, dict[str, ProviderLocator]] = {}
    for repository, raw_aliases in raw_repositories.items():
        if not isinstance(repository, str) or not _REPOSITORY.fullmatch(repository):
            raise ConfigError("task_environment repository identity is invalid")
        if not isinstance(raw_aliases, dict) or len(raw_aliases) > 128:
            raise ConfigError("task_environment aliases are invalid")
        aliases: dict[str, ProviderLocator] = {}
        for alias, raw_locator in raw_aliases.items():
            if not isinstance(alias, str) or not _ALIAS.fullmatch(alias):
                raise ConfigError("task_environment alias is invalid")
            if not isinstance(raw_locator, dict) or set(raw_locator) != {"path", "state"}:
                raise ConfigError("task_environment provider locator is invalid")
            path, state = raw_locator["path"], raw_locator["state"]
            if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
                raise ConfigError("task_environment provider path is invalid")
            if state not in {"available", "expired", "revoked"}:
                raise ConfigError("task_environment provider state is invalid")
            aliases[alias] = ProviderLocator(Path(path), state)
        repositories[repository] = aliases
    return TaskEnvironmentPolicy(max_value_bytes=max_value_bytes, repositories=repositories)


def _build_config(doc: dict[str, object]) -> SandboxConfig:
    """Build the typed policy object after individual fields are validated."""
    vm = VmLimits(*_limits(doc, _VM_FIELDS, "vm"))
    host = HostLimits(*_limits(doc, _HOST_FIELDS, "host"))
    if vm.cpu > host.max_cpu or vm.memory_mib > host.max_memory_mib or vm.disk_gib > host.max_disk_gib:
        raise ConfigError("one VM exceeds configured aggregate capacity")
    event_max_bytes = _positive(doc["event_max_bytes"], "event_max_bytes")
    if event_max_bytes < _MIN_EVENT_BYTES:
        raise ConfigError(f"event_max_bytes must be at least {_MIN_EVENT_BYTES}")
    migration = _migration_limits(doc)
    return SandboxConfig(
        project=_name(doc, "project"), profile=_name(doc, "profile"),
        pool=_name(doc, "pool"), bridge=_name(doc, "bridge"), image=_image(doc),
        state_dir=_path(doc, "state_dir"), event_log=_path(doc, "event_log"),
        event_max_bytes=event_max_bytes,
        observation_max_age_seconds=_positive(
            doc["observation_max_age_seconds"], "observation_max_age_seconds"
        ),
        operator_uid=_positive(doc["operator_uid"], "operator_uid"), vm=vm, host=host,
        migration=migration, task_environment=_task_environment_policy(doc),
    )


def load_config(path: Path, *, expected_uid: int = 0) -> SandboxConfig:
    """Load the fixed host policy; caller input is never configuration."""
    _owned_regular(path, expected_uid)
    document = _read_document(path)
    _check_top_level(document)
    return _build_config(document)


def upgrade_config(path: Path, *, expected_uid: int = 0) -> bool:
    """Atomically add the closed v2 migration limits to a valid v1 policy."""
    _owned_regular(path, expected_uid)
    document = _read_document(path)
    _check_top_level(document)
    _build_config(document)
    if document["schema"] == _SCHEMA_V3:
        return False
    upgraded = {
        **document, "schema": _SCHEMA_V3,
        "migration": document.get("migration", _DEFAULT_MIGRATION),
        "task_environment": _DEFAULT_TASK_ENVIRONMENT,
    }
    _check_top_level(upgraded)
    _build_config(upgraded)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix="config-", suffix=".json",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            json.dump(upgraded, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except Exception:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise
    return True


if __name__ == "__main__":
    if sys.argv != [sys.argv[0], "upgrade", "/etc/gc-incus-sandbox/config.json"] or os.geteuid() != 0:
        raise SystemExit("usage: config.py upgrade /etc/gc-incus-sandbox/config.json (as root)")
    upgrade_config(Path(sys.argv[2]))
