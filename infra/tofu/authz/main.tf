# =============================================================================
# Authorization provisioning — OpenFGA (docs/module1.md §5.4, implementation plan Step 4/8).
#
# The model is the checked-in DSL at packages/authz/model/model.fga — the same file the
# assertion tests run against. Changing it creates a NEW model version (models are immutable);
# the control plane pins OPENFGA_MODEL_ID, so a model deploy never changes the answer to an
# in-flight check.
# =============================================================================
terraform {
  required_version = ">= 1.8"
  required_providers {
    openfga = { source = "openfga/openfga", version = "~> 0.2" }
  }
}

variable "api_url" { type = string }
variable "api_token" {
  type      = string
  default   = null
  sensitive = true
}
variable "store_name" { type = string }

provider "openfga" {
  api_url   = var.api_url
  api_token = var.api_token
}

data "openfga_authorization_model_document" "model" {
  dsl = file("${path.module}/../../../packages/authz/model/model.fga")
}

resource "openfga_store" "platform" {
  name = var.store_name
}

resource "openfga_authorization_model" "platform" {
  store_id   = openfga_store.platform.id
  model_json = data.openfga_authorization_model_document.model.result
}

output "store_id" { value = openfga_store.platform.id }
output "model_id" { value = openfga_authorization_model.platform.id }
