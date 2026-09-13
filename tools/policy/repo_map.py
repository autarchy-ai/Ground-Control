"""Policy check: README repository-map freshness (issue #543, ADR-095, GC-P029).

The root ``README.md`` carries a "Repository map" section so a contributor can see
where each top-level directory of the repo belongs. A navigation doc nothing
enforces drifts: a new top-level directory is added and never listed, or a listed
directory is removed and the row lingers. This check keeps the map honest, the same
shrink-only discipline the file-size gate (GC-P028) applies to its grandfather list.

It is deliberately dependency-free and enforces four things over the map section:

- every tracked top-level directory (not in the exclusion set) is listed;
- every directory the map lists is a real tracked top-level directory;
- every excluded directory still exists (the exclusion set can only shrink);
- every repo-relative Markdown link in the section resolves on disk (the repo has
  no automated Markdown link checker, so the map's links are verified here).
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .core import REPO_ROOT, Violation

README_PATH = REPO_ROOT / "README.md"

# Heading text (case-insensitive) that introduces the map section.
MAP_HEADING = "repository map"

# Top-level directories intentionally omitted from the contributor map, each with a
# reason. These are agent/editor/lint tooling configuration, not a source surface a
# contributor navigates. `.github` is deliberately NOT here: CI, templates, and
# CODEOWNERS are contributor-relevant, so the map must document it.
MAP_EXCLUDED_DIRS: dict[str, str] = {
    ".claude": "Claude Code runtime adapter/config, not a source surface",
    ".cursor": "Cursor runtime adapter/config, not a source surface",
    ".gc": "Ground Control local run config and artifacts, tooling not source",
    ".serena": "Serena code-index tool config",
    ".vale": "Vale prose-lint styles",
}

SECTION_CODE = "repo-map-section"
DRIFT_CODE = "repo-map-drift"
LINK_CODE = "repo-map-broken-link"

_INLINE_CODE = re.compile(r"`([^`]+)`")
_MARKDOWN_LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
_TOP_LEVEL_DIR_TOKEN = re.compile(r"^[A-Za-z0-9._-]+/$")
_URL_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)


def _extract_section(text: str, heading: str) -> str | None:
    """Return the body under the ``## <heading>`` section, or None when absent.

    The section runs from the heading to the next level-1 or level-2 heading, so a
    nested ``###`` subheading stays inside it.
    """
    lines = text.splitlines()
    start: int | None = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("## ") and stripped[3:].strip().lower() == heading:
            start = index + 1
            break
    if start is None:
        return None
    body: list[str] = []
    for line in lines[start:]:
        if re.match(r"^#{1,2} ", line):
            break
        body.append(line)
    return "\n".join(body)


def _documented_dirs(section: str) -> set[str]:
    """Top-level directory names the section lists as inline-code ``name/`` tokens."""
    names: set[str] = set()
    for token in _INLINE_CODE.findall(section):
        if _TOP_LEVEL_DIR_TOKEN.match(token):
            names.add(token[:-1])
    return names


def _relative_link_targets(section: str) -> list[str]:
    """Repo-relative Markdown link targets in the section (skips URLs and anchors)."""
    targets: list[str] = []
    for raw in _MARKDOWN_LINK.findall(section):
        target = raw.strip()
        # Drop any #fragment / ?query so the on-disk path is what remains.
        target = target.split("#", 1)[0].split("?", 1)[0]
        if not target or _URL_SCHEME.match(target):
            continue
        targets.append(target)
    return targets


def _git_top_level_dirs(repo_root: Path) -> set[str]:
    """Tracked top-level directories: the first path segment of each tracked file."""
    result = subprocess.run(
        ["git", "-C", str(repo_root), "ls-files"],
        check=True,
        capture_output=True,
        text=True,
    )
    dirs: set[str] = set()
    for path in result.stdout.splitlines():
        head, sep, _ = path.partition("/")
        if sep:
            dirs.add(head)
    return dirs


def _coverage_violations(
    actual: set[str], documented: set[str], exclusions: dict[str, str]
) -> list[Violation]:
    """Two-sided directory drift: required-but-undocumented and documented-but-absent."""
    violations = [
        Violation(
            DRIFT_CODE,
            f"top-level directory `{name}/` is not listed in the README Repository map",
        )
        for name in sorted(actual)
        if name not in exclusions and name not in documented
    ]
    violations.extend(
        Violation(
            DRIFT_CODE,
            f"Repository map lists `{name}/`, which is not a tracked top-level directory",
        )
        for name in sorted(documented)
        if name not in actual
    )
    return violations


def _stale_exclusion_violations(exclusions: dict[str, str], actual: set[str]) -> list[Violation]:
    """Excluded directories that no longer exist (the exclusion set is shrink-only)."""
    return [
        Violation(
            DRIFT_CODE,
            f"excluded directory `{name}/` no longer exists; remove it from "
            "MAP_EXCLUDED_DIRS in tools/policy/repo_map.py",
        )
        for name in sorted(exclusions)
        if name not in actual
    ]


def _broken_link_violations(section: str, root: Path) -> list[Violation]:
    """Repo-relative Markdown links in the section that do not resolve on disk."""
    return [
        Violation(LINK_CODE, f"Repository map links to `{target}`, which does not exist")
        for target in _relative_link_targets(section)
        if not (root / target).exists()
    ]


def run_repository_map_freshness_check(
    readme_path: Path | None = None,
    repo_root: Path | None = None,
    top_level_dirs: set[str] | None = None,
    excluded: dict[str, str] | None = None,
) -> list[Violation]:
    """Enforce that the README "Repository map" section matches the repository.

    Reports a violation when a tracked top-level directory is undocumented, a
    documented directory is not tracked, an excluded directory has disappeared, or a
    repo-relative link in the section does not resolve. See ADR-095 / GC-P029.
    """
    readme = readme_path if readme_path is not None else README_PATH
    root = repo_root if repo_root is not None else REPO_ROOT
    exclusions = excluded if excluded is not None else MAP_EXCLUDED_DIRS

    try:
        text = readme.read_text(encoding="utf-8")
    except OSError:
        return [Violation(SECTION_CODE, f"{readme.name} is missing or unreadable")]

    section = _extract_section(text, MAP_HEADING)
    if section is None:
        return [
            Violation(
                SECTION_CODE,
                f"{readme.name} has no '## Repository map' section (issue #543 / GC-P029)",
            )
        ]

    actual = set(top_level_dirs) if top_level_dirs is not None else _git_top_level_dirs(root)
    documented = _documented_dirs(section)

    return [
        *_coverage_violations(actual, documented, exclusions),
        *_stale_exclusion_violations(exclusions, actual),
        *_broken_link_violations(section, root),
    ]
