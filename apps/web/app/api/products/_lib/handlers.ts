import {
  createLogger,
  FAMILY_GROUPING_REPORTED_EVENT,
  groupingReportEventProperties,
  recordGroupingReport,
  reportGroupingRequestSchema,
  accountAttribution,
  type Logger,
  type PosthogCapture,
} from '@sortiva/core'
import { makeFamilyStore, type FamilyStore } from '@sortiva/db'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * The one thing a merchant can do about a wrong grouping in v1.
 *
 * Families are read-only — no split, no merge, no rename — so this route is the
 * whole of the escape hatch. It accepts, records, and says so; nothing changes
 * about the family, which is what the screen tells the merchant too.
 */

export interface ReportGroupingDeps {
  readonly families: FamilyStore
  readonly log: Logger
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

export function makeReportGroupingHandler(deps: ReportGroupingDeps): AccountHandler {
  return async (request, { scope }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest('invalid_body', 'Send a JSON body naming the family and the reason.')
    }

    const parsed = reportGroupingRequestSchema.safeParse(body)
    if (!parsed.success) {
      return badRequest(
        'invalid_body',
        'A report names the family it is about and says what is wrong with it.',
      )
    }

    // Read through the account scope, so a family id belonging to another
    // merchant answers "not found" rather than confirming that it exists.
    const family = await deps.families.find(scope, parsed.data.familyId)
    if (!family) {
      return Response.json(
        { error: { code: 'family_not_found', message: 'That grouping is gone.' } },
        { status: 404 },
      )
    }

    const report = {
      accountId: scope.accountId,
      familyId: family.id,
      memberCount: family.memberCount,
      groupingSource: family.groupingSource,
      reason: parsed.data.reason,
    }
    recordGroupingReport(deps.log, report)

    // Three facts leave for analytics and the merchant's own words do not: they
    // are prose about their own catalogue, and no event may carry store content.
    deps.capture?.capture({
      event: FAMILY_GROUPING_REPORTED_EVENT,
      attribution: accountAttribution(scope.accountId),
      properties: groupingReportEventProperties(report),
    })

    return Response.json({ ok: true })
  }
}

export function reportGroupingDeps(): ReportGroupingDeps {
  return { families: makeFamilyStore(), log: createLogger({ base: { component: 'products' } }) }
}

function badRequest(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 400 })
}
