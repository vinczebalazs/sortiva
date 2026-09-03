import { withAccount } from '../../auth/_lib/session'
import { opportunitiesDeps } from '../_lib/config'
import { makeScanStatusHandler } from '../_lib/scan-status'

/** The 2-second fallback poll for when the SSE stream drops (tech §1.6). */
export const dynamic = 'force-dynamic'

export const GET = withAccount((request, context) => makeScanStatusHandler(opportunitiesDeps())(request, context))
