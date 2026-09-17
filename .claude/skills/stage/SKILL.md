---
name: stage
description: Stage files for review without duplicating commit-time hooks
disable-model-invocation: true
---

# Stage Changes

## Step 1: Identify Changed Files

1. Run `git status` to see all changed and untracked files.
2. Exclude from staging: .env files, credentials, secrets, large binaries.

## Step 2: Stage Files

1. `git add` all relevant changed files.

## Step 3: Preserve the Commit Boundary

Do not run `pre-commit` while staging. An ordinary commit invokes the installed
commit-time hook, and the Ground Control publish action owns its explicit
pre-commit boundary while disabling hook dispatch for the following commit.
Running the all-files hook here would duplicate either path on the same staged
snapshot.

## Step 4: Report

- List what is staged: `git diff --cached --name-only`
- State that validation remains owned by the subsequent commit or publish
  boundary.
- "All relevant files staged. Ready for the commit or publish boundary."
