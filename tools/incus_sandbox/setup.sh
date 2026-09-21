#!/usr/bin/env bash
# Privileged, explicit installation and removal for the local Incus sandbox.
set -euo pipefail

readonly PROJECT="gc-sandbox"
readonly PROFILE="gc-sandbox-default"
readonly POOL="gc-sandbox-pool"
readonly BRIDGE="gcbr0"
readonly BRIDGE_ADDRESS="10.74.0.1"
readonly INSTALL_ROOT="/usr/local/lib/gc-incus-sandbox"
readonly CONFIG_ROOT="/etc/gc-incus-sandbox"
readonly STATE_ROOT="/var/lib/gc-incus-sandbox"
readonly RULES_PATH="/etc/nftables.d/gc-incus-sandbox.nft"
readonly OWNERSHIP_RECORD="$STATE_ROOT/setup-owned"
readonly POOL_SIZE="64GiB"
readonly PAYLOAD_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
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
  if [[ ! "$image" =~ ^(images:|local:)[0-9a-f]{64}$ ]] || [[ "$image" == *"0000000000000000000000000000000000000000000000000000000000000000" ]]; then
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

allow_bridge_forwarding() {
  # Docker, libvirt and hardened hosts set the legacy FORWARD policy to DROP, which drops
  # guest traffic before this table sees it; an accept here cannot override that chain.
  "$dry_run" && { echo "allow $BRIDGE where the legacy FORWARD policy is DROP"; return 0; }
  command -v iptables >/dev/null 2>&1 || return 0
  iptables -S FORWARD 2>/dev/null | grep -qx -- "-P FORWARD DROP" || return 0
  local chain=FORWARD
  if iptables -S DOCKER-USER >/dev/null 2>&1; then chain=DOCKER-USER; fi
  # Guest-initiated traffic only, filtered by this table's own rules, plus its
  # return traffic. Unsolicited inbound traffic keeps hitting the drop policy.
  iptables -C "$chain" -i "$BRIDGE" -j ACCEPT 2>/dev/null ||
    iptables -I "$chain" -i "$BRIDGE" -j ACCEPT
  iptables -C "$chain" -o "$BRIDGE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null ||
    iptables -I "$chain" -o "$BRIDGE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  grep -Fxq "forwarding $chain" "$OWNERSHIP_RECORD" ||
    printf '%s\n' "forwarding $chain" >>"$OWNERSHIP_RECORD"
}

remove_bridge_forwarding() {
  local chain
  [[ -f "$OWNERSHIP_RECORD" ]] || return 0
  chain="$(awk '/^forwarding / { print $2 }' "$OWNERSHIP_RECORD" | tail -n 1)"
  [[ -n "$chain" ]] || return 0
  while iptables -C "$chain" -i "$BRIDGE" -j ACCEPT 2>/dev/null; do
    iptables -D "$chain" -i "$BRIDGE" -j ACCEPT
  done
  while iptables -C "$chain" -o "$BRIDGE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null; do
    iptables -D "$chain" -o "$BRIDGE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  done
}

populate_nft_sets() {
  "$dry_run" && { echo "populate gc_incus_sandbox host, bridge, and DNS address sets"; echo "record network-addresses.sha256"; return 0; }
  local host_addresses dns_addresses address
  host_addresses="$(ip -o -4 addr show | awk '{print $4}' | cut -d/ -f1 | sort -u)"
  dns_addresses="$(awk '/^nameserver / { print $2 }' /etc/resolv.conf | sort -u)"
  nft add element inet gc_incus_sandbox bridge_ipv4 "{ $BRIDGE_ADDRESS }"
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
  local preserve_ownership="${1:-false}"
  run install -d -m 0750 "$CONFIG_ROOT"
  if "$dry_run"; then
    echo "create root-owned configuration when absent, then require a pinned image fingerprint"
  elif [[ ! -e "$CONFIG_ROOT/config.json" ]]; then
    [[ "${SUDO_UID:-}" =~ ^[1-9][0-9]*$ ]] || { echo "install through sudo from the intended operator" >&2; return 64; }
    sed "s/\"operator_uid\": 1000/\"operator_uid\": ${SUDO_UID}/" \
      "$PAYLOAD_ROOT/config.example.json" >"$CONFIG_ROOT/config.json"
    chmod 0600 "$CONFIG_ROOT/config.json"
    echo "replace the image placeholder with a pinned fingerprint, then rerun setup" >&2
    return 64
  fi
  run install -d -m 0750 "$INSTALL_ROOT" "$STATE_ROOT" /var/log/gc-incus-sandbox
  run install -m 0640 "$PAYLOAD_ROOT/config.py" "$INSTALL_ROOT/config.py"
  run install -m 0640 "$PAYLOAD_ROOT/events.py" "$INSTALL_ROOT/events.py"
  run install -m 0640 "$PAYLOAD_ROOT/observations.py" "$INSTALL_ROOT/observations.py"
  run install -m 0640 "$PAYLOAD_ROOT/repository_environment.py" "$INSTALL_ROOT/repository_environment.py"
  run install -m 0750 "$PAYLOAD_ROOT/task_environment.py" "$INSTALL_ROOT/task_environment.py"
  run install -m 0644 "$PAYLOAD_ROOT/task_launcher.py" "$INSTALL_ROOT/task-launcher.py"
  run install -m 0644 "$PAYLOAD_ROOT/guest_bootstrap.py" "$INSTALL_ROOT/guest-bootstrap.py"
  run install -m 0644 "$PAYLOAD_ROOT/migration.py" "$INSTALL_ROOT/migration.py"
  run install -m 0644 "$PAYLOAD_ROOT/migration_packet.py" "$INSTALL_ROOT/migration_packet.py"
  run install -m 0644 "$PAYLOAD_ROOT/migration_guard.mjs" /usr/local/bin/migration_guard.mjs
  run install -m 0644 "$PAYLOAD_ROOT/repository_identity.mjs" /usr/local/bin/repository_identity.mjs
  run install -m 0644 "$PAYLOAD_ROOT/source_binding.mjs" /usr/local/bin/source_binding.mjs
  run install -m 0644 "$PAYLOAD_ROOT/task_client.mjs" /usr/local/bin/task_client.mjs
  run install -m 0750 "$PAYLOAD_ROOT/helper.py" "$INSTALL_ROOT/helper.py"
  run install -m 0750 "$PAYLOAD_ROOT/transfer.py" "$INSTALL_ROOT/transfer.py"
  run install -m 0755 "$PAYLOAD_ROOT/client.mjs" /usr/local/bin/gc-incus-sandbox
  run install -m 0644 "$PAYLOAD_ROOT/source.mjs" /usr/local/bin/source.mjs
  run install -m 0640 "$PAYLOAD_ROOT/gc-incus-sandbox.nft" "$RULES_PATH"
  if ! "$dry_run"; then
    [[ "${SUDO_UID:-}" =~ ^[1-9][0-9]*$ ]] || { echo "install through sudo from the intended operator" >&2; exit 64; }
    cat >"/etc/sudoers.d/gc-incus-sandbox" <<EOF
# This helper validates the closed action and sandbox-name vocabulary itself.
${SUDO_USER} ALL=(root) NOPASSWD: $INSTALL_ROOT/helper.py *, $INSTALL_ROOT/transfer.py *, $INSTALL_ROOT/task_environment.py *
EOF
    chmod 0440 /etc/sudoers.d/gc-incus-sandbox
    visudo -cf /etc/sudoers.d/gc-incus-sandbox
    if [[ "$preserve_ownership" != true ]]; then
      : >"$OWNERSHIP_RECORD"
      chmod 0600 "$OWNERSHIP_RECORD"
      printf '%s\n' files sudoers rules config >>"$OWNERSHIP_RECORD"
    fi
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
  run incus network create "$BRIDGE" "ipv4.address=$BRIDGE_ADDRESS/24" ipv4.nat=true ipv6.address=none dns.mode=none
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
  allow_bridge_forwarding
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

require_program_ownership_record() {
  [[ -f "$OWNERSHIP_RECORD" && ! -L "$OWNERSHIP_RECORD" ]] || { echo "missing sandbox ownership record" >&2; exit 65; }
  [[ "$(stat -c '%u:%a' "$OWNERSHIP_RECORD")" == "0:600" ]] || { echo "unsafe sandbox ownership record" >&2; exit 65; }
  local item
  for item in files sudoers rules config; do
    grep -Fxq "$item" "$OWNERSHIP_RECORD" || { echo "incomplete sandbox program ownership record" >&2; exit 65; }
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
  remove_bridge_forwarding
  rm -f /etc/sudoers.d/gc-incus-sandbox "$RULES_PATH"
  rm -rf "$INSTALL_ROOT" "$CONFIG_ROOT" "$STATE_ROOT" /var/log/gc-incus-sandbox
}

refresh() {
  # Host addresses and another firewall's chains change under a live installation.
  # Reapplying only those keeps the destructive install path out of the routine case.
  "$dry_run" && { echo "reapply the sandbox firewall table, address sets, and bridge forwarding"; return 0; }
  # Refresh mutates only the setup-owned rules file/table and forwarding entries.
  # Older valid installs may predate the later resource-completion markers.
  require_program_ownership_record
  nft delete table inet gc_incus_sandbox 2>/dev/null || true
  nft -f "$RULES_PATH"
  populate_nft_sets
  allow_bridge_forwarding
}

upgrade() {
  # Replace only reviewed sandbox programs and migrate the closed root policy;
  # existing guests, allocations, storage, and network resources remain intact.
  "$dry_run" && { echo "upgrade sandbox programs and gc.incus-sandbox config to v3"; return 0; }
  require_program_ownership_record
  install_files true
  /usr/bin/python3 "$INSTALL_ROOT/config.py" upgrade "$CONFIG_ROOT/config.json"
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
  remove_bridge_forwarding
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
    # A second install would recreate owned resources, fail, and take the partial-install
    # cleanup path over a working installation.
    if ! "$dry_run" && [[ -f "$OWNERSHIP_RECORD" ]] && grep -Fxq complete "$OWNERSHIP_RECORD"; then
      echo "sandbox is already installed; use 'setup.sh refresh' or roll back first" >&2
      exit 64
    fi
    if ! install_files; then
      exit 64
    fi
    install_failed=true
    trap 'if "$install_failed"; then rollback_partial; fi' EXIT
    install_resources
    install_failed=false
    trap - EXIT
    ;;
  refresh) refresh ;;
  upgrade) upgrade ;;
  rollback) rollback ;;
  *) echo "usage: setup.sh [--dry-run] {install|upgrade|refresh|rollback}" >&2; exit 64 ;;
esac
