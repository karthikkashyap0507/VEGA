# VEGA — Complete Product Specification

> **Build bible.** This document is the single source of truth for what VEGA is, what it does,
> how it is built, and in what order. If something is not in here, it is not in scope. If this
> document and a conversation disagree, update this document.

**Status:** Living spec — v0.1
**Last updated:** 2026-08-22
**Owner:** karthik5kashyapks@gmail.com
**Codename:** VEGA (placeholder — see §3, trademark conflicts unresolved)

---

## Table of Contents

**Part I — Strategy**
1. [Thesis & Positioning](#1-thesis--positioning)
2. [Competitive Landscape](#2-competitive-landscape)
3. [Naming & Trademark](#3-naming--trademark)
4. [Beachhead Market](#4-beachhead-market)
5. [Capability Map](#5-capability-map)

**Part II — Product**

6. [Product Surfaces](#6-product-surfaces)
7. [C-Series — Core Agent Loop](#7-c-series--core-agent-loop)
8. [D-Series — Differentiators](#8-d-series--differentiators)
9. [P-Series — Platform & Organization](#9-p-series--platform--organization)

**Part III — Engineering**

10. [System Architecture](#10-system-architecture)
11. [Data Model](#11-data-model)
12. [Execution Semantics](#12-execution-semantics)
13. [Risk Scoring Specification](#13-risk-scoring-specification)
14. [Autonomy State Machine](#14-autonomy-state-machine)
15. [Threat Model](#15-threat-model)
16. [Technology Stack](#16-technology-stack)
17. [Repository Layout](#17-repository-layout)
18. [API Surface](#18-api-surface)

**Part IV — Execution**

19. [Build Phases](#19-build-phases)
20. [Testing & Evaluation](#20-testing--evaluation)
21. [Metrics](#21-metrics)
22. [Pricing, Packaging & Market Sequencing](#22-pricing-packaging--market-sequencing)
23. [Compliance Mapping](#23-compliance-mapping)
24. [Risks & Kill Criteria](#24-risks--kill-criteria)
25. [Decision Log & Open Questions](#25-decision-log--open-questions)
26. [Glossary](#26-glossary)

---

# Part I — Strategy

## 1. Thesis & Positioning

### 1.1 The problem

Organizations run on dozens of disconnected tools — email, calendars, documents, chat, CRM,
project management, research tools. The bottleneck is not missing software. It is the human
effort required to coordinate all of it: reading email, scheduling, searching, following up,
preparing reports, updating systems, and moving information between applications.

Traditional automation executes predefined workflows. AI assistants answer questions. Neither
closes the gap, because what is actually needed is an agent that understands a goal, plans the
work, uses the right tools, remembers context, executes, verifies, and knows when to ask a human.

That much is now widely understood — and widely built. Which leads to the harder problem.

### 1.2 The real problem (why the obvious product is not enough)

The generic "AI agent that does your work" category is closed as of August 2026. ChatGPT Work,
Gemini Spark, Microsoft Copilot, and Lindy all ship goal-driven multi-step execution over email
and calendar as a first-party feature. Building the same thing better is not a business.

The unsolved problem is not capability. It is **trust at the moment of consequence**:

- Enterprises cannot let an agent send a client email, move money, or update a system of record,
  because a mistake is unrecoverable and unexplainable.
- So they restrict the agent to read-only summarization.
- So the agent delivers a fraction of its value.
- So the deployment stalls. Gartner projects >40% of agentic AI projects cancelled by end of 2027.

Every vendor responds by adding more restriction. That makes the problem worse, not better.

### 1.3 The claim

> Every AI agent platform makes agents safe by **restricting** them. Their success metric is
> *actions blocked*. VEGA makes agents safe by making actions **reversible, provable, and
> progressively trusted** — so a customer can safely run *more* autonomy here than anywhere else.
> Our success metric is *percentage of work completed with no human touch, at a bounded error rate*.

### 1.4 The strategic keystone

Reversibility is an input to risk. Therefore **making an action reversible lowers its risk tier
and unlocks autonomy**. The safety system is the thing that increases automation:

```
   more reversibility  ──>  lower risk score  ──>  higher autonomy tier
           ▲                                              │
           │                                              ▼
   better compensators  <──  more override data  <──  more actions executed
```

Every engineering hour spent building a compensating action directly increases the share of a
customer's work that can run unattended. Competitors have no equivalent flywheel: a blocked
action generates no learning and no additional value.

### 1.5 The proprietary asset

Architecture is copyable in a weekend. The defensible asset is the **override corpus** — the
record of which actions humans approved, rejected, or edited before release, per action type,
per industry, together with the evidence they saw at the time. It:

- measurably improves risk scoring over a generic LLM judge,
- cannot be bought, scraped, or synthesized,
- compounds with every customer and every operating day,
- is the training set for auto-generated policy (see [D2](#82-d2--earned-autonomy-engine)).

**Protect this.** It is the only asset in the plan that gets harder to replicate over time.
Contractual data rights for aggregate, de-identified override telemetry must be in the standard
MSA from customer #1.

### 1.6 The demo that wins

Not "plan my day" — that is a first-party feature of ChatGPT Work and Gemini Spark. Lead with a
consequential, irreversible, regulated action:

> The agent drafts and sends a client communication that legally requires principal review.
> VEGA shows: the taint provenance of every factual claim in the draft, the policy that triggered
> review, the reviewer's signed approval receipt, the tamper-evident audit entry, and a 10-minute
> window in which the entire action can be pulled back. Then it exports the evidence pack for the
> compliance officer.

No mainstream assistant can produce that artifact today.

### 1.7 Positioning statement

**For** operations and compliance leaders in regulated industries
**who** need AI to do consequential work but cannot accept unrecoverable or unexplainable actions,
**VEGA** is an AI execution platform
**that** makes every agent action reversible, provable, and trusted only as far as it has earned.
**Unlike** Microsoft Agent 365, Zenity, or ChatGPT Work, which reduce risk by restricting what
agents may do,
**VEGA** reduces risk by controlling what agents can *undo*, *prove*, and *have demonstrated* —
which increases how much they are allowed to do.

---

## 2. Competitive Landscape

Verified August 2026. Refresh quarterly — this table drives positioning and must not go stale.

| Layer | Who owns it today | Our stance |
|---|---|---|
| Goal-driven execution over Gmail/Calendar/CRM | ChatGPT Work (Jul 2026, 1400+ connectors, Gmail send w/ per-message approval), Gemini Spark, Lindy (relaunched Feb 2026 as personal exec assistant) | **Parity, not differentiation.** Build it because it is table stakes; never pitch it. |
| Agent governance control plane | Microsoft Agent 365 (GA 2026), Copilot Control System | **Do not compete.** Interoperate — export our audit stream into their control plane. |
| Runtime guardrails / agent security posture | Zenity ($125M Series C), Noma ($100M Series B, per-agent identity + tool-level approve/review/block), WitnessAI ($58M), Prompt Security | **Adjacent.** They observe and block agents they do not run. We run the agent, so we can undo it. That is the wedge. |
| Model routing | OpenRouter, Portkey, LiteLLM, NotDiamond, Martian, RouteLLM, vLLM Semantic Router | **Commodity.** Build internally for cost control ([C4](#74-c4--intelligent-model-router)); never a pricing line or a slide. |
| Agent memory | Mem0, Zep, Letta, plus native memory in every frontier assistant | **Commodity.** Build the minimum ([C7](#77-c7--semantic-memory)). |
| Durable execution / saga infra | Temporal ($300M at $5B, Feb 2026), LangGraph, OpenAI Agents SDK | **Consume, don't rebuild.** The infra exists; the *governed product* on top does not. That gap is D1. |
| Tamper-evident AI audit | Asqav (ML-DSA / FIPS 204 signing), assorted compliance tooling | **Partial overlap.** Signing alone is not a company. Signing an execution we also perform *and can reverse* is. |
| Cross-org agent identity | Emerging (A2A-style protocols) | **Watch.** Not in scope before Phase 4. |

### 2.1 Structural threats

1. **Foundation-model encroachment.** The labs ship features that erase whole startup categories
   every few months. Mitigation: never build what a lab would obviously ship; anchor on
   per-integration compensator engineering and regulated-industry evidence, which they will not
   do because it does not scale horizontally.
2. **Wrapper economics.** Inference cost fell ~80% 2023–2025; margin-on-tokens is not a business.
   Mitigation: price on governed actions and seats of oversight, never on tokens.
3. **Microsoft bundling.** Agent 365 governs agents "regardless of where they were built."
   Mitigation: be one of those agents. Integrate rather than oppose; win on the depth of undo and
   evidence that a generic control plane cannot provide.

---

## 3. Naming & Trademark

**Status: unresolved. Blocking for any public artifact, domain purchase, or launch.**

Conflicts found:

| Name | Entity | Overlap |
|---|---|---|
| VEGA (Reg. #5290045) | Vega Factor Inc., Class 042 computer & software services, live | **Direct legal conflict** |
| VEGA AI (myvega.ai) | AI platform for test-prep & corporate L&D | Category-adjacent |
| Vega Minds | Multi-agent coordination for advisor workflows | **Direct category overlap** |
| Vega Health | Health-system AI procurement & monitoring | Adjacent |
| Vega (vega.io) | Security platform, agentic detection, MCP tooling | **Direct category overlap** |
| vega / vega-lite | Open-source visualization grammar | Permanent SEO and dev-search poisoning |

### 3.1 Actions

1. Formal knockout search with a trademark attorney (US, EU, IN) before spending on brand.
2. Generate candidates. Constraints: `.com` available, no live mark in Class 042 or 009, no OSS
   collision, pronounceable, not a backronym.
3. Keep `VEGA` as the internal codename. **Isolate every brand string behind
   `packages/shared/src/brand.ts`** so the rename is a one-file change.

### 3.2 Retire the backronym

"Virtual Encrypted Goal-driven Agent" should be dropped regardless of naming outcome.
"Encrypted" describes an implementation detail rather than a benefit, and invites security
scrutiny before we have earned it.

---

## 4. Beachhead Market

**The highest-leverage open decision in the project.** The architecture in Part III is
vertical-neutral; policy packs, integrations, and go-to-market are not.

### 4.1 Selection criteria

A qualifying vertical must have **all five**:

1. Actions that are consequential and hard to reverse (money, client communications, records).
2. A **pre-existing, legally mandated human review step** — so we automate an existing paid
   workflow rather than imposing a new burden.
3. Regulatory audit obligations, making evidence packs a purchase requirement not a nicety.
4. A system of record Microsoft has not absorbed.
5. Buyers not already standardized on Copilot for this workflow.

### 4.2 ~~Recommendation — Wealth management / RIA~~ — WITHDRAWN 2026-08-22

> **This recommendation was wrong and is retained only so the reasoning error is visible.**

The original argument: supervised review of client communications is *already a paid human job*
mandated by FINRA/SEC rules, so our approval layer replaces a cost center rather than adding one.
The logic was sound. The market check was not.

**Why it fails:** the workflow is already owned. **Smarsh** is a 2025 Gartner Magic Quadrant Leader
for digital communications governance and archiving, purpose-built for FINRA 3110 supervision and
SEC 17a-4 / 204-2 recordkeeping, used by **18 of the 20 largest financial institutions** — and in
**May 2026 shipped agentic AI supervision workflows**. Global Relay owns the tamper-proof archive
adjacent to it.

Entering there means a first-time unknown vendor displacing the entrenched category leader in
their core workflow, three months after they moved into AI. The budget line is real; it is already
spent, on them.

**The transferable lesson:** criterion 2 (a mandated human review step) reliably identifies a real
budget — and a real budget that has existed for years is usually already claimed. Add a sixth
criterion:

> **6. No entrenched category leader already performs this review workflow with AI.**

Wealth management is not permanently closed — an *integration* posture (govern the agent, write
into the existing archive) may work later. It is closed as a **beachhead**.

### 4.3 Revised vertical ranking

Re-scored against all six criteria, best first:

| Vertical | Why it scores | Watch out for |
|---|---|---|
| **Insurance claims / TPA ops** | Irreversible payments, state DOI audit obligations, human adjuster + QA review. Core systems (Guidewire, Duck Creek) own the record, **not the agent governance layer** | Long cycles at carriers — start with TPAs and MGAs, who move faster |
| **BPO / outsourced professional services** | **They sell labor.** An agent doing the work with an audit trail is direct margin. No entrenched governance vendor, fastest decisions | Price pressure; they may try to build it themselves |
| **Mortgage / lending back-office QC** | Irreversible fund movement, mandated underwriting QC, TRID/ECOA audit | LOS incumbents (Encompass) adjacent but not in this layer |
| **Healthcare revenue cycle / prior auth** | Enormous labor cost, strong audit need, HIPAA forces our architecture anyway | 12–18 month procurement; PHI liability from day one |
| Pharma MLR review | Mandated approval workflow — excellent structural fit | **Veeva PromoMats owns it.** Same failure mode as Smarsh |
| Legal ops | Consequential comms; conservative buyers value undo | Small budgets outside large firms; Ironclad/Icertis own contract flow |

### 4.4 Buyer profile (applies across verticals)

The shape matters more than the industry:

- **Size:** 200–2,000 employees — a named compliance function and real ops budget, but the COO can
  still decide without a year-long committee.
- **Workflow:** a queue of consequential decisions handled by 3–15 people, where human review is
  *mandated* rather than optional.
- **The tell:** hiring for that queue, or sitting on a backlog they cannot staff, or holding a
  recent audit finding about it.
- **Titles:** VP/Director of Operations, Chief Compliance Officer, Head of Shared Services, COO.
  **Not** CIO, not Head of Innovation — innovation budgets buy pilots that die.
- **Anchor economics (validate, do not assume):** a loaded reviewer costs ~$70–120k US. Eight of
  them is a ~$700k+ line. First Teams/Enterprise ACV plausibly $30–150k/year.

**Deal structure — the three-person rule.** Ops champions (throughput), Compliance sponsors
(evidence), Security approves (D4). If an account lacks all three, walk.

> **The structural advantage:** in almost every enterprise, Compliance is the reason an AI project
> dies. VEGA is the rare product where Compliance is the reason the deal *closes*. Structure every
> deal that way.

**Positioning trap to avoid:** never sell "replace your reviewers." The signer is usually the
reviewers' manager, and you are asking them to shrink their own team. Sell **"handle the growth
without hiring"** or **"clear the backlog you cannot staff for."** Same ROI, opposite politics.

### 4.5 The credibility problem (plan around it before Phase 1)

The market where the product is most valuable is the market least willing to buy from an unknown
first-time vendor. Regulated buyers do not hand compliance-critical workflows to a company with no
SOC 2, no references, and no track record. This is not solvable with a better deck.

Two routes through — secure one **before writing product code**:

1. **Relationship access.** Start where you or an advisor already have a warm door to an ops or
   compliance leader. Personal trust substitutes for institutional trust exactly once, and that
   is your design partner.
2. **Lower the blast radius for deal one.** Land on an *internal* workflow (internal reporting,
   record updates) where a mistake is embarrassing rather than reportable. Prove undo and the
   evidence pack, then expand outward. Same product, far shorter trust runway.

### 4.6 How to close it

15 discovery calls across the top two verticals **before Phase 2 code**.
Disqualifying answer: *"we'd never let AI touch that."*
Qualifying answer: *"we pay two people to review those, and they're the bottleneck."*

Until closed, build only vertical-neutral infrastructure (D1, D3, D4, C-series).

---

## 5. Capability Map

Everything VEGA does, in one place. Three series: **C** (core agent loop — table stakes,
necessary but not differentiating), **D** (differentiators — the moat), **P** (platform and
organizational capability — required to sell to companies).

| ID | Capability | Series | Phase | Differentiating? |
|---|---|---|---|---|
| C1 | Intent & Goal Understanding | Core | 1 | No |
| C2 | Task Planner | Core | 1 | No |
| C3 | Policy & Risk Engine | Core | 1 | Partially |
| C4 | Intelligent Model Router | Core | 2 | No at Enterprise — **existential below Teams** (§22.6). Owned by Module 5 |
| C5 | Autonomous Task Executor & Tool Layer | Core | 1 | No |
| C6 | Verification Engine | Core | 2 | Partially |
| C7 | Semantic Memory | Core | 2 | No |
| C8 | Explainability & Trace | Core | 1 | Partially |
| **D1** | **Reversibility Layer** | **Diff** | **1** | **Yes — keystone** |
| **D2** | **Earned Autonomy Engine** | **Diff** | **2** | **Yes — data moat** |
| **D3** | **Proof-Carrying Actions** | **Diff** | **1** | **Yes — sells the deal** |
| **D4** | **Taint-Tracked Execution** | **Diff** | **1** | **Yes — makes it credible** |
| **D5** | **Escalation & Approval Surface** | **Diff** | **1** | **Yes — keeps it alive** |
| **D6** | **Cross-Agent Contention Control** | **Diff** | **3** | **Yes — at scale** |
| P1 | Identity, RBAC & Tenancy | Platform | 1 | No |
| P2 | Team Workspaces & Shared Agents | Platform | 3 | No |
| P3 | Connector Framework | Platform | 1 | No |
| P4 | Enterprise Knowledge Base | Platform | 3 | No |
| P5 | Usage Analytics & Cost Controls | Platform | 2 | No |
| P6 | Agent Marketplace | Platform | 4+ | No |
| P7 | Deployment Modes | Platform | 3 | No |

### 5.1 The seven-step loop (original framing, retained)

The user-facing narrative stays as originally conceived, with the differentiators woven in:

| Step | What happens | Owned by |
|---|---|---|
| **1. Understand** | Natural language in (text or voice); intent and objectives extracted | C1 |
| **2. Plan** | Objective decomposed into an executable task graph | C2 |
| **3. Decide** | Each action scored for risk; data access, tool use, approval need, model choice determined | C3, C4, D4 |
| **4. Execute** | Authorized tools invoked, with compensators registered before commit | C5, D1 |
| **5. Verify** | Result validated for accuracy, permissions, conflicts, policy, exposure | C6 |
| **6. Learn** | Preferences and context retained; autonomy adjusted from override telemetry | C7, D2 |
| **7. Explain** | Every action traceable, signed, and exportable as evidence | C8, D3 |

The original loop was **Understand → Plan → Decide → Execute → Verify → Learn → Explain**.
The revised loop inserts two steps that no competitor has:

> **Understand → Plan → Decide → *Simulate* → Execute → Verify → *Hold/Undo* → Learn → Explain**

---

# Part II — Product

## 6. Product Surfaces

Six surfaces. Each maps to a distinct job and a distinct user.

### 6.1 Conversational Surface

The primary input. Text first; voice deferred past Phase 3 (demo candy, no effect on thesis).

- Threaded conversations scoped to a workspace.
- Every assistant turn that proposes consequential action renders an **action card**, not prose:
  the simulated effect, risk tier, reversibility class, and the approve/modify/reject control.
- Inline provenance chips: hovering a factual claim shows its source document and taint level.
- Supports `@`-mention of connectors and knowledge sources to scope a request.

### 6.2 Action Center

The organization's command center — the original deck's centerpiece, retained in full.

**Today's Executive Brief**
Urgent messages, upcoming meetings, pending tasks, follow-ups due, decisions awaiting the user.
Generated on a schedule, not on demand, so it is ready before the user asks.

**Active AI Tasks**
Every run in flight, grouped by state: `RUNNING`, `AWAITING_APPROVAL`, `HELD` (inside undo
window), `COMPLETED`, `FAILED`, `COMPENSATED`, `NEEDS_ATTENTION`. Each row shows elapsed time,
current step, risk tier, and time remaining in hold if applicable.

**Security Center**
Risk events, blocked actions, approval requests, access activity, policy violations, taint
violations, anomaly-triggered demotions. Filterable by agent, user, connector, severity.

**AI Usage**
Models used, token consumption, estimated cost, task performance, and savings attributable to
routing. Per user, per agent, per workflow. Budget consumption against caps.

**Autonomy Dashboard** *(new — the metric that defines us)*
Per workflow: current autonomy tier, autonomy rate, error rate, mean time-to-undo, promotion
eligibility, and pending promotion recommendations.

### 6.3 Approval Inbox

Where human-in-the-loop lives or dies. Spec in [D5](#85-d5--escalation--approval-surface).

### 6.4 Audit Explorer

Search, replay, and export. Query any action by actor, subject, connector, policy, time, or data
subject. Open any run to see the full trace. Export an evidence pack. Verify the hash chain.

### 6.5 Agent Studio

Where an operator defines a workflow: trigger, objective, allowed connectors, allowed tools,
policy bindings, autonomy tier, escalation targets, and the shadow-mode certification report.
Non-technical UI over the same declarative spec engineers write in YAML.

### 6.6 Admin & Policy Console

Tenancy, SSO, roles, connector authorization, policy authoring and simulation, budget caps,
retention settings, key management, and the promotion/demotion approval queue.

---

## 7. C-Series — Core Agent Loop

Table stakes. Build competently, ship quietly, never pitch as differentiation.

### 7.1 C1 — Intent & Goal Understanding

**Purpose.** Convert a natural-language request into a structured objective.

**Output contract.**

```jsonc
{
  "objective": "Schedule a follow-up with Acme and send the revised proposal",
  "entities":  [{ "type": "org", "value": "Acme Corp", "resolved_id": "crm:acct_8812" }],
  "constraints": ["afternoons only", "before Friday"],
  "success_criteria": ["meeting exists on calendar", "proposal sent to primary contact"],
  "ambiguities": [{ "field": "which proposal", "candidates": ["v2", "v3"] }],
  "requested_autonomy": "supervised"
}
```

**Behavior.**
- Resolves entities against memory (C7) and connected systems before planning.
- **Never guesses on an ambiguity that affects an irreversible action.** Ambiguity on an `R3`
  action forces a clarifying question; ambiguity on `R0` may be resolved by best guess.
- Detects and rejects instructions that arrived from untrusted content (see D4) — a request can
  only originate from an authenticated principal, never from the body of an email being read.

**Done when:** 95% entity resolution accuracy on the beachhead corpus; zero cases of an
`R3` action proceeding with an unresolved ambiguity in the eval set.

### 7.2 C2 — Task Planner

**Purpose.** Decompose the objective into a directed acyclic graph of executable steps.

**Behavior.**
- Emits a `TaskGraph` of typed nodes: `TOOL_CALL`, `REASONING`, `HUMAN_INPUT`, `CHECKPOINT`,
  `VERIFY`, `COMPENSATE`.
- Every `TOOL_CALL` node is annotated at plan time with its declared reversibility class,
  egress class, and estimated risk — **before** anything executes. This is what makes the
  simulation in D1 possible.
- Plans are re-entrant: a failed or demoted step re-plans from the last checkpoint rather than
  restarting.
- Plan depth and fan-out are bounded per workflow to prevent runaway execution.
- Planner output is itself an artifact: versioned, diffable, and attached to the audit record.

**Replanning triggers:** tool failure, verification failure, policy denial, contention lock
timeout, new information invalidating a precondition, human modification of a pending action.

### 7.3 C3 — Policy & Risk Engine

**Purpose.** Decide, for every action: allowed at all? at what autonomy tier? by whom?

**Inputs.** Actor identity and role; target resource and its sensitivity label; tool declaration;
data provenance/taint (D4); reversibility class (D1); current autonomy tier (D2); org policy;
regulatory pack; budget state.

**Outputs.** `ALLOW` | `ALLOW_WITH_HOLD` | `REQUIRE_APPROVAL(role)` | `REQUIRE_DUAL_APPROVAL` |
`DENY`, plus the reason chain that produced it.

**Policy language.** Declarative, versioned, testable. Policies are code, reviewed and deployed
like code, with a simulation mode that replays historical actions against a proposed policy and
reports what would have changed.

```yaml
- id: external-comms-supervision
  description: Client-facing communications require principal review
  when:
    tool.egress_class: EXTERNAL
    target.audience: CLIENT
  then:
    decision: REQUIRE_APPROVAL
    approver_role: REGISTERED_PRINCIPAL
    hold_window: 15m
    evidence: [draft_body, source_provenance, client_record]
  citation: FINRA 2210
```

The four risk tiers from the original design are preserved and made computable in §13:

| Tier | Example | Default disposition |
|---|---|---|
| **Low** | "Summarize my emails" | Execute automatically |
| **Medium** | "Draft a response to this customer" | Execute, hold for review |
| **High** | "Send this confidential document externally" | Require explicit approval |
| **Critical** | "Delete all project records" | Block or require elevated dual authorization |

### 7.4 C4 — Intelligent Model Router

**Purpose.** Internal cost and latency optimization. **Not a marketed feature.**

**Routing signals.** Task complexity, reasoning requirement, context size, latency budget, cost
budget, data residency/privacy constraints, and required accuracy floor for the risk tier.

**Hard rules that override cost optimization:**
- Any action at High or Critical risk tier uses the highest-accuracy tier model, regardless of cost.
- Any prompt containing `UNTRUSTED` taint goes to the quarantined model only (D4) — never to the
  privileged planner.
- Data-residency-constrained tenants route only to approved regions/providers.

**Implementation.** Thin abstraction over a gateway (LiteLLM/Portkey-class) with our own policy
layer above it. Do not build a router from scratch; this is commodity infrastructure.

**Reporting.** Savings attributable to routing are shown in the Action Center because customers
like the number — but the number is never a pricing basis.

### 7.5 C5 — Autonomous Task Executor & Tool Layer

**Purpose.** Execute the task graph durably.

**Connector surface (launch set):** Gmail / Outlook, Google Calendar / Exchange, Google Drive /
SharePoint, web search & fetch, Slack, a CRM (beachhead-dependent), and a generic authenticated
HTTP tool. MCP-compatible so third-party tool servers can be attached.

**Every tool must declare, statically:**

```ts
interface ToolDeclaration {
  id: string;
  scopes: string[];                 // OAuth scopes actually required
  egress_class: 'INTERNAL' | 'EXTERNAL' | 'PUBLIC';
  reversibility: 'R0' | 'R1' | 'R2' | 'R3';
  compensator?: CompensatorRef;     // required unless R0 or R3
  hold_supported: boolean;
  max_taint: 'TRUSTED' | 'ORG' | 'UNTRUSTED';  // highest taint allowed in its arguments
  idempotency: 'NATIVE' | 'KEYED' | 'NONE';
  sensitivity_hint: number;         // 0-100, contributes to risk score
  cost_hint?: { unit: string; estimate: number };
}
```

**A tool without a declaration cannot be registered.** This is enforced at build time — it is the
mechanism that makes D1, D3, and D4 possible at all.

**Execution guarantees.** Durable (survives process restart), idempotent per step where the
underlying API allows, at-most-once for `R3` actions, with every attempt written to the audit
chain before the call is made.

### 7.6 C6 — Verification Engine

**Purpose.** Before an action is released, confirm it actually did (or will do) the right thing.

**Checks:**
- **Accuracy** — claims in generated content are grounded in retrieved sources; unsupported
  claims are flagged with their provenance gap.
- **Permissions** — the acting identity genuinely holds the scope, re-checked at execution time
  rather than at plan time.
- **Conflicts** — calendar double-booking, duplicate outreach, contradictory record updates.
- **Policy** — re-evaluated post-generation, because generated content can change the risk tier
  (e.g. a draft that turns out to contain PII).
- **Data exposure** — recipient domains, attachment contents, and PII/PHI classification.
- **Consequence** — the simulated effect matches the planned effect; divergence aborts.

**Failure handling.** Verification failure on a not-yet-committed action aborts and replans.
Verification failure on a committed action triggers the compensation path (D1) automatically.

### 7.7 C7 — Semantic Memory

**Purpose.** Stop treating every conversation as a blank slate.

**Memory classes:**

| Class | Example | Scope | TTL |
|---|---|---|---|
| User preference | "Prefers afternoon meetings" | User | Indefinite, revalidated |
| Working context | "Acme is mid-partnership negotiation" | Workspace | Until closed/stale |
| Task history | "Proposal sent yesterday" | Workspace | Retention policy |
| Organizational knowledge | "External emails require approval" | Tenant | Until changed |
| Long-term style | "Keep client emails concise and professional" | User | Indefinite |

**Rules:**
- Memory is **written only from `TRUSTED` or `ORG` taint sources.** Content originating from an
  external email can never write a memory — otherwise memory becomes a prompt-injection
  persistence vector. This is a hard architectural rule, not a heuristic.
- Every memory carries provenance: what created it, when, from which run.
- Memory is user-visible, user-editable, and user-deletable. A memory that influenced a decision
  appears in that decision's trace.
- Contradiction detection: a new memory conflicting with an existing one raises a resolution
  prompt rather than silently overwriting.

**Implementation.** Postgres + pgvector. Hybrid retrieval (BM25 + dense). Do not build a
bespoke memory engine; this is commodity.

### 7.8 C8 — Explainability & Trace

**Purpose.** Any user can answer: what did it do, why, and on what basis?

Every run produces a trace answering:
- **What** VEGA did — the ordered list of committed actions with their effects.
- **Why** — the objective, the plan, and the reasoning summary per step.
- **Which tools** — every call with arguments (redacted per sensitivity) and responses.
- **What information influenced it** — retrieved documents, memories, and their taint levels.
- **Which policies applied** — every policy evaluated, with the decision and reason chain.
- **Whether approval was required** — who approved, when, what they saw, how long they took.

Traces are rendered for humans and exported as machine-readable evidence (D3).

---

## 8. D-Series — Differentiators

This is the product. Everything in §7 exists to make this section possible.

### 8.1 D1 — Reversibility Layer

> **"Undo for real-world actions."** The keystone. Nobody sells this.

The engineering pattern exists as developer plumbing — saga orchestration, compensating
transactions, durable execution (Temporal raised $300M at $5B in Feb 2026; LangGraph, Pydantic AI,
and the OpenAI Agents SDK all made durable execution first-class). Nobody has turned it into a
**governed, business-user-facing capability**. That gap is the product.

#### 8.1.1 Reversibility classes

Every tool action is statically classified. This classification drives risk scoring, autonomy
eligibility, and UI treatment.

| Class | Meaning | Mechanism | Examples |
|---|---|---|---|
| **R0** | Fully reversible | Native undo or version restore | Draft edit, file version write, label change |
| **R1** | Compensable | A registered inverse action restores equivalent state | Calendar event created → delete + notify; CRM field write → snapshot restore; task created → task deleted |
| **R2** | Hold-only | Cannot be reversed after release, but release can be delayed | Outbound email, outbound message, published post |
| **R3** | Irreversible | No undo, no meaningful delay | Payment capture, regulatory filing, third-party destructive API call |

**Design rule:** the engineering goal for every new connector action is to move it up this
ladder. Turning an R3 into an R2, or an R2 into an R1, is directly worth money because it raises
the autonomy ceiling for that action.

#### 8.1.2 Compensator registry

For every `R1` action, a compensator is registered **before the forward action is attempted**.

```ts
interface Compensator {
  tool_id: string;
  // Captured pre-commit; everything needed to reverse without re-deriving it
  capture(ctx: ActionContext): Promise<CompensationToken>;
  // Executed in reverse order on rollback
  compensate(token: CompensationToken): Promise<CompensationResult>;
  // Not all compensation is silent — some requires telling a human
  side_effects: 'SILENT' | 'NOTIFIES_THIRD_PARTY';
  confidence: 'EXACT' | 'APPROXIMATE';   // "deleted the event" vs "sent a correction"
  ttl: Duration;                          // after which compensation is no longer valid
}
```

**Honest constraints, designed for rather than hidden:**

- A compensator is **not a perfect inverse**. You can reverse a refund; you cannot un-send an
  email. `confidence: APPROXIMATE` must be surfaced in the UI — "we will delete the meeting and
  notify the three attendees" is not the same as "it never happened," and the user must see that.
- Compensation can itself fail. A failed compensation is a **first-class incident**: it pages,
  it appears in the Security Center, and it automatically demotes the workflow's autonomy tier.
- Compensators expire. After the TTL, the action is treated as permanent.

#### 8.1.3 Hold window (pre-commit buffer)

For `R2` actions, VEGA commits internally but delays release.

- Configurable per policy, per action type: default 30s (low risk) to 15min (client comms).
- Revocable from anywhere — web, mobile push, email link, one tap, no login challenge for revoke.
- The held artifact is fully visible during the window; the user can revoke, edit-and-requeue,
  or release immediately.
- On release, the audit chain records both the hold decision and the release.
- **Rationale:** the overwhelming majority of "oh no" moments occur within 60 seconds. This
  converts most of the emotional risk of autonomy into a solved problem for near-zero cost.

#### 8.1.4 Blast-radius simulation (dry run)

Before executing, show the **simulated effect**, not the plan in prose. Every competitor shows a
plan. Nobody shows effects.

```
This run will:
  ✉  send 3 emails       → 2 external domains (acme.com, contoso.com)   [R2 · 10m hold]
  📅 create 1 event      → 4 attendees, Thu 14:00                        [R1 · reversible]
  🗂  update 1 CRM field  → Acme / Stage: Negotiation → Closed Won        [R1 · reversible]
  💸 no financial actions
  🔒 reads: 12 emails, 3 documents  (2 contain PII)
```

Implementation: tools expose a `simulate()` alongside `execute()`. Where a provider offers a
sandbox/dry-run mode, use it; otherwise simulation is computed from the declaration plus the
resolved arguments. **Divergence between simulated and actual effect aborts the run** and is
logged as a verification failure.

#### 8.1.5 Time-to-Undo as a published metric

Per action type: median and p99 elapsed time from "user decides to undo" to "state restored."
Displayed in-product and quoted in sales. It is the number that makes the promise concrete.

#### 8.1.6 Acceptance criteria

- 100% of registered non-R0/R3 actions have a tested compensator.
- Compensation success rate ≥ 99% in the eval harness; every failure produces an incident.
- Hold revocation works end-to-end from mobile push in < 5 seconds.
- Simulation matches actual effect on ≥ 99% of eval runs.

---

### 8.2 D2 — Earned Autonomy Engine

> Autonomy is not a setting. It is a status that a workflow earns and can lose.

Anthropic's own published data shows trust is earned empirically — users grant full auto-approve
more than 40% of the time by their 750th session, versus ~20% for new users. Nobody has
productized that ratchet. We do.

#### 8.2.1 The ladder

Every *(workflow × action type)* pair holds an independent autonomy tier:

| Tier | Agent behavior | Human behavior |
|---|---|---|
| **SHADOW** | Decides, does not act. Decision recorded and scored against what the human actually did. | Works normally, unaware |
| **SUPERVISED** | Acts only after explicit approval | Approves every action |
| **SAMPLED** | Acts; 1-in-N actions routed for review | Reviews a sample |
| **AUTONOMOUS** | Acts; review by exception only | Handles escalations only |
| **SUSPENDED** | Blocked pending investigation | Investigates |

Full state machine in [§14](#14-autonomy-state-machine).

#### 8.2.2 Promotion — certification by replay

A workflow cannot be promoted by opinion. It is promoted by evidence:

1. Re-run the agent against N months of **historical cases** where the human outcome is known.
2. Report measured agreement rate, error taxonomy, and the cost of each error class.
3. Require minimum sample size, minimum agreement, and zero critical-class errors.
4. Produce a **certification report** — a signed artifact a risk committee can put in a file.

```
Workflow: client-comm-draft · Action: email.send (R2)
  Shadow period:        62 days
  Decisions evaluated:  1,247
  Agreement w/ human:   96.3%   (threshold 95%)
  Human edits before send: 18.1% (threshold <25%)
  Critical errors:      0       (threshold 0)
  Recommendation:       PROMOTE  SUPERVISED → SAMPLED (1 in 5)
```

#### 8.2.3 Policy learned from override telemetry

Administrators are poor at authoring policy up front. So the system proposes it from evidence:

- *"You have approved 47 of 47 invoice approvals under $500 in the last 90 days. Promote to
  autonomous for this action type?"*
- *"3 of the last 10 external sends to first-contact domains were edited before release. Demote
  to SUPERVISED for new domains?"*

Every proposal cites its evidence, is one-click accepted or dismissed, and dismissals are
themselves training signal. Proposals never auto-apply — a human always ratifies a change in
autonomy.

**This subsystem produces the override corpus described in §1.5. It is the moat. Instrument it
completely from day one, even before the learning is built.**

#### 8.2.4 Automatic demotion

Autonomy ratchets *down* automatically and immediately on:

- error rate crossing threshold over a rolling window,
- any critical-class error, ever,
- a compensation failure,
- a taint violation (D4),
- statistical novelty — inputs materially unlike the certification distribution,
- a connector or model version change (re-certification required),
- an anomalous volume spike.

Demotion notifies the workflow owner with the triggering evidence. Re-promotion requires a fresh
certification run.

#### 8.2.5 Acceptance criteria

- Autonomy tier is enforced at the executor, not the UI — a tier change takes effect mid-run.
- Every promotion and demotion is an audit event with full evidence attached.
- Override telemetry captured for 100% of human interventions, including *what the human changed*,
  not merely that they intervened.

---

### 8.3 D3 — Proof-Carrying Actions

> Every action carries a signed, independently verifiable receipt.

#### 8.3.1 Why now

EU AI Act high-risk obligations became enforceable **2 August 2026** — three weeks before this
document. Article 12 requires automatic, tamper-evident logging with ≥6 month retention;
Article 14 requires demonstrable human oversight with genuine intervention and override capability;
Article 15 imposes cybersecurity obligations; Article 73 governs forensic preservation. Exposure
reaches €35M or 7% of worldwide turnover.

The Act does not literally mandate cryptographic logs — but traceability plus security plus
forensic preservation makes hash-chained, signed logs the economically rational implementation,
and it is what auditors will ask for.

#### 8.3.2 The receipt

Every consequential action emits:

```jsonc
{
  "action_id": "act_01J...",
  "run_id": "run_01J...",
  "ts": "2026-08-22T10:14:03.221Z",
  "actor": { "principal": "user_88", "on_behalf_of": "user_88", "agent": "client-comm-v3" },
  "tool": { "id": "gmail.send", "egress": "EXTERNAL", "reversibility": "R2" },
  "arguments_digest": "sha256:...",          // full args stored separately, sensitivity-gated
  "inputs_read": [ { "source": "gmail:msg_44", "taint": "UNTRUSTED", "digest": "sha256:..." } ],
  "model": { "id": "claude-opus-5", "params_digest": "sha256:..." },
  "policies_evaluated": [ { "id": "external-comms-supervision", "version": 7, "decision": "REQUIRE_APPROVAL" } ],
  "approval": { "by": "user_12", "role": "REGISTERED_PRINCIPAL", "at": "...", "evidence_digest": "sha256:...", "latency_ms": 41200 },
  "risk": { "score": 68, "tier": "HIGH", "factors": { } },
  "hold": { "window_ms": 900000, "released_at": "...", "revoked": false },
  "outcome": "COMMITTED",
  "prev_hash": "sha256:...",
  "entry_hash": "sha256:...",
  "signature": "ML-DSA-65:..."
}
```

#### 8.3.3 Chain properties

- **Hash-chained.** Each entry commits to the previous entry's hash. Altering any entry breaks
  the chain visibly.
- **Signed with a key the agent cannot hold.** Signing happens in a separate service with its own
  KMS-held key; the execution plane can append but never rewrite. Post-quantum signature
  (ML-DSA / FIPS 204) so the artifact survives its own retention period.
- **Append-only storage** with WORM-capable object storage for the beachhead vertical's
  books-and-records requirements.
- **Periodic anchoring** of the chain head (published digest) so a customer can prove no
  retroactive rewrite occurred — including by us.
- **Independently verifiable.** A standalone open-source verifier binary lets an auditor check
  a chain without trusting our infrastructure. This is a deliberate trust asset: publish it.

#### 8.3.4 Evidence packs

The product is not the log — it is the **one-click evidence pack**:

> "Show me everything the agent did involving this client between March and June, the policies
> that governed it, who approved what, and the control each entry satisfies."

Output: a signed archive containing the filtered action chain, the policy versions in force, the
approval receipts with what the approver saw, the model versions used, the verification results,
a control-mapping index (§23), and the verifier binary with instructions.

#### 8.3.5 Deterministic replay

Any decision can be re-run against the state as it was at the time: same inputs, same retrieved
context, same policy versions, same model version pinned. Used for investigation, dispute
resolution, regression testing, and D2 certification.

Requires: content-addressed storage of every input, pinned model versions per run, and versioned
policy. Design for this from the first commit — it cannot be retrofitted.

#### 8.3.6 Acceptance criteria

- 100% of consequential actions produce a chain entry before the side effect occurs.
- Chain verification passes on every environment, continuously, as a monitored job.
- Evidence pack generation < 60s for a 12-month, single-client query.
- Replay reproduces the original decision on ≥ 99% of eval runs.

---

### 8.4 D4 — Taint-Tracked Execution

> **Non-negotiable.** Without this, "security-governed" is a false claim.

#### 8.4.1 The problem we have by design

VEGA's core use case — read email, then act, including sending email externally — is the complete
**lethal trifecta**: access to private data + exposure to untrusted content + an exfiltration
vector. Zero-click agentic prompt-injection compromises have already hit production enterprise
systems. OpenAI, Google DeepMind, and Anthropic have all publicly acknowledged that prompt
injection is not solvable at the model layer; the model-level attack surface is unbounded.

Therefore it must be solved at the **architecture** layer.

#### 8.4.2 Architecture (CaMeL-derived)

Two models, strictly separated:

- **Privileged planner.** Sees the user's instruction and *metadata* about untrusted content, but
  never raw untrusted text. Emits a restricted program over declared tools. Holds tool access.
- **Quarantined extractor.** Processes untrusted content (email bodies, web pages, documents).
  **Holds no tool access whatsoever.** Returns typed, schema-constrained values only — never
  free-form instructions.

Between them sits a **capability-tracking interpreter** that executes the planner's program,
propagates provenance through every variable, and gates every tool call against policy.

```
user instruction ──> PRIVILEGED PLANNER ──> restricted program
                                                 │
                    ┌────────────────────────────┴─────────────┐
                    ▼                                          ▼
        QUARANTINED EXTRACTOR                       CAPABILITY INTERPRETER
        (untrusted content in,                      (propagates taint,
         typed values out, no tools)                 gates every tool call)
                    │                                          │
                    └──────────── tainted values ──────────────┘
                                                               ▼
                                                    POLICY CHECK ──> TOOL
```

#### 8.4.3 Taint lattice

| Level | Source |
|---|---|
| `TRUSTED` | Authenticated principal's direct instruction |
| `ORG` | Internal systems of record, admin-curated knowledge |
| `UNTRUSTED` | External email bodies, web content, inbound documents, third-party API responses |

Taint propagates through every derivation: any value computed from an `UNTRUSTED` input is
`UNTRUSTED`, transitively, with no laundering path. Summarization does not reduce taint.

#### 8.4.4 The core rule

> **An `UNTRUSTED`-derived value may not parameterize an `EXTERNAL` egress tool without explicit
> human approval — and may never determine the *recipient* of one.**

Corollaries enforced mechanically:
- Untrusted content can never write memory (see C7).
- Untrusted content can never originate an objective (see C1).
- Untrusted content can never modify policy, autonomy tier, or approval routing.
- Rendered content (images, links) from untrusted sources is stripped of exfiltration channels.

#### 8.4.5 Make it visible — this is a sales feature

The security must be legible, not silent:

> ⚠ *This draft contains content derived from an external email (`UNTRUSTED`). The recipient
> address was set by you, not by that content. Two claims are unsupported by any trusted source —
> shown highlighted. This action cannot be released without your approval.*

That paragraph wins CISO meetings, because no mainstream assistant can produce it.

#### 8.4.6 Honest limits

This is mitigation, not a proof of safety. The quarantined model can still be manipulated into
returning misleading *values* within its schema. We therefore also require: schema constraints on
every extraction, value-range validation, cross-source corroboration for claims that drive High-risk
actions, and a continuously maintained red-team corpus in CI (§20).

**Never market this as "immune to prompt injection."** Market it as: untrusted content is
structurally prevented from reaching privileged tools, and every path it did influence is visible.

#### 8.4.7 Acceptance criteria

- Zero successful exfiltration in the red-team corpus, run on every build.
- 100% of tool calls carry a resolved taint level; a call with unresolved provenance fails closed.
- Taint violations page immediately and auto-demote the workflow (D2).

---

### 8.5 D5 — Escalation & Approval Surface

> Human-in-the-loop dies of approval fatigue. Always. Treat the approval as a product surface.

Not a moat — but it is the difference between HITL working and being switched off in month two.
McKinsey's 2026 work found only about one in three organizations reach governance maturity level
3+, while deploying increasingly autonomous agents anyway. The gap is operational, not conceptual.

#### 8.5.1 The decision packet

One screen. Everything needed, nothing more:

- **What** will happen (the simulated effect from D1, not prose).
- **Why** it was proposed — objective, trigger, and the reasoning in one sentence.
- **Evidence** — the source material, with untrusted content marked and unsupported claims flagged.
- **The recommended default**, pre-selected.
- **What happens if you do nothing** — expiry behavior, stated explicitly.
- **Actions:** Approve · Approve with edits · Reject · Reject with reason · Ask a question.

Target: **median approval in under 10 seconds** for routine actions.

#### 8.5.2 Batching and rhythm

- Approvals are **batched into review moments**, not drip-fed as interruptions. Configurable
  cadence (e.g. 9am / 1pm / 5pm) with an urgency override that breaks the batch.
- A batch renders as a queue with keyboard-driven approve/reject and bulk actions on
  homogeneous groups.
- Notification budget per user per day, enforced. Exceeding it is a product bug, tracked as one.

#### 8.5.3 Expiry and fallback

Every approval request declares its expiry and its fallback: `AUTO_REJECT` (default),
`AUTO_APPROVE` (only for Low tier, only if policy permits), or `ESCALATE_TO(role)`.
Nothing hangs forever. Nothing silently proceeds.

#### 8.5.4 Delegation and coverage

Out-of-office delegation, role-based routing, dual approval for Critical actions with
separation-of-duties enforcement (the requester can never be the approver), and an escalation
chain when the primary approver is unresponsive.

#### 8.5.5 Mobile

Approve, reject, and — critically — **revoke a held action** from a push notification. Revoke
requires no login challenge; approve does. Asymmetric by design: the safe action must always be
the fastest.

#### 8.5.6 Approval telemetry

Every interaction feeds D2: decision, latency, whether edits were made, **what was edited**,
rejection reason, and whether the approver opened the evidence. This is the override corpus.

#### 8.5.7 Acceptance criteria

- Median approval latency < 10s; p90 < 45s for routine tiers.
- Zero approval requests without an expiry and declared fallback.
- Notification volume per user per day within budget for 100% of active tenants.

---

### 8.6 D6 — Cross-Agent Contention Control

> The problem that appears exactly when a deployment starts to scale — i.e. at renewal time.

Once an organization runs twenty agents, two will touch the same customer record, and three will
email the same prospect in the same week. Nobody solves this today.

#### 8.6.1 Entity locking

- Agents acquire **advisory locks on business entities** (`crm:account:8812`, `client:44`), not on
  database rows — the contention is semantic, not transactional.
- Lock modes: `SHARED_READ`, `EXCLUSIVE_WRITE`, `COMMUNICATION` (only one agent may contact a
  given human at a time).
- Leases with TTL and heartbeat; automatic release on run termination; deadlock detection with
  deterministic victim selection by risk tier (the lower-risk run yields).

#### 8.6.2 Duplicate outreach suppression

A global **contact ledger** per external human: who contacted them, when, through which channel,
on whose behalf. Policy-enforced cooldowns per relationship type. A second agent attempting
contact inside the cooldown is blocked and told who holds the relationship.

#### 8.6.3 Write reconciliation

Two agents proposing conflicting updates to the same field: last-write-wins is unacceptable.
Conflicts are detected pre-commit and either merged by policy, escalated to a human with both
proposals shown, or the lower-priority write is deferred and replanned against the new state.

#### 8.6.4 "Who else is on this account"

A visible surface: for any entity, every agent and human currently acting on it, with intent and
lock state. Operationally mundane, and exactly what makes a large deployment survivable.

#### 8.6.5 Acceptance criteria

- Zero duplicate outbound contacts to a single recipient inside the configured cooldown, measured
  in production.
- Lock acquisition p99 < 50ms; no deadlock persists beyond 5s.

---

## 9. P-Series — Platform & Organization

### 9.1 P1 — Identity, RBAC & Tenancy

- Hard multi-tenancy with row-level isolation enforced at the database, not the application layer.
- SSO/SAML/OIDC; SCIM provisioning for Enterprise.
- **Agents have their own identities**, distinct from the users they act for. Every action records
  both the agent identity and the human principal it acts on behalf of. Agent credentials are
  short-lived and scoped per run — never a long-lived superuser token.
- Roles: `OWNER`, `ADMIN`, `COMPLIANCE_OFFICER`, `WORKFLOW_OWNER`, `APPROVER`, `MEMBER`, `AUDITOR`.
  `AUDITOR` is read-only across the audit plane and cannot see message bodies unless granted.
- Least privilege on connector scopes: request the minimum scope a tool declares, never a blanket
  mailbox grant, and show the user exactly what was granted.

### 9.2 P2 — Team Workspaces & Shared Agents

Workspaces scope memory, connectors, policy, and agents. Shared agents are owned by a workspace
with an explicit owner accountable for their autonomy tier. Per-agent permission sets. Agent
definitions are versioned and diffable; changing one resets certification (D2).

Original deck's team archetypes, retained as templates: **Sales** (lead research → qualification →
CRM update → follow-up), **Operations** (reports → workflows → scheduling → monitoring),
**HR** (candidate coordination → scheduling → communication), **Marketing** (research → content
workflow → campaign analysis), **Management** (executive summaries → meeting prep → follow-ups).

Each ships as a template with pre-built policy bindings — but every one starts in `SHADOW`.

### 9.3 P3 — Connector Framework

- MCP-compatible connector interface so third-party tool servers attach without bespoke work.
- **Every connector action must ship a tool declaration (§7.5) or it cannot register.** No
  exceptions — this is what makes D1/D3/D4 possible.
- Connector SDK responsibilities: auth lifecycle, rate limiting, retry/backoff, idempotency keys,
  `simulate()`, and a compensator per non-R0/R3 action.
- Connector certification checklist before production: declaration complete, compensator tested,
  simulation accuracy verified, taint classification correct, scopes minimized.

**Launch connectors:** Gmail, Google Calendar, Google Drive, Outlook/Exchange, SharePoint, Slack,
web search/fetch, generic HTTP, and one beachhead CRM.

### 9.4 P4 — Enterprise Knowledge Base

Ingest organizational documents for grounding. Hybrid retrieval, per-document sensitivity labels,
and ACL-aware retrieval (a user must never receive a chunk from a document they cannot open).
Retrieved content carries `ORG` taint. Do not compete with Glean — support connecting to it.

### 9.5 P5 — Usage Analytics & Cost Controls

Per user, agent, workflow, and connector: model usage, token consumption, estimated cost, task
success rate, latency, and routing savings. **Hard budget caps** with configurable behavior on
breach (degrade to cheaper models, queue, or halt). Anomalous spend alerts. Cost attribution to
business outcomes where the workflow defines one.

### 9.6 P6 — Agent Marketplace *(Phase 4+ — deliberately deferred)*

Long-term: organizations install specialized agents and skills — Sales, Research, Finance, HR,
Meeting, Customer Support. Each marketplace agent must ship declarations, compensators, and a
certification report, and installs at `SHADOW` regardless of publisher.

**Deferred deliberately.** A marketplace requires a developer ecosystem we will not have for 24+
months, and shipping it early signals a platform we cannot support. Revisit only after 50 paying
customers and a stable connector SDK.

### 9.7 P7 — Deployment Modes

| Mode | For | Notes |
|---|---|---|
| Multi-tenant SaaS | Default | Regional data residency options |
| Single-tenant hosted | Enterprise | Dedicated infrastructure, isolated keys |
| Private VPC | Regulated enterprise | Customer cloud, our control plane |
| On-prem / air-gapped | Phase 4+ | Only with a self-hosted model; do not promise early |

Signing keys and the audit chain are **always** customer-controlled in single-tenant and above —
that is the point of independent verifiability.

---

# Part III — Engineering

## 10. System Architecture

### 10.1 Planes

The system separates into three planes with strictly different trust properties. **This
separation is the architecture** — it is what makes the audit chain trustworthy and taint
tracking enforceable.

```
┌─────────────────────────────────────────────────────────────────────┐
│  EXPERIENCE PLANE                                                   │
│  Chat · Action Center · Approval Inbox · Audit Explorer             │
│  Agent Studio · Admin & Policy Console                              │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE            (decides — never touches customer data)   │
│  ┌───────────┐ ┌───────────┐ ┌────────────┐ ┌──────────────────┐    │
│  │ Planner   │ │ Policy &  │ │ Autonomy   │ │ Model Router     │    │
│  │ (C1,C2)   │ │ Risk (C3) │ │ Mgr (D2)   │ │ (C4)             │    │
│  └───────────┘ └───────────┘ └────────────┘ └──────────────────┘    │
│  ┌────────────────────────┐  ┌──────────────────────────────────┐   │
│  │ Contention Mgr (D6)    │  │ Approval Orchestrator (D5)       │   │
│  └────────────────────────┘  └──────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│  EXECUTION PLANE                (acts — handles customer data)      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Capability Interpreter (D4) — taint propagation, tool gating │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌───────────────┐ ┌──────────────┐ ┌──────────────────────────┐    │
│  │ Durable       │ │ Compensator  │ │ Hold Buffer (D1)         │    │
│  │ Orchestrator  │ │ Registry(D1) │ │                          │    │
│  └───────────────┘ └──────────────┘ └──────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Connector Runtime (P3) · Quarantined Extractor (D4)          │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                  │  (append-only, one direction)
┌─────────────────────────────────────────────────────────────────────┐
│  EVIDENCE PLANE       (append-only · separate keys · separate creds) │
│  Audit Chain (D3) · Signing Service · Evidence Pack Builder         │
│  Replay Engine · Verifier                                           │
└─────────────────────────────────────────────────────────────────────┘
```

### 10.2 Invariants

Violating any of these is a P0 architectural defect, not a bug:

1. **The execution plane can append to the evidence plane but never read, modify, or delete it.**
   Separate credentials, separate keys, enforced at the IAM boundary.
2. **No side effect occurs before its audit entry is committed.** Write-ahead, always.
3. **No tool call executes without a resolved taint level.** Unresolved provenance fails closed.
4. **No tool registers without a complete declaration** (scopes, egress, reversibility,
   compensator, max taint, idempotency). Enforced at build time.
5. **The privileged planner never receives raw untrusted content.** Enforced by type, not by prompt.
6. **Autonomy tier is enforced at the executor.** UI-level enforcement is not enforcement.
7. **Every input is content-addressed and every model version is pinned per run**, or replay (D3)
   is impossible. This cannot be retrofitted.

### 10.3 Request lifecycle

```
1  Principal submits instruction              → TRUSTED taint assigned
2  C1 extracts objective, resolves entities   → memory + connectors consulted
3  C2 emits TaskGraph                          → each node pre-annotated: R-class, egress, risk
4  C3 evaluates policy per node                → ALLOW | HOLD | APPROVAL | DENY + reason chain
5  D2 applies autonomy tier per action type    → may downgrade the disposition
6  D6 acquires entity locks                    → blocks or yields on contention
7  D1 simulates → blast radius presented       → user or policy gate
8  For each node, in graph order:
     a. audit entry written (D3)               → BEFORE the call
     b. compensator captured (D1)              → BEFORE the call
     c. quarantined extraction if untrusted    → typed values only
     d. capability interpreter gates the call  → taint check (D4)
     e. tool executes
     f. C6 verifies the result
     g. R2 → hold buffer; R0/R1 → committed
9  On any failure: compensate in reverse order, log every compensation
10 Release or revoke held actions
11 Telemetry → D2 override corpus
12 Trace assembled → C8; chain sealed → D3
```

---

## 11. Data Model

Postgres. Core tables, abbreviated to essential columns. Everything is tenant-scoped with RLS.

```sql
-- Tenancy & identity ------------------------------------------------
tenants(id, name, plan, region, retention_days, created_at)
users(id, tenant_id, email, role, sso_subject, status)
workspaces(id, tenant_id, name, settings_json)
agents(id, tenant_id, workspace_id, name, version, spec_json,
       owner_user_id, status)            -- agents hold their own identity

-- Connectors & tools -------------------------------------------------
connectors(id, tenant_id, kind, auth_ref, scopes_granted, status)
tool_declarations(id, connector_kind, tool_id, version, egress_class,
       reversibility, max_taint, idempotency, sensitivity_hint,
       compensator_ref, simulate_supported, hold_supported)

-- Execution ----------------------------------------------------------
runs(id, tenant_id, workspace_id, agent_id, principal_user_id,
     objective_json, status, started_at, ended_at, cost_cents)
task_nodes(id, run_id, parent_id, kind, tool_id, args_json,
     planned_risk, planned_reversibility, status, attempt, result_ref)
actions(id, run_id, node_id, tool_id, args_digest, effect_json,
     risk_score, risk_tier, reversibility, taint_level,
     state, committed_at, released_at)     -- state: PLANNED|HELD|COMMITTED|
                                           -- COMPENSATED|FAILED|REVOKED

-- Reversibility (D1) --------------------------------------------------
compensations(id, action_id, token_json, ttl_at, confidence,
     side_effects, state, executed_at, result_json)
holds(id, action_id, window_ms, expires_at, released_at,
     revoked_at, revoked_by)

-- Policy & risk (C3) --------------------------------------------------
policies(id, tenant_id, key, version, spec_yaml, citation,
     active_from, active_to, author_id)
policy_evaluations(id, action_id, policy_id, policy_version,
     decision, reason_json)

-- Autonomy (D2) -------------------------------------------------------
autonomy_state(id, tenant_id, workflow_key, action_type, tier,
     since, certification_id, next_review_at)
certifications(id, workflow_key, action_type, sample_size,
     agreement_rate, edit_rate, critical_errors, report_json,
     signature, decided_by, decided_at)
overrides(id, action_id, approver_id, decision, latency_ms,
     edited bool, edit_diff_json, reason, evidence_opened bool)
                                           -- ^ THE MOAT. Never lose a row.

-- Approvals (D5) ------------------------------------------------------
approval_requests(id, action_id, approver_role, assigned_to,
     packet_json, expires_at, fallback, state, resolved_at)

-- Provenance & taint (D4) ---------------------------------------------
sources(id, tenant_id, uri, digest, taint, fetched_at, connector_id)
derivations(id, run_id, value_ref, source_ids[], taint, op)

-- Memory (C7) ----------------------------------------------------------
memories(id, tenant_id, scope, subject_id, class, content,
     embedding vector, provenance_json, confidence,
     created_from_run, valid_from, valid_to, superseded_by)

-- Contention (D6) -------------------------------------------------------
entity_locks(id, tenant_id, entity_key, mode, holder_run_id,
     lease_expires_at, acquired_at)
contact_ledger(id, tenant_id, external_identity, channel,
     contacted_at, by_run_id, on_behalf_of, cooldown_until)

-- Evidence plane (D3) — separate database, separate credentials --------
audit_entries(id, tenant_id, seq, ts, payload_json,
     prev_hash, entry_hash, signature, anchor_id)
anchors(id, tenant_id, chain_head_hash, anchored_at, method)
evidence_packs(id, tenant_id, query_json, built_at, artifact_ref,
     signature, requested_by)
```

### 11.1 Retention

Configurable per tenant, floor of 6 months for the audit chain (EU AI Act Art. 12), 24 months
where the vertical requires it. Message bodies and arguments are stored separately from the chain
and can be redacted on a data-subject request **without breaking the chain** — the chain commits
to digests, not plaintext. This is a deliberate design choice enabling GDPR erasure alongside
tamper-evident audit.

---

## 12. Execution Semantics

### 12.1 Action state machine

```
                  ┌──────────┐
                  │ PLANNED  │
                  └────┬─────┘
         policy DENY   │   policy ALLOW
        ┌──────────────┴───────────────┐
        ▼                              ▼
   ┌─────────┐                  ┌─────────────┐  needs approval  ┌──────────┐
   │ BLOCKED │                  │  APPROVING  │◄─────────────────┤ PLANNED  │
   └─────────┘                  └──────┬──────┘                  └──────────┘
                                       │ approved
                                       ▼
                    R2 ──────────► ┌────────┐ ──revoked──► ┌─────────┐
                                   │  HELD  │              │ REVOKED │
                                   └───┬────┘              └─────────┘
                                       │ released / R0,R1 direct
                                       ▼
                                 ┌───────────┐  verify fail   ┌──────────────┐
                                 │ COMMITTED │───────────────►│ COMPENSATING │
                                 └───────────┘                └──────┬───────┘
                                       │                    ┌────────┴────────┐
                                       ▼                    ▼                 ▼
                                    (done)          ┌──────────────┐  ┌──────────────┐
                                                    │ COMPENSATED  │  │ COMP_FAILED  │
                                                    └──────────────┘  └──────┬───────┘
                                                                             │
                                                                      INCIDENT + auto-demote
```

### 12.2 Saga semantics

- Forward actions execute in graph order; each registers its compensator **before** committing.
- On unrecoverable failure, compensators run in **strict reverse order** of commitment.
- Compensation is itself audited, and can itself fail — `COMP_FAILED` is an incident that pages,
  surfaces in the Security Center, and demotes the workflow's autonomy tier automatically.
- `R3` actions are **at-most-once** and are placed last in the graph wherever the plan permits, so
  that as much as possible remains reversible when they execute.
- Long-running runs checkpoint; a restart resumes from the last checkpoint without re-executing
  committed side effects (idempotency keys where the provider supports them).

### 12.3 Concurrency

Entity locks (D6) are acquired in a canonical order to prevent deadlock. Lease-based with
heartbeat; expiry releases. Victim selection on detected cycles: lowest risk tier yields, ties
broken by run start time.

---

## 13. Risk Scoring Specification

A transparent, auditable function — **not** an opaque model. Every factor must be explainable to
a compliance officer, and the score must be reproducible on replay.

```
risk = clamp(0, 100,
    w1 · data_sensitivity      // 0-100 from resource labels + PII/PHI detection
  + w2 · blast_radius          // recipients, records, monetary value affected
  + w3 · external_exposure     // INTERNAL 0 · EXTERNAL 60 · PUBLIC 100
  + w4 · irreversibility       // R0 0 · R1 25 · R2 60 · R3 100
  + w5 · authority_gap         // action authority vs. principal's granted authority
  + w6 · taint_pressure        // UNTRUSTED influence on args: 0 / 40 / 100
  - w7 · certification_credit  // demonstrated agreement rate for this action type
)
```

Default tier boundaries: `LOW < 25 ≤ MEDIUM < 55 ≤ HIGH < 80 ≤ CRITICAL`.

**Rules that bypass the score entirely (hard gates, never overridable by a good score):**

- `R3` + `EXTERNAL` → always at least `HIGH`.
- Any `UNTRUSTED` value determining a recipient → always `CRITICAL`.
- Any action outside the principal's granted scope → `DENY`, unconditionally.
- Any action on a resource labeled `RESTRICTED` → dual approval minimum.

Weights are tenant-tunable within bounds, versioned, and recorded per evaluation so a historical
score can be reproduced exactly.

---

## 14. Autonomy State Machine

```
        certification passed                sample agreement holds
 SHADOW ────────────────────► SUPERVISED ──────────────────► SAMPLED
   ▲                              ▲    │                        │
   │                              │    │  error/novelty         │ sustained
   │                              │    │                        │ agreement
   │      re-certification        │    ▼                        ▼
   └──────────────────────────────┴─ (demote) ◄──────────── AUTONOMOUS
                                       │                        │
                                       │  critical error /      │
                                       │  comp failure /        │
                                       ▼  taint violation       │
                                  SUSPENDED ◄───────────────────┘
```

**Promotion requires all of:** minimum sample size met; agreement ≥ threshold; edit rate ≤
threshold; zero critical errors; connector and model versions unchanged since certification;
and an explicit human ratification. **Promotion is never automatic.**

**Demotion is always automatic and immediate** on the triggers in §8.2.4. Asymmetry is deliberate:
earning trust is slow and deliberate; losing it is instant.

---

## 15. Threat Model

| # | Threat | Impact | Mitigation |
|---|---|---|---|
| T1 | Indirect prompt injection via email/web/document | Agent exfiltrates data or acts for an attacker | D4 architecture; egress gating; red-team corpus in CI |
| T2 | Injection persisted into memory | Long-lived compromise across sessions | C7: untrusted content can never write memory |
| T3 | Compromised connector token | Broad data access | Short-lived scoped credentials per run; least privilege; anomaly detection |
| T4 | Malicious or careless insider | Data exfiltration under cover of the agent | Separation of duties; dual approval; auditor role; immutable chain |
| T5 | Audit tampering (including by us) | Evidence worthless | Separate plane, separate keys, hash chain, external anchoring, public verifier |
| T6 | Compensation failure cascade | Unrecoverable state after a partial run | Reverse-order sagas; TTL awareness; incident path; auto-demote |
| T7 | Runaway execution / cost | Financial and operational damage | Plan depth and fan-out bounds; hard budget caps; rate limits per entity |
| T8 | Duplicate/conflicting agent actions | Customer-visible embarrassment | D6 locks and contact ledger |
| T9 | Model regression on provider update | Silent quality collapse | Pinned versions; re-certification required on change; continuous eval |
| T10 | Data residency / cross-border leakage | Regulatory breach | Region-pinned routing (C4); per-tenant residency enforcement |
| T11 | Over-broad OAuth consent | User grants mailbox-wide access unnecessarily | Scope minimization per tool declaration; consent transparency screen |
| T12 | Approval fatigue → rubber-stamping | HITL becomes theatre | D5 batching, budgets; monitor approval latency as a *quality* signal — implausibly fast approvals are flagged |

**T12 deserves emphasis.** An approval workflow that humans rubber-stamp is worse than no
approval workflow, because it manufactures false evidence of oversight. Track approval latency
distribution and evidence-open rate; flag approvers whose behavior indicates non-review. This is
also an EU AI Act Article 14 exposure: oversight must be *genuine*, not nominal.

---

## 16. Technology Stack

Chosen for a small team shipping fast, with no component that blocks the invariants in §10.2.

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript end-to-end | One language, one type system across planes; shared contracts |
| Web | Next.js (App Router) + React | Standard, fast to build the six surfaces |
| API | Fastify + tRPC internal, REST + webhooks external | Type-safe internally, conventional externally |
| Primary DB | Postgres 16 + pgvector | Relational integrity, RLS for tenancy, vectors without a second store |
| Evidence DB | Separate Postgres instance + WORM object storage | Physical separation is the point |
| Durable execution | Temporal | Validated pattern; do not rebuild saga/durability |
| Queue / cache / locks | Redis | Entity leases, rate limits, batching |
| Object storage | S3-compatible with object lock | WORM for books-and-records |
| Secrets / keys | Cloud KMS + HSM-backed signing key | Execution plane must not hold the signing key |
| LLM gateway | LiteLLM or Portkey behind our own router | Commodity; do not build |
| Models | Claude Opus 5 (planning, high-risk), Claude Sonnet 5 (routine), Claude Haiku 4.5 (classification/extraction) | Frontier reasoning where risk is high, cheap models where it is not |
| Capability interpreter | Purpose-built TS AST interpreter over a restricted DSL | **Never `eval`.** A restricted DSL is the enforcement boundary for D4 |
| Signatures | ML-DSA (FIPS 204) + SHA-256 chain | Post-quantum; artifact outlives its retention period |
| Observability | OpenTelemetry → your APM of choice | Trace IDs correlate with run IDs |
| Eval harness | Custom, in-repo, CI-gated | Certification and red-team corpora are first-class code |

**Model note:** default to the most capable Claude models for planning and any High/Critical tier
action; route down for classification, extraction, and summarization. The quarantined extractor
(D4) should use a small fast model — it does structured extraction only and holds no tools.

---

## 17. Repository Layout

```
vega/
├─ apps/
│  ├─ web/                    # Next.js — all six surfaces (§6)
│  └─ mobile/                 # Approvals + revoke only (Phase 2)
├─ services/
│  ├─ control/                # Planner, policy, risk, autonomy, router, contention
│  ├─ execution/              # Interpreter, orchestrator, connector runtime, holds
│  ├─ evidence/               # Chain, signing, packs, replay  (separate creds)
│  └─ gateway/                # Public API, webhooks, auth
├─ packages/
│  ├─ contracts/              # Shared types: TaskGraph, ToolDeclaration, Receipt…
│  ├─ policy-engine/          # Policy DSL parser, evaluator, simulator
│  ├─ taint/                  # Lattice, propagation, capability interpreter
│  ├─ compensators/           # Compensator registry + per-connector inverses
│  ├─ connectors/             # One package per connector, all MCP-compatible
│  ├─ risk/                   # Scoring function, versioned weights
│  ├─ shared/                 # brand.ts (§3.1), utils, logging
│  └─ verifier/               # Standalone open-source chain verifier — publish this
├─ evals/
│  ├─ redteam/                # Prompt-injection corpus  (CI-gated, D4)
│  ├─ certification/          # Historical replay sets   (D2)
│  ├─ simulation/             # Simulated vs. actual effect accuracy (D1)
│  └─ compensation/           # Compensator correctness  (D1)
├─ policies/                  # Versioned policy packs, incl. vertical packs
├─ infra/                     # IaC — note the IAM boundary between planes
└─ PROJECT.md                 # This file
```

---

## 18. API Surface

External REST API, versioned at `/v1`. Every mutating endpoint is idempotent by key.

```
POST   /v1/runs                       # start a run from an objective
GET    /v1/runs/:id                   # status + trace
POST   /v1/runs/:id/cancel
GET    /v1/runs/:id/simulation        # blast radius, pre-execution      (D1)

GET    /v1/actions/:id
POST   /v1/actions/:id/revoke         # revoke a held action             (D1)
POST   /v1/actions/:id/release        # release early
POST   /v1/actions/:id/compensate     # explicit rollback                (D1)

GET    /v1/approvals                  # queue for the caller             (D5)
POST   /v1/approvals/:id/decide       # approve | edit | reject
GET    /v1/approvals/:id/packet       # the decision packet

GET    /v1/autonomy                   # tiers per workflow × action      (D2)
POST   /v1/autonomy/certify           # run certification
POST   /v1/autonomy/promote           # human ratification
GET    /v1/autonomy/proposals         # learned policy proposals

GET    /v1/audit/entries              # filtered chain query             (D3)
POST   /v1/audit/verify               # verify chain integrity
POST   /v1/evidence-packs             # build an evidence pack
GET    /v1/evidence-packs/:id
POST   /v1/replay/:action_id          # deterministic replay

GET    /v1/agents  POST /v1/agents  PATCH /v1/agents/:id
GET    /v1/policies  POST /v1/policies  POST /v1/policies/simulate
GET    /v1/connectors  POST /v1/connectors/:kind/authorize
GET    /v1/usage                      # cost & token analytics          (P5)

Webhooks: run.completed · approval.requested · action.held ·
          action.revoked · compensation.failed · autonomy.demoted ·
          taint.violation · budget.exceeded
```

---

# Part IV — Execution

## 19. Build Phases

Sequencing principle: **build the thing that makes the demo in §1.6 true, on one workflow, before
building anything horizontal.** Do not build all six differentiators at once.

### Phase 0 — Decisions (weeks 1–4, no product code)

- [ ] Trademark clearance; name selected (§3)
- [ ] 15 discovery calls; beachhead vertical closed (§4)
- [ ] One named design partner willing to run a shadow-mode pilot
- [ ] The single beachhead workflow specified end to end

**Gate:** do not proceed without a design partner. Building this without one is how the original
deck's version of this product dies.

### Phase 1 — The Provable, Reversible Core (months 2–5)

Vertical-neutral infrastructure plus one workflow.

- C1, C2, C5, C8 — minimum viable loop, one connector family (email + calendar)
- C3 — policy engine with the four risk tiers
- **D4** — taint architecture. *First*, not last. Retrofitting it is impossible.
- **D1** — reversibility classes, compensator registry, hold buffer, simulation
- **D3** — audit chain, signing, replay foundations, verifier
- **D5** — approval inbox and decision packets
- P1, P3 — tenancy, RBAC, connector framework

**Exit criteria:** the §1.6 demo runs end to end for a real design partner, in shadow or
supervised mode, with a real evidence pack and a working revoke.

### Phase 2 — Earned Autonomy (months 6–9)

- **D2** — full ladder, certification-by-replay, override corpus, learned proposals, auto-demotion
- C6 — verification engine
- C7 — semantic memory
- C4 — model router (internal cost control)
- P5 — usage analytics and budget caps
- Mobile approvals + revoke
- Action Center complete, including the Autonomy Dashboard

**Exit criteria:** at least one workflow promoted from `SHADOW` to `SAMPLED` at a paying customer,
on the strength of a certification report.

### Phase 3 — Multi-agent & Enterprise (months 10–15)

- **D6** — contention control, contact ledger, write reconciliation
- P2 — team workspaces and shared agents; the five team templates
- P4 — enterprise knowledge base
- P7 — single-tenant and private VPC deployment
- Vertical policy packs; SSO/SCIM; compliance certifications (SOC 2 Type II)

### Phase 4+ — Ecosystem

- P6 — marketplace, only after ~50 paying customers and a stable connector SDK
- Cross-org agent-to-agent protocols
- On-prem / air-gapped

---

## 20. Testing & Evaluation

Evals are product code, not QA. They gate CI.

| Suite | Gates | Failure means |
|---|---|---|
| **Red-team injection corpus** (D4) | Every build | Ship blocked. Zero successful exfiltrations, no exceptions. |
| **Compensation correctness** (D1) | Every build | The connector cannot register |
| **Simulation accuracy** (D1) | Nightly | Simulation is disabled for that tool until fixed |
| **Chain integrity** (D3) | Continuous, all envs | P0 incident |
| **Replay determinism** (D3) | Nightly | Certification is invalidated |
| **Certification replay sets** (D2) | On promotion request | No promotion |
| **Policy simulation** (C3) | On every policy change | Policy cannot deploy |
| **Approval-quality monitors** (D5) | Continuous in prod | Investigate the approver, not the model |

Additional practice: maintain an adversarial corpus that grows with every real incident — every
production surprise becomes a permanent test case. Track the red-team corpus size as a first-class
engineering metric.

---

## 21. Metrics

### 21.1 The metric that defines the company

> **Autonomy Rate** — the percentage of consequential actions completed with no human touch, at a
> bounded error rate.

Competitors report *actions blocked*. We report *work safely delegated*. Every board update leads
with this number, per customer, trending up.

### 21.2 Product health

| Metric | Target |
|---|---|
| Autonomy rate (per customer, trending) | Up and to the right, always |
| Error rate by risk tier | Critical: 0. High: < 0.5% |
| Mean / p99 Time-to-Undo | < 5s / < 60s for R1 |
| Compensation success rate | ≥ 99% |
| Median approval latency | < 10s routine |
| Evidence-open rate on approvals | > 60% (below this, oversight is theatre) |
| Notification volume per user per day | Within configured budget, 100% of tenants |
| Workflows promoted per customer per quarter | ≥ 2 |
| Simulation vs. actual divergence | < 1% |
| Successful injections in red-team corpus | 0 |

### 21.3 Business

Design partners converted; time from pilot to first promotion; net revenue retention (should be
driven by autonomy expansion, not seat growth); evidence packs exported per customer per quarter
(a proxy for whether compliance actually depends on us).

---

## 22. Pricing, Packaging & Market Sequencing

**Principle: never price on tokens.** Token margin is a collapsing business (inference fell ~80%
2023–2025). Price on governed actions and oversight seats — what the customer is actually buying.

### 22.1 The subset architecture constraint (binding on all modules)

> **Every tier runs the same engine. Tiers differ only in what is *exposed*, never in what is
> *built*.** Same interpreter, same compensators, same taint rules, same trace. A self-serve tier
> is a different front door onto identical machinery — never a second product.

This is a **design constraint, not a packaging preference**, and it binds every module. Retrofitting
a self-serve tier onto an enterprise-shaped product is a rewrite; building the seam now costs
roughly 8–12 engineer-weeks of onboarding, billing, defaults, and support tooling on top of the
ten modules.

**Undo is identical in every tier, including free.** It is the one differentiator that translates
to a single user, and it is the reason anyone would choose us over a free assistant. Never gate it.

| Capability | Individual / SMB | Teams / Enterprise |
|---|---|---|
| **Reversibility & undo (D1)** | **Identical** | **Identical** |
| **Taint defense (D4)** | **Identical** (invisible to the user) | **Identical** |
| Policy (C3) | 3 preset modes: Cautious / Balanced / Fast | Full YAML authoring + simulation |
| Approvals (D5) | Self-approval, in-app + push | Role routing, delegation, dual approval, SoD |
| Audit (D3) | Readable history, exportable | Signed chain, evidence packs, verifier, replay |
| Autonomy (D2) | "Ask before sending" toggle | Full certification ladder |
| Memory & knowledge (C7/P4) | Personal memory | + shared knowledge, ACL-aware retrieval |
| Contention (D6) | n/a | Locks, contact ledger, reconciliation |
| Deployment (P7) | Multi-tenant SaaS | + single-tenant, private VPC, air-gapped |
| Onboarding | Self-serve, credit card, < 5 min | Sales-assisted, SSO, implementation |

### 22.2 Tiers

| Tier | For | Includes |
|---|---|---|
| **Free** | Individuals trying it | 1 connector, limited runs/month, hold + undo, readable history. Exists to convert to SMB, not as a business |
| **Pro** | Individual professionals | Multi-connector, multi-step workflows, memory, full reversibility, usage visibility |
| **Business** | **5–50 person firms** | Multiple users, shared connectors, preset policy modes, simple approvals, team history. **Credit card, no procurement** |
| **Teams** | Operating teams inside larger orgs | Shared agents, workspaces, RBAC, approval routing, shared knowledge, earned autonomy engine |
| **Enterprise** | Regulated organizations | SSO/SCIM, custom policy packs, evidence packs, private deployment, data residency, certification reporting, support SLA |

### 22.3 Market sequencing — the order is the decision

Do **not** launch two motions at once. One small team cannot run an enterprise sale and a
self-serve funnel simultaneously — different pricing, onboarding, support, and cycle length. That
is the failure mode, not the ambition.

| Order | Tier | Why | Gate to advance |
|---|---|---|---|
| **1** | Design partner → **Teams/Enterprise** | Proves the engine on consequential work and funds the compensator engineering that makes undo real | One workflow promoted past SUPERVISED (§19 Phase 2 exit) |
| **2** | **Business (SMB self-serve)** | The real "anyone can buy it." Same engine, defaults instead of policy authoring | Positive contribution margin per account at target usage |
| **3** | Free / Pro (individual) | A wedge into (2) — converts when a second person joins | Only if organic acquisition works without paid spend |

**Why enterprise-down rather than consumer-up.** Undo is expensive to build (per-connector
compensator engineering, §24) and cheap to imitate in a demo. Fund it with enterprise revenue,
then give it away downmarket. Going consumer-first means paying for the moat out of $30/month
subscriptions while competing with free.

### 22.4 The SMB tier is the real answer to "anyone can use it"

Not individuals — **5–50 person firms**: agencies, recruiting shops, law practices, clinics,
brokerages, property managers, accounting firms.

They have everything that makes VEGA valuable and none of what makes enterprise sales slow:
consequential actions (client emails, invoices, bookings, records); an owner who **cannot
personally supervise everything**, making "show me what it did and let me undo it" immediately
valuable; and no compliance department, procurement, or security review. They buy with a credit
card in one session.

### 22.5 Pricing shape

| Segment | Shape |
|---|---|
| Free / Pro | Flat monthly, hard usage caps, no overage billing (caps degrade, never surprise) |
| Business | Per seat + included governed actions, metered above |
| Teams / Enterprise | Platform fee (governance, audit, evidence) + per oversight seat + metered governed actions with volume commitments |

Model cost is an input cost we absorb and optimize via C4 — never a line item the customer reasons
about.

### 22.6 The margin inversion — read before building the self-serve tier

At enterprise ACV, inference cost is a rounding error. **At $30/month it is the entire business.**

An individual running Opus 5 planning on every request is plausibly gross-margin negative. So the
low tiers force routing to Sonnet/Haiku-class planning and self-hosted extraction — and cheaper
planning means a higher error rate, which is precisely what the whole thesis is about bounding.

Consequences, all binding:

1. **C4 (model router) is existential below Teams, not a cost optimization.** Owned by Module 5.
2. **Hard budget caps ship with the first self-serve account**, not later. Breach degrades or
   queues; it never bills a surprise and never silently upgrades the model.
3. **Self-hosted embeddings, reranking, and extraction are mandatory** in the low tiers
   (TECHSTACK §14, §10.3) — they remove the per-document cost that scales with every mailbox.
4. **Publish per-tier contribution margin as an internal metric** from the first paying SMB
   account. A tier that cannot reach positive margin at target usage does not ship.

### 22.7 Acquisition risk

Individual and SMB acquisition competes against free products from OpenAI, Google, and Microsoft.
Paid acquisition against free incumbents is the documented failure pattern for AI startups (§2.1) —
ad costs rise, budgets exhaust, no organic distribution remains.

Therefore tier 3 launches **only** if organic acquisition works: content, the undo demo as an
inherently shareable artifact, and expansion from Business accounts. If the plan requires paid
acquisition to make individual users work, the answer is to stay at Business and above.

---

## 23. Compliance Mapping

Maintained as a live matrix; ships inside every evidence pack.

| Requirement | Where satisfied |
|---|---|
| **EU AI Act Art. 12** — automatic, tamper-evident logging, ≥6 months | D3 hash chain, WORM storage, retention config |
| **EU AI Act Art. 14** — genuine human oversight, intervention & override | D5 approvals, D1 revoke/undo, T12 rubber-stamp monitoring |
| **EU AI Act Art. 15** — accuracy, robustness, cybersecurity | D4 architecture, C6 verification, red-team CI |
| **EU AI Act Art. 26** — deployer obligations, log retention | Tenant retention config, evidence packs |
| **EU AI Act Art. 73** — serious-incident reporting | Incident path on COMP_FAILED and taint violations |
| **NIST AI RMF** — Govern / Map / Measure / Manage | Policy engine, risk scoring, metrics, autonomy ladder |
| **SEC/FINRA books & records (beachhead)** | WORM object lock, supervised-review receipts, archival export |
| **SOC 2 Type II** | Phase 3 — plane separation and audit chain do most of the work |
| **GDPR erasure vs. immutable audit** | Chain commits to digests; plaintext is separately redactable (§11.1) |

Enforcement note: EU AI Act high-risk obligations became enforceable **2 August 2026**. Penalties
reach €35M or 7% of worldwide turnover. This is a live buying trigger, not a future one.

---

## 24. Risks & Kill Criteria

| Risk | Severity | Mitigation | Kill criterion |
|---|---|---|---|
| Compensators are per-integration and expensive | High — this *is* the moat, and moats cost | Start with 6 connectors, deepest first | If a typical connector costs > 6 engineer-weeks to make compensable, the economics fail |
| Prompt injection is unsolved in the general case | High | D4 mitigates structurally; never claim immunity | A successful exfiltration in production that D4 architecture could not have prevented |
| Microsoft ships reversibility in Agent 365 | High | Depth per connector + regulated evidence; they optimize for horizontal breadth | If they ship true per-action compensation across the M365 estate, re-evaluate the entire thesis |
| Customers do not actually want more autonomy | **Existential** | Phase 0 discovery exists to test exactly this | If design partners will not promote a single workflow past SUPERVISED in 6 months, the thesis is wrong |
| Regulated sales cycles outrun runway | High | Design partner before code; charge for pilots | Two consecutive quarters with no pilot converting |
| Overbuilding before a customer | High | Phase gates; one workflow only | Phase 1 exceeding 5 months |
| Approval fatigue kills the pilot | Medium | D5 is a first-class product, not a form | Evidence-open rate below 40% sustained |
| The name | Medium | §3 | — |

**The honest summary of difficulty:** everything in D1 is per-integration engineering, not a
framework you install. That cost *is* the moat — but it is also the thing most likely to kill the
company if the per-connector economics do not work. Measure it explicitly from the first connector.

---

## 25. Decision Log & Open Questions

### Decided

| # | Decision | Rationale | Date |
|---|---|---|---|
| D-01 | Position on reversibility + proof + earned autonomy, not on capability breadth | Capability layer is closed; §1.2 | 2026-08-22 |
| D-02 | Model router is internal only, never marketed | Commodity, collapsing margin | 2026-08-22 |
| D-03 | Marketplace deferred to Phase 4+ | No ecosystem for 24+ months | 2026-08-22 |
| D-04 | ~~Launch at Teams/Enterprise, not Personal~~ — **superseded by D-08** | Direction was right, sequencing was incomplete | 2026-08-22 |
| D-05 | D4 (taint) built in Phase 1, not later | Cannot be retrofitted; invalidates the security claim | 2026-08-22 |
| D-06 | Consume Temporal for durability rather than build | Validated infra; our value is above it | 2026-08-22 |
| D-07 | Publish the chain verifier as open source | Independent verifiability is the trust asset | 2026-08-22 |
| **D-08** | **Three-stage market sequencing: Enterprise → SMB self-serve → individual**, one motion at a time | Undo is expensive to build and cheap to imitate — fund it with enterprise revenue, then give it away downmarket (§22.3) | 2026-08-22 |
| **D-09** | **Subset architecture: all tiers run one engine; tiers differ only in what is exposed** | Retrofitting self-serve onto an enterprise-shaped product is a rewrite. Binding on every module (§22.1) | 2026-08-22 |
| **D-10** | **Undo (D1) and taint defense (D4) are identical in every tier, including free** | D1 is the only differentiator that translates to a single user; it is the reason to choose us over a free assistant | 2026-08-22 |
| **D-11** | **Wealth-management beachhead withdrawn**; sixth selection criterion added | Smarsh owns FINRA 3110 supervision (Gartner MQ Leader, 18 of top 20 FIs, agentic supervision shipped May 2026) — §4.2 | 2026-08-22 |
| **D-12** | **C4 assigned to Module 5** and reclassified as existential below Teams | At $30/month, inference cost is the whole business, not a rounding error (§22.6) | 2026-08-22 |

### Open — ranked by leverage

1. **Beachhead vertical** (§4). Blocks policy packs, connectors, and GTM. *Owner: founder. Due: Phase 0.*
2. **Name** (§3). Blocks anything public. *Due: Phase 0.*
3. **Design partner.** Blocks Phase 1 entirely. *Due: Phase 0.*
4. **Per-connector compensator economics.** Measure on connector #1; it determines whether the
   moat is affordable.
5. **Deployment posture for the beachhead** — will these buyers accept multi-tenant SaaS, or does
   Phase 1 need single-tenant? Affects infrastructure cost dramatically.
6. **Do we ever hold the signing key?** Recommendation: no, for single-tenant and above. Confirm
   with a compliance buyer.
7. **How much override telemetry can we aggregate across tenants?** Contract language needed in
   the MSA from customer #1 — this is the moat's legal foundation.

---

## 26. Glossary

| Term | Meaning |
|---|---|
| **Action** | A single tool invocation with a real-world effect |
| **Autonomy tier** | SHADOW / SUPERVISED / SAMPLED / AUTONOMOUS / SUSPENDED, per workflow × action type |
| **Autonomy rate** | % of consequential actions completed with no human touch at bounded error |
| **Blast radius** | The simulated set of effects a run will produce before it executes |
| **Certification** | Evidence-based report qualifying a workflow for promotion |
| **Compensator** | A registered inverse action that reverses a committed action |
| **Decision packet** | The one-screen artifact an approver sees |
| **Egress class** | INTERNAL / EXTERNAL / PUBLIC — where an action's effect reaches |
| **Evidence pack** | Signed, exportable archive proving what happened, mapped to controls |
| **Hold window** | Delay between internal commit and external release, during which revoke works |
| **Lethal trifecta** | Private data + untrusted content + exfiltration vector (Willison) |
| **Override corpus** | The record of human approvals, rejections, and edits — the moat |
| **Proof-carrying action** | An action accompanied by a signed, verifiable receipt |
| **R0–R3** | Reversibility classes: fully reversible → irreversible |
| **Taint** | TRUSTED / ORG / UNTRUSTED provenance label, propagated through all derivations |
| **Time-to-Undo** | Elapsed time from "user decides to undo" to "state restored" |

---

*End of specification. Update this document before changing scope, not after.*


