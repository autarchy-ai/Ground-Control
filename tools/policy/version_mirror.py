"""Policy checks: Release Please version-mirror consistency.

Extracted from tools/policy/checks.py (issue #1355), which had reached 5,679 lines against
the repo's 500-LOC limit. checks.py remains the entry point and re-exports this module, so
every existing import path and the CLI keep working.

The first cut named each file for the section that began where the previous chunk ended, so
every name described a neighbour's contents. The modules are named for what they hold.
"""

from __future__ import annotations
import json
import re
from pathlib import Path
from typing import Any
from .core import (
    REPO_ROOT,
    Violation,
)


RELEASE_PLEASE_CONFIG = "release-please-config.json"


RELEASE_PLEASE_MANIFEST = ".release-please-manifest.json"


# The single Ground Control root component's key in both the config and the manifest.
RELEASE_PLEASE_ROOT_PACKAGE = "."


# release-please "generic" updater annotation (string-form extra-files), e.g.
#   version = "1.0.1" // x-release-please-version   (backend/build.gradle.kts)
_GENERIC_VERSION_ANNOTATION = "x-release-please-version"


_QUOTED_VERSION_RE = re.compile(r"""["'](\d+\.\d+\.\d+[0-9A-Za-z.\-+]*)["']""")
_SEMVER_RE = re.compile(
    r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


# Characters that terminate a plain (dot-navigated) JSONPath key segment.
_JSONPATH_DELIMS = ".["


class _ShortCircuit(Exception):
    """Internal signal carrying the single Violation a check should emit and stop.

    It lets the failure gates of a check raise instead of threading an error value
    back through every caller, which keeps each function within the return-count
    and complexity limits without changing the check's observable behaviour.
    """

    def __init__(self, violation: Violation) -> None:
        super().__init__(violation.message)
        self.violation = violation


def _scan_plain_key(text: str, start: int) -> int:
    """Return the index after a plain key beginning at ``start`` in ``text``.

    Scanning stops at the next JSONPath delimiter (``.`` or ``[``) or the end of
    the string.
    """
    j, n = start, len(text)
    while j < n and text[j] not in _JSONPATH_DELIMS:
        j += 1
    return j


def _parse_bracket_key(text: str, start: int) -> tuple[str, int] | None:
    """Parse a ``[...]`` segment at ``start``; return ``(key, next_index)`` or ``None``.

    A quoted inner value has its matching surrounding quotes stripped. Returns
    ``None`` when the closing bracket is absent.
    """
    close = text.find("]", start)
    if close == -1:
        return None
    inner = text[start + 1 : close].strip()
    if len(inner) >= 2 and inner[0] in "\"'" and inner[-1] == inner[0]:
        inner = inner[1:-1]
    return inner, close + 1


def _jsonpath_keys(jsonpath: str) -> list[str] | None:
    """Tokenize a minimal JSONPath into an ordered key list.

    Supports the forms release-please emits for JSON extra-files: ``$.version``,
    ``$.a.b``, and bracketed keys including the empty root-package key
    ``$.packages[''].version`` / ``$.packages[""].version``. Returns ``None`` for a
    path this resolver cannot parse.
    """
    s = jsonpath.strip()
    if s.startswith("$"):
        s = s[1:]
    keys: list[str] = []
    i, n = 0, len(s)
    while i < n:
        if s[i] == "[":
            parsed = _parse_bracket_key(s, i)
            if parsed is None:
                return None
            key, i = parsed
        else:
            start = i + 1 if s[i] == "." else i
            end = _scan_plain_key(s, start)
            if end == start:
                return None
            key, i = s[start:end], end
        keys.append(key)
    return keys or None


def _extract_json_version(data: object, jsonpath: str) -> str | None:
    """Return the string value at ``jsonpath`` inside parsed JSON ``data``.

    Returns ``None`` when the path cannot be parsed, the keys do not resolve to a
    value, or the resolved value is not a string.
    """
    keys = _jsonpath_keys(jsonpath)
    if keys is None:
        return None
    cur: object = data
    for key in keys:
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        else:
            return None
    return cur if isinstance(cur, str) else None


def _extract_generic_version(text: str) -> str | None:
    """Return the version from the first ``x-release-please-version`` annotated line.

    Returns ``None`` when no annotated line carries a quoted semantic version.
    """
    for line in text.splitlines():
        if _GENERIC_VERSION_ANNOTATION in line:
            match = _QUOTED_VERSION_RE.search(line)
            if match:
                return match.group(1)
    return None


def _drift(message: str, details: list[str] | None = None) -> Violation:
    """Build a ``version-mirror-drift`` Violation with optional detail lines."""
    return Violation(code="version-mirror-drift", message=message, details=details or [])


def _require_release_please_pair(config_path: Path, manifest_path: Path) -> None:
    """Raise ``_ShortCircuit`` when only one of the config/manifest pair is present."""
    if config_path.exists() and manifest_path.exists():
        return
    missing = RELEASE_PLEASE_CONFIG if not config_path.exists() else RELEASE_PLEASE_MANIFEST
    raise _ShortCircuit(
        Violation(
            code="version-mirror-config-missing",
            message=(
                "Release Please version management is partially configured: "
                f"{missing} is missing (config and manifest must ship together)."
            ),
            details=[],
        )
    )


def _parse_release_please_files(config_path: Path, manifest_path: Path) -> tuple[Any, Any]:
    """Return ``(manifest, config)`` parsed from JSON, raising on read/parse failure."""
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise _ShortCircuit(
            Violation(
                code="version-mirror-config-invalid",
                message="release-please config/manifest could not be parsed.",
                details=[str(exc)],
            )
        ) from exc
    return manifest, config


def _require_manifest_version(manifest: object) -> str:
    """Return the root-package version string, raising when it is absent or non-string."""
    manifest_version = (
        manifest.get(RELEASE_PLEASE_ROOT_PACKAGE) if isinstance(manifest, dict) else None
    )
    if not isinstance(manifest_version, str) or not _SEMVER_RE.fullmatch(manifest_version):
        raise _ShortCircuit(
            Violation(
                code="version-mirror-config-invalid",
                message=(
                    f"{RELEASE_PLEASE_MANIFEST} has no semantic version for the root "
                    f'package "{RELEASE_PLEASE_ROOT_PACKAGE}".'
                ),
                details=[],
            )
        )
    return manifest_version


def _load_version_mirror_context(root: Path) -> tuple[str | None, list[Any]]:
    """Load the manifest version and the declared mirror inventory.

    Returns ``(None, [])`` when Release Please is not adopted (nothing to enforce).
    Otherwise returns ``(manifest_version, extra_files)``. Raises ``_ShortCircuit``
    carrying a configuration Violation when the config/manifest pair is partial,
    unparseable, or missing a root-package version.
    """
    config_path = root / RELEASE_PLEASE_CONFIG
    manifest_path = root / RELEASE_PLEASE_MANIFEST

    # No Release Please adoption in this repo -> nothing to enforce.
    if not config_path.exists() and not manifest_path.exists():
        return None, []

    _require_release_please_pair(config_path, manifest_path)
    manifest, config = _parse_release_please_files(config_path, manifest_path)
    manifest_version = _require_manifest_version(manifest)
    packages = config.get("packages") if isinstance(config, dict) else None
    package = packages.get(RELEASE_PLEASE_ROOT_PACKAGE) if isinstance(packages, dict) else None
    if not isinstance(package, dict):
        raise _ShortCircuit(
            Violation(
                code="version-mirror-config-invalid",
                message=f'{RELEASE_PLEASE_CONFIG} has no root package "{RELEASE_PLEASE_ROOT_PACKAGE}".',
                details=[],
            )
        )
    extra_files = package.get("extra-files", [])
    if not isinstance(extra_files, list):
        raise _ShortCircuit(
            Violation(
                code="version-mirror-config-invalid",
                message="Release Please extra-files must be a list.",
                details=[],
            )
        )
    return manifest_version, extra_files


def _parse_extra_file_entry(entry: object) -> tuple[str, str | None, str]:
    """Return one validated Release Please extra-files entry."""
    if isinstance(entry, str):
        path, jsonpath, kind = entry, None, "generic"
    elif isinstance(entry, dict):
        path = entry.get("path")
        jsonpath = entry.get("jsonpath")
        kind = entry.get("type", "generic")
    else:
        path, jsonpath, kind = None, None, None
    if (
        not isinstance(path, str)
        or not path.strip()
        or (jsonpath is not None and not isinstance(jsonpath, str))
        or kind not in {"generic", "json"}
    ):
        raise _ShortCircuit(
            Violation(
                code="version-mirror-config-invalid",
                message="Release Please extra-files contains a malformed entry.",
                details=[repr(entry)],
            )
        )
    return path, jsonpath, kind


def _resolve_mirror_target(root: Path, path: str) -> Path:
    """Resolve a mirror path while refusing absolute and repository-escaping targets."""
    root_resolved = root.resolve()
    target = Path(path)
    try:
        resolved = (root_resolved / target).resolve()
        resolved.relative_to(root_resolved)
    except (OSError, ValueError) as exc:
        raise _ShortCircuit(
            Violation(
                code="version-mirror-config-invalid",
                message="Release Please mirror paths must stay inside the repository.",
                details=[path],
            )
        ) from exc
    if target.is_absolute():
        raise _ShortCircuit(
            Violation(
                code="version-mirror-config-invalid",
                message="Release Please mirror paths must be repository-relative.",
                details=[path],
            )
        )
    return resolved


def _read_mirror_text(target: Path, path: str) -> str:
    """Return a mirror file's text, raising ``_ShortCircuit`` when missing/unreadable."""
    if not target.exists():
        raise _ShortCircuit(_drift(f"Release Please version mirror is missing: {path}"))
    try:
        return target.read_text(encoding="utf-8")
    except OSError as exc:
        raise _ShortCircuit(_drift(f"cannot read version mirror {path}", [str(exc)])) from exc


def _extract_mirror_version(
    text: str, kind: str, jsonpath: str | None, path: str
) -> tuple[str | None, str]:
    """Return ``(found_version, label)`` for a mirror, raising on invalid JSON."""
    if kind == "json":
        resolved_path = jsonpath or "$.version"
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise _ShortCircuit(_drift(f"{path} is not valid JSON", [str(exc)])) from exc
        return _extract_json_version(data, resolved_path), f"{path} ({resolved_path})"
    return _extract_generic_version(text), f"{path} (x-release-please-version)"


def _version_drift_violations(
    found: str | None, label: str, manifest_version: str
) -> list[Violation]:
    """Return drift Violations comparing a mirror's version to the manifest version."""
    if found is None:
        return [
            _drift(
                f"could not read a product version from mirror {label}",
                [f"expected manifest version: {manifest_version}"],
            )
        ]
    if found != manifest_version:
        return [
            _drift(
                f"Product-version mirror {label} is {found}, but the Release "
                f"Please manifest ({RELEASE_PLEASE_MANIFEST}) says {manifest_version}. "
                "Mirrors are updated by the release PR; do not hand-edit them out of sync."
            )
        ]
    return []


def _version_mirror_entry_violations(
    entry: str | dict[str, object], root: Path, manifest_version: str
) -> list[Violation]:
    """Return the drift Violations (zero or one) for a single extra-files entry."""
    try:
        path, jsonpath, kind = _parse_extra_file_entry(entry)
        text = _read_mirror_text(_resolve_mirror_target(root, path), path)
        found, label = _extract_mirror_version(text, kind, jsonpath, path)
        return _version_drift_violations(found, label, manifest_version)
    except _ShortCircuit as exc:
        return [exc.violation]


def run_version_mirror_consistency_check(root: Path = REPO_ROOT) -> list[Violation]:
    """Fail when a product-version mirror drifts from the Release Please manifest.

    The set of mirrors is read from the release-please config's ``extra-files`` for
    the root package (the declarative inventory), so this check never carries its own
    hard-coded mirror list.
    """
    try:
        manifest_version, extra_files = _load_version_mirror_context(root)
    except _ShortCircuit as exc:
        return [exc.violation]

    if manifest_version is None:
        return []

    violations: list[Violation] = []
    for entry in extra_files:
        violations.extend(_version_mirror_entry_violations(entry, root, manifest_version))
    return violations
