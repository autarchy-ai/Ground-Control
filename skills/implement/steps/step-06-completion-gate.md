---
status: retired
step: "Step 6 (retired)"
---

# Step 6: Retired local broad verification

Issue #1629 removes the mechanical verification phase. CI owns repository-wide
completion and policy suites. Use targeted tests during implementation and review
repairs, then proceed to the required reviews and publish.

Keep the acceptance mapping from Step 4.5. For a documentation-only carve-out,
check both the changed paths and every diff hunk for executable behavior before
publish. These are semantic checks, not a local full-suite command.
