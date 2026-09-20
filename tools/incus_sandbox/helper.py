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
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from config import SandboxConfig, load_config
    from events import EventWriter


class UsageError(RuntimeError):
    """The caller requested a lifecycle action outside the closed vocabulary."""


class AdmissionError(RuntimeError):
    """Host capacity facts do not safely admit a VM operation."""


_NAME = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
_ACTIONS = {"create", "list", "attach", "stop", "start", "delete", "status", "diagnose"}
_INCUS = "/usr/bin/incus"
_IP = "/usr/sbin/ip"
_INVALID_ALLOCATION = "allocation state is invalid"


def _run(argv: list[str]) -> dict[str, int]:
    """Run one already-allowlisted executable argument vector."""
    completed = subprocess.run(argv, check=True, stdin=None, stdout=None, stderr=None)
    return {"returncode": completed.returncode}


def _observation() -> dict[str, int | bool]:
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


def _network_policy_fresh(config: SandboxConfig) -> bool:
    """A changed host address set invalidates starts until setup refreshes nft sets."""
    stamp = config.state_dir / "network-addresses.sha256"
    try:
        expected = stamp.read_text(encoding="ascii").strip()
        addresses = subprocess.check_output([_IP, "-o", "-4", "addr", "show"], text=True)
    except (OSError, subprocess.SubprocessError):
        return False
    return expected == hashlib.sha256(addresses.encode("utf-8")).hexdigest()


def _positive_fact(value: object) -> int | None:
    """Return a non-negative integer observation, otherwise no fact."""
    return value if isinstance(value, int) and value >= 0 else None


def _guest_usage(info: object) -> tuple[int | None, int | None, int | None]:
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
    return _positive_fact(cpu.get("usage")), _positive_fact(memory.get("usage")), _positive_fact(root.get("usage"))


def _query_payload(stdout: str) -> dict[str, object] | None:
    """Unwrap Incus' synchronous-query envelope without exposing raw JSON."""
    try:
        response = json.loads(stdout)
    except ValueError:
        return None
    if not isinstance(response, dict):
        return None
    payload = response.get("metadata")
    return payload if isinstance(payload, dict) else response


def _status_state(info: object, observed: dict[str, int | bool]) -> tuple[bool, str]:
    """Normalize daemon status only when the independent host facts are fresh."""
    if not isinstance(info, dict) or observed.get("fresh") is not True:
        return False, "unavailable"
    status = info.get("status", "unavailable")
    if not isinstance(status, str) or len(status) > 32:
        return False, "unavailable"
    return True, status.lower()


def _observed_facts(observed: dict[str, int | bool], info: object, available: bool) -> dict[str, object]:
    """Return the stable observed-facts subdocument without raw daemon JSON."""
    cpu_usage, memory_usage, disk_usage = _guest_usage(info if available else None)
    memory = _positive_fact(observed.get("memory_mib")) if available else None
    disk = _positive_fact(observed.get("disk_gib")) if available else None
    return {
        "availability": "fresh" if available else "unavailable", "memory_mib": memory,
        "disk_gib": disk, "cpu_usage_ns": cpu_usage,
        "guest_memory_mib": memory_usage // (1024 * 1024) if memory_usage is not None else None,
        "guest_disk_gib": disk_usage // (1024 ** 3) if disk_usage is not None else None,
    }


class LifecycleHelper(object):
    """Validates caller intent, reserves capacity, then emits only fixed Incus argv."""

    def __init__(self, config: SandboxConfig, *, runner: Callable[[list[str]], object] = _run,
                 event_writer: EventWriter, observer: Callable[[], dict[str, int | bool]] = _observation,
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
        if _positive_fact(observed.get("memory_mib")) is None:
            raise AdmissionError("host observations are unavailable")
        if _positive_fact(observed.get("disk_gib")) is None:
            raise AdmissionError("host observations are unavailable")
        if not self.network_checker(self.config):
            raise AdmissionError("network policy observations are stale")
        return observed

    def _has_headroom(self, observed: dict[str, int | bool]) -> bool:
        """Check host reserves before taking the allocation lock."""
        memory = _positive_fact(observed.get("memory_mib"))
        disk = _positive_fact(observed.get("disk_gib"))
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

    def _admit(self, name: str) -> tuple[int, dict[str, dict[str, int]], dict[str, int | bool]]:
        """Reserve capacity for a caller after fresh local admission checks."""
        observed = self._admission_observation()
        if not self._has_headroom(observed):
            raise AdmissionError("host headroom is insufficient")
        fd, records = self._locked_allocations()
        if name in records and records[name]["active"]:
            self._unlock(fd)
            raise AdmissionError("sandbox is already reserved")
        if not self._aggregate_fits(records):
            self._unlock(fd)
            raise AdmissionError("aggregate allocation is insufficient")
        if self.caller_uid != self.config.operator_uid:
            self._unlock(fd)
            raise UsageError("caller is not the configured sandbox operator")
        records[name] = {"cpu": self.config.vm.cpu, "memory_mib": self.config.vm.memory_mib,
                         "disk_gib": self.config.vm.disk_gib, "owner_uid": self.caller_uid, "active": True}
        return fd, records, observed

    def _require_owner(self, name: str) -> None:
        if self.caller_uid != self.config.operator_uid:
            raise UsageError("caller is not the configured sandbox operator")
        fd, records = self._locked_allocations()
        try:
            record = records.get(name)
            if record is None or record["owner_uid"] != self.caller_uid:
                raise UsageError("sandbox is not owned by this operator")
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
        available, status = _status_state(incus_info, observed)
        return {
            "schema": "gc.incus-sandbox.status/v1",
            "sandbox_id": name,
            "desired_state": "running" if name in self._allocation_names() else "stopped",
            "observed_state": status,
            "assigned": {"cpu": self.config.vm.cpu, "memory_mib": self.config.vm.memory_mib,
                         "disk_gib": self.config.vm.disk_gib},
            "observed": _observed_facts(observed, incus_info, available),
            "admission_headroom": self._headroom(),
            "last_transition": "unavailable",
            "failure_reason": "none" if available else "observation_unavailable",
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
            info = _query_payload(completed.stdout)
            if isinstance(info, dict):
                state_path = f"/1.0/instances/{name}/state?project={self.config.project}"
                state = subprocess.run([_INCUS, "query", state_path, "--raw"],
                                       check=True, text=True, capture_output=True)
                info["state"] = _query_payload(state.stdout)
            report = self.normalized_observation(name, info)
            print(json.dumps(report, separators=(",", ":")))
            self._emit(action, "success", name, started=started, observed=self.observer())
        except Exception:
            self._emit(action, "failure", name, error_code="command_failed", started=started)
            raise

    def _reservation(
        self, name: str, reserve: bool,
    ) -> tuple[int | None, dict[str, dict[str, int]] | None, dict[str, int | bool] | None]:
        """Authorize an existing VM or hold capacity for a new one."""
        if not reserve:
            self._require_owner(name)
            return None, None, None
        descriptor, records, observed = self._admit(name)
        self._save_allocations(descriptor, records)
        return descriptor, records, observed

    def _run_commands(self, commands: list[list[str]]) -> None:
        """Run the already constructed fixed lifecycle command sequence."""
        for argv in commands:
            self.runner(argv)

    def _rollback_create(self, name: str, descriptor: int | None, records: dict[str, dict[str, int]] | None) -> None:
        """Release a failed create reservation and request Incus cleanup."""
        if descriptor is None:
            return
        if records is not None:
            records.pop(name, None)
            self._save_allocations(descriptor, records)
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
                release: bool = False) -> None:
        name = self._name(name)
        started = time.monotonic()
        self.events.ensure_available()
        descriptor: int | None = None
        records: dict[str, dict[str, int]] | None = None
        observed: dict[str, int | bool] | None = None
        try:
            descriptor, records, observed = self._reservation(name, reserve)
            self._run_commands(commands)
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
            if action == "create":
                self._rollback_create(name, descriptor, records)
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
        self._mutate("create", name, commands, reserve=True)
        self._emit("boot", "success", name)

    def start(self, name: str) -> None:
        name = self._name(name)
        self._mutate("start", name, [[_INCUS, "start", name, "--project", self.config.project]], reserve=True)

    def stop(self, name: str) -> None:
        name = self._name(name)
        self._mutate("stop", name, [[_INCUS, "stop", name, "--project", self.config.project]], release=True)

    def delete(self, name: str) -> None:
        name = self._name(name)
        command = [_INCUS, "delete", name, "--force", "--project", self.config.project]
        self._mutate("delete", name, [command], release=True)
        self._forget(name)

    def attach(self, name: str) -> None:
        name = self._name(name)
        self._mutate("attach", name, [[_INCUS, "exec", name, "--project", self.config.project, "--",
                                        "su", "-", "sandbox", "-c", "exec tmux new-session -A -s coding"]])

    def list(self) -> None:
        self.events.ensure_available()
        self.runner([_INCUS, "list", "--project", self.config.project, "--format", "json"])
        self._emit("status", "success", None)

    def status(self, name: str) -> None:
        self._query(name, "status")

    def diagnose(self, name: str) -> None:
        self._query(name, "diagnose")

    def dispatch(self, action: str, name: str | None = None) -> None:
        if action not in _ACTIONS:
            raise UsageError("unsupported lifecycle action")
        if action == "list":
            if name is not None:
                raise UsageError("list does not accept a sandbox name")
            self.list()
            return
        if name is None:
            raise UsageError("lifecycle action requires a sandbox name")
        getattr(self, action)(name)


def main(argv: list[str]) -> int:
    """Run the fixed root helper entry point invoked by its sudo rule."""
    if os.geteuid() != 0:
        raise UsageError("the helper must run as root through its fixed sudo rule")
    if len(argv) not in (2, 3):
        raise UsageError("usage: gc-incus-helper ACTION [SANDBOX]")
    config_path = Path("/etc/gc-incus-sandbox/config.json")
    config = load_config(config_path)
    sudo_uid = os.environ.get("SUDO_UID")
    if sudo_uid is None or not sudo_uid.isdecimal():
        raise UsageError("the helper requires sudo to preserve the calling operator identity")
    helper = LifecycleHelper(config, event_writer=EventWriter(config.event_log, config.event_max_bytes),
                             caller_uid=int(sudo_uid))
    helper.dispatch(argv[1], argv[2] if len(argv) == 3 else None)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except (UsageError, AdmissionError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
