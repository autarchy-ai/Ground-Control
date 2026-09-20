#!/usr/bin/env bash
# Privileged, explicit installation and removal for the local Incus sandbox.
set -euo pipefail

readonly PROJECT="gc-sandbox"
readonly PROFILE="gc-sandbox-default"
readonly POOL="gc-sandbox-pool"
readonly BRIDGE="gcbr0"
readonly INSTALL_ROOT="/usr/local/lib/gc-incus-sandbox"
readonly CONFIG_ROOT="/etc/gc-incus-sandbox"
readonly STATE_ROOT="/var/lib/gc-incus-sandbox"
readonly RULES_PATH="/etc/nftables.d/gc-incus-sandbox.nft"
readonly OWNERSHIP_RECORD="$STATE_ROOT/setup-owned"
readonly POOL_SIZE="64GiB"
dry_run=false

run() {
  if "$dry_run"; then
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

need_root() {
  if ! "$dry_run" && [[ "${EUID}" -ne 0 ]]; then
    echo "setup must run as root" >&2
    exit 64
  fi
}

check_local_api_only() {
  "$dry_run" && return 0
  local https
  https="$(incus config get core.https_address || true)"
  if [[ -n "$https" ]]; then
    echo "refusing to alter an Incus daemon with an HTTPS management address" >&2
    exit 65
  fi
}

require_pinned_image() {
  "$dry_run" && { echo "require a pinned image fingerprint before setup"; return 0; }
  local image
  image="$(python3 -c 'import json; print(json.load(open("/etc/gc-incus-sandbox/config.json"))["image"])')"
  if [[ ! "$image" =~ ^(sha256:|images:)[0-9a-f]{64}$ ]] || [[ "$image" == *"0000000000000000000000000000000000000000000000000000000000000000" ]]; then
    echo "replace the image placeholder with a pinned fingerprint before setup" >&2
    exit 65
  fi
}

quota_write_probe() {
  "$dry_run" && { echo "quota write probe for $POOL"; return 0; }
  local probe_vm="gc-quota-probe-vm-$$" image
  image="$(python3 -c 'import json; print(json.load(open("/etc/gc-incus-sandbox/config.json"))["image"])')"
  incus launch "$image" "$probe_vm" --project "$PROJECT" --profile "$PROFILE" --vm
  trap "incus delete \"$probe_vm\" --force --project \"$PROJECT\" 2>/dev/null || true" RETURN
  local deadline=$((SECONDS + 120))
  until incus exec "$probe_vm" --project "$PROJECT" -- true 2>/dev/null; do
    [[ "$SECONDS" -lt "$deadline" ]] || { echo "quota probe VM agent did not become ready" >&2; exit 65; }
    sleep 2
  done
  if incus exec "$probe_vm" --project "$PROJECT" -- sh -c 'dd if=/dev/zero of=/quota-fill bs=1M count=16385 conv=fsync'; then
    echo "refusing storage pool without an enforced write quota" >&2
    exit 65
  fi
}

populate_nft_sets() {
  "$dry_run" && { echo "populate gc_incus_sandbox host and DNS address sets"; echo "record network-addresses.sha256"; return 0; }
  local host_addresses dns_addresses address
  host_addresses="$(ip -o -4 addr show | awk '{print $4}' | cut -d/ -f1 | sort -u)"
  dns_addresses="$(awk '/^nameserver / { print $2 }' /etc/resolv.conf | sort -u)"
  for address in $host_addresses; do
    [[ "$address" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "invalid host address" >&2; exit 65; }
    nft add element inet gc_incus_sandbox host_ipv4 "{ $address }"
  done
  for address in $dns_addresses; do
    [[ "$address" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "invalid DNS address" >&2; exit 65; }
    nft add element inet gc_incus_sandbox dns_ipv4 "{ $address }"
  done
  install -d -m 0750 "$STATE_ROOT/state"
  ip -o -4 addr show | sha256sum | awk '{print $1}' >"$STATE_ROOT/state/network-addresses.sha256"
  chmod 0640 "$STATE_ROOT/state/network-addresses.sha256"
}

install_files() {
  run install -d -m 0750 "$CONFIG_ROOT"
  if "$dry_run"; then
    echo "create root-owned configuration when absent, then require a pinned image fingerprint"
  elif [[ ! -e "$CONFIG_ROOT/config.json" ]]; then
    [[ "${SUDO_UID:-}" =~ ^[1-9][0-9]*$ ]] || { echo "install through sudo from the intended operator" >&2; return 64; }
    sed "s/\"operator_uid\": 1000/\"operator_uid\": ${SUDO_UID}/" \
      tools/incus_sandbox/config.example.json >"$CONFIG_ROOT/config.json"
    chmod 0600 "$CONFIG_ROOT/config.json"
    echo "replace the image placeholder with a pinned fingerprint, then rerun setup" >&2
    return 64
  fi
  run install -d -m 0750 "$INSTALL_ROOT" "$STATE_ROOT" /var/log/gc-incus-sandbox
  run install -m 0640 tools/incus_sandbox/config.py "$INSTALL_ROOT/config.py"
  run install -m 0640 tools/incus_sandbox/events.py "$INSTALL_ROOT/events.py"
  run install -m 0750 tools/incus_sandbox/helper.py "$INSTALL_ROOT/helper.py"
  run install -m 0755 tools/incus_sandbox/client.mjs /usr/local/bin/gc-incus-sandbox
  run install -m 0640 tools/incus_sandbox/gc-incus-sandbox.nft "$RULES_PATH"
  if ! "$dry_run"; then
    [[ "${SUDO_UID:-}" =~ ^[1-9][0-9]*$ ]] || { echo "install through sudo from the intended operator" >&2; exit 64; }
    cat >"/etc/sudoers.d/gc-incus-sandbox" <<EOF
# This helper validates the closed action and sandbox-name vocabulary itself.
${SUDO_USER} ALL=(root) NOPASSWD: $INSTALL_ROOT/helper.py *
EOF
    chmod 0440 /etc/sudoers.d/gc-incus-sandbox
    visudo -cf /etc/sudoers.d/gc-incus-sandbox
    : >"$OWNERSHIP_RECORD"
    chmod 0600 "$OWNERSHIP_RECORD"
    printf '%s\n' files sudoers rules config >>"$OWNERSHIP_RECORD"
  else
    echo "install validated fixed-helper sudo rule"
  fi
}

install_resources() {
  run apt-get update
  run apt-get install -y incus nftables tmux
  if ! "$dry_run" && ! incus info >/dev/null 2>&1; then
    incus admin init --minimal
  fi
  check_local_api_only
  require_pinned_image
  run incus project create "$PROJECT"
  "$dry_run" || printf '%s\n' project >>"$OWNERSHIP_RECORD"
  run incus project set "$PROJECT" restricted true
  run incus project set "$PROJECT" restricted.containers.nesting block
  run incus project set "$PROJECT" restricted.devices.disk block
  run incus project set "$PROJECT" restricted.devices.nic allow
  run incus project set "$PROJECT" restricted.networks.access "$BRIDGE"
  run incus project set "$PROJECT" restricted.devices.proxy block
  run incus project set "$PROJECT" restricted.devices.usb block
  run incus project set "$PROJECT" restricted.virtual-machines.lowlevel block
  run incus project set "$PROJECT" limits.instances 8
  run incus project set "$PROJECT" limits.cpu 8
  run incus project set "$PROJECT" limits.memory 32GiB
  run incus storage create "$POOL" btrfs size="$POOL_SIZE"
  "$dry_run" || printf '%s\n' pool >>"$OWNERSHIP_RECORD"
  run incus network create "$BRIDGE" ipv4.address=10.74.0.1/24 ipv4.nat=true ipv6.address=none dns.mode=none
  "$dry_run" || printf '%s\n' network >>"$OWNERSHIP_RECORD"
  run incus profile create "$PROFILE" --project "$PROJECT"
  "$dry_run" || printf '%s\n' profile >>"$OWNERSHIP_RECORD"
  run incus profile device add "$PROFILE" root disk path=/ pool="$POOL" --project "$PROJECT"
  run incus profile device add "$PROFILE" eth0 nic nictype=bridged parent="$BRIDGE" name=eth0 --project "$PROJECT"
  run incus profile device add "$PROFILE" agent disk source=agent:config --project "$PROJECT"
  run incus profile set "$PROFILE" limits.cpu 2 --project "$PROJECT"
  run incus profile set "$PROFILE" limits.memory 4GiB --project "$PROJECT"
  run nft -f "$RULES_PATH"
  populate_nft_sets
  quota_write_probe
  "$dry_run" || printf '%s\n' complete >>"$OWNERSHIP_RECORD"
}

require_complete_ownership_record() {
  [[ -f "$OWNERSHIP_RECORD" && ! -L "$OWNERSHIP_RECORD" ]] || { echo "missing sandbox ownership record" >&2; exit 65; }
  [[ "$(stat -c '%u:%a' "$OWNERSHIP_RECORD")" == "0:600" ]] || { echo "unsafe sandbox ownership record" >&2; exit 65; }
  local item
  for item in files sudoers rules config project pool network profile complete; do
    grep -Fxq "$item" "$OWNERSHIP_RECORD" || { echo "incomplete sandbox ownership record" >&2; exit 65; }
  done
}

rollback_partial() {
  [[ -f "$OWNERSHIP_RECORD" && ! -L "$OWNERSHIP_RECORD" ]] || return 0
  [[ "$(stat -c '%u:%a' "$OWNERSHIP_RECORD")" == "0:600" ]] || return 0
  grep -Fxq complete "$OWNERSHIP_RECORD" && return 0
  grep -Fxq project "$OWNERSHIP_RECORD" && incus project delete "$PROJECT" 2>/dev/null || true
  grep -Fxq network "$OWNERSHIP_RECORD" && incus network delete "$BRIDGE" 2>/dev/null || true
  grep -Fxq pool "$OWNERSHIP_RECORD" && incus storage delete "$POOL" 2>/dev/null || true
  grep -Fxq rules "$OWNERSHIP_RECORD" && nft delete table inet gc_incus_sandbox 2>/dev/null || true
  rm -f /etc/sudoers.d/gc-incus-sandbox "$RULES_PATH"
  rm -rf "$INSTALL_ROOT" "$CONFIG_ROOT" "$STATE_ROOT" /var/log/gc-incus-sandbox
}

rollback() {
  "$dry_run" && { echo "refuse rollback while owned VMs are running"; echo "remove only gc-sandbox project, profile, pool, bridge, and nft table"; return 0; }
  require_complete_ownership_record
  if incus list --project "$PROJECT" --format csv -c ns | grep -q RUNNING; then
    echo "refusing rollback while owned VMs are running" >&2
    exit 65
  fi
  incus project delete "$PROJECT"
  incus network delete "$BRIDGE"
  incus storage delete "$POOL"
  nft delete table inet gc_incus_sandbox 2>/dev/null || true
  rm -f /etc/sudoers.d/gc-incus-sandbox "$RULES_PATH"
  rm -rf "$INSTALL_ROOT" "$CONFIG_ROOT" "$STATE_ROOT" /var/log/gc-incus-sandbox
}

if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi
need_root
case "${1:-}" in
  install)
    if ! install_files; then
      exit 64
    fi
    install_failed=true
    trap 'if "$install_failed"; then rollback_partial; fi' EXIT
    install_resources
    install_failed=false
    trap - EXIT
    ;;
  rollback) rollback ;;
  *) echo "usage: setup.sh [--dry-run] {install|rollback}" >&2; exit 64 ;;
esac
