-- OpenFGA keeps its own tables (store, tuple, authorization_model, ...). They must not live in the
-- application's database: the RLS coverage suite requires every table in `vega` to be either
-- tenant-scoped or an explicitly declared global, and OpenFGA's are neither.
CREATE DATABASE vega_openfga OWNER vega;
