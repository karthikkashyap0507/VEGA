#!/usr/bin/env bash
# =============================================================================
# PLANE SEPARATION POLICY TEST — docs/module1.md §11.4. A failure here is a P0.
#
# Runs against a DEPLOYED cluster (the platform chart). Application code cannot enforce
# invariant 1; this proves the infrastructure does:
#
#   1. the execution service account has NO credential for the evidence database
#   2. a pod in the execution plane cannot open TCP to the evidence database
#   3. the evidence plane cannot initiate a connection to the execution plane
#   4. the execution service account cannot read the evidence signing key
#
# plus the mTLS boundary and default-deny coverage. Every negative check is paired with a
# POSITIVE CONTROL on the same path, so "blocked" can never mean "the network is broken".
#
#   PREFIX=vega infra/tests/plane-separation.sh
#   KMS_DENY_CHECK='<cmd that must FAIL when run with the execution identity>'   (cloud envs)
# =============================================================================
set -uo pipefail

PREFIX="${PREFIX:-vega}"
EX="${PREFIX}-experience"; CO="${PREFIX}-control"; XE="${PREFIX}-execution"; EV="${PREFIX}-evidence"
failures=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

# tcp <namespace> <deployment> <host> <port>  → exit 0 if a TCP connection opens within 3s
tcp() {
  kubectl -n "$1" exec "deploy/$2" -- node -e "
    const s = require('net').connect({ host: '$3', port: $4, timeout: 3000 });
    s.on('connect', () => { s.destroy(); process.exit(0); });
    s.on('timeout', () => process.exit(1));
    s.on('error', () => process.exit(1));
  " >/dev/null 2>&1
}

# https <namespace> <deployment> <url> <method> [present-cert:yes|no] → prints HTTP status or TLSFAIL
https() {
  kubectl -n "$1" exec "deploy/$2" -- node -e "
    const fs = require('fs'), https = require('https');
    const withCert = '${5:-yes}' === 'yes';
    const u = new URL('$3');
    const req = https.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: '$4',
      ca: fs.readFileSync('/tls/ca.crt'),
      ...(withCert ? { cert: fs.readFileSync('/tls/tls.crt'), key: fs.readFileSync('/tls/tls.key') } : {}),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (process.env.EVIDENCE_APPEND_TOKEN || '') },
      timeout: 5000 }, (res) => { done(String(res.statusCode)); res.resume(); });
    let reported = false;
    function done(v) { if (!reported) { reported = true; console.log(v); } }
    req.on('error', () => done('TLSFAIL'));
    req.on('timeout', () => { done('TIMEOUT'); req.destroy(); });
    if ('$4' === 'POST') req.write(JSON.stringify({ tenantId: '7a2c1d33-2b6e-4a5f-8f2e-1c9d0b7a6e22', source: 'policy-test', kind: 'plane.separation', payload: { ok: true } }));
    req.end();
  " 2>/dev/null
}

echo "Plane separation policy test (prefix=${PREFIX})"
echo "================================================================"

echo "[0] Coverage"
for ns in "$EX" "$CO" "$XE" "$EV"; do
  if kubectl -n "$ns" get ciliumnetworkpolicy default-deny >/dev/null 2>&1; then pass "$ns has default-deny"; else fail "$ns has NO default-deny policy"; fi
done

echo "[1] The execution plane holds no evidence-database credential"
leak=$(kubectl -n "$XE" get secrets -o json | node -e "
  const s = JSON.parse(require('fs').readFileSync(0));
  const bad = s.items.flatMap(i => Object.keys(i.data || {}).filter(k => /EVIDENCE_(DATABASE|WRITER)_URL|EVIDENCE_READER/.test(k)).map(k => i.metadata.name + '/' + k));
  console.log(bad.join(','));")
if [ -z "$leak" ]; then pass "no Secret in $XE carries an evidence-DB credential"; else fail "evidence-DB credential present in $XE: $leak"; fi
if kubectl -n "$XE" exec deploy/execution -- env 2>/dev/null | grep -qE '^EVIDENCE_(DATABASE|WRITER)_URL='; then
  fail "the execution container environment contains an evidence-DB URL"
else
  pass "the execution container environment has no evidence-DB URL"
fi
for target in "$EV" "$CO"; do
  can=$(kubectl auth can-i get secrets -n "$target" --as="system:serviceaccount:${XE}:execution" 2>/dev/null)
  if [ "$can" = "no" ]; then pass "execution SA cannot read Secrets in $target"; else fail "execution SA CAN read Secrets in $target"; fi
done

echo "[2] Execution cannot open TCP to the evidence database"
if tcp "$XE" execution "evidence.${EV}.svc" 3004; then pass "positive control: execution → evidence:3004 opens"; else fail "positive control: execution → evidence:3004 is blocked (network broken?)"; fi
if tcp "$XE" execution "postgres-evidence.${EV}.svc" 5432; then fail "execution → evidence DB:5432 OPENED"; else pass "execution → evidence DB:5432 blocked"; fi
if tcp "$EV" evidence "postgres-evidence.${EV}.svc" 5432; then pass "positive control: evidence → evidence DB:5432 opens"; else fail "positive control: evidence → evidence DB is blocked"; fi

echo "[3] The evidence plane cannot initiate a connection to the execution plane"
if tcp "$CO" control "execution.${XE}.svc" 3003; then pass "positive control: control → execution:3003 opens"; else fail "positive control: control → execution:3003 is blocked"; fi
if tcp "$EV" evidence "execution.${XE}.svc" 3003; then fail "evidence → execution:3003 OPENED"; else pass "evidence → execution:3003 blocked"; fi
if tcp "$EV" evidence "postgres-primary.${CO}.svc" 5432; then fail "evidence → primary DB OPENED"; else pass "evidence → primary DB blocked"; fi

echo "[4] The execution identity cannot use the evidence signing key"
can=$(kubectl auth can-i get secret/signing-key -n "$EV" --as="system:serviceaccount:${XE}:execution" 2>/dev/null)
if [ "$can" = "no" ]; then pass "execution SA cannot read the evidence signing key Secret"; else fail "execution SA CAN read the signing key"; fi
if [ -n "${KMS_DENY_CHECK:-}" ]; then
  if eval "$KMS_DENY_CHECK" >/dev/null 2>&1; then fail "KMS: the execution identity could use the signing key"; else pass "KMS denies the execution identity"; fi
else
  echo "  SKIP  cloud KMS check (set KMS_DENY_CHECK in deployed environments)"
fi

echo "[5] The only way in is /append, over mTLS"
status=$(https "$XE" execution "https://evidence.${EV}.svc:3004/append" POST yes)
if [ "$status" = "201" ]; then pass "execution → evidence POST /append over mTLS: 201"; else fail "execution → evidence /append returned '$status'"; fi
status=$(https "$XE" execution "https://evidence.${EV}.svc:3004/entries" GET yes)
if [ "$status" = "404" ] || [ "$status" = "405" ]; then pass "execution → evidence GET /entries: $status (no read path)"; else fail "execution could read from evidence: '$status'"; fi
status=$(https "$XE" execution "https://evidence.${EV}.svc:3004/append" POST no)
if [ "$status" = "TLSFAIL" ]; then pass "evidence refuses a client with no certificate"; else fail "evidence accepted a client without a certificate: '$status'"; fi
status=$(https "$CO" gateway "https://control.${CO}.svc:3002/trpc/me.get" GET no)
if [ "$status" = "TLSFAIL" ]; then pass "control refuses a client with no certificate"; else fail "control accepted a client without a certificate: '$status'"; fi

echo "================================================================"
if [ "$failures" -gt 0 ]; then
  echo "${failures} check(s) FAILED — plane separation is violated. This is a P0."
  exit 1
fi
echo "All plane-separation checks passed."
