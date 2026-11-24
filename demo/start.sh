#!/usr/bin/env bash
# Bring the adaptive-form demo up for a presentation. Run it on the laptop that hosts the
# Multipass VM. Everything stays private to this laptop:
#   - the API is reached through the Juju-managed ingress on the VM's private Multipass
#     address, which your LAN and the internet can't reach;
#   - the sample landing page is served on 127.0.0.1 only.
# demo/stop.sh undoes all of it.
#
# Usage: demo/start.sh [--simulate N] [--headful]
set -euo pipefail

VM="${DEMO_VM:-charm-dev}"
APP="marketing-form-dynamic-optimization"
INGRESS_APP="nginx-ingress-integrator"
API_HOST="${DEMO_API_HOST:-marketing-form}"   # nginx-ingress-integrator's service-hostname
SITE_PORT="${DEMO_SITE_PORT:-5173}"
SUDO="${SUDO:-sudo}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/demo/.run"
SIMULATE=0
HEADFUL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --simulate) SIMULATE="$2"; shift 2 ;;
    --headful) HEADFUL="--headful"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
# `multipass exec` can hang if stdin is open or stdout is a regular file (e.g. `> log`),
# so always close stdin and pipe both output streams.
vm() { multipass exec "$VM" -- bash -c "$1" </dev/null 2>&1 | cat; }
mkdir -p "$RUN"

step "Starting VM '$VM'"
multipass info "$VM" | grep -q "State:.*Running" || multipass start "$VM"
VM_IP="$(multipass info "$VM" | awk '/IPv4/{print $2; exit}')"
echo "  private address: $VM_IP"

step "Waiting for the Juju model to settle"
for app in postgresql-k8s "$APP" "$INGRESS_APP"; do
  vm "juju wait-for application $app --query='status==\"active\"' --timeout=15m" >/dev/null
  echo "  $app: active"
done
# After a VM boot or pod restart, hooks replan Flask a couple of times; wait until they finish.
vm "juju wait-for unit $APP/0 --query='workload-status==\"active\" && agent-status==\"idle\"' --timeout=10m" >/dev/null

step "Checking the ingress routes to the current pod"
ingress_ok() {
  vm "pod=\$(sudo k8s kubectl get pod -n $APP $APP-0 -o jsonpath='{.status.podIP}')
      svc=\$(sudo k8s kubectl get ingress -n $APP -o jsonpath='{.items[*].spec.rules[*].http.paths[*].backend.service.name}')
      [ -n \"\$svc\" ] && sudo k8s kubectl get endpoints -n $APP \$svc -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null | grep -qw \"\$pod\""
}
if ! ingress_ok; then
  echo "  stale ingress: re-creating the integration so the charm republishes its address"
  vm "juju remove-relation $APP $INGRESS_APP
      while juju status --relations | grep -q '$INGRESS_APP:ingress'; do sleep 3; done
      juju integrate $APP $INGRESS_APP
      juju wait-for application $INGRESS_APP --query='status==\"active\"' --timeout=5m >/dev/null"
  for _ in $(seq 1 30); do ingress_ok && break; sleep 2; done
fi
echo "  ok"

step "Resolving http://$API_HOST -> $VM_IP (local /etc/hosts entry, removed by stop.sh)"
if ! grep -qE "^$VM_IP[[:space:]]+$API_HOST # adaptive-form-demo$" /etc/hosts; then
  $SUDO sh -c "sed -i '/[[:space:]]$API_HOST # adaptive-form-demo\$/d' /etc/hosts && echo '$VM_IP $API_HOST # adaptive-form-demo' >> /etc/hosts"
fi
for i in $(seq 1 30); do
  curl -fsS -m 5 -o /dev/null "http://$API_HOST/" && break
  [[ $i == 30 ]] && { echo "API not reachable at http://$API_HOST/" >&2; exit 1; }
  sleep 2
done
echo "  $(curl -fsS "http://$API_HOST/")"

step "Serving the sample landing page on http://localhost:$SITE_PORT (127.0.0.1 only)"
if [[ -f "$RUN/site.pid" ]] && kill -0 "$(cat "$RUN/site.pid")" 2>/dev/null; then
  echo "  already running"
else
  nohup python3 -m http.server "$SITE_PORT" --bind 127.0.0.1 -d "$ROOT/dummy_site" >"$RUN/site.log" 2>&1 &
  echo $! >"$RUN/site.pid"
  sleep 1
  curl -fsS -o /dev/null "http://localhost:$SITE_PORT/" && echo "  ok"
fi

cat <<EOF

Demo is up:
  Landing page : http://localhost:$SITE_PORT/
  API (Juju)   : http://$API_HOST/      metrics: http://$API_HOST/metrics
Stop everything with: demo/stop.sh
EOF

if [[ "$SIMULATE" -gt 0 ]]; then
  step "Simulating $SIMULATE visitors with Puppeteer"
  PATH="$PATH:$HOME/.local/opt/node/bin"
  cd "$ROOT/simulation"
  [[ -d node_modules ]] || npm install
  node simulate.js --url "http://localhost:$SITE_PORT/" --api "http://$API_HOST" --visitors "$SIMULATE" --fast $HEADFUL
fi
