#!/usr/bin/env bash
# =============================================================================
# WEB-FETCH ISOLATION TEST — docs/module2.md §10.3 and §13 ("Web-fetch pod cannot reach cloud
# metadata or private ranges (test proves it)"). Runs against a DEPLOYED cluster.
#
# The application refuses private destinations itself (safeFetch). This test deliberately
# goes AROUND the application — raw sockets from inside the pod — to prove the NETWORK refuses
# them too. Every negative check has a positive control on the same pod.
#
#   PREFIX=vega infra/tests/web-fetch-isolation.sh
#   PUBLIC_PROBE=1.1.1.1   (any public address that accepts TCP/443 from your cluster)
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
  kubectl -n "$XE" exec deploy/web-fetch -- node -e "require('dns').lookup('$1', (e, a) => console.log(e ? '' : a))" 2>/dev/null
}
# POST to web-fetch /fetch from the execution pod over mTLS → prints "status error-code"
fetch_via_app() {
  kubectl -n "$XE" exec deploy/execution -- node -e "
    const fs = require('fs'), https = require('https');
    const req = https.request({ hostname: 'web-fetch.${XE}.svc', port: 3005, path: '/fetch', method: 'POST',
      ca: fs.readFileSync('/tls/ca.crt'), cert: fs.readFileSync('/tls/tls.crt'), key: fs.readFileSync('/tls/tls.key'),
      headers: { 'content-type': 'application/json' }, timeout: 8000 }, (res) => {
        let b = ''; res.on('data', (c) => b += c); res.on('end', () => {
          let code = ''; try { code = JSON.parse(b).error?.code ?? ''; } catch {}
          console.log(res.statusCode + ' ' + code);
        });
      });
    req.on('error', (e) => console.log('ERR ' + e.code));
    req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); });
    req.write(JSON.stringify({ url: '$1' })); req.end();
  " 2>/dev/null
}

echo "Web-fetch isolation test (prefix=${PREFIX})"
echo "================================================================"

echo "[0] Nothing worth stealing"
spec=$(kubectl -n "$XE" get deploy web-fetch -o json)
if echo "$spec" | node -e "const d=JSON.parse(require('fs').readFileSync(0)); const c=d.spec.template.spec.containers; process.exit(c.some(x => (x.envFrom||[]).length || (x.env||[]).some(e => e.valueFrom && e.valueFrom.secretKeyRef)) ? 1 : 0)"; then
  pass "web-fetch mounts no Secret (envFrom / secretKeyRef)"
else
  fail "web-fetch has a Secret in its environment"
fi
if kubectl -n "$XE" exec deploy/web-fetch -- test -e /var/run/secrets/kubernetes.io/serviceaccount/token 2>/dev/null; then
  fail "web-fetch has a service-account token mounted"
else
  pass "web-fetch has no service-account token"
fi
can=$(kubectl auth can-i --list -n "$XE" --as="system:serviceaccount:${XE}:web-fetch" 2>/dev/null | grep -cE '^(secrets|pods|configmaps) ')
if [ "$can" = "0" ]; then pass "web-fetch SA has no RBAC on secrets/pods/configmaps"; else fail "web-fetch SA has RBAC grants"; fi

echo "[1] Network layer: raw sockets from inside the pod (bypassing the application)"
if tcp "$XE" web-fetch "$PUBLIC_PROBE" 443; then pass "positive control: web-fetch → ${PUBLIC_PROBE}:443 opens"; else fail "positive control: web-fetch → ${PUBLIC_PROBE}:443 blocked (network broken, or PUBLIC_PROBE unreachable)"; fi
if tcp "$XE" web-fetch "$PUBLIC_PROBE" 22; then fail "web-fetch → ${PUBLIC_PROBE}:22 OPENED (only 80/443 allowed)"; else pass "web-fetch → public:22 blocked (ports 80/443 only)"; fi
if tcp "$XE" web-fetch 169.254.169.254 80; then fail "web-fetch → cloud metadata 169.254.169.254:80 OPENED"; else pass "web-fetch → 169.254.169.254:80 (cloud metadata) blocked"; fi
if tcp "$XE" web-fetch 169.254.169.254 443; then fail "web-fetch → 169.254.169.254:443 OPENED"; else pass "web-fetch → 169.254.169.254:443 blocked"; fi
api=$(kubectl get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}')
if tcp "$XE" web-fetch "$api" 443; then fail "web-fetch → Kubernetes API ${api}:443 OPENED"; else pass "web-fetch → Kubernetes API ${api}:443 blocked"; fi
for target in "gateway.${CO}.svc:3001" "control.${CO}.svc:3002" "execution.${XE}.svc:3003" "evidence.${EV}.svc:3004" "postgres-primary.${CO}.svc:5432" "valkey.${CO}.svc:6379"; do
  host="${target%%:*}"; port="${target##*:}"
  ip=$(resolve "$host")
  if [ -n "$ip" ] && tcp "$XE" web-fetch "$ip" "$port"; then fail "web-fetch → ${host}:${port} (${ip}) OPENED"; else pass "web-fetch → ${host}:${port} blocked"; fi
  if [ -n "$ip" ] && tcp "$XE" web-fetch "$ip" 443; then fail "web-fetch → ${ip}:443 OPENED (private range on an allowed port)"; fi
done
for ip in 10.0.0.1 172.16.0.1 192.168.0.1 100.64.0.1; do
  if tcp "$XE" web-fetch "$ip" 443; then fail "web-fetch → ${ip}:443 OPENED"; else pass "web-fetch → ${ip}:443 (private range) blocked"; fi
done

echo "[2] Only the execution plane can call web-fetch"
if tcp "$XE" execution "web-fetch.${XE}.svc" 3005; then pass "positive control: execution → web-fetch:3005 opens"; else fail "positive control: execution → web-fetch:3005 blocked"; fi
if tcp "$CO" control "web-fetch.${XE}.svc" 3005; then fail "control → web-fetch:3005 OPENED"; else pass "control → web-fetch:3005 blocked"; fi
if tcp "$CO" gateway "web-fetch.${XE}.svc" 3005; then fail "gateway → web-fetch:3005 OPENED"; else pass "gateway → web-fetch:3005 blocked"; fi
if tcp "$EV" evidence "web-fetch.${XE}.svc" 3005; then fail "evidence → web-fetch:3005 OPENED"; else pass "evidence → web-fetch:3005 blocked"; fi
if tcp "$XE" execution "$PUBLIC_PROBE" 443; then fail "execution → ${PUBLIC_PROBE}:443 OPENED (execution must not fetch the web itself)"; else pass "execution has no direct public egress"; fi

echo "[3] Application layer agrees (defence in depth)"
for url in "http://169.254.169.254/latest/meta-data/" "http://metadata.google.internal/" "http://postgres-primary.${CO}.svc:5432/" "http://gateway.${CO}.svc.cluster.local:3001/v1/me" "http://127.0.0.1:3005/"; do
  out=$(fetch_via_app "$url")
  case "$out" in
    "403 EGRESS_DENIED") pass "web-fetch refuses ${url} (403 EGRESS_DENIED)" ;;
    *) fail "web-fetch answered '${out}' for ${url}" ;;
  esac
done

echo "================================================================"
if [ "$failures" -gt 0 ]; then
  echo "${failures} check(s) FAILED — the web fetcher can reach something it must not. P0."
  exit 1
fi
echo "All web-fetch isolation checks passed."
