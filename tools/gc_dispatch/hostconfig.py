"""Host-owned dispatcher configuration.

Capacity and the queue bound describe the machine, not the workload, so they are
read from the host owner's configuration and can never be supplied by a
repository or an invocation. A repository declares only its demand, through the
dispatcher arguments it embeds in its own command fields (ADR-096).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, NamedTuple

CONFIG_BASENAME = "dispatch.json"
DEFAULT_MAX_QUEUE_WAIT_SECONDS = 1800.0
DEFAULT_STALE_LEASE_SECONDS = 21600.0

_FIELD_BOUNDS: dict[str, tuple[float, float]] = {
    "cpu_capacity": (1, 1024),
    "max_queue_wait_seconds": (0, 86400),
    "stale_lease_seconds": (1, 604800),
}


class HostConfigError(RuntimeError):
    """The host configuration is unusable. The dispatcher refuses to guess."""


class HostConfig(NamedTuple):
    """Everything the dispatcher reads from the machine rather than the caller."""

    cpu_capacity: int
    max_queue_wait_seconds: float
    stale_lease_seconds: float
    state_dir: Path
    config_path: Path


def default_cpu_capacity() -> int:
    """Return the number of CPUs this process may actually use.

    A cgroup or taskset-confined host reports far fewer usable CPUs than the
    machine has, and admitting against the machine count would oversubscribe
    exactly the constrained environments the dispatcher exists to protect.
    """
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        return max(1, os.cpu_count() or 1)


def _default_config_path() -> Path:
    """Return the owner's dispatcher configuration path."""
    base = os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")
    return Path(base) / "ground-control" / CONFIG_BASENAME


def _default_state_dir() -> Path:
    """Return the per-user runtime directory holding the shared ledger.

    There is deliberately no fallback to a world-writable directory such as
    ``/tmp``. This directory is the host's admission authority, and a predictable
    path under a shared directory is one another account can pre-create or race.
    ``XDG_RUNTIME_DIR`` is the right home; ``XDG_STATE_HOME`` (or its documented
    ``~/.local/state`` default) is the per-user stand-in when it is unset.
    """
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        return Path(runtime) / "ground-control" / "dispatch"
    state_home = os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local" / "state")
    return Path(state_home) / "ground-control" / "dispatch"


def resolve_paths() -> tuple[Path, Path]:
    """Locate the owner's configuration and the shared per-user admission state.

    Only the standard XDG locations are consulted. There is deliberately no
    dispatcher-specific override: one that redirected these paths would let a
    single invocation opt out of the host's configured capacity and coordinate
    against a ledger no other process shares, which is exactly the
    oversubscription this tool exists to prevent.
    """
    return _default_config_path(), _default_state_dir()


def _assert_config_file_is_owner_only(path: Path) -> None:
    """Refuse a configuration file another account could have written."""
    if path.is_symlink():
        raise HostConfigError(f"{path} must not be a symlink")
    stat = path.stat()
    if stat.st_uid != os.getuid():
        raise HostConfigError(f"{path} is not owned by this user")
    if stat.st_mode & 0o022:
        raise HostConfigError(f"{path} is writable by group or other; tighten it to 0600")


def _read_config_file(path: Path) -> dict[str, Any]:
    """Parse and shape-check the owner's configuration file."""
    _assert_config_file_is_owner_only(path)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        raise HostConfigError(f"{path} is not readable dispatcher configuration: {exc}") from exc
    if not isinstance(doc, dict):
        raise HostConfigError(f"{path} must hold a JSON object")
    unknown = sorted(set(doc) - set(_FIELD_BOUNDS))
    if unknown:
        raise HostConfigError(f"{path} has unknown key(s): {', '.join(unknown)}")
    return doc


def _numeric(doc: dict[str, Any], key: str, fallback: float, path: Path) -> float:
    """Return a bounded numeric setting, or the default when it is absent."""
    if key not in doc:
        return fallback
    value = doc[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HostConfigError(f"{path}: {key} must be a number")
    low, high = _FIELD_BOUNDS[key]
    if not low <= value <= high:
        raise HostConfigError(f"{path}: {key} must be between {low} and {high}")
    return float(value)


def load_host_config() -> HostConfig:
    """Read the host's capacity, queue bound, and lease age, with safe defaults."""
    config_path, state_dir = resolve_paths()
    doc = _read_config_file(config_path) if config_path.exists() else {}
    capacity = _numeric(doc, "cpu_capacity", float(default_cpu_capacity()), config_path)
    if capacity != int(capacity):
        raise HostConfigError(f"{config_path}: cpu_capacity must be a whole number")
    return HostConfig(
        cpu_capacity=int(capacity),
        max_queue_wait_seconds=_numeric(
            doc, "max_queue_wait_seconds", DEFAULT_MAX_QUEUE_WAIT_SECONDS, config_path),
        stale_lease_seconds=_numeric(
            doc, "stale_lease_seconds", DEFAULT_STALE_LEASE_SECONDS, config_path),
        state_dir=state_dir,
        config_path=config_path,
    )
