import { isPromotion, moreRestrictive, type Tier } from './ladder.js';
import type { AutonomyStore, CertificationRow, TransitionRow } from './store.js';

/**
 * PROMOTION — docs/module10.md §4.1, §18. "Promotion is never automatic": this is the ONLY
 * function in the package that moves a pair up, and it takes a certification row and a named
 * human. Every gate condition is checked again at ratification time, because the certification
 * may be days old and a connector or model may have changed since.
 */
export class PromotionRefused extends Error {
  constructor(
    message: string,
    readonly reasons: string[],
  ) {
    super(message);
  }
}

export interface RatifyInput {
  tenantId: string;
  certificationId: string;
  ratifiedBy: string;
  /** What the pair's tool declaration says NOW (injected: it lives behind the execution plane). */
  currentConnectorVersion: number;
  currentSimulateFidelity: string;
  /** The tool's declared cap, if any (an undeclared MCP tool stops at SUPERVISED). */
  autonomyCap?: 'SUPERVISED' | null;
  /** 1-in-N when the target tier is SAMPLED. */
  sampleRate?: number;
}

const MAX_AGE_MS = 30 * 86_400_000; // a certification older than this must be re-run, not ratified

export class PromotionEngine {
  constructor(private readonly store: AutonomyStore, private readonly now: () => Date = () => new Date()) {}

  async ratify(i: RatifyInput): Promise<{ transition: TransitionRow; certification: CertificationRow }> {
    const cert = await this.store.certification(i.tenantId, i.certificationId);
    if (!cert) throw new PromotionRefused('no such certification', ['not found']);
    const why: string[] = [];
    if (cert.recommendation !== 'PROMOTE' || !cert.recommendedTier) why.push(`the report recommends ${cert.recommendation}, not PROMOTE`);
    if (cert.decidedAt) why.push('this certification was already acted on; run a fresh one');
    if (this.now().getTime() - cert.createdAt.getTime() > MAX_AGE_MS) why.push('the certification is more than 30 days old');
    if ((cert.criticalErrors ?? 0) > 0) why.push(`${cert.criticalErrors} critical error(s) in the certified history`);

    const pinned = (cert.connectorVersions as Record<string, number>)[cert.actionType];
    if (pinned !== undefined && pinned !== i.currentConnectorVersion) why.push(`the connector changed since certification (v${pinned} → v${i.currentConnectorVersion})`);
    if (i.currentSimulateFidelity === 'DECLARED') why.push('simulation fidelity for this tool is DECLARED (M6 §5.6)');
    if (i.autonomyCap === 'SUPERVISED' && cert.recommendedTier && cert.recommendedTier !== 'SUPERVISED') why.push(`this tool is capped at SUPERVISED until its declaration is reviewed`);

    const state = await this.store.get(i.tenantId, cert.workflowKey, cert.actionType);
    const from = (state?.tier as Tier | undefined) ?? 'SHADOW';
    if (state && state.certificationId !== cert.id && state.since > cert.createdAt) why.push('the pair changed tier after this certification was made (e.g. a demotion): re-certify');
    if (from !== cert.fromTier) why.push(`the pair is at ${from}, not ${cert.fromTier}: re-certify`);
    const to = cert.recommendedTier as Tier | null;
    if (to && !isPromotion(from, to)) why.push(`${from} → ${to} is not a single promotion step`);
    if (why.length) throw new PromotionRefused(`promotion refused: ${why.join('; ')}`, why);

    const certification = await this.store.ratify(i.tenantId, cert.id, i.ratifiedBy);
    const { transition } = await this.store.transition({
      tenantId: i.tenantId,
      workflowKey: cert.workflowKey,
      actionType: cert.actionType,
      fromTier: from,
      toTier: to!,
      direction: 'PROMOTE',
      trigger: 'certification',
      evidence: { certificationId: cert.id, agreementRate: Number(cert.agreementRate), editRate: Number(cert.editRate), sampleSize: cert.sampleSize, reportRef: cert.reportRef },
      actorId: i.ratifiedBy,
      certificationId: cert.id,
      sampleRate: to === 'SAMPLED' ? (i.sampleRate ?? 5) : null,
    });
    return { transition, certification };
  }

  /** A person demoting by hand (§16 `POST /v1/autonomy/demote`): always allowed, always recorded. */
  async manualDemote(i: { tenantId: string; workflowKey: string; actionType: string; to: Tier; by: string; reason: string }): Promise<TransitionRow> {
    const state = await this.store.get(i.tenantId, i.workflowKey, i.actionType);
    const from = (state?.tier as Tier | undefined) ?? 'AUTONOMOUS';
    if (!moreRestrictive(from, i.to)) throw new PromotionRefused(`a manual demotion must be stricter than ${from}`, [`${from} → ${i.to} is not a demotion`]);
    const { transition } = await this.store.transition({ tenantId: i.tenantId, workflowKey: i.workflowKey, actionType: i.actionType, fromTier: from, toTier: i.to, direction: 'DEMOTE', trigger: 'manual', evidence: { reason: i.reason }, actorId: i.by });
    return transition;
  }
}
