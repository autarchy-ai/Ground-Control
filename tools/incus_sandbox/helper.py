#!/usr/bin/python3
"""Root-side fixed-command lifecycle helper for local Incus sandboxes."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from collections.abc import Callable
if __package__:
    from .allocations import (
        CLEANUP_PENDING, RUNNING, SANDBOX_NAME, STOPPED, AdmissionError, CleanupPendingError, Ledger,
        fits, headroom,
    )
    from .config import SandboxConfig, load_config
    from .events import EventWriter
    from .observations import observation, positive_fact, query_payload, status_document
    from .owned_process import COMMAND_ERRORS, capture, run_owned
    from .reconcile import reconcile_ledger
    from .task_environment import redacted_task_observation, state_lock
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from allocations import (
        CLEANUP_PENDING, RUNNING, SANDBOX_NAME, STOPPED, AdmissionError, CleanupPendingError, Ledger,
        fits, headroom,
    )
    from config import SandboxConfig, load_config
    from events import EventWriter
    from observations import observation, positive_fact, query_payload, status_document
    from owned_process import COMMAND_ERRORS, capture, run_owned
    from reconcile import reconcile_ledger
    from task_environment import redacted_task_observation, state_lock


class UsageError(RuntimeError):
    """The caller requested a lifecycle action outside the closed vocabulary."""


_ACTIONS = {"create", "list", "attach", "stop", "start", "delete", "status", "diagnose", "reconcile"}
_INCUS = "/usr/bin/incus"
_IP = "/usr/sbin/ip"
_INVALID_OPERATOR = "caller is not the configured sandbox operator"
_PENDING = "sandbox cleanup is pending; remove it with `grndctl sandbox delete NAME --confirm NAME`"
_ResourceFacts = dict[str, int | bool]
_Record = dict[str, int | str]


def _network_policy_fresh(config: SandboxConfig) -> bool:
    """A changed host address set invalidates starts until setup refreshes nft sets."""
    stamp = config.state_dir / "network-addresses.sha256"
    try:
        expected = stamp.read_text(encoding="ascii").strip()
        addresses = capture([_IP, "-o", "-4", "addr", "show"], config.deadlines.query)
    except COMMAND_ERRORS:
        return False
    return expected == hashlib.sha256(addresses.encode("utf-8")).hexdigest()


def _failure_code(error: BaseException) -> str:
    """Map a failed call to the bounded audit vocabulary."""
    return "command_timeout" if isinstance(error, subprocess.TimeoutExpired) else "command_failed"


def _capture(argv: list[str], deadline_seconds: int) -> str:
    """Run a fixed query argv, resolved at call time so a test can patch `capture`."""
    return capture(argv, deadline_seconds)


class LifecycleHelper(object):
    """Validates caller intent, reserves capacity, then emits only fixed Incus argv."""

    def __init__(self, config: SandboxConfig, *, runner: Callable[[list[str], str], object] | None = None,
                 event_writer: EventWriter, observer: Callable[[], _ResourceFacts] | None = None,
                 network_checker: Callable[[SandboxConfig], bool] = _network_policy_fresh,
                 caller_uid: int | None = None,
                 query: Callable[[list[str], int], str] = _capture) -> None:
        """Bind the host policy; the runner and query default to deadline-bounded Incus execution."""
        self.config = config
        self.runner = runner if runner is not None else self._run
        self.events = event_writer
        self.observer = observer if observer is not None else self._observe
        self.network_checker = network_checker
        self.caller_uid = os.getuid() if caller_uid is None else caller_uid
        self.query = query

    def _run(self, argv: list[str], operation: str) -> object:
        """Run one fixed Incus argv under its operation's configured deadline."""
        if operation == "attach":
            # The operator's own terminal session: it holds no lock, needs the controlling
            # tty, and lasts until they detach, so it is the one call without a deadline.
            return subprocess.run(argv, check=True)
        return run_owned(argv, deadline_seconds=getattr(self.config.deadlines, operation))

    def _incus_query(self, path: str) -> object:
        """GET one Incus API path under the query deadline; None when it cannot be read."""
        try:
            return query_payload(self.query([_INCUS, "query", path, "--raw"], self.config.deadlines.query))
        except COMMAND_ERRORS:
            return None

    def _observe(self) -> _ResourceFacts:
        """Host facts plus the configured storage pool's observed space."""
        return observation(lambda: self._incus_query(f"/1.0/storage-pools/{self.config.pool}/resources"))

    def inventory(self, *, recursive: bool = False) -> object:
        """The project's instances as Incus lists them, or None when unobservable."""
        suffix = "&recursion=1" if recursive else ""
        try:
            return json.loads(self.query([_INCUS, "query", f"/1.0/instances?project={self.config.project}{suffix}",
                                          "--raw"], self.config.deadlines.query))
        except (*COMMAND_ERRORS, ValueError):
            return None

    @staticmethod
    def _name(name: str) -> str:
        if not isinstance(name, str) or not SANDBOX_NAME.fullmatch(name):
            raise UsageError("sandbox name must be lowercase letters, digits, and hyphens")
        return name

    def emit(self, action: str, outcome: str, name: str | None, *, error_code: str = "none",
             started: float | None = None, observed: _ResourceFacts | None = None) -> None:
        """Write one allowlisted lifecycle event."""
        duration = int((time.monotonic() - started) * 1000) if started is not None else 0
        self.events.write({"action": action, "outcome": outcome, "sandbox_id": name,
                           "error_code": error_code, "duration_ms": duration,
                           "assigned": {"cpu": self.config.vm.cpu,
                                        "memory_mib": self.config.vm.memory_mib,
                                        "disk_gib": self.config.vm.disk_gib},
                           "observed": observed})

    def ledger(self, *, recover: bool = False) -> Ledger:
        """Take the allocation lock for this host policy's state directory."""
        return Ledger(self.config.state_dir, recover=recover)

    def vm_record(self, state: str) -> _Record:
        """The configured per-VM reservation, owned by the host operator, in `state`."""
        return {"cpu": self.config.vm.cpu, "memory_mib": self.config.vm.memory_mib,
                "disk_gib": self.config.vm.disk_gib, "owner_uid": self.config.operator_uid, "state": state}

    def _admission_observation(self) -> _ResourceFacts:
        """Read and validate the host and pool facts used for a new reservation."""
        observed = self.observer()
        if observed.get("fresh") is not True:
            raise AdmissionError("host observations are stale")
        if any(positive_fact(observed.get(fact)) is None for fact in ("memory_mib", "disk_gib")):
            raise AdmissionError("host observations are unavailable")
        if any(positive_fact(observed.get(fact)) is None for fact in ("pool_total_gib", "pool_free_gib")):
            raise AdmissionError("storage pool observations are unavailable")
        if not self.network_checker(self.config):
            raise AdmissionError("network policy observations are stale")
        return observed

    def _has_headroom(self, observed: _ResourceFacts) -> bool:
        """Check host reserves before taking the allocation lock."""
        required_memory = self.config.host.reserve_memory_mib + self.config.vm.memory_mib
        required_disk = self.config.host.reserve_disk_gib + self.config.vm.disk_gib
        return int(observed["memory_mib"]) >= required_memory and int(observed["disk_gib"]) >= required_disk

    def _check_transition(self, previous: _Record | None, fresh: bool) -> None:
        """Refuse a reservation that is not a legal transition for this action."""
        if previous is not None and previous["state"] == RUNNING:
            raise AdmissionError("sandbox is already reserved")
        if fresh and previous is not None:
            raise AdmissionError("sandbox is already allocated")
        if not fresh and previous is None:
            raise UsageError("sandbox is not owned by this operator")
        if previous is not None and previous["state"] == CLEANUP_PENDING:
            raise UsageError(_PENDING)
        if self.caller_uid != self.config.operator_uid:
            raise UsageError(_INVALID_OPERATOR)

    def _check_capacity(self, ledger: Ledger, name: str, fresh: bool, observed: _ResourceFacts) -> None:
        """Admit only a prospective ledger that fits, and only a fresh name Incus proves unused."""
        prospective = {**ledger.records, name: self.vm_record(RUNNING)}
        if not fits(prospective, self.config.host, int(observed["pool_total_gib"])):
            raise AdmissionError("aggregate allocation is insufficient")
        if not fresh:
            return
        if int(observed["pool_free_gib"]) < self.config.vm.disk_gib:
            raise AdmissionError("storage pool free space is insufficient")
        listed = self.inventory()
        if not isinstance(listed, list):
            raise AdmissionError("project inventory is unavailable")
        if f"/1.0/instances/{name}" in listed:
            # Any instance present after a failed launch must be provably this call's own.
            raise AdmissionError("an unrecorded instance has this name; run `grndctl sandbox reconcile`")

    def _admit(self, name: str, fresh: bool) -> tuple[Ledger, _ResourceFacts, _Record | None]:
        """Reserve capacity for a caller after fresh local admission checks."""
        observed = self._admission_observation()
        if not self._has_headroom(observed):
            raise AdmissionError("host headroom is insufficient")
        ledger = self.ledger()
        previous = ledger.records.get(name)
        try:
            self._check_transition(previous, fresh)
            self._check_capacity(ledger, name, fresh, observed)
            ledger.records[name] = self.vm_record(RUNNING)
            ledger.save()
        except BaseException:
            ledger.release()
            raise
        return ledger, observed, previous

    def _require_owner(self, name: str, *, allow_pending: bool = False) -> None:
        """Admit only the operator's recorded VM; one awaiting cleanup only when allowed."""
        if self.caller_uid != self.config.operator_uid:
            raise UsageError(_INVALID_OPERATOR)
        with self.ledger() as ledger:
            record = ledger.records.get(name)
        if record is None or record["owner_uid"] != self.caller_uid:
            raise UsageError("sandbox is not owned by this operator")
        if record["state"] == CLEANUP_PENDING and not allow_pending:
            raise UsageError(_PENDING)

    def require_active_owner(self, name: str) -> None:
        """Admit transfer only to this operator's active, still-isolated sandbox."""
        name = self._name(name)
        if self.caller_uid != self.config.operator_uid:
            raise UsageError(_INVALID_OPERATOR)
        if not self.network_checker(self.config):
            raise AdmissionError("sandbox network isolation observation is stale")
        with self.ledger() as ledger:
            record = ledger.records.get(name)
        if record is None or record["owner_uid"] != self.caller_uid or record["state"] != RUNNING:
            raise UsageError("migration target is not an active sandbox owned by this operator")

    def _release(self, name: str) -> None:
        """Return a confirmed-stopped VM's CPU and memory; its disk stays charged."""
        with self.ledger() as ledger:
            if name in ledger.records:
                ledger.records[name] = {**ledger.records[name], "state": STOPPED}
                ledger.save()

    def forget(self, name: str) -> None:
        """Clear the state derived from a VM whose deletion or absence is confirmed."""
        (self.config.state_dir / "source-bindings" / f"{name}.json").unlink(missing_ok=True)
        self._task_state_path(name).unlink(missing_ok=True)

    def _headroom(self, observed: _ResourceFacts | None = None) -> dict[str, int | None]:
        """The aggregate headroom admission would use, given the observed pool."""
        with self.ledger() as ledger:
            records = ledger.records
        pool_total = positive_fact((observed or {}).get("pool_total_gib"))
        return headroom(records, self.config.host, pool_total)

    def normalized_observation(self, name: str, incus_info: dict[str, object] | None) -> dict[str, object]:
        """Render the closed status shape; malformed daemon JSON remains unavailable."""
        observed = self.observer()
        with self.ledger() as ledger:
            record = ledger.records.get(name)
        return status_document(
            name, str(record["state"]) if record is not None else STOPPED, self.vm_record(RUNNING), observed,
            incus_info, self._headroom(observed),
            lambda running: redacted_task_observation(self._task_state_path(name), running))

    def _query(self, name: str, action: str) -> None:
        name = self._name(name)
        self.events.ensure_available()
        self._require_owner(name, allow_pending=True)
        started = time.monotonic()
        try:
            deadline = self.config.deadlines.query
            instance_path = f"/1.0/instances/{name}?project={self.config.project}"
            info = query_payload(self.query([_INCUS, "query", instance_path, "--raw"], deadline))
            if isinstance(info, dict):
                state_path = f"/1.0/instances/{name}/state?project={self.config.project}"
                info["state"] = query_payload(self.query([_INCUS, "query", state_path, "--raw"], deadline))
            report = self.normalized_observation(name, info)
            print(json.dumps(report, separators=(",", ":")))
            self.emit(action, "success", name, started=started, observed=self.observer())
        except Exception as exc:
            self.emit(action, "failure", name, error_code=_failure_code(exc), started=started)
            raise

    def _instance_absent(self, name: str) -> bool:
        """True only on positive proof that the project holds no instance of this name."""
        listed = self.inventory()
        return isinstance(listed, list) and f"/1.0/instances/{name}" not in listed

    def _delete_instance(self, name: str) -> None:
        """Delete the instance; one that provably no longer exists counts as deleted."""
        try:
            self.runner([_INCUS, "delete", name, "--force", "--project", self.config.project], "lifecycle")
        except COMMAND_ERRORS:
            if not self._instance_absent(name):
                raise

    def _compensate(self, name: str, ledger: Ledger, previous: _Record | None, *, fresh: bool,
                    error: BaseException) -> str | None:
        """Undo a reservation this call could not complete; return a failed cleanup's code.

        Admission proved a fresh name unused, so an instance present now is this call's own
        and is deleted. Capacity is released only once that VM is gone or proven absent; when
        the delete fails too, the VM keeps its full reservation as cleanup-pending.
        """
        if not fresh:
            # A start that timed out may have started the VM, so it keeps its reservation.
            if previous is not None and not isinstance(error, subprocess.TimeoutExpired):
                ledger.records[name] = previous
                ledger.save()
            return None
        try:
            if not self._instance_absent(name):
                self._delete_instance(name)
        except Exception as cleanup:
            ledger.records[name] = {**ledger.records[name], "state": CLEANUP_PENDING}
            ledger.save()
            return _failure_code(cleanup)
        ledger.records.pop(name, None)
        ledger.save()
        return None

    @staticmethod
    def _admission_error_code(error: AdmissionError) -> str:
        """Map detailed local admission errors to the bounded audit vocabulary."""
        if "stale" in str(error) or "unavailable" in str(error):
            return "admission_observation_stale"
        if "unrecorded instance" in str(error):
            return "admission_conflict"
        return "admission_insufficient"

    def _step(self, operation: str, argv: list[str]) -> Callable[[], object]:
        """Bind one fixed argv to its operation's deadline for a lifecycle mutation."""
        return lambda: self.runner(argv, operation)

    def _mutate(self, action: str, name: str, steps: list[Callable[[], object]], *, reserve: bool = False,
                release: bool = False, fresh: bool = False, allow_pending: bool = False) -> None:
        """Run one audited lifecycle mutation, compensating for a reservation it could not complete."""
        name = self._name(name)
        started = time.monotonic()
        self.events.ensure_available()
        ledger: Ledger | None = None
        observed: _ResourceFacts | None = None
        previous: _Record | None = None
        applied = False
        try:
            if reserve:
                ledger, observed, previous = self._admit(name, fresh)
            else:
                self._require_owner(name, allow_pending=allow_pending)
            for step in steps:
                step()
            # Incus made the change, so the ledger already tells the truth about it; a later
            # ledger or audit failure is raised as is and never compensated.
            applied = True
            if release:
                self._release(name)
            self.emit(action, "success", name, started=started, observed=observed)
        except AdmissionError as exc:
            code = self._admission_error_code(exc)
            self.emit(action, "denied", name, error_code=code, started=started, observed=observed)
            raise
        except Exception as exc:
            if applied:
                raise
            cleanup_code = (self._compensate(name, ledger, previous, fresh=fresh, error=exc)
                            if ledger is not None else None)
            self.emit(action, "failure", name, error_code=_failure_code(exc), started=started, observed=observed)
            if cleanup_code is None:
                raise
            self.emit("cleanup", "failure", name, error_code=cleanup_code, started=started)
            raise CleanupPendingError(action, name, _failure_code(exc), cleanup_code) from exc
        finally:
            if ledger is not None:
                ledger.release()

    def create(self, name: str) -> None:
        name = self._name(name)
        project = self.config.project
        steps = [
            self._step("launch", [_INCUS, "launch", self.config.image, name, "--project", project,
                                  "--profile", self.config.profile, "--vm", "--device",
                                  f"root,size={self.config.vm.disk_gib}GiB"]),
            self._step("lifecycle", [_INCUS, "config", "set", name, "limits.cpu", str(self.config.vm.cpu),
                                     "--project", project]),
            self._step("lifecycle", [_INCUS, "config", "set", name, "limits.memory",
                                     f"{self.config.vm.memory_mib}MiB", "--project", project]),
        ]
        self._mutate("create", name, steps, reserve=True, fresh=True)
        self.emit("boot", "success", name)
    def start(self, name: str) -> None:
        name = self._name(name)
        with state_lock(self.config.state_dir, name):
            self._mutate("start", name, [self._step("lifecycle", [_INCUS, "start", name, "--project",
                                                                  self.config.project])], reserve=True)
            self._task_state_path(name).unlink(missing_ok=True)
    def _task_state_path(self, name: str) -> Path:
        return self.config.state_dir / "tasks" / f"{name}.json"
    def _terminate_task(self, name: str) -> None:
        """Stop the fixed task session before a VM can stop or disappear."""
        state = self._task_state_path(name)
        if not state.exists():
            return
        self.runner([_INCUS, "exec", name, "--project", self.config.project, "--",
                     "/usr/bin/python3", "/usr/local/lib/gc-incus-sandbox/task-launcher.py", "stop"], "task")
        state.unlink(missing_ok=True)

    def stop(self, name: str) -> None:
        name = self._name(name)
        with state_lock(self.config.state_dir, name):
            self._require_owner(name)
            self._terminate_task(name)
            self._mutate("stop", name, [self._step("lifecycle", [_INCUS, "stop", name, "--project",
                                                                 self.config.project])], release=True)

    def delete(self, name: str, confirmation: str | None = None) -> None:
        name = self._name(name)
        if confirmation != name:
            raise UsageError("delete requires the exact sandbox name as confirmation")
        with state_lock(self.config.state_dir, name):
            self._require_owner(name, allow_pending=True)
            self._terminate_task(name)
            self._mutate("delete", name, [lambda: self._delete_instance(name)], allow_pending=True)
            with self.ledger() as ledger:
                ledger.records.pop(name, None)
                ledger.save()
            self.forget(name)

    def attach(self, name: str) -> None:
        name = self._name(name)
        self._mutate("attach", name, [self._step("attach", [
            _INCUS, "exec", name, "--project", self.config.project, "--",
            "/usr/bin/tmux", "-S", "/run/gc-sandbox-task/control", "attach-session", "-t", "gc-task"])])

    def list(self) -> None:
        self.events.ensure_available()
        self.runner([_INCUS, "list", "--project", self.config.project, "--format", "json"], "query")
        self.emit("status", "success", None)

    def status(self, name: str) -> None:
        self._query(name, "status")

    def reconcile(self) -> None:
        """Bring the ledger in line with one positive inventory of the sandbox project."""
        if self.caller_uid != self.config.operator_uid:
            raise UsageError(_INVALID_OPERATOR)
        print(json.dumps(reconcile_ledger(self), separators=(",", ":")))

    def diagnose(self, name: str) -> None:
        self._query(name, "diagnose")

    def dispatch(self, action: str, name: str | None = None, confirmation: str | None = None) -> None:
        if action not in _ACTIONS:
            raise UsageError("unsupported lifecycle action")
        if action in {"list", "reconcile"}:
            if name is not None:
                raise UsageError(f"{action} does not accept a sandbox name")
            getattr(self, action)()
            return
        if name is None:
            raise UsageError("lifecycle action requires a sandbox name")
        if action == "delete":
            self.delete(name, confirmation)
            return
        if confirmation is not None:
            raise UsageError("confirmation is accepted only for delete")
        getattr(self, action)(name)


def main(argv: list[str]) -> int:
    """Run the fixed root helper entry point invoked by its sudo rule."""
    if os.geteuid() != 0:
        raise UsageError("the helper must run as root through its fixed sudo rule")
    if len(argv) not in (2, 3, 4):
        raise UsageError("usage: gc-incus-helper ACTION [SANDBOX [CONFIRMATION]]")
    config_path = Path("/etc/gc-incus-sandbox/config.json")
    config = load_config(config_path)
    sudo_uid = os.environ.get("SUDO_UID")
    if sudo_uid is None or not sudo_uid.isdecimal():
        raise UsageError("the helper requires sudo to preserve the calling operator identity")
    helper = LifecycleHelper(config, event_writer=EventWriter(config.event_log, config.event_max_bytes),
                             caller_uid=int(sudo_uid))
    helper.dispatch(argv[1], argv[2] if len(argv) >= 3 else None, argv[3] if len(argv) == 4 else None)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except (UsageError, AdmissionError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
    except CleanupPendingError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
