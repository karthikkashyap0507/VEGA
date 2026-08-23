# infra

- `docker/` - local development stack (Module 1)
- `k8s/` - Helm charts, four namespaces, Cilium policies (Module 1 deploy)
- `tofu/` - OpenTofu IaC (Module 1 deploy)

The four-namespace separation is a security control, not a layout preference.
See docs/module1.md section 3.1 and docs/PROJECT.md section 10.2 (invariant 1).
