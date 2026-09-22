"""Host and guest resource facts the lifecycle helper admits and reports on."""

from __future__ import annotations

import json
import os
from pathlib import Path


def observation() -> dict[str, int | bool]:
    """Return conservative host availability facts without exposing process state."""
    memory_available = 0
    try:
        for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
            if line.startswith("MemAvailable:"):
                memory_available = int(line.split()[1]) // 1024
                break
        disk_available = os.statvfs("/").f_bavail * os.statvfs("/").f_frsize // (1024 ** 3)
        return {"memory_mib": memory_available, "disk_gib": disk_available, "fresh": True}
    except OSError:
        return {"memory_mib": 0, "disk_gib": 0, "fresh": False}


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
        "disk_gib": disk, "cpu_usage_ns": cpu_usage,
        "guest_memory_mib": memory_usage // (1024 * 1024) if memory_usage is not None else None,
        "guest_disk_gib": disk_usage // (1024 ** 3) if disk_usage is not None else None,
    }
