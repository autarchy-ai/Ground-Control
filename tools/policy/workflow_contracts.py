
import ast
import re

from pathlib import Path

from .core import REPO_ROOT, Violation, require_scanned


# ---------------------------------------------------------------------------
# Scan-floor contract (issue #1355)
# ---------------------------------------------------------------------------
#
# A test that regexes a source file and asserts over the result passes identically when the
# extraction matched nothing: the assertion becomes vacuous and the suite reports green because
# it found nothing to check. Four separate gates failed exactly this way during the #1355 split,
# each because its subject had moved. Bounding the extracted collection is what distinguishes
# "scanned and clean" from "never looked", so it is required rather than conventional.

SCAN_EXTRACTORS = ("findall", "finditer")

# Only assertions that actually fail on an empty extraction. assertNotEqual is deliberately
# absent: assertNotEqual(len(found), 5) passes when the scan matched nothing, which is the very
# hole this contract exists to close.
SCAN_FLOOR_ASSERTIONS = ("assertGreaterEqual", "assertGreater", "assertTrue")


def _reads_repo_source(node: ast.AST) -> bool:
    return any(isinstance(n, ast.Attribute) and n.attr == "read_text" for n in ast.walk(node))


def _extracts_collection(node: ast.AST) -> bool:
    return any(
        isinstance(n, ast.Attribute) and n.attr in SCAN_EXTRACTORS for n in ast.walk(node)
    ) or any(
        isinstance(n, ast.Call)
        and isinstance(n.func, ast.Name)
        and n.func.id in {"findall", "finditer"}
        for n in ast.walk(node)
    )


def _extracted_names(node: ast.AST) -> set[str]:
    """Names assigned from an extraction, so a bound on them counts as bounding the scan."""
    names: set[str] = set()
    for assign in ast.walk(node):
        if not isinstance(assign, ast.Assign):
            continue
        produces = any(
            isinstance(n, ast.Attribute) and n.attr in SCAN_EXTRACTORS for n in ast.walk(assign.value)
        ) or any(isinstance(n, (ast.ListComp, ast.SetComp, ast.GeneratorExp)) for n in ast.walk(assign.value))
        if not produces:
            continue
        for target in assign.targets:
            for n in ast.walk(target):
                if isinstance(n, ast.Name):
                    names.add(n.id)
    return names


def _bounds_extraction(node: ast.AST) -> bool:
    """Does the method prove its extraction found something?

    Deliberately accepts any spelling that fails on an empty extraction: a `len()` floor, a
    truthiness assertion on the extracted collection, or a membership assertion against it.
    Demanding one form would push tests toward a shape their author did not mean, which is a
    worse outcome than the bug this closes.
    """
    extracted = _extracted_names(node)
    for call in ast.walk(node):
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)):
            continue
        attr = call.func.attr
        if attr in SCAN_FLOOR_ASSERTIONS and any(
            isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name) and inner.func.id == "len"
            for arg in call.args
            for inner in ast.walk(arg)
        ):
            return True
        # assertTrue(collection) / assertIn(x, collection) both fail when the scan found nothing.
        if attr in {"assertTrue", "assertIn", "assertCountEqual"} and any(
            isinstance(inner, ast.Name) and inner.id in extracted
            for arg in call.args
            for inner in ast.walk(arg)
        ):
            return True
    return False


def run_scan_floor_contract(root: Path = REPO_ROOT) -> list[Violation]:
    """Every source-scanning test must prove its extraction found something.

    Scoped to tests that both read a source file and build a collection from it by regex. A test
    that reads a fixture it just wrote, or asserts on a parsed JSON document, is not in scope:
    those fail loudly when their subject is missing.
    """
    tests_dir = root / "tools" / "tests"
    if not tests_dir.is_dir():
        return []

    offenders: list[str] = []
    scanned = 0
    for path in sorted(tests_dir.glob("test_*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        scanned += 1
        for cls in [n for n in tree.body if isinstance(n, ast.ClassDef)]:
            for method in cls.body:
                if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                if not method.name.startswith("test_"):
                    continue
                if not (_reads_repo_source(method) and _extracts_collection(method)):
                    continue
                if _bounds_extraction(method):
                    continue
                offenders.append(f"{path.relative_to(root).as_posix()}::{cls.name}::{method.name}")

    violations = require_scanned("scan-floor contract", scanned)
    if violations:
        return violations
    if not offenders:
        return []
    return [
        Violation(
            code="scan-without-floor",
            message=(
                "A test scans source and asserts over the result without bounding what it "
                "extracted, so it passes identically when the extraction matches nothing."
            ),
            details=sorted(offenders),
        )
    ]


# The documentation-coverage catalogue maps repository paths to the docs that must move with them
# (ADR-054). Its anchors are literal paths, so a file that moves takes its coverage requirement with
# it: the surface keeps matching the old path, matches nothing, and the gate stops asking. It goes
# green for the reason hardest to notice. Both checks below make that failure loud instead.
_SURFACE_CATALOGUE = Path("mcp") / "ground-control" / "lib" / "doc-coverage.js"
_EXACT_PATTERNS_RE = re.compile(r"exact_patterns:\s*\[(.*?)\]", re.DOTALL)
_PREFIX_PATTERNS_RE = re.compile(r"prefix_patterns:\s*\[(.*?)\]", re.DOTALL)
_QUOTED_RE = re.compile(r'"([^"]+)"')


def run_doc_coverage_anchor_contract(root: Path = REPO_ROOT) -> list[Violation]:
    """Every documentation-coverage surface anchor must name something that exists."""
    catalogue = root / _SURFACE_CATALOGUE
    if not catalogue.is_file():
        return [
            Violation(
                code="doc-coverage-catalogue-missing",
                message=(
                    "The documentation-coverage surface catalogue is absent, so no surface can be "
                    "verified. Update this check to its new home rather than leaving it inert."
                ),
                details=[_SURFACE_CATALOGUE.as_posix()],
            )
        ]

    source = catalogue.read_text(encoding="utf-8")
    dangling: list[str] = []
    anchors = 0
    for match in _EXACT_PATTERNS_RE.finditer(source):
        for anchor in _QUOTED_RE.findall(match.group(1)):
            anchors += 1
            if not (root / anchor).is_file():
                dangling.append(f"exact_patterns: {anchor}")
    for match in _PREFIX_PATTERNS_RE.finditer(source):
        for anchor in _QUOTED_RE.findall(match.group(1)):
            anchors += 1
            target = root / anchor
            # A prefix names either a directory or a file stem such as `bin/policy`.
            if not target.is_dir() and not target.is_file():
                dangling.append(f"prefix_patterns: {anchor}")

    violations = require_scanned("doc-coverage surface anchors", anchors)
    if violations:
        return violations
    if not dangling:
        return []
    return [
        Violation(
            code="doc-coverage-anchor-dangling",
            message=(
                "A documentation-coverage surface anchors on a path that no longer exists, so it "
                "matches nothing and silently stops requiring documentation for that surface."
            ),
            details=sorted(dangling),
        )
    ]
