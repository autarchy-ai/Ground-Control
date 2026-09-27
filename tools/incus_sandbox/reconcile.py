"""Reconcile the allocation ledger with one positive inventory of the sandbox project."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TYPE_CHECKING

if __package__:
    from .allocations import CLEANUP_PENDING, RUNNING, SANDBOX_NAME, STOPPED, AdmissionError
    from .task_environment import state_lock
else:
    from allocations import CLEANUP_PENDING, RUNNING, SANDBOX_NAME, STOPPED, AdmissionError
    from task_environment import state_lock

if TYPE_CHECKING:
    from .helper import LifecycleHelper

# Throwaway guests that template builds and setup's quota probe run in the same project.
_TOOLING_PREFIXES = ("gc-template-build-", "gc-quota-probe-vm-")
_MAX_INSTANCES = 4096
_Record = dict[str, int | str]
Inventory = dict[str, tuple[str, bool]]


def _is_sandbox_vm(item: dict[str, object], name: str, profile: str, pool: str) -> bool:
    """True only for a VM with the configured profile whose root disk is on the configured pool."""
    devices = item.get("expanded_devices")
    root = devices.get("root") if isinstance(devices, dict) else None
    return (item.get("type") == "virtual-machine" and item.get("profiles") == [profile]
            and isinstance(root, dict) and root.get("pool") == pool
            and SANDBOX_NAME.fullmatch(name) is not None and not name.startswith(_TOOLING_PREFIXES))


def observed_instances(listed: object, profile: str, pool: str) -> Inventory | None:
    """Map every listed instance to its capacity state and whether it is a sandbox VM.

    None unless the listing is a complete, well-formed inventory: an instance Incus reports
    as anything but stopped is treated as running, so its CPU and memory stay charged.
    """
    if not isinstance(listed, list) or len(listed) > _MAX_INSTANCES:
        return None
    instances: Inventory = {}
    for item in listed:
        name = item.get("name") if isinstance(item, dict) else None
        if not isinstance(name, str):
            return None
        state = STOPPED if item.get("status") == "Stopped" else RUNNING
        instances[name] = (state, _is_sandbox_vm(item, name, profile, pool))
    return instances


def _recorded(records: dict[str, _Record], instances: Inventory,
              report: dict[str, list[str]]) -> dict[str, _Record]:
    """Keep each recorded VM the inventory still holds, in the state Incus reports."""
    kept: dict[str, _Record] = {}
    for name, record in records.items():
        if name not in instances:
            report["forgotten"].append(name)
        elif record["state"] == CLEANUP_PENDING:
            report["cleanup_pending"].append(name)
            kept[name] = record
        else:
            observed = instances[name][0]
            if record["state"] != observed:
                report["updated"].append(name)
            kept[name] = {**record, "state": observed}
    return kept


def _unrecorded(records: dict[str, _Record], instances: Inventory, vm_record: Callable[[str], _Record],
                report: dict[str, list[str]]) -> dict[str, _Record]:
    """Adopt each unrecorded sandbox VM and report any other instance a sandbox could be named."""
    adopted: dict[str, _Record] = {}
    for name, (observed, sandbox_vm) in instances.items():
        if name in records:
            continue
        if sandbox_vm:
            adopted[name] = vm_record(observed)
            report["adopted"].append(name)
        elif SANDBOX_NAME.fullmatch(name) and not name.startswith(_TOOLING_PREFIXES):
            report["unmanaged"].append(name)
    return adopted


def reconciled(records: dict[str, _Record], instances: Inventory,
               vm_record: Callable[[str], _Record]) -> tuple[dict[str, _Record], dict[str, list[str]]]:
    """Apply one inventory to the ledger; nothing is deleted and no capacity is guessed.

    A record is dropped only for an instance positively absent from the inventory. A
    cleanup-pending record stays until its delete is confirmed. An unrecorded instance is
    adopted only when it has the sandbox profile and pool; any other one is reported.
    """
    report: dict[str, list[str]] = {"adopted": [], "forgotten": [], "updated": [], "cleanup_pending": [],
                                    "unmanaged": []}
    result = {**_recorded(records, instances, report), **_unrecorded(records, instances, vm_record, report)}
    return result, {key: sorted(names) for key, names in report.items()}


def reconcile_ledger(helper: LifecycleHelper) -> dict[str, object]:
    """Persist the reconciled ledger, then clear derived state for every forgotten VM.

    An unreadable inventory changes nothing. A ledger that is missing or no longer parses is
    rebuilt from the inventory, and damaged bytes are kept beside it for inspection.
    """
    config = helper.config
    helper.events.ensure_available()
    started = time.monotonic()
    try:
        # The inventory is read under the ledger lock and applied before it is released, so
        # no create or start can land between the observation and the update.
        with helper.ledger(recover=True) as ledger:
            instances = observed_instances(helper.inventory(recursive=True), config.profile, config.pool)
            if instances is None:
                raise AdmissionError("project inventory is unavailable")
            rebuilt = ledger.rebuilt
            ledger.records, report = reconciled(ledger.records, instances, helper.vm_record)
            ledger.save()
    except AdmissionError:
        helper.emit("reconcile", "denied", None, error_code="admission_observation_stale", started=started)
        raise
    except Exception:
        helper.emit("reconcile", "failure", None, error_code="command_failed", started=started)
        raise
    for name in report["forgotten"]:
        with state_lock(config.state_dir, name):
            helper.forget(name)
    helper.emit("reconcile", "success", None, started=started)
    return {"schema": "gc.incus-sandbox.reconcile/v1", "rebuilt": rebuilt, **report}
