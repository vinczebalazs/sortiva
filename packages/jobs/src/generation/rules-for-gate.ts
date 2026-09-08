import type { Db } from '@sortiva/db'
import { rules, type ResolvedRules } from '@sortiva/rules'
import { TableRulesOverrideReader } from '../scan/rules-overrides'

/**
 * The numbers this store's gates judge by, and the version to stamp on what
 * they decide.
 *
 * An operator can move one threshold for one store without a deploy. Until this
 * existed the gates read the repo file and nothing else, so such a change was
 * accepted by the operator command and then ignored here — silently, which is
 * the shape of failure the whole mechanism exists to prevent.
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
 * The locale passed in is the one the gate itself judges by, so the layer this
 * returns and the rows folded onto it always agree about which language is in
 * play. A row aimed at a page type reaches no gate: gates decide about a topic
 * and a draft, neither of which is a page type.
 */
export async function resolveRulesForGate(
  db: Db,
  accountId: string,
  locale: string | null | undefined,
): Promise<ResolvedRules> {
  const scope = { accountId, ...(locale ? { locale } : {}) }
  const overrides = await new TableRulesOverrideReader(db).read(scope)
  return rules().resolve({ ...scope, overrides })
}
