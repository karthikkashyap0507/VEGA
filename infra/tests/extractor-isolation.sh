#!/usr/bin/env bash
# =============================================================================
# EXTRACTOR ISOLATION TEST — docs/module3.md §11.3 (BLOCKING): "Extractor isolation (pod cannot
# reach tools or egress)" and §12 "Quarantined extractor pod has no tool access and no egress
# (proven by test)". Runs against a DEPLOYED cluster, with raw sockets from inside the pod.
#
#   PREFIX=vega infra/tests/extractor-isolation.sh
# =============================================================================
set -uo pipefail

PREFIX="${PREFIX:-vega}"
CO="${PREFIX}-control"; XE="${PREFIX}-execution"; EV="${PREFIX}-evidence"
PUBLIC_PROBE="${PUBLIC_PROBE:-1.1.1.1}"
failures=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

tcp() {
  kubectl -n "$1" exec "deploy/$2" -- node -e "
    const s = require('net').connect({ host: '$3', port: $4, timeout: 3000 });
    s.on('connect', () => { s.destroy(); process.exit(0); });
    s.on('timeout', () => process.exit(1));
    s.on('error', () => process.exit(1));
  " >/dev/null 2>&1
}
resolve() {
  kubectl -n "$XE" exec deploy/extractor -- node -e "require('dns').lookup('$1', (e, a) => console.log(e ? '' : a))" 2>/dev/null
}

echo "Extractor isolation test (prefix=${PREFIX})"
echo "================================================================"

echo "[0] It holds nothing but its token and a model key"
env_keys=$(kubectl -n "$XE" exec deploy/extractor -- env 2>/dev/null | cut -d= -f1)
bad=$(echo "$env_keys" | grep -E '^(DATABASE|EVIDENCE|LOCAL_KEK|KMS_|EXECUTION_INTERNAL_TOKEN|SESSION_SECRET|CONNECTOR_STATE|GOOGLE_|MICROSOFT_|SLACK_|OPENFGA|VALKEY)' | tr '\n' ' ')
if [ -z "$bad" ]; then pass "no database, KEK, connector or platform secret in the extractor environment"; else fail "extractor environment carries: $bad"; fi
if kubectl -n "$XE" exec deploy/extractor -- test -e /var/run/secrets/kubernetes.io/serviceaccount/token 2>/dev/null; then fail "extractor has a service-account token"; else pass "extractor has no service-account token"; fi
if kubectl -n "$XE" exec deploy/extractor -- sh -c 'ls /app/packages/connectors/*/src 2>/dev/null | head -1' >/dev/null && \
   kubectl -n "$XE" exec deploy/extractor -- node -e "process.exit(Object.keys(process.env).some(k => /TOKEN/.test(k) && k !== 'EXTRACTOR_TOKEN') ? 1 : 0)" 2>/dev/null; then
  pass "the only token in the extractor is its own service token"
else
  fail "the extractor holds a token other than EXTRACTOR_TOKEN"
fi

echo "[1] No tools, no data, no web — raw sockets from inside the pod"
if tcp "$XE" extractor "$PUBLIC_PROBE" 443; then fail "extractor → ${PUBLIC_PROBE}:443 OPENED (general egress)"; else pass "extractor has no general internet egress"; fi
if tcp "$XE" extractor 169.254.169.254 80; then fail "extractor → cloud metadata OPENED"; else pass "extractor → 169.254.169.254 blocked"; fi
for target in "execution.${XE}.svc:3003" "web-fetch.${XE}.svc:3005" "control.${CO}.svc:3002" "gateway.${CO}.svc:3001" "evidence.${EV}.svc:3004" "postgres-primary.${CO}.svc:5432" "valkey.${CO}.svc:6379" "openfga.${CO}.svc:8080" "postgres-evidence.${EV}.svc:5432"; do
  host="${target%%:*}"; port="${target##*:}"
  ip=$(resolve "$host")
  if [ -n "$ip" ] && tcp "$XE" extractor "$ip" "$port"; then fail "extractor → ${host}:${port} OPENED"; else pass "extractor → ${host}:${port} blocked"; fi
done
api=$(kubectl get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}')
if tcp "$XE" extractor "$api" 443; then fail "extractor → Kubernetes API OPENED"; else pass "extractor → Kubernetes API blocked"; fi
for host in gmail.googleapis.com graph.microsoft.com slack.com; do
  ip=$(resolve "$host")
  if [ -n "$ip" ] && tcp "$XE" extractor "$ip" 443; then fail "extractor → ${host} (a connector API) OPENED"; else pass "extractor → ${host} (connector API) blocked"; fi
done

echo "[2] Only the interpreter can call it"
if tcp "$XE" execution "extractor.${XE}.svc" 3006; then pass "positive control: execution → extractor:3006 opens"; else fail "positive control: execution → extractor:3006 blocked"; fi
for from in "$CO control" "$CO gateway" "$EV evidence" "$XE web-fetch"; do
  set -- $from
  if tcp "$1" "$2" "extractor.${XE}.svc" 3006; then fail "$2 → extractor OPENED"; else pass "$2 → extractor blocked"; fi
done

echo "================================================================"
if [ "$failures" -gt 0 ]; then
  echo "${failures} check(s) FAILED — the quarantined extractor is not quarantined. P0."
  exit 1
fi
echo "All extractor isolation checks passed."
