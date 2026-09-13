"""The CPU admission policy.

Deliberately pure: it takes the host capacity, a snapshot of the shared ledger,
and the ticket asking to run, and returns the grant or ``None``. Keeping the
scheduling decision free of filesystem, lock, and process concerns is what lets a
future weighted-fair policy replace this module without touching persistence or
command execution (ADR-096).
"""

from __future__ import annotations

# One record in the shared ledger. Spelled out here so the policy, the store, and
# the tests all name the same shape.
LedgerEntry = dict[str, object]


def _effective(value: int, capacity: int) -> int:
    """Clamp a demand to the host's total capacity.

    A workload that asks for more CPU than the machine has is a configuration
    mismatch, not a deadlock: clamping lets it run alone on an otherwise idle
    host instead of queueing until the wait bound expires.
    """
    return max(1, min(int(value), capacity))


def _remaining_capacity(capacity: int, entries: list[LedgerEntry]) -> int:
    """Capacity left after every running grant is subtracted."""
    used = sum(int(entry.get("granted") or 0) for entry in entries if entry.get("state") == "running")
    return max(0, capacity - used)


def _queued_in_order(entries: list[LedgerEntry]) -> list[LedgerEntry]:
    """Queued entries oldest first, with the ticket breaking a sequence tie."""
    return sorted(
        (entry for entry in entries if entry.get("state") == "queued"),
        key=lambda entry: (int(entry["seq"]), str(entry["ticket"])),
    )


def plan_admission(capacity: int, entries: list[LedgerEntry], ticket: str) -> int | None:
    """Return the CPU grant for ``ticket``, or ``None`` while it must keep waiting.

    Admission is strict first-in-first-out by sequence number. Each queued entry
    ahead of the caller consumes what it would be granted, so cheaper work behind
    a satisfied request is backfilled from the remainder. The walk stops at the
    first entry that does not fit: letting later work jump a blocked head is what
    starves a large suite indefinitely on a busy host.
    """
    capacity = max(1, int(capacity))
    remaining = _remaining_capacity(capacity, entries)
    granted: int | None = None
    for entry in _queued_in_order(entries):
        minimum = _effective(entry["minimum"], capacity)
        if remaining < minimum:
            break
        grant = min(_effective(entry["requested"], capacity), remaining)
        if entry["ticket"] == ticket:
            granted = grant
            break
        remaining -= grant
    return granted
