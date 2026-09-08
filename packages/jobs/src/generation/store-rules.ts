import type { Db } from '@sortiva/db'
import { rules, type ResolvedRules } from '@sortiva/rules'
import { TableRulesOverrideReader } from '../scan/rules-overrides'

/**
 * The numbers this store is judged by, and the version to stamp on whatever
 * they decide — a gate verdict, a piece of work raised for the merchant, or
 * anything else a threshold produces.
 *
 * An operator can move one threshold for one store without a deploy. A caller
 * that reads the repo file instead accepts such a change and then ignores it —
 * silently, which is the shape of failure the whole mechanism exists to
 * prevent. Which callers do and do not go through here is not something to
 * discover by reading them: it is written down in `packages/rules`'s reach
 * table, which is also what the operator command refuses against.
 *
 * **The version comes back from the same call as the numbers, and that is the
 * point.** The string stamped on a decision is read by the learning loop and by
 * every audit as "these were the numbers that produced this". A decision
 * reached under a moved threshold must therefore not stamp the string that
 * means "the repo file's numbers judged this". A store on the repo file's
 * numbers stamps exactly what it always stamped, so nothing already recorded
 * becomes unreadable.
 *
 * A malformed row throws rather than being skipped, matching the weekly scan:
 * a threshold that quietly fails to apply is worse than one never set, because
 * the operator believes it is in force and only the store's behaviour says
 * otherwise.
 *
 * The locale passed in is the one the caller already judges by, so the layer
 * this returns and the rows folded onto it always agree about which language is
 * in play. Passing none means the global layer, exactly as before — going and
 * looking up the store's own language here would change which numbers every
 * non-English store is judged by, with no override anywhere in sight. A row
 * aimed at a page type reaches nothing that calls this: a topic, a draft and a
 * published article of ours are not page types.
 */
export async function resolveStoreRules(
  db: Db,
  accountId: string,
  locale: string | null | undefined,
): Promise<ResolvedRules> {
  const scope = { accountId, ...(locale ? { locale } : {}) }
  const overrides = await new TableRulesOverrideReader(db).read(scope)
  return rules().resolve({ ...scope, overrides })
}
