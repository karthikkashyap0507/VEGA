#!/usr/bin/env bash
# Creates the per-plane Secrets for a local policy-test cluster (values-dev-cluster.yaml).
# Deployed environments source these from External Secrets / OpenBao instead.
#
# Note what each plane receives — and what it does not:
#   control    primary DB (owner for dev migrations + app role), session secret, KEK, OpenFGA, Valkey
#   execution  the evidence APPEND token and the primary app role. NO evidence-DB credential.
#   evidence   evidence owner + INSERT-only writer URLs, the append token, a dev signing key
set -euo pipefail
PREFIX="${PREFIX:-vega}"
CO="${PREFIX}-control"; XE="${PREFIX}-execution"; EV="${PREFIX}-evidence"
APPEND_TOKEN="$(openssl rand -hex 24)"
PRIMARY="postgres-primary.${CO}.svc:5432"
EVIDB="postgres-evidence.${EV}.svc:5432"

RELEASE="${RELEASE:-platform}"
# The chart owns these namespaces; mark them so `helm install` adopts rather than refuses them.
for ns in "$CO" "$XE" "$EV"; do
  kubectl get ns "$ns" >/dev/null 2>&1 || kubectl create ns "$ns" >/dev/null
  kubectl label ns "$ns" app.kubernetes.io/managed-by=Helm --overwrite >/dev/null
  kubectl annotate ns "$ns" meta.helm.sh/release-name="$RELEASE" meta.helm.sh/release-namespace=default --overwrite >/dev/null
done

kubectl -n "$CO" create secret generic control-secrets --dry-run=client -o yaml \
  --from-literal=DATABASE_URL="postgresql://vega:vega_local_dev_only@${PRIMARY}/vega" \
  --from-literal=DATABASE_APP_URL="postgresql://vega_app:vega_app_local_dev_only@${PRIMARY}/vega" \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')" \
  --from-literal=LOCAL_KEK_BASE64="$(openssl rand -base64 32)" \
  --from-literal=OPENFGA_API_URL="http://openfga.${CO}.svc:8080" \
  --from-literal=VALKEY_URL="redis://valkey.${CO}.svc:6379" | kubectl apply -f - >/dev/null

kubectl -n "$XE" create secret generic execution-secrets --dry-run=client -o yaml \
  --from-literal=EVIDENCE_APPEND_TOKEN="$APPEND_TOKEN" \
  --from-literal=DATABASE_APP_URL="postgresql://vega_app:vega_app_local_dev_only@${PRIMARY}/vega" | kubectl apply -f - >/dev/null

kubectl -n "$EV" create secret generic evidence-secrets --dry-run=client -o yaml \
  --from-literal=EVIDENCE_DATABASE_URL="postgresql://vega_evi:vega_evi_local_dev_only@${EVIDB}/vega_evidence" \
  --from-literal=EVIDENCE_WRITER_URL="postgresql://vega_evi_writer:vega_evi_writer_local@${EVIDB}/vega_evidence" \
  --from-literal=EVIDENCE_APPEND_TOKEN="$APPEND_TOKEN" | kubectl apply -f - >/dev/null

# Stand-in for the evidence signing key (Module 7 uses KMS/HSM). Present so the test can prove
# the execution identity cannot read it.
kubectl -n "$EV" create secret generic signing-key --dry-run=client -o yaml \
  --from-literal=key="$(openssl rand -base64 32)" | kubectl apply -f - >/dev/null
echo "per-plane secrets created"
