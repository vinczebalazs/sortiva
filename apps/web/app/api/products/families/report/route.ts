import { withAccount } from '../../../auth/_lib/session'
import { makeReportGroupingHandler, reportGroupingDeps } from '../../_lib/handlers'

/**
 * Feedback only. The family is not edited, and the answer says nothing about
 * what will happen to it — because in v1 nothing does, and implying otherwise
 * would be a promise the product cannot keep.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(makeReportGroupingHandler(reportGroupingDeps()))
