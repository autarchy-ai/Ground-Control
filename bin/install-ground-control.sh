#!/usr/bin/env bash
#
# install-ground-control.sh
#
# The general Ground Control host installer. It installs the agent-neutral
# workflow skills and the host-wide verification dispatcher onto this machine.
#
# Two artifacts, two owners:
#
#   skills     — delegated verbatim to bin/install-skills.sh, which remains the
#   canonical skill installer. Its managed-target, --force, --dry-run, and
#   target-selection rules live in exactly one place; this script passes the
#   matching flags through rather than growing a second copy of them.
#
#   dispatcher — bin/gc-test-dispatch plus its tools/gc_dispatch package, both
#   installed as real copies. Never a symlink into this checkout: the dispatcher
#   becomes the command every repository on the host runs at its verification
#   boundaries, so switching a branch, moving the clone, or deleting it must not
#   change or break it. That is the same reasoning that makes user-level Claude
#   hooks copies rather than symlinks (docs/DEVELOPMENT_WORKFLOW.md).
#
# Host targets are never clobbered blindly. A target this script owns — one byte
# identical to the repo source — is refreshed in place. Anything else is left
# untouched and the run fails; re-run with --force to overwrite it.
#
# Usage:
#   bin/install-ground-control.sh [--dry-run] [--force] [--no-skills] [--no-dispatcher]
#                                 [--copy] [--no-codex] [--no-cursor]
#                                 [--claude-dir <path>] [--codex-dir <path>]
#                                 [--codex-prompts-dir <path>] [--cursor-dir <path>]
#                                 [--bin-dir <path>] [--data-dir <path>]
#
# Options:
#   --dry-run         Print actions without writing anything.
#   --force           Overwrite host targets that differ from the repo copy.
#   --no-skills       Skip the skill install (dispatcher only).
#   --no-dispatcher   Skip the dispatcher install (skills only).
#   --bin-dir P       Where gc-test-dispatch is installed (default: ~/.local/bin).
#   --data-dir P      Where the dispatcher package is installed
#                     (default: ${XDG_DATA_HOME:-~/.local/share}/ground-control).
#   --copy, --no-codex, --no-cursor, --claude-dir, --codex-dir,
#   --codex-prompts-dir, --cursor-dir
#                     Passed straight through to bin/install-skills.sh.
#
# Host capacity for the dispatcher is host-owned configuration and is NOT written
# by this script; see docs/DEVELOPMENT_WORKFLOW.md for
# ${XDG_CONFIG_HOME:-~/.config}/ground-control/dispatch.json. Without it the
# dispatcher admits against this host's effective CPU affinity.
#
# Safe to re-run. Run after cloning Ground Control on a new host and after pulling
# a change to the dispatcher.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dispatcher_src="${repo_root}/bin/gc-test-dispatch"
package_src="${repo_root}/tools/gc_dispatch"

dry_run=0
force=0
install_skills=1
install_dispatcher=1
skill_args=()
bin_dir="${HOME}/.local/bin"
data_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/ground-control"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1; skill_args+=("$1"); shift ;;
    --force)
      force=1; skill_args+=("$1"); shift ;;
    --no-skills)
      install_skills=0; shift ;;
    --no-dispatcher)
      install_dispatcher=0; shift ;;
    --copy|--no-codex|--no-cursor)
      skill_args+=("$1"); shift ;;
    --claude-dir|--codex-dir|--codex-prompts-dir|--cursor-dir)
      skill_args+=("$1" "$2"); shift 2 ;;
    --bin-dir)
      bin_dir="$2"; shift 2 ;;
    --data-dir)
      data_dir="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; /^set -euo/d'
      exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2 ;;
  esac
done

run() {
  if [[ "${dry_run}" -eq 1 ]]; then
    printf 'DRY-RUN: %s\n' "$*"
  else
    "$@"
  fi
}

# A host target is ours to refresh only when it is byte-identical to the repo
# source. Anything else may be a locally written tool that happens to share the
# name, and silently replacing it is the failure this check exists to prevent.
is_managed_target() {
  local src="$1" dst="$2"
  if [[ -L "${dst}" ]]; then
    return 1
  fi
  if [[ -f "${src}" && -f "${dst}" ]]; then
    diff -q -- "${src}" "${dst}" >/dev/null 2>&1 && return 0
  fi
  if [[ -d "${src}" && -d "${dst}" ]]; then
    diff -qr -- "${src}" "${dst}" >/dev/null 2>&1 && return 0
  fi
  return 1
}

install_copy() {
  local src="$1" dst="$2" label="$3"

  if [[ -e "${dst}" || -L "${dst}" ]]; then
    if is_managed_target "${src}" "${dst}"; then
      printf '%-7s %-10s %s (already current)\n' "current" "${label}" "${dst}"
      return 0
    elif [[ "${force}" -eq 1 ]]; then
      echo "FORCE: overwriting ${label} ${dst} (differs from repo copy)" >&2
      run rm -rf -- "${dst}"
    else
      echo "ERROR: refusing to overwrite ${label} ${dst} — it differs from the repo copy. Re-run with --force to overwrite." >&2
      exit 3
    fi
  fi

  if [[ -d "${src}" ]]; then
    run cp -R -- "${src}" "${dst}"
  else
    run cp -- "${src}" "${dst}"
    run chmod 0755 -- "${dst}"
  fi
  printf '%-7s %-10s %s -> %s\n' "copy" "${label}" "${dst}" "${src}"
}

if [[ "${install_skills}" -eq 1 ]]; then
  "${repo_root}/bin/install-skills.sh" ${skill_args[@]+"${skill_args[@]}"}
else
  echo "Skipping skill install (--no-skills set)."
fi

if [[ "${install_dispatcher}" -eq 1 ]]; then
  if [[ ! -f "${dispatcher_src}" || ! -d "${package_src}" ]]; then
    echo "ERROR: dispatcher sources are missing from ${repo_root}. Are you running this from a Ground Control checkout?" >&2
    exit 1
  fi
  run mkdir -p "${bin_dir}" "${data_dir}"
  # The package first: the entry point is useless without it, and installing the
  # binary last means a half-finished run never leaves a callable command that
  # cannot find its own code.
  install_copy "${package_src}" "${data_dir}/gc_dispatch" "dispatch"
  install_copy "${dispatcher_src}" "${bin_dir}/gc-test-dispatch" "dispatch"

  case ":${PATH}:" in
    *":${bin_dir}:"*) ;;
    *) echo "NOTE: ${bin_dir} is not on PATH; add it before wrapping .ground-control.yaml commands in gc-test-dispatch." >&2 ;;
  esac
else
  echo "Skipping dispatcher install (--no-dispatcher set)."
fi

echo "Done."
