-- INVARIANT 1 (docs/PROJECT.md 10.2), enforced at the grant level.
--
-- The execution plane may APPEND to the evidence plane and nothing else.
-- Four layers enforce this: network policy, this grant, a trigger, and IAM on the
-- signing key. This file is the second layer. Do not add UPDATE or DELETE here.

CREATE ROLE vega_evi_writer LOGIN PASSWORD 'vega_evi_writer_local';
CREATE ROLE vega_evi_reader LOGIN PASSWORD 'vega_evi_reader_local';

GRANT CONNECT ON DATABASE vega_evidence TO vega_evi_writer, vega_evi_reader;
GRANT USAGE ON SCHEMA public TO vega_evi_writer, vega_evi_reader;

-- writer: INSERT ONLY. No SELECT, no UPDATE, no DELETE.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO vega_evi_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO vega_evi_writer;

-- reader: SELECT only, used by the evidence service query/pack path (M7).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO vega_evi_reader;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
