import { router } from '../trpc.js';
import { agentsRouter } from './agents.js';
import { connectorsRouter } from './connectors.js';
import { mcpRouter } from './mcp.js';
import { contactsRouter, programsRouter, securityRouter } from './programs.js';
import { toolsRouter } from './tools.js';
import { meRouter } from './me.js';
import { signupRouter } from './signup.js';
import { tenantsRouter } from './tenants.js';
import { usersRouter } from './users.js';
import { workspacesRouter } from './workspaces.js';
import { runsRouter } from './runs.js';
import { conversationsRouter } from './conversations.js';
import { policiesRouter } from './policies.js';
import { riskRouter } from './risk.js';
import { triggersRouter, webhooksRouter } from './webhooks.js';
import { holdsRouter, reversibilityRouter, undoRouter } from './reversibility.js';
import { auditRouter, evidencePacksRouter, publicEvidenceRouter, replayRouter, tracesRouter } from './evidence.js';
import { kbRouter, memoriesRouter, retrievalsRouter, verificationsRouter } from './knowledge.js';
import { actionCenterRouter, approvalQualityRouter, approvalsRouter, delegationsRouter } from './approvals.js';

export const appRouter = router({
  me: meRouter,
  tenants: tenantsRouter,
  users: usersRouter,
  workspaces: workspacesRouter,
  agents: agentsRouter,
  connectors: connectorsRouter,
  tools: toolsRouter,
  mcp: mcpRouter,
  programs: programsRouter,
  security: securityRouter,
  contacts: contactsRouter,
  runs: runsRouter,
  conversations: conversationsRouter,
  webhooks: webhooksRouter,
  policies: policiesRouter,
  risk: riskRouter,
  triggers: triggersRouter,
  holds: holdsRouter,
  undo: undoRouter,
  reversibility: reversibilityRouter,
  audit: auditRouter,
  traces: tracesRouter,
  evidencePacks: evidencePacksRouter,
  replay: replayRouter,
  publicEvidence: publicEvidenceRouter,
  approvals: approvalsRouter,
  delegations: delegationsRouter,
  approvalQuality: approvalQualityRouter,
  actionCenter: actionCenterRouter,
  memories: memoriesRouter,
  kb: kbRouter,
  verifications: verificationsRouter,
  retrievals: retrievalsRouter,
  signup: signupRouter,
});

export type AppRouter = typeof appRouter;
