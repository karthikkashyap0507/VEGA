# Security position: prompt injection

> For customer conversations, security questionnaires and sales decks (docs/module3.md §10.1).
> Every sentence here must stay mechanically true. If the product changes, change this first.

## What we claim

**Untrusted content is structurally prevented from reaching privileged tools, and every path it
did influence is visible.**

We do **not** claim to be "immune to prompt injection". No one can make that claim honestly:
the model vendors themselves say injection is not solvable at the model layer. We solve a
narrower problem at the architecture layer, and we can show our work.

## How it works, in one paragraph

The component that decides what to do (the *planner*) never sees content from outside your
organization: it sees your instruction, the tools, and *metadata* about content (for example,
"an email from acme.example, 34-character subject"). It writes a small program in a restricted
language. A separate *interpreter* runs that program and labels every value with where it came
from. Content from email, the web or inbound documents is read only by an isolated *extractor*
that has no tools, no credentials and no network access except the model, and can only fill in a
typed form. Before any tool runs, a *gate* checks the labels of its arguments.

## The guarantees

1. **Content can never choose a recipient.** An argument that names who receives something (an
   email's To/Cc/Bcc, a share's grantee, a meeting's attendees, a Slack channel) must come from
   your instruction or from a registry your organization controls (your directory, your trusted
   contacts). This is refused, not escalated: **no approval can override it**, because a human
   approving "send this to the address in the email" is exactly the failure approval cannot fix.
2. **Content cannot trigger external actions on its own.** Anything leaving your organization
   whose arguments — or whose decision to happen at all — were influenced by untrusted content
   waits for a human, who sees which parts came from where.
3. **Summarizing does not launder.** A summary, extraction or rewrite of untrusted content is
   still untrusted. So is anything computed inside a branch that depended on it.
4. **The planner never sees content.** This is enforced by the build (the planner package cannot
   even reference the types that carry content) and asserted on captured prompts in CI.
5. **Every influence is visible.** Every value records its sources; every run has a provenance
   graph; every refusal is a recorded, paged security incident.

## Honest limits — say these out loud

- **The extractor can be misled within its schema.** A hijacked extraction can return a plausible
  but wrong meeting time or figure. It cannot return a new recipient, and schemas bound every
  value (a 90,000-minute meeting is rejected), but a wrong value inside the bounds is possible.
  Mitigations: value-range validation, cross-source corroboration for high-risk actions, and the
  approval gate.
- **Metadata can mislead the planner.** A crafted sender domain is still visible to it (hostname
  characters only; look-alike Unicode domains are dropped rather than shown).
- **Approval is a human control.** If someone approves an external action influenced by untrusted
  content, that action happens. The approval screen says exactly which arguments came from where;
  it cannot make the person read it. In particular, an approved web fetch of a link found in
  untrusted content reveals to that site whatever the link contains.
- **A compromised connector is trusted as far as its label.** Content from an internal system we
  label ORG is believed to that level.
- **Confidentiality is not the lattice's job.** Taint tracks *integrity* (who influenced this),
  not secrecy. Keeping confidential data from leaving is data classification and policy
  (Module 5) plus the recipient guarantee above.

## Evidence we can show a customer

| Claim | Evidence |
|---|---|
| Recipient guarantee | Gate decision table (81 cases); red-team corpus with a rubber-stamp approver — 0 attacker recipients |
| No laundering / implicit flow | Seven property-based soundness properties over random programs, mutation-tested |
| Planner isolation | Build-time lint rule; CI asserts no attack string appears in captured planner prompts |
| Extractor isolation | In-cluster test: the extractor pod cannot reach any tool, database, service or the internet |
| Red-team | 207 cases (14 categories × 9 encodings), zero successful attacks, blocking in CI |

The corpus grows with every production surprise, and its size is a tracked metric.
