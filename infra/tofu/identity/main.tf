# =============================================================================
# Identity provisioning — Zitadel (docs/module1.md §5.5, implementation plan Step 8).
#
# The deployed-environment counterpart of scripts/zitadel-bootstrap.ts. It creates exactly the
# objects the platform needs and nothing else:
#   · a project, and a WEB OIDC app with private_key_jwt + PKCE (no shared secret exists)
#   · the provisioner service account (IAM_OWNER: it creates one organization per tenant)
#   · JSON keys for both, emitted as SENSITIVE outputs for the secret store — never to disk
#
# Tenant organizations, human users and agent machine users are NOT managed here: they are
# runtime data created by the control plane, and must never be in Terraform state.
# =============================================================================
terraform {
  required_version = ">= 1.8"
  required_providers {
    zitadel = { source = "zitadel/zitadel", version = "~> 2.2" }
  }
}

variable "zitadel_domain" { type = string }
variable "zitadel_port" {
  type    = string
  default = "443"
}
variable "zitadel_insecure" {
  type    = bool
  default = false
}
variable "zitadel_token_file" {
  type        = string
  description = "Path to an admin credential: a JWT-profile key JSON, or a PAT file when use_pat = true."
}
variable "use_pat" {
  type    = bool
  default = false
}
variable "org_id" {
  type        = string
  description = "The platform's own organization (hosts the project and provisioner)."
}
variable "name" {
  type        = string
  description = "Product name (from packages/shared/src/brand.ts) — used for project/app names."
}
variable "gateway_public_url" { type = string }
variable "web_public_url" { type = string }
variable "key_expiration" {
  type    = string
  default = "2027-01-01T00:00:00Z"
}

provider "zitadel" {
  domain           = var.zitadel_domain
  port             = var.zitadel_port
  insecure         = var.zitadel_insecure
  jwt_profile_file = var.use_pat ? null : var.zitadel_token_file
  access_token     = var.use_pat ? trimspace(file(var.zitadel_token_file)) : null
}

resource "zitadel_project" "platform" {
  org_id = var.org_id
  name   = var.name
}

resource "zitadel_application_oidc" "web" {
  org_id                      = var.org_id
  project_id                  = zitadel_project.platform.id
  name                        = "${lower(var.name)}-web"
  redirect_uris               = ["${var.gateway_public_url}/v1/oauth/callback"]
  post_logout_redirect_uris   = ["${var.web_public_url}/"]
  response_types              = ["OIDC_RESPONSE_TYPE_CODE"]
  grant_types                 = ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"]
  app_type                    = "OIDC_APP_TYPE_WEB"
  auth_method_type            = "OIDC_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT"
  access_token_type           = "OIDC_TOKEN_TYPE_JWT"
  id_token_userinfo_assertion = true
  dev_mode                    = startswith(var.gateway_public_url, "http://")
}

resource "zitadel_application_key" "web" {
  org_id          = var.org_id
  project_id      = zitadel_project.platform.id
  app_id          = zitadel_application_oidc.web.id
  key_type        = "KEY_TYPE_JSON"
  expiration_date = var.key_expiration
}

resource "zitadel_machine_user" "provisioner" {
  org_id            = var.org_id
  user_name         = "${lower(var.name)}-provisioner"
  name              = "${var.name} provisioner"
  description       = "Creates tenant organizations and agent machine users."
  access_token_type = "ACCESS_TOKEN_TYPE_JWT"
}

resource "zitadel_instance_member" "provisioner" {
  user_id = zitadel_machine_user.provisioner.id
  roles   = ["IAM_OWNER"]
}

resource "zitadel_machine_key" "provisioner" {
  org_id          = var.org_id
  user_id         = zitadel_machine_user.provisioner.id
  key_type        = "KEY_TYPE_JSON"
  expiration_date = var.key_expiration
}

output "client_id" {
  # Not a secret (it is in every authorize URL); the provider marks it sensitive anyway.
  value = nonsensitive(zitadel_application_oidc.web.client_id)
}
output "app_key_json" {
  value     = zitadel_application_key.web.key_details
  sensitive = true
}
output "provisioner_key_json" {
  value     = zitadel_machine_key.provisioner.key_details
  sensitive = true
}
