"""Complete, crash-safe replacement of the sandbox's root-owned state files."""

from __future__ import annotations

import contextlib
import errno
import fcntl
import os
import secrets
from collections.abc import Iterator
from pathlib import Path


def write_all(descriptor: int, data: bytes) -> None:
    """Write every byte, looping over short writes; a write that makes no progress fails."""
    view = memoryview(data)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError(errno.EIO, "write made no progress")
        view = view[written:]


def _fsync_directory(directory: Path) -> None:
    """Persist a rename by syncing the directory entry that names the file."""
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def replace_file(path: Path, data: bytes, mode: int) -> None:
    """Atomically replace `path` with `data`; an interruption leaves the previous file whole.

    The content goes to a private same-directory temporary file that is completely written
    and synced before it is renamed over the target, then the rename itself is synced.
    """
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        try:
            write_all(descriptor, data)
            os.fchmod(descriptor, mode)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    _fsync_directory(path.parent)


def acquire_lock(path: Path) -> int:
    """Take an exclusive lock on a stable lock file that is never itself replaced."""
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def release_lock(descriptor: int) -> None:
    """Release a lock taken by `acquire_lock`."""
    fcntl.flock(descriptor, fcntl.LOCK_UN)
    os.close(descriptor)


@contextlib.contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    """Hold `acquire_lock` for the duration of a block."""
    descriptor = acquire_lock(path)
    try:
        yield
    finally:
        release_lock(descriptor)
