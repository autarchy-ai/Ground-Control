---
stage_id: precommit
step: "Step 5"
tier: low
---

# Step 5: Proportionate Local Verification

Batch the completed implementation edits and run the narrowest tests that
exercise the changed behavior. Expand breadth for shared or cross-cutting
boundaries, security-sensitive changes, or targeted failures that indicate
wider risk. Record the commands and the tree state they verified for review.

Do not run `pre-commit` here; Step 7 owns its single mandatory pre-publish
invocation. Do not run the repository-wide completion or policy suites here;
CI owns repository-wide completion and policy suites.

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "targeted_verification_passed": true,
    "verification_commands": [ "<command>" ],
    "wider_risk_reason": null
  }
}
```

If targeted verification fails, fix the issue, batch related corrections, and
rerun the affected tests. Preparation or partial verification is not success.
