import { withAccount } from '../../auth/_lib/session'
import { opportunitiesDeps } from '../_lib/config'
import { makeScanStreamHandler } from '../_lib/scan-status'

/** Server-sent stream of the onboarding run's own `signal_runs` state (tech §1.6; ui §3.8). */
export const dynamic = 'force-dynamic'

export const GET = withAccount((request, context) => makeScanStreamHandler(opportunitiesDeps())(request, context))
