import type { Logger } from '../observability/logger'

/**
 * "You've grouped these wrong."
 *
 * Families are read-only in v1 — a split/merge/rename editor is an entire UI
 * surface and is deliberately deferred — so a merchant who disagrees with a
 * grouping has one thing they can do, and this is it. The escape hatch matters
 * more than it looks: without it, a merchant who sees us describe their
 * catalogue wrongly has no way to say so, and the next thing they read from us
 * is an article built on the same mistake.
 *
 * Two things happen with what they send, and they are deliberately different.
 * The **words** are feedback about their own catalogue — free prose naming their
 * own products — so they go into our own record and nowhere else. The **facts**
 * about the report (which family, how big it was, which signal grouped it) are
 * what makes the reports useful in aggregate: whether we merge too eagerly, and
 * which signal does it. Those are ids and counts, which is all an analytics
 * event may ever carry.
 */

export const FAMILY_GROUPING_REPORTED_EVENT = 'family_grouping_reported'

export interface GroupingReport {
  readonly accountId: string
  readonly familyId: string
  readonly memberCount: number
  readonly groupingSource: string
  /** What the merchant typed. Never leaves our own systems. */
  readonly reason: string
}

/**
 * Records one report.
 *
 * It is written to our own structured log rather than to a table, because there
 * is no support-feedback table in this schema and a feature card may not add
 * one. The log is durable, is where every other operational record of what a
 * merchant did already lives, and carries the family id — so a report can be
 * traced back to the exact grouping that prompted it. See DECISIONS
 * 2026-09-02 T2.4.
 */
export function recordGroupingReport(log: Logger, report: GroupingReport): void {
  log.info('family_grouping.reported', {
    account_id: report.accountId,
    family_id: report.familyId,
    member_count: report.memberCount,
    grouping_source: report.groupingSource,
    reason: report.reason,
  })
}

/**
 * The three facts about a report that may leave for analytics.
 *
 * Built here rather than at the call site so the merchant's words cannot be
 * added to it by a later edit without deleting a line that says why they may
 * not be.
 */
export function groupingReportEventProperties(
  report: GroupingReport,
): Record<string, string | number> {
  return {
    family_id: report.familyId,
    member_count: report.memberCount,
    grouping_source: report.groupingSource,
  }
}
