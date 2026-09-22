#!/usr/bin/python3
"""Root-side fixed-command lifecycle helper for local Incus sandboxes."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from collections.abc import Callable
if __package__:
    from .config import SandboxConfig, load_config
    from .events import EventWriter
    from .observations import observation, observed_facts, positive_fact, query_payload, status_state
    from .task_environment import redacted_task_observation, state_lock
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from config import SandboxConfig, load_config
    from events import EventWriter
    from observations import observation, observed_facts, positive_fact, query_payload, status_state
    from task_environment import redacted_task_observation, state_lock


class UsageError(RuntimeError):
    """The caller requested a lifecycle action outside the closed vocabulary."""

class AdmissionError(RuntimeError):
    """Host capacity facts do not safely admit a VM operation."""

_NAME = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
_ACTIONS = {"create", "list", "attach", "stop", "start", "delete", "status", "diagnose"}
_INCUS = "/usr/bin/incus"
_IP = "/usr/sbin/ip"
_INVALID_ALLOCATION = "allocation state is invalid"
_INVALID_OPERATOR = "caller is not the configured sandbox operator"

def _run(argv: list[str]) -> dict[str, int]:
    """Run one already-allowlisted executable argument vector."""
    completed = subprocess.run(argv, check=True, stdin=None, stdout=None, stderr=None)
    return {"returncode": completed.returncode}


def _network_policy_fresh(config: SandboxConfig) -> bool:
    """A changed host address set invalidates starts until setup refreshes nft sets."""
    stamp = config.state_dir / "network-addresses.sha256"
    try:
        expected = stamp.read_text(encoding="ascii").strip()
        addresses = subprocess.check_output([_IP, "-o", "-4", "addr", "show"], text=True)
    except (OSError, subprocess.SubprocessError):
        return False
    return expected == hashlib.sha256(addresses.encode("utf-8")).hexdigest()


class LifecycleHelper(object):
    """Validates caller intent, reserves capacity, then emits only fixed Incus argv."""

    def __init__(self, config: SandboxConfig, *, runner: Callable[[list[str]], object] = _run,
                 event_writer: EventWriter, observer: Callable[[], dict[str, int | bool]] = observation,
                 network_checker: Callable[[SandboxConfig], bool] = _network_policy_fresh,
                 caller_uid: int | None = None) -> None:
        self.config = config
        self.runner = runner
        self.events = event_writer
        self.observer = observer
        self.network_checker = network_checker
        self.caller_uid = os.getuid() if caller_uid is None else caller_uid

    @staticmethod
    def _name(name: str) -> str:
        if not isinstance(name, str) or not _NAME.fullmatch(name):
            raise UsageError("sandbox name must be lowercase letters, digits, and hyphens")
        return name

    def _emit(self, action: str, outcome: str, name: str | None, *, error_code: str = "none",
              started: float | None = None, observed: dict[str, int | bool] | None = None) -> None:
        duration = int((time.monotonic() - started) * 1000) if started is not None else 0
        self.events.write({"action": action, "outcome": outcome, "sandbox_id": name,
                           "error_code": error_code, "duration_ms": duration,
                           "assigned": {"cpu": self.config.vm.cpu,
                                        "memory_mib": self.config.vm.memory_mib,
                                        "disk_gib": self.config.vm.disk_gib},
                           "observed": observed})

    def _allocation_path(self) -> Path:
        self.config.state_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        return self.config.state_dir / "allocations.json"

    def _locked_allocations(self) -> tuple[int, dict[str, dict[str, int]]]:
        path = self._allocation_path()
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o640)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            raw = os.read(fd, 1024 * 1024).decode("utf-8")
            doc = json.loads(raw) if raw else {}
            if not isinstance(doc, dict):
                raise AdmissionError(_INVALID_ALLOCATION)
            records: dict[str, dict[str, int]] = {}
            for name, value in doc.items():
                if not _NAME.fullmatch(name) or not isinstance(value, dict):
                    raise AdmissionError(_INVALID_ALLOCATION)
                fields = ("cpu", "memory_mib", "disk_gib", "owner_uid")
                valid_fields = set(value) == {*fields, "active"}
                if not valid_fields:
                    raise AdmissionError(_INVALID_ALLOCATION)
                valid_numbers = all(isinstance(value[key], int) and value[key] > 0 for key in fields)
                if not valid_numbers or not isinstance(value["active"], bool):
                    raise AdmissionError(_INVALID_ALLOCATION)
                records[name] = value
            return fd, records
        except Exception:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
            raise

    @staticmethod
    def _save_allocations(fd: int, records: dict[str, dict[str, int]]) -> None:
        payload = json.dumps(records, separators=(",", ":")).encode("utf-8")
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)
        os.write(fd, payload)
        os.fsync(fd)

    @staticmethod
    def _unlock(fd: int) -> None:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)

    def _admission_observation(self) -> dict[str, int | bool]:
        """Read and validate the host facts used for a new reservation."""
        observed = self.observer()
        if observed.get("fresh") is not True:
            raise AdmissionError("host observations are stale")
        if positive_fact(observed.get("memory_mib")) is None:
            raise AdmissionError("host observations are unavailable")
        if positive_fact(observed.get("disk_gib")) is None:
            raise AdmissionError("host observations are unavailable")
        if not self.network_checker(self.config):
            raise AdmissionError("network policy observations are stale")
        return observed

    def _has_headroom(self, observed: dict[str, int | bool]) -> bool:
        """Check host reserves before taking the allocation lock."""
        memory = positive_fact(observed.get("memory_mib"))
        disk = positive_fact(observed.get("disk_gib"))
        if memory is None or disk is None:
            return False
        required_memory = self.config.host.reserve_memory_mib + self.config.vm.memory_mib
        required_disk = self.config.host.reserve_disk_gib + self.config.vm.disk_gib
        return memory >= required_memory and disk >= required_disk

    def _aggregate_fits(self, records: dict[str, dict[str, int]]) -> bool:
        """Check aggregate VM allocations against the fixed host capacity."""
        active = [record for record in records.values() if record["active"]]
        cpu = sum(record["cpu"] for record in active) + self.config.vm.cpu
        memory = sum(record["memory_mib"] for record in active) + self.config.vm.memory_mib
        disk = sum(record["disk_gib"] for record in active)
        disk += self.config.vm.disk_gib + self.config.host.overhead_disk_gib
        return (
            cpu <= self.config.host.max_cpu and memory <= self.config.host.max_memory_mib
            and disk <= self.config.host.max_disk_gib
        )

    def _check_transition(self, previous: dict[str, int] | None, fresh: bool,
                          records: dict[str, dict[str, int]]) -> None:
        """Refuse a reservation that is not a legal transition for this action."""
        if previous is not None and previous["active"]:
            raise AdmissionError("sandbox is already reserved")
        if fresh and previous is not None:
            raise AdmissionError("sandbox is already allocated")
        if not fresh and previous is None:
            raise UsageError("sandbox is not owned by this operator")
        if not self._aggregate_fits(records):
            raise AdmissionError("aggregate allocation is insufficient")
        if self.caller_uid != self.config.operator_uid:
            raise UsageError(_INVALID_OPERATOR)

    def _admit(self, name: str, fresh: bool) -> tuple[
        int, dict[str, dict[str, int]], dict[str, int | bool], dict[str, int] | None,
    ]:
        """Reserve capacity for a caller after fresh local admission checks."""
        observed = self._admission_observation()
        if not self._has_headroom(observed):
            raise AdmissionError("host headroom is insufficient")
        fd, records = self._locked_allocations()
        previous = records.get(name)
        try:
            self._check_transition(previous, fresh, records)
        except Exception:
            self._unlock(fd)
            raise
        records[name] = {"cpu": self.config.vm.cpu, "memory_mib": self.config.vm.memory_mib,
                         "disk_gib": self.config.vm.disk_gib, "owner_uid": self.caller_uid, "active": True}
        return fd, records, observed, previous

    def _require_owner(self, name: str) -> None:
        if self.caller_uid != self.config.operator_uid:
            raise UsageError(_INVALID_OPERATOR)
        fd, records = self._locked_allocations()
        try:
            record = records.get(name)
            if record is None or record["owner_uid"] != self.caller_uid:
                raise UsageError("sandbox is not owned by this operator")
        finally:
            self._unlock(fd)

    def require_active_owner(self, name: str) -> None:
        """Admit transfer only to this operator's active, still-isolated sandbox."""
        name = self._name(name)
        if self.caller_uid != self.config.operator_uid:
            raise UsageError(_INVALID_OPERATOR)
        if not self.network_checker(self.config):
            raise AdmissionError("sandbox network isolation observation is stale")
        fd, records = self._locked_allocations()
        try:
            record = records.get(name)
            if record is None or record["owner_uid"] != self.caller_uid or not record["active"]:
                raise UsageError("migration target is not an active sandbox owned by this operator")
        finally:
            self._unlock(fd)

    def _release(self, name: str) -> None:
        fd, records = self._locked_allocations()
        try:
            if name in records:
                records[name]["active"] = False
            self._save_allocations(fd, records)
        finally:
            self._unlock(fd)

    def _forget(self, name: str) -> None:
        fd, records = self._locked_allocations()
        try:
            records.pop(name, None)
            self._save_allocations(fd, records)
        finally:
            self._unlock(fd)
        (self.config.state_dir / "source-bindings" / f"{name}.json").unlink(missing_ok=True)
        (self.config.state_dir / "tasks" / f"{name}.json").unlink(missing_ok=True)

    def _headroom(self) -> dict[str, int]:
        fd, records = self._locked_allocations()
        try:
            return {
                "cpu": self.config.host.max_cpu - sum(record["cpu"] for record in records.values() if record["active"]),
                "memory_mib": self.config.host.max_memory_mib - sum(
                    record["memory_mib"] for record in records.values() if record["active"]
                ),
                "disk_gib": self.config.host.max_disk_gib - self.config.host.overhead_disk_gib - sum(
                    record["disk_gib"] for record in records.values() if record["active"]
                ),
            }
        finally:
            self._unlock(fd)

    def normalized_observation(self, name: str, incus_info: dict[str, object] | None) -> dict[str, object]:
        """Render the closed status shape; malformed daemon JSON remains unavailable."""
        observed = self.observer()
        available, status = status_state(incus_info, observed)
        return {
            "schema": "gc.incus-sandbox.status/v2",
            "sandbox_id": name,
            "desired_state": "running" if name in self._allocation_names() else "stopped",
            "observed_state": status,
            "assigned": {"cpu": self.config.vm.cpu, "memory_mib": self.config.vm.memory_mib,
                         "disk_gib": self.config.vm.disk_gib},
            "observed": observed_facts(observed, incus_info, available),
            "admission_headroom": self._headroom(),
            "last_transition": "unavailable",
            "failure_reason": "none" if available else "observation_unavailable",
            "task_environment": redacted_task_observation(
                self._task_state_path(name), status == "running",
            ),
        }

    def _allocation_names(self) -> set[str]:
        fd, records = self._locked_allocations()
        try:
            return {name for name, record in records.items() if record["active"]}
        finally:
            self._unlock(fd)

    def _query(self, name: str, action: str) -> None:
        name = self._name(name)
        self.events.ensure_available()
        self._require_owner(name)
        started = time.monotonic()
        try:
            instance_path = f"/1.0/instances/{name}?project={self.config.project}"
            completed = subprocess.run([_INCUS, "query", instance_path, "--raw"],
                                       check=True, text=True, capture_output=True)
            info = query_payload(completed.stdout)
            if isinstance(info, dict):
                state_path = f"/1.0/instances/{name}/state?project={self.config.project}"
                state = subprocess.run([_INCUS, "query", state_path, "--raw"],
                                       check=True, text=True, capture_output=True)
                info["state"] = query_payload(state.stdout)
            report = self.normalized_observation(name, info)
            print(json.dumps(report, separators=(",", ":")))
            self._emit(action, "success", name, started=started, observed=self.observer())
        except Exception:
            self._emit(action, "failure", name, error_code="command_failed", started=started)
            raise

    def _reservation(self, name: str, reserve: bool, fresh: bool) -> tuple[
        int | None, dict[str, dict[str, int]] | None, dict[str, int | bool] | None, dict[str, int] | None,
    ]:
        """Authorize an existing VM or hold capacity for a new one."""
        if not reserve:
            self._require_owner(name)
            return None, None, None, None
        descriptor, records, observed, previous = self._admit(name, fresh)
        self._save_allocations(descriptor, records)
        return descriptor, records, observed, previous

    def _rollback_reservation(self, name: str, descriptor: int | None,
                              records: dict[str, dict[str, int]] | None,
                              previous: dict[str, int] | None, *, delete: bool) -> None:
        """Restore the prior allocation and remove only an instance this call created."""
        if descriptor is None or records is None:
            return
        if previous is None:
            records.pop(name, None)
        else:
            records[name] = previous
        self._save_allocations(descriptor, records)
        if not delete:
            return
        try:
            self.runner([_INCUS, "delete", name, "--force", "--project", self.config.project])
        except Exception:
            return

    @staticmethod
    def _admission_error_code(error: AdmissionError) -> str:
        """Map detailed local admission errors to the bounded audit vocabulary."""
        if "stale" in str(error) or "unavailable" in str(error):
            return "admission_observation_stale"
        return "admission_insufficient"

    def _mutate(self, action: str, name: str, commands: list[list[str]], *, reserve: bool = False,
                release: bool = False, fresh: bool = False) -> None:
        name = self._name(name)
        started = time.monotonic()
        self.events.ensure_available()
        descriptor: int | None = None
        records: dict[str, dict[str, int]] | None = None
        observed: dict[str, int | bool] | None = None
        previous: dict[str, int] | None = None
        created = False
        try:
            descriptor, records, observed, previous = self._reservation(name, reserve, fresh)
            for argv in commands:
                self.runner(argv)
                created = fresh
            if descriptor is not None and records is not None:
                self._save_allocations(descriptor, records)
            if release:
                self._release(name)
            self._emit(action, "success", name, started=started, observed=observed)
        except AdmissionError as exc:
            code = self._admission_error_code(exc)
            self._emit(action, "denied", name, error_code=code, started=started, observed=observed)
            raise
        except Exception:
            # Only an instance this invocation launched is deleted; a reservation that
            # never completed is returned to the state it replaced.
            self._rollback_reservation(name, descriptor, records, previous, delete=created)
            self._emit(action, "failure", name, error_code="command_failed", started=started, observed=observed)
            raise
        finally:
            if descriptor is not None:
                self._unlock(descriptor)

    def create(self, name: str) -> None:
        name = self._name(name)
        project = self.config.project
        commands = [
            [_INCUS, "launch", self.config.image, name, "--project", project,
             "--profile", self.config.profile, "--vm", "--device",
             f"root,size={self.config.vm.disk_gib}GiB"],
            [_INCUS, "config", "set", name, "limits.cpu", str(self.config.vm.cpu), "--project", project],
            [_INCUS, "config", "set", name, "limits.memory", f"{self.config.vm.memory_mib}MiB", "--project", project],
        ]
        self._mutate("create", name, commands, reserve=True, fresh=True)
        self._emit("boot", "success", name)
    def start(self, name: str) -> None:
        name = self._name(name)
        with state_lock(self.config.state_dir, name):
            self._mutate("start", name, [[_INCUS, "start", name, "--project", self.config.project]], reserve=True)
            self._task_state_path(name).unlink(missing_ok=True)
    def _task_state_path(self, name: str) -> Path:
        return self.config.state_dir / "tasks" / f"{name}.json"
    def _terminate_task(self, name: str) -> None:
        """Stop the fixed task session before a VM can stop or disappear."""
        state = self._task_state_path(name)
        if not state.exists():
            return
        self.runner([_INCUS, "exec", name, "--project", self.config.project, "--",
                     "/usr/bin/python3", "/usr/local/lib/gc-incus-sandbox/task-launcher.py", "stop"])
        state.unlink(missing_ok=True)

    def stop(self, name: str) -> None:
        name = self._name(name)
        with state_lock(self.config.state_dir, name):
            self._require_owner(name)
            self._terminate_task(name)
            self._mutate("stop", name, [[_INCUS, "stop", name, "--project", self.config.project]], release=True)

    def delete(self, name: str, confirmation: str | None = None) -> None:
        name = self._name(name)
        if confirmation != name:
            raise UsageError("delete requires the exact sandbox name as confirmation")
        with state_lock(self.config.state_dir, name):
            self._require_owner(name)
            self._terminate_task(name)
            command = [_INCUS, "delete", name, "--force", "--project", self.config.project]
            self._mutate("delete", name, [command], release=True)
            self._forget(name)

    def attach(self, name: str) -> None:
        name = self._name(name)
        self._mutate("attach", name, [[_INCUS, "exec", name, "--project", self.config.project, "--",
                                        "/usr/bin/tmux", "-S", "/run/gc-sandbox-task/control",
                                        "attach-session", "-t", "gc-task"]])

    def list(self) -> None:
        self.events.ensure_available()
        self.runner([_INCUS, "list", "--project", self.config.project, "--format", "json"])
        self._emit("status", "success", None)

    def status(self, name: str) -> None:
        self._query(name, "status")

    def diagnose(self, name: str) -> None:
        self._query(name, "diagnose")

    def dispatch(self, action: str, name: str | None = None, confirmation: str | None = None) -> None:
        if action not in _ACTIONS:
            raise UsageError("unsupported lifecycle action")
        if action == "list":
            if name is not None:
                raise UsageError("list does not accept a sandbox name")
            self.list()
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
