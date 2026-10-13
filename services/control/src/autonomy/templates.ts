import type { AgentSpec } from '@vega/contracts';

/**
 * TEAM TEMPLATES — docs/module10.md §11, PROJECT.md §9.2. A template is a starting point for an
 * agent's spec with policy bindings that ship with it. It is NOT a shortcut up the ladder: every
 * (agent × consequential tool) pair a template creates starts at SHADOW, template or not, and
 * only a certification a person ratifies moves it.
 *
 * Templates carry no program: the planner makes the plan from the objective template, inside
 * the tools listed. A tool that a tenant has not connected is simply not usable until it is.
 */
export interface TeamTemplate {
  key: 'sales' | 'operations' | 'hr' | 'marketing' | 'management';
  name: string;
  summary: string;
  flow: string[];
  spec: Pick<AgentSpec, 'objectiveTemplate' | 'allowedTools' | 'allowedConnectors' | 'policyBindings' | 'limits'>;
}

/** The policy pack's keys that apply to anything that writes to a person outside the organization. */
const OUTBOUND_BINDINGS = ['client-confidentiality', 'personal-data-to-non-clients', 'credentials-never-sent', 'first-contact-hold'];
const DOCUMENT_BINDINGS = ['client-confidentiality', 'credentials-never-sent', 'irreversible-human-oversight'];

export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
  {
    key: 'sales',
    name: 'Sales',
    summary: 'Research a lead, qualify it, keep the CRM current, and draft the follow-up for a person to send.',
    flow: ['Lead research', 'Qualification', 'CRM update', 'Follow-up'],
    spec: {
      objectiveTemplate: 'Research the lead named in the request, summarise what is publicly known, qualify it against our criteria, and draft a follow-up email. Do not send anything.',
      allowedTools: ['web.search', 'web.fetch', 'gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send', 'gcal.list'],
      allowedConnectors: ['gmail', 'gcal', 'web'],
      policyBindings: OUTBOUND_BINDINGS,
      limits: { maxSteps: 40, maxCostCents: 150, maxFanout: 10 },
    },
  },
  {
    key: 'operations',
    name: 'Operations',
    summary: 'Compile reports, run recurring workflows, schedule work and watch for things that need attention.',
    flow: ['Reports', 'Workflows', 'Scheduling', 'Monitoring'],
    spec: {
      objectiveTemplate: 'Compile the report requested from the shared documents and mail, schedule the follow-up work it implies, and flag anything that needs a person’s attention.',
      allowedTools: ['gdrive.read', 'gmail.search', 'gmail.read', 'gcal.list', 'gcal.create', 'slack.post'],
      allowedConnectors: ['gdrive', 'gmail', 'gcal', 'slack'],
      policyBindings: [...DOCUMENT_BINDINGS, 'credentials-never-sent'].filter((v, i, a) => a.indexOf(v) === i),
      limits: { maxSteps: 60, maxCostCents: 200, maxFanout: 20 },
    },
  },
  {
    key: 'hr',
    name: 'HR',
    summary: 'Coordinate candidates: find times, draft messages and keep the process moving — personal data stays inside.',
    flow: ['Candidate coordination', 'Scheduling', 'Communication'],
    spec: {
      objectiveTemplate: 'Find a time that works for the candidate and the interviewers, draft the invitation and the confirmation message, and leave both for a person to approve.',
      allowedTools: ['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send', 'gcal.list', 'gcal.create'],
      allowedConnectors: ['gmail', 'gcal'],
      policyBindings: [...OUTBOUND_BINDINGS, 'health-data-never-external'],
      limits: { maxSteps: 30, maxCostCents: 100, maxFanout: 5 },
    },
  },
  {
    key: 'marketing',
    name: 'Marketing',
    summary: 'Research a market, run content through a drafting workflow and read campaign results.',
    flow: ['Research', 'Content workflow', 'Campaign analysis'],
    spec: {
      objectiveTemplate: 'Research the topic requested, draft the content for review, and summarise how the last campaign performed against its goals.',
      allowedTools: ['web.search', 'web.fetch', 'gdrive.read', 'gdrive.write', 'slack.post'],
      allowedConnectors: ['web', 'gdrive', 'slack'],
      policyBindings: DOCUMENT_BINDINGS,
      limits: { maxSteps: 40, maxCostCents: 150, maxFanout: 10 },
    },
  },
  {
    key: 'management',
    name: 'Management',
    summary: 'Executive summaries, meeting preparation and follow-ups, with nothing leaving the organization unreviewed.',
    flow: ['Executive summaries', 'Meeting prep', 'Follow-ups'],
    spec: {
      objectiveTemplate: 'Summarise what changed this week across mail, calendar and documents, prepare the briefing for the next meeting, and draft the follow-ups it implies.',
      allowedTools: ['gmail.search', 'gmail.read', 'gmail.draft', 'gcal.list', 'gdrive.read', 'slack.post'],
      allowedConnectors: ['gmail', 'gcal', 'gdrive', 'slack'],
      policyBindings: OUTBOUND_BINDINGS,
      limits: { maxSteps: 40, maxCostCents: 150, maxFanout: 10 },
    },
  },
];

export const templateByKey = (key: string): TeamTemplate | undefined => TEAM_TEMPLATES.find((t) => t.key === key);
