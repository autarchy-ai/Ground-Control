"""Read live GitHub branch protection and report drift from the versioned baseline.

`.github/branch-protection-baseline.json` declares what the repository's protected
branches are supposed to enforce. `tools/policy/ci_strictness.py` checks that
declaration against the workflow files, which is a comparison between two files in
the repository; nothing checked it against what GitHub actually enforces. Issue
#1155 found that gap already open: live `main` carried
`required_status_checks.strict: false` while the baseline declared `strict: true`,
and live `dev` allowed force pushes against the documented intent (GC-P031).

Usage:
    make branch-protection-check
    python3 -m tools.ci.check_branch_protection --json

Exit codes are three-valued: 0 when live protection matches the declaration, 1 on
drift, and 2 when any branch could not be evaluated. Collapsing the third into
either of the others is how a check reports a verdict it never measured.

Reading branch protection needs repository administration permission, which is not
a grantable GitHub Actions `permissions:` scope, so this cannot run on the CI
`policy` job's token and is deliberately not part of `make policy`. It is an
explicitly invoked gate that always enforces when run, rather than a merge gate
that would have to skip silently when the read is unauthorized.

This module is the IO boundary: the comparison itself lives in
`branch_protection_compare.py`. It never writes. Reconciling live protection is a
repository-admin operation on GitHub's narrow required-status-checks endpoint, and a
repeatable administration capability would need its own authorization contract
rather than a write mode here.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

from tools.policy.branch_protection_baseline import (
    CI_STRICTNESS_BRANCHES,
    BranchProtectionBaselineError,
    load_branch_protection_baseline,
)
from tools.policy.repo_identity import CANONICAL_REPO_SLUG

from .branch_protection_compare import (
    ProtectionReport,
    Unevaluable,
    compare_protection,
    render_markdown,
    report_for_invalid_baseline,
)

# The repository whose protection this compares. Bound to the canonical identity
# rather than offered as an option: the credential that can read branch protection
# can read it for every repository the operator administers, so a caller-supplied
# or environment-supplied target would let the check compare this repository's
# declaration against some other repository's protection and report a verdict.
TARGET_REPO = CANONICAL_REPO_SLUG

GH_HOSTNAME = "github.com"

# A read that never returns would hang the gate open rather than failing it.
GH_TIMEOUT_SECONDS = 30


def build_protection_read_args(branch: str) -> list[str]:
    """The argv for one branch's protection read.

    Host and repository are fixed here rather than inherited from `GH_HOST` /
    `GH_REPO`, so an ambient environment cannot redirect an administration-capable
    credential at a different target. No token is passed: `gh` uses the operator's
    own stored credential, and a secret in argv would be visible to every process
    on the host.
    """
    return [
        "gh",
        "api",
        "--hostname",
        GH_HOSTNAME,
        f"repos/{TARGET_REPO}/branches/{branch}/protection",
    ]


def collect_live_protection(
    branches: tuple[str, ...] = CI_STRICTNESS_BRANCHES,
) -> dict[str, object]:
    """Fetch each protected branch's live protection document through `gh`.

    A branch whose protection cannot be read maps to an `Unevaluable` naming why,
    never to an empty document: an empty document would compare as a branch that
    enforces nothing and report drift on every field.
    """
    live: dict[str, object] = {}
    for branch in branches:
        try:
            payload = subprocess.run(
                build_protection_read_args(branch),
                capture_output=True,
                text=True,
                check=True,
                shell=False,
                timeout=GH_TIMEOUT_SECONDS,
            ).stdout
            live[branch] = json.loads(payload)
        except subprocess.TimeoutExpired:
            live[branch] = Unevaluable(
                branch, "live_read_timed_out", f"gh did not respond within {GH_TIMEOUT_SECONDS}s"
            )
        except FileNotFoundError:
            live[branch] = Unevaluable(branch, "gh_unavailable", "the gh executable was not found")
        except subprocess.CalledProcessError as error:
            # Most often a credential without administration:read on this
            # repository, which is a different fact from "protection is absent".
            live[branch] = Unevaluable(
                branch, "live_read_failed", f"gh exited {error.returncode}"
            )
        except json.JSONDecodeError:
            live[branch] = Unevaluable(
                branch, "live_response_malformed", "gh returned output that is not JSON"
            )
    return live


def build_report() -> ProtectionReport:
    """The comparison for this repository, or the invalid-declaration result."""
    try:
        baseline = load_branch_protection_baseline()
    except BranchProtectionBaselineError as error:
        # The contract itself is unusable, so nothing can be compared against it.
        return report_for_invalid_baseline(error.details)
    except OSError as error:
        return report_for_invalid_baseline([f"the baseline could not be read: {error}"])
    return compare_protection(baseline, collect_live_protection(), CI_STRICTNESS_BRANCHES)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """The parsed command line."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--json", action="store_true", help="emit the structured report instead of Markdown"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Print the comparison and return its three-valued exit code."""
    args = parse_args(argv)
    report = build_report()
    if args.json:
        payload = {
            "drifts": [vars(drift) for drift in report.drifts],
            "unevaluable": [vars(item) for item in report.unevaluable],
        }
        print(json.dumps(payload, indent=2, default=repr))
    else:
        print(render_markdown(report))
    if report.unevaluable:
        print(
            f"{len(report.unevaluable)} branch(es) could not be evaluated; "
            "this is not a clean result",
            file=sys.stderr,
        )
    return report.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
