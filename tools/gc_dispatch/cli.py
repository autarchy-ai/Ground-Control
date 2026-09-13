"""The `gc-test-dispatch` command line.

One parser, one normalized workload shape. A repository declares what its command
costs; the host decides when that cost fits. Nothing here inspects, rewrites, or
reasons about the command itself.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, NamedTuple

from .hostconfig import HostConfig, HostConfigError, load_host_config
from .ledger import Ledger, LedgerError, Ticket
from .supervisor import ChildResult, exit_like, run_command

EXIT_USAGE = 64
EXIT_INTERNAL = 70
EXIT_QUEUE_TIMEOUT = 75

PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
DEMAND_MIN = 1
DEMAND_MAX = 1024
XDIST_WORKER_ENV = "PYTEST_XDIST_AUTO_NUM_WORKERS"
METRICS_NAME = "metrics.jsonl"
METRICS_MAX_BYTES = 1_048_576
POLL_MIN_SECONDS = 0.02
POLL_MAX_SECONDS = 0.5

USAGE = (
    "usage: gc-test-dispatch --profile <name> [--cpu N] [--min-cpu N] [--xdist] "
    "-- <command> [args...]"
)
VALUE_OPTIONS = ("--profile", "--cpu", "--min-cpu")


class UsageError(ValueError):
    """A malformed invocation, refused before any work is registered."""


class Request(NamedTuple):
    """One workload's declared demand and the exact command to run."""

    profile: str
    requested: int
    minimum: int
    xdist: bool
    argv: list[str]


def _demand(option: str, raw: str) -> int:
    """Parse and bound one CPU demand value."""
    try:
        value = int(raw, 10)
    except ValueError:
        raise UsageError(f"{option} must be a whole number, got {raw!r}") from None
    if not DEMAND_MIN <= value <= DEMAND_MAX:
        raise UsageError(f"{option} must be between {DEMAND_MIN} and {DEMAND_MAX}, got {value}")
    return value


def _split_options(args: list[str]) -> tuple[list[str], list[str]]:
    """Separate dispatcher options from the command that follows ``--``."""
    if "--" not in args:
        raise UsageError("the command to run must follow '--'")
    separator = args.index("--")
    command = args[separator + 1:]
    if not command:
        raise UsageError("no command was given after '--'")
    return args[:separator], command


def _consume_option(options: list[str], index: int, values: dict[str, str]) -> int:
    """Read one option at ``index``, returning the next index to read."""
    option = options[index]
    name, _, inline = option.partition("=")
    if name not in VALUE_OPTIONS:
        raise UsageError(f"unknown option {option!r}")
    if inline:
        values[name] = inline
        return index + 1
    if index + 1 >= len(options):
        raise UsageError(f"{name} needs a value")
    values[name] = options[index + 1]
    return index + 2


def _parse_options(options: list[str]) -> tuple[dict[str, str], bool]:
    """Collect the option values and the xdist opt-in."""
    values: dict[str, str] = {}
    xdist = False
    index = 0
    while index < len(options):
        name, _, inline = options[index].partition("=")
        if name == "--xdist":
            if inline:
                raise UsageError("--xdist takes no value")
            xdist = True
            index += 1
        else:
            index = _consume_option(options, index, values)
    return values, xdist


def parse_args(args: list[str]) -> Request:
    """Turn an argument vector into one validated workload request."""
    options, command = _split_options(list(args))
    values, xdist = _parse_options(options)

    profile = values.get("--profile")
    if profile is None:
        raise UsageError("--profile is required")
    if not PROFILE_RE.match(profile):
        raise UsageError(
            f"--profile must match {PROFILE_RE.pattern} (lowercase, no spaces), got {profile!r}")

    requested = _demand("--cpu", values["--cpu"]) if "--cpu" in values else 1
    minimum = _demand("--min-cpu", values["--min-cpu"]) if "--min-cpu" in values else requested
    if minimum > requested:
        raise UsageError(f"--min-cpu ({minimum}) cannot exceed --cpu ({requested})")
    return Request(profile=profile, requested=requested, minimum=minimum, xdist=xdist, argv=command)


def milliseconds(seconds: float) -> int:
    """Round a duration to whole milliseconds, never below zero."""
    return max(0, int(round(seconds * 1000)))


def _append_metric(path: Path, record: dict[str, Any]) -> None:
    """Append one bounded JSON line, restarting the file when it grows too large."""
    if path.exists() and path.stat().st_size > METRICS_MAX_BYTES:
        path.unlink()
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")


def report(state_dir: Path, record: dict[str, Any]) -> None:
    """Emit the bounded operational record for one dispatch.

    Local diagnostics only: never an issue-thread record, never step telemetry,
    and never a cache anything may read back as a result.
    """
    summary = " ".join(f"{key}={value}" for key, value in record.items() if value is not None)
    print(f"gc-test-dispatch: {summary}", file=sys.stderr)
    try:
        _append_metric(state_dir / METRICS_NAME, record)
    except OSError:
        # Measurement must never be the reason a verification command fails.
        pass


def _wait_for_admission(
    ledger: Ledger, ticket: Ticket, capacity: int, wait_seconds: float,
) -> int | None:
    """Poll for a grant until one arrives or the host's queue bound expires."""
    deadline = time.monotonic() + wait_seconds
    delay = POLL_MIN_SECONDS
    granted = ledger.try_admit(ticket, capacity)
    while granted is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        time.sleep(min(delay, remaining))
        delay = min(delay * 2, POLL_MAX_SECONDS)
        granted = ledger.try_admit(ticket, capacity)
    return granted


def _child_environment(request: Request, granted: int) -> dict[str, str]:
    """Return the command's environment, adding only the opted-in worker count."""
    env = dict(os.environ)
    if request.xdist:
        env[XDIST_WORKER_ENV] = str(granted)
    return env


def _new_record(request: Request, config: HostConfig) -> dict[str, Any]:
    """Seed the measurement record with everything known before admission."""
    return {
        "profile": request.profile,
        "requested": request.requested,
        "minimum": request.minimum,
        "granted": None,
        "capacity": config.cpu_capacity,
        "queue_ms": 0,
        "exec_ms": 0,
        "outcome": "queue_timeout",
        "exit_code": None,
        "term_signal": None,
    }


def _run_admitted(
    request: Request, ticket: Ticket, granted: int, record: dict[str, Any],
) -> ChildResult:
    """Run the command on its grant and fold the outcome into the record."""
    record["granted"] = granted
    started_at = time.monotonic()
    result = run_command(request.argv, _child_environment(request, granted), ticket.lease_fd)
    record["exec_ms"] = milliseconds(time.monotonic() - started_at)
    record["outcome"] = "ran"
    record["exit_code"] = result.exit_code
    record["term_signal"] = result.term_signal
    return result


def _dispatch(request: Request, config: HostConfig, ledger: Ledger) -> ChildResult | int:
    """Queue for capacity, run the command once admitted, and always release."""
    queued_at = time.monotonic()
    ticket = ledger.enqueue(request.profile, request.requested, request.minimum)
    record = _new_record(request, config)
    try:
        granted = _wait_for_admission(
            ledger, ticket, config.cpu_capacity, config.max_queue_wait_seconds)
        record["queue_ms"] = milliseconds(time.monotonic() - queued_at)
        if granted is None:
            return EXIT_QUEUE_TIMEOUT
        return _run_admitted(request, ticket, granted, record)
    except LedgerError as exc:
        record["outcome"] = "state_error"
        print(f"gc-test-dispatch: {exc}", file=sys.stderr)
        return EXIT_INTERNAL
    finally:
        ledger.release(ticket)
        report(config.state_dir, record)


def main(argv: list[str]) -> int:
    """Parse, admit, run, and return the status the caller should exit with."""
    try:
        request = parse_args(argv)
    except UsageError as exc:
        print(f"gc-test-dispatch: {exc}\n{USAGE}", file=sys.stderr)
        return EXIT_USAGE
    try:
        config = load_host_config()
        ledger = Ledger(config.state_dir, config.stale_lease_seconds)
    except (HostConfigError, LedgerError) as exc:
        print(f"gc-test-dispatch: {exc}", file=sys.stderr)
        return EXIT_INTERNAL
    outcome = _dispatch(request, config, ledger)
    if isinstance(outcome, ChildResult):
        exit_like(outcome)
    return outcome
