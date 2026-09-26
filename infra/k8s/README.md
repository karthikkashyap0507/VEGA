# infra/k8s

Kubernetes is deployed from **`infra/helm/platform`** (the chart) through **`infra/argocd`**.
This directory holds nothing hand-applied: plane separation is enforced by the chart's Cilium
policies and verified by `infra/tests/plane-separation.sh` (docs/module1.md §11.4).

Prerequisites in the cluster: Cilium (CNI and policy), cert-manager (the plane CA and workload
certificates), and — in deployed environments — External Secrets for the per-plane Secrets.
