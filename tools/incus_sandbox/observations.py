"""Host and guest resource facts the lifecycle helper admits and reports on."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path

if __package__:
    from .allocations import CLEANUP_PENDING, RUNNING, STOPPED
else:
    from allocations import CLEANUP_PENDING, RUNNING, STOPPED


_GIB = 1024 ** 3


def pool_space(payload: object) -> dict[str, int] | None:
    """Validate a storage-pool resources document into whole free and total GiB."""
    space = payload.get("space") if isinstance(payload, dict) else None
    if not isinstance(space, dict):
        return None
    total, used = space.get("total"), space.get("used")
    valid = all(isinstance(value, int) and not isinstance(value, bool) for value in (total, used))
    if not valid or not 0 <= used <= total or total == 0:
        return None
    return {"pool_total_gib": total // _GIB, "pool_free_gib": (total - used) // _GIB}


def observation(pool_resources: Callable[[], object] | None = None) -> dict[str, int | bool]:
    """Return conservative host and storage-pool availability without exposing process state.

    `disk_gib` is the host root file system, where a loop-backed pool grows; the pool facts
    are the configured Incus pool itself and are absent when it cannot be observed.
    """
    memory_available = 0
    try:
        for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
            if line.startswith("MemAvailable:"):
                memory_available = int(line.split()[1]) // 1024
                break
        root = os.statvfs("/")
        facts: dict[str, int | bool] = {"memory_mib": memory_available,
                                        "disk_gib": root.f_bavail * root.f_frsize // _GIB, "fresh": True}
    except OSError:
        return {"memory_mib": 0, "disk_gib": 0, "fresh": False}
    pool = pool_space(pool_resources()) if pool_resources is not None else None
    return {**facts, **(pool or {})}


def positive_fact(value: object) -> int | None:
    """Return a non-negative integer observation, otherwise no fact."""
    return value if isinstance(value, int) and value >= 0 else None


def guest_usage(info: object) -> tuple[int | None, int | None, int | None]:
    """Extract the three numeric guest resource facts from Incus state JSON."""
    if not isinstance(info, dict):
        return None, None, None
    state = info.get("state")
    if not isinstance(state, dict):
        return None, None, None
    cpu = state.get("cpu") if isinstance(state.get("cpu"), dict) else {}
    memory = state.get("memory") if isinstance(state.get("memory"), dict) else {}
    disks = state.get("disk") if isinstance(state.get("disk"), dict) else {}
    root = disks.get("root") if isinstance(disks.get("root"), dict) else {}
    return positive_fact(cpu.get("usage")), positive_fact(memory.get("usage")), positive_fact(root.get("usage"))


def query_payload(stdout: str) -> dict[str, object] | None:
    """Unwrap Incus' synchronous-query envelope without exposing raw JSON."""
    try:
        response = json.loads(stdout)
    except ValueError:
        return None
    if not isinstance(response, dict):
        return None
    payload = response.get("metadata")
    return payload if isinstance(payload, dict) else response


def status_state(info: object, observed: dict[str, int | bool]) -> tuple[bool, str]:
    """Normalize daemon status only when the independent host facts are fresh."""
    if not isinstance(info, dict) or observed.get("fresh") is not True:
        return False, "unavailable"
    status = info.get("status", "unavailable")
    if not isinstance(status, str) or len(status) > 32:
        return False, "unavailable"
    return True, status.lower()


def observed_facts(observed: dict[str, int | bool], info: object, available: bool) -> dict[str, object]:
    """Return the stable observed-facts subdocument without raw daemon JSON."""
    cpu_usage, memory_usage, disk_usage = guest_usage(info if available else None)
    memory = positive_fact(observed.get("memory_mib")) if available else None
    disk = positive_fact(observed.get("disk_gib")) if available else None
    return {
        "availability": "fresh" if available else "unavailable", "memory_mib": memory,
        "disk_gib": disk, "pool_total_gib": positive_fact(observed.get("pool_total_gib")),
        "pool_free_gib": positive_fact(observed.get("pool_free_gib")), "cpu_usage_ns": cpu_usage,
        "guest_memory_mib": memory_usage // (1024 * 1024) if memory_usage is not None else None,
        "guest_disk_gib": disk_usage // (1024 ** 3) if disk_usage is not None else None,
    }


def status_document(name: str, state: str, assigned: dict[str, int | str], observed: dict[str, int | bool],
                    incus_info: object, headroom: dict[str, int | None],
                    task: Callable[[bool], dict[str, object]]) -> dict[str, object]:
    """The closed `status`/`diagnose` document for one recorded VM in its ledger `state`."""
    available, status = status_state(incus_info, observed)
    if state == CLEANUP_PENDING:
        failure_reason = "cleanup_pending"
    else:
        failure_reason = "none" if available else "observation_unavailable"
    return {
        "schema": "gc.incus-sandbox.status/v3",
        "sandbox_id": name,
        "desired_state": {RUNNING: "running", STOPPED: "stopped", CLEANUP_PENDING: "deleted"}[state],
        "observed_state": status,
        "assigned": {key: assigned[key] for key in ("cpu", "memory_mib", "disk_gib")},
        "observed": observed_facts(observed, incus_info, available),
        "admission_headroom": headroom,
        "last_transition": "unavailable",
        "failure_reason": failure_reason,
        "task_environment": task(status == "running"),
    }
