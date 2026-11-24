#!/usr/bin/env bash
# Tear the demo down so nothing stays reachable. It stops the landing-page server, removes the
# /etc/hosts entry added by start.sh, and stops the Multipass VM. Pass --keep-vm to leave the VM
# running.
set -uo pipefail

VM="${DEMO_VM:-charm-dev}"
API_HOST="${DEMO_API_HOST:-marketing-form}"
SUDO="${SUDO:-sudo}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/demo/.run"

if [[ -f "$RUN/site.pid" ]]; then
  kill "$(cat "$RUN/site.pid")" 2>/dev/null && echo "Stopped landing-page server"
  rm -f "$RUN/site.pid"
fi

if grep -q "[[:space:]]$API_HOST # adaptive-form-demo$" /etc/hosts; then
  $SUDO sed -i "/[[:space:]]$API_HOST # adaptive-form-demo\$/d" /etc/hosts && echo "Removed /etc/hosts entry for $API_HOST"
fi

if [[ "${1:-}" != "--keep-vm" ]]; then
  multipass stop "$VM" && echo "Stopped VM $VM"
fi
echo "Demo stopped."
