import { withAccount } from '../../../auth/_lib/session'
import { makeRemoveKeywordHandler, profileDeps } from '../../_lib/handlers'

/** Removing a term. Scoped to the account, so another merchant's id answers "already gone". */
export const dynamic = 'force-dynamic'

export const DELETE = withAccount(makeRemoveKeywordHandler(profileDeps()))
