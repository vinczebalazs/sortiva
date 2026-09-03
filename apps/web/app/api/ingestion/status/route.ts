import { withAccount } from '../../auth/_lib/session'
import { ingestionDeps, makeIngestionStatusHandler } from '../_lib/handlers'

/** The 5-second fallback poll for when the SSE stream drops (tech §1.6). */
export const dynamic = 'force-dynamic'

export const GET = withAccount(makeIngestionStatusHandler(ingestionDeps()))
