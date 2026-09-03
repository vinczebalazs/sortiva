import type { Opportunity, OpportunitySource } from '@sortiva/core'
import { toContractOpportunity } from '@sortiva/core'
import { accountScope, acceptedContentOpportunities, type Db } from '@sortiva/db'
import { rules } from '@sortiva/rules'

/**
 * The `OpportunitySource` seam (`packages/core/contracts/opportunities.ts`),
 * filled: Lane D's calendar-seeding and replenishment read auto-accepted
 * CREATE/REFRESH opportunities through this rather than the stub pool from
 * `signals.fixtures`.
 *
 * A thin read, deliberately: the repository already does the filtering
 * (`status = 'accepted' AND recommended_action IN ('create','refresh')`,
 * main §7.9's autopilot policy), so this class only has to map each row into
 * the shape the contract promises.
 */
export class DbOpportunitySource implements OpportunitySource {
  constructor(private readonly db: Db) {}

  async acceptedContentOpportunities(accountId: string): Promise<readonly Opportunity[]> {
    const rows = await acceptedContentOpportunities(this.db, accountScope(accountId))
    const confidenceConfig = rules().defaults.scoring.confidence
    return rows.map((row) =>
      toContractOpportunity(
        {
          id: row.id,
          accountId: row.accountId,
          signalType: row.signalType,
          entityType: row.entityType,
          entityRef: row.entityRef,
          evidenceJson: row.evidenceJson,
          impact: row.impact,
          impactScore: row.impactScore,
          confidence: row.confidence,
          reasonTemplateKey: row.reasonTemplateKey,
          reasonParamsJson: row.reasonParamsJson,
          recommendedAction: row.recommendedAction,
          preconditionsJson: row.preconditionsJson,
          status: row.status,
          rulesVersion: row.rulesVersion,
          limitedIntelligence: row.limitedIntelligence,
          detectedAt: row.detectedAt,
          updatedAt: row.updatedAt,
          expiredReason: row.expiredReason,
        },
        confidenceConfig,
      ),
    )
  }
}
