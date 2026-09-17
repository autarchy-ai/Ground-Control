# ADR-079: Commit-Time Pre-commit Hook Activation

## Status

Accepted

## Date

2026-07-01

## Context

Ground Control onboarding treats pre-commit as an active local gate: an
onboarded repository has a `.pre-commit-config.yaml`, contributors run
`pre-commit run --all-files`, and commits are expected to execute the same
policy automatically.

That assumption fails on hosts that use a global Git `core.hooksPath`
dispatcher. In the observed environment, `core.hooksPath` points at a global
hooks directory where each hook delegates through a `_chain` script to the
repo-local hook under Git's hook path. The dispatcher can run a repo-local
`pre-commit` hook when one exists, but `pre-commit install` refuses to create
that hook whenever `core.hooksPath` is set at all. A freshly onboarded repo can
therefore contain a valid `.pre-commit-config.yaml` and pass CI while commits
run no local hooks.

This is a workflow reliability problem, not a pre-commit configuration problem.
The repository already verifies selected pre-commit hooks in CI through
`tools/policy/checks.py::run_ci_strictness_contract`, but CI execution and
commit-time activation are distinct contracts.

## Decision

Ground Control onboarding must treat commit-time hook activation as a separate
invariant from pre-commit configuration and CI coverage.

An onboarding run is incomplete until it can verify all of the following for
the current clone:

- `.pre-commit-config.yaml` exists and contains the repo's selected hooks.
- the Git hook dispatch path for the current clone reaches a `pre-commit`
  hook at commit time.
- `pre-commit run --all-files` has been executed successfully after hook
  activation is wired.

### Ownership Boundary

The repository owns the committed pre-commit configuration, the repo-native
installer/verifier, and any managed clone-local hook payload it writes under
Git's hook path. The host environment owns global `core.hooksPath` and any
global dispatcher installed there.

Ground Control onboarding must not unset or rewrite global `core.hooksPath`.
When no `core.hooksPath` is configured, onboarding may use the normal
`pre-commit install` path. When a supported global dispatcher delegates to the
repo-local Git hook path, onboarding may create or repair the clone-local
`pre-commit` hook directly because `pre-commit install` cannot do so. When a
non-empty `core.hooksPath` cannot be recognized as a supported dispatcher,
onboarding must fail closed with an actionable diagnostic rather than reporting
success with inactive hooks.

### Verification Boundary

Hook activation verification must inspect Git's effective hook configuration
and Git-resolved hook path for the current clone. It must not infer activation
from the presence of `.pre-commit-config.yaml`, installed Python packages, or a
green CI pre-commit job.

For managed clone-local hook files, the verifier must distinguish
Ground-Control-managed content from user-managed content. Existing unmanaged
hooks are not overwritten silently; setup fails with a merge/repair diagnostic
unless the operator explicitly chooses the clobber path supported by the future
installer.

Fresh clones remain a per-clone setup problem because `.git/hooks/` is not
versioned. The durable repo contract is the checked-in installer/verifier and
the `/repo-setup` workflow invoking it, not a committed hook file.

### Security and Runtime Constraints

The hook activation path is local repository hygiene. It must not introduce a
GitHub, Ground Control API, or network side effect. Hook bodies and diagnostics
must not embed tokens, secrets, or environment dumps. Any path supplied by Git
configuration is data: quote it, avoid shell evaluation, and resolve hook paths
through Git rather than by assuming `.git/hooks` is a directory.

Expected setup failures should surface as stable diagnostics and non-zero exit
codes, not as silent success followed by commits that run no hooks.

## Consequences

### Positive

- Onboarding can detect the "config present but hook not wired" state before a
  contributor relies on local enforcement.
- The repository and host responsibilities are explicit: repo setup adapts to
  a compatible dispatcher but does not take ownership of global Git policy.
- CI pre-commit coverage remains useful without being confused for per-clone
  commit-time activation.

### Negative

- Fresh clones need an explicit local setup/verification step because Git hooks
  remain unversioned by design.
- Unsupported global hook dispatchers become visible setup failures that need
  host-level remediation or an added supported strategy.

### Risks

- A too-narrow dispatcher check would reject a valid host setup; keep the
  strategy detection small, explicit, and testable.
- A too-permissive check would recreate the current silent no-op under another
  name; activation must be proven against Git's effective hook path.
- Silently overwriting an existing user hook could drop local controls. Managed
  hook markers and fail-closed repair behavior are required.

## Non-Goals

- Replacing or standardizing the host's global hooks dispatcher.
- Moving pre-commit enforcement out of CI or weakening
  `run_ci_strictness_contract`.
- Adding a backend controller, database table, MCP tool, or Ground Control
  server state for local Git hook activation.
- Making `--no-verify` an accepted workflow path.

## Related Issues

- #1153 - Onboarded repos silently get no commit-time pre-commit hooks when
  `pre-commit install` refuses under a global `core.hooksPath` dispatcher.

## Related ADRs

- ADR-027 - Agent-neutral workflow packaging and `.ground-control.yaml` as the
  repo context boundary.
- ADR-029 - Issue-thread gate model and durable workflow record.
- ADR-036 - Per-step routing, deterministic tool surfaces, and telemetry.

## 2026-09-17 amendment: single publish hook execution (issue #1626)

Commit-time activation remains the contract for ordinary human and direct Git
commits. The Ground Control mechanical publish path is a distinct, deterministic
boundary: it runs the configured pre-commit command explicitly because clone
activation cannot be assumed, then performs its Git commit with hook dispatch
disabled. This prevents the installed hook from repeating the same all-files
checks immediately after the explicit boundary. The standalone staging skill no
longer runs pre-commit in advance of an ordinary commit; the commit-time hook owns
that path. CI remains the independent hosted replay.
