#!/usr/bin/env bash
#
# bootstrap-claude-workflow.sh — wire the Claude Code runtime at
# ~/.claude/{skills,hooks}/ to the workflow surfaces checked into this repo.
#
# Skills use a DIFFERENT install mode than hooks on purpose:
#
#   skills/ — symlinked. ~/.claude/skills/<name> is a directory symlink into
#   .claude/skills/<name> in this repo. Editing a SKILL.md in the repo takes
#   effect in the next Claude Code session on the same host, no re-run.
#   Skills are only read at session start, so cross-session weirdness is low.
#
#   hooks/ — copied. ~/.claude/hooks/<name> is a real file copied out of
#   .claude/hooks/<name>. Hooks are execed by the harness on every tool call
#   in every session on the host, so the runtime path must NOT depend on
#   which branch a specific repo happens to be checked out to. Symlinking
#   hooks into a working tree means every git checkout in that tree silently
#   breaks Bash for every concurrent Claude window on the machine. Copies
#   decouple runtime from worktree state at the cost of requiring a re-run
#   whenever the repo-side hook file changes.
#
# Only hooks listed in WORKFLOW_HOOKS below are touched. The repo-scoped
# protect_files.sh hook is wired via $CLAUDE_PROJECT_DIR in
# .claude/settings.json and must NEVER land under ~/.claude/hooks/, so the
# allowlist is explicit.
#
# Host-state semantics:
#
#   skills — if ~/.claude/skills/<name> is already the desired symlink, it's
#   left alone. If it's a plain directory byte-identical to the repo copy,
#   it's replaced with a symlink. If it differs, the script refuses to touch
#   it; re-run with --force to clobber.
#
#   hooks  — if ~/.claude/hooks/<name> is already a copy byte-identical to
#   the repo version, it's left alone. If it's a stale copy or a symlink
#   (common after the earlier design that symlinked hooks), it's replaced
#   with a fresh copy from the repo. If it differs and isn't a symlink, the
#   script refuses to touch it; re-run with --force to clobber.
#
#   Entries that exist at the user level but not in the repo are never
#   touched regardless.
#
# Usage:
#   scripts/bootstrap-claude-workflow.sh [--force] [--dry-run]
#
# Safe to re-run. Run after cloning Ground-Control on a new host, after any
# edit to a hook under .claude/hooks/, or after any host-level reset that
# wipes ~/.claude/skills or ~/.claude/hooks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/.claude/skills"
SKILLS_DST="${HOME}/.claude/skills"
HOOKS_SRC="$REPO_ROOT/.claude/hooks"
HOOKS_DST="${HOME}/.claude/hooks"

WORKFLOW_HOOKS=(
  "git-merge-guard.py"
  "block-defer-language.py"
  "block-implement-worktree.py"
)

force=0
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help)
      sed -n '2,58p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

run() {
  if [[ "$dry_run" -eq 1 ]]; then
    echo "DRY-RUN: $*"
  else
    eval "$@"
  fi
}

linked=0
copied=0
clobbered=0
already_correct=0

# Symlink a skill directory from src → dst, with the safety rail.
link_skill() {
  local src="$1"
  local dst="$2"

  if [[ -L "$dst" ]]; then
    local current
    current="$(readlink "$dst")"
    if [[ "$current" == "$src" ]]; then
      already_correct=$((already_correct + 1))
      return 0
    fi
    echo "updating skill symlink $dst: $current -> $src"
    run "rm -f \"$dst\" && ln -s \"$src\" \"$dst\""
    linked=$((linked + 1))
    return 0
  fi

  if [[ -e "$dst" ]]; then
    if [[ -d "$dst" ]] && diff -qr "$src" "$dst" > /dev/null 2>&1; then
      echo "replacing identical skill directory $dst with symlink -> $src"
      run "rm -rf \"$dst\" && ln -s \"$src\" \"$dst\""
      clobbered=$((clobbered + 1))
      return 0
    fi
    if [[ "$force" -eq 1 ]]; then
      echo "FORCE: replacing skill $dst with symlink -> $src"
      run "rm -rf \"$dst\" && ln -s \"$src\" \"$dst\""
      clobbered=$((clobbered + 1))
      return 0
    fi
    echo "refusing to replace skill $dst (differs from repo copy). Re-run with --force to overwrite." >&2
    exit 3
  fi

  echo "linking skill $dst -> $src"
  run "ln -s \"$src\" \"$dst\""
  linked=$((linked + 1))
}

# Copy a hook file from src → dst, with the safety rail. A pre-existing
# symlink at dst is treated as "stale, replace with a real copy" because the
# earlier design symlinked hooks into the worktree and we're migrating away
# from that.
copy_hook() {
  local src="$1"
  local dst="$2"

  if [[ -L "$dst" ]]; then
    echo "replacing stale hook symlink $dst with a real copy from $src"
    run "rm -f \"$dst\" && cp \"$src\" \"$dst\" && chmod +x \"$dst\""
    copied=$((copied + 1))
    return 0
  fi

  if [[ -e "$dst" ]]; then
    if [[ -f "$dst" ]] && diff -q "$src" "$dst" > /dev/null 2>&1; then
      already_correct=$((already_correct + 1))
      return 0
    fi
    if [[ "$force" -eq 1 ]]; then
      echo "FORCE: overwriting hook $dst with repo copy"
      run "cp \"$src\" \"$dst\" && chmod +x \"$dst\""
      clobbered=$((clobbered + 1))
      return 0
    fi
    echo "refusing to overwrite hook $dst (differs from repo copy). Re-run with --force to overwrite." >&2
    exit 3
  fi

  echo "installing hook $dst (copy of $src)"
  run "cp \"$src\" \"$dst\" && chmod +x \"$dst\""
  copied=$((copied + 1))
}

# --- skills ---
if [[ ! -d "$SKILLS_SRC" ]]; then
  echo "error: $SKILLS_SRC does not exist — run from inside a Ground-Control checkout" >&2
  exit 1
fi
mkdir -p "$SKILLS_DST"

shopt -s nullglob
for skill_dir in "$SKILLS_SRC"/*/; do
  name="$(basename "$skill_dir")"
  link_skill "$SKILLS_SRC/$name" "$SKILLS_DST/$name"
done
shopt -u nullglob

# --- workflow hooks ---
if [[ ! -d "$HOOKS_SRC" ]]; then
  echo "error: $HOOKS_SRC does not exist — run from inside a Ground-Control checkout" >&2
  exit 1
fi
mkdir -p "$HOOKS_DST"

for hook_name in "${WORKFLOW_HOOKS[@]}"; do
  src="$HOOKS_SRC/$hook_name"
  if [[ ! -f "$src" ]]; then
    echo "warning: $src is declared in WORKFLOW_HOOKS but missing from the repo" >&2
    continue
  fi
  copy_hook "$src" "$HOOKS_DST/$hook_name"
done

echo
echo "bootstrap-claude-workflow: linked=$linked copied=$copied clobbered=$clobbered already-correct=$already_correct"
