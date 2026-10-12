/**
 * The EVIDENCE contract (docs/module7.md §5.1, §5.7): what an action's receipt commits to, and
 * the replay tape that lets the evidence plane re-run the decision without the primary database.
 *
 * Rules every field obeys:
 *   · digests, never plaintext — "sha256:<hex>" over the exact bytes kept in the evidence
 *     plane's content-addressed store (JSON is stored as RFC 8785 JCS bytes)
 *   · snake_case: this is the document an auditor reads, and it is the published format
 *   · additive only: a new field is optional; a changed meaning is a new `receipt_version`
 */

export const RECEIPT_VERSION = 1;
export const TAPE_VERSION = 1;

/** Entry kinds the chain carries (module7.md §4.1). Payloads of other kinds are platform events. */
export const ENTRY_KINDS = [
  'action.pre',
  'action.post',
  'approval',
  'hold',
  'compensation.succeeded',
  'compensation.failed',
  'policy.activated',
  'autonomy.changed',
  'admin',
  'taint.violation',
  'run.program',
  'redaction',
  'evidence.pack_built',
  'replay.recorded',
] as const;

export interface ReceiptPolicy {
  decision: string;
  evaluation_id: string | null;
  decided_by: string | null;
  reason: string | null;
  fail_closed: boolean;
  preset: string | null;
  preset_version: number | null;
  bundle_version: number | null;
  bundle_revision: string | null;
  /** The OPA input this decision was made on (content). */
  input_digest: string | null;
}

export interface ReceiptRisk {
  score: number | null;
  tier: string | null;
  weights_version: number | null;
  /** The risk function's input (content). */
  input_digest: string | null;
  factors?: Record<string, number> | undefined;
}

/** §5.1. The `action.pre` entry is committed BEFORE the call; `action.post` records what happened. */
export interface ActionReceipt {
  receipt_version: typeof RECEIPT_VERSION;
  phase: 'pre' | 'post';
  /** The journal row of the call (task_nodes.id): stable across retries and replays. */
  action_id: string;
  run_id: string;
  actor: { principal: string; on_behalf_of: string; agent: string; agent_version: number; agent_identity: string | null };
  tool: { id: string; connector: string; egress: string; reversibility: string; idempotency: string; decl_version: number };
  connector_id: string | null;
  arguments_digest: string;
  arg_taint: string;
  inputs_read: Array<{ source: string; taint: string }>;
  program: { version: number; digest: string | null; call_seq: number; node_id: string };
  model: { id: string | null; prompt_version: string | null };
  policies_evaluated: Array<{ id: string; version: number | null; decision: string; citation: string | null }>;
  policy: ReceiptPolicy | null;
  risk: ReceiptRisk | null;
  /** Who approved and `evidence_digest`: the SHA-256 of the decision packet they were shown (Module 8). */
  approval: { required: boolean; granted: boolean; approver_role: string | null; by: string[]; evidence_digest: string | null; request_id?: string } | null;
  hold: { window_ms: number; released: boolean; revoked: boolean } | null;
  /** The recorded inputs a replay needs (content): see ReplayTape. Pre only. */
  replay_tape_digest?: string | undefined;
  /** People and domains the action reaches — the Audit Explorer's "data subject" facet. */
  subjects: string[];
  outcome?: 'COMMITTED' | 'FAILED' | 'UNKNOWN' | undefined;
  /** The tool's result (content). Post only, when there was one. */
  effect_digest?: string | null | undefined;
  effect_summary?: string | null | undefined;
  error?: string | null | undefined;
  /** Module 9: the verification of this phase — its row, verdict, and the checks (content). */
  verification?: { id: string | null; phase: 'pre_commit' | 'post_commit'; outcome: string; failed_check: string | null; checks_digest: string } | undefined;
}

/**
 * §5.7 — everything a DRY re-execution of the program up to this call reads, as recorded. The
 * interpreter is deterministic (no clock, no randomness): the same tape gives the same calls,
 * the same arguments and the same taint, or there is a bug.
 */
export interface ReplayTape {
  tape_version: typeof TAPE_VERSION;
  tenant_id: string;
  run_id: string;
  program: { version: number; digest: string; content_digest: string; model_id: string; now: string };
  inputs: Record<string, { data: unknown; taint: 'TRUSTED' | 'ORG' | 'UNTRUSTED'; sourceId?: string }>;
  max_collection: number;
  /** Declarations of every tool the program names, as they were (content). */
  declarations_digest: string;
  /** Calls before the target, in order: the result each one returned (content). */
  calls: Array<{ seq: number; tool_id: string; args_digest: string; result_digest: string }>;
  extractions: Array<{ seq: number; schema: string; value_digest: string | null; error?: string }>;
  lookups: Array<{ seq: number; registry: 'directory' | 'contacts'; key: string; entity: unknown }>;
  target: { call_seq: number; tool_id: string; args_digest: string; arg_taint: string; arg_taints_digest: string };
  /** The deterministic decision layers, with their inputs (content). */
  decision: {
    risk_input_digest: string | null;
    weights: Record<string, unknown> | null;
    policy_input_digest: string | null;
    preset: string | null;
    preset_version: number | null;
    bundle_version: number | null;
    matches: Array<{ id: string; version: number }>;
    recorded: { decision: string; decided_by: string | null; risk_score: number | null; risk_tier: string | null };
  } | null;
}

/** `policy.activated` (control plane): the documents in force, so replay and packs need nothing else. */
export interface PolicyActivatedRecord {
  bundle_id: string;
  version: number;
  previous_version: number | null;
  digest: string;
  simulation_id: string | null;
  activated_by: string;
  policies: Array<{ key: string; version: number; document_digest: string; citation: string | null }>;
}
