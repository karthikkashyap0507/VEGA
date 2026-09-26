# infra/tofu

OpenTofu (not Terraform — TECHSTACK §3) for the objects the platform needs from its
dependencies. Runtime data (tenant organizations, users, agent machine users, tuples) is never
managed here: it belongs to the control plane and must not live in state.

| Module | Creates | Outputs → secret store |
|---|---|---|
| `identity/` | Zitadel project, private_key_jwt web app + key, provisioner service account + key | `client_id`, `app_key_json`, `provisioner_key_json` |
| `authz/` | OpenFGA store + the model from `packages/authz/model/model.fga` | `OPENFGA_STORE_ID`, `OPENFGA_MODEL_ID` |

State holds private keys: use an encrypted backend (OpenTofu state encryption or a KMS-backed
remote backend). Local development uses `pnpm idp:bootstrap` instead.
