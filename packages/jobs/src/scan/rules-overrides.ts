import { accountScope, readRulesOverridesForAccount, type Db } from '@sortiva/db'
import type { RulesOverrideReader, RulesOverrideRow, RulesOverrideScope } from '@sortiva/rules'

/**
 * The real reader for `rules_overrides`, filling the socket the config layer has
 * always had — a threshold moved for one store, one language or one page type,
 * without a deploy.
 *
 * No cache. Every read is one indexed lookup against a table holding a handful
 * of rows, made once per scan of one store, next to dozens of far heavier
 * queries — so caching would buy nothing and would introduce the question of
 * how long an operator waits for a change to take. As it stands the answer is
 * "the store's next scan", with no window in which the product is running on
 * numbers the table no longer holds.
 */
export class TableRulesOverrideReader implements RulesOverrideReader {
  constructor(private readonly db: Db) {}

  async read(scope: RulesOverrideScope): Promise<RulesOverrideRow[]> {
    if (!scope.accountId) {
      throw new Error('rules_overrides are read for one store at a time; no account id was given')
    }
    const rows = await readRulesOverridesForAccount(this.db, accountScope(scope.accountId), {
      ...(scope.locale === undefined ? {} : { locale: scope.locale }),
      ...(scope.pageType === undefined ? {} : { pageType: scope.pageType }),
    })
    return rows.map((row) => ({
      scope: {
        ...(row.accountId === null ? {} : { accountId: row.accountId }),
        ...(row.locale === null ? {} : { locale: row.locale }),
        ...(row.pageType === null ? {} : { pageType: row.pageType }),
      },
      key: row.key,
      value: row.value,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    }))
  }
}
