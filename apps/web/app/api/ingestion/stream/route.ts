import { withAccount } from '../../auth/_lib/session'
import { ingestionDeps, makeIngestionStreamHandler } from '../_lib/handlers'

/** Server-sent stream of `job_steps` transitions for the active run (tech §1.6). */
export const dynamic = 'force-dynamic'

export const GET = withAccount(makeIngestionStreamHandler(ingestionDeps()))
