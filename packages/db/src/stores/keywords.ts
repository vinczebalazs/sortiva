import { db, type Db } from '../client'
import { findDomainForAccount } from '../repositories/domains'
import {
  addCompetitor,
  addManualKeyword,
  confirmedKeywords,
  listCompetitors,
  removeCompetitor,
  removeKeyword,
  type CompetitorRow,
  type KeywordRow,
} from '../repositories/keywords'
import { readPersona, type StoredPersona } from '../repositories/persona'
import { rankedDomainsForQueries, type RankedDomainRow } from '../repositories/serp'
import { systemScope, type AccountScope } from '../scope'

/**
 * Editing a store's search terms and competitors from outside this package.
 *
 * A route handler is called by its framework, so nothing of ours can hand it a
 * database — and importing the handle is exactly how a query ends up running
 * without naming the account whose data it touches. So the handlers take this
 * port: the handle stays inside the package that owns it, every method still
 * demands an `AccountScope`, and an integration test hands in its own isolated
 * database.
 *
 * `rankedDomains` is the one method with no account, and it is worth saying why
 * it is safe. Stored results pages are shared — two stores in the same market
 * asking about the same search share one purchase — so they carry no account
 * and are reached under a system scope with a written reason. What comes back
 * is flat rows with no identity: a caller can count them, and there is no path
 * from here into anybody's competitor list except through `addCompetitor`,
 * which is a merchant's click.
 */

export interface KeywordStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
}

export interface KeywordStore {
  persona(scope: AccountScope): Promise<StoredPersona | undefined>
  /** The store's own claimed domain, normalised — what a typed competitor is checked against. */
  ownDomain(scope: AccountScope): Promise<string | undefined>
  addKeyword(
    scope: AccountScope,
    input: { term: string; language: string; country: string },
  ): Promise<KeywordRow>
  removeKeyword(scope: AccountScope, keywordId: string): Promise<boolean>
  confirmedKeywords(scope: AccountScope): Promise<KeywordRow[]>
  listCompetitors(scope: AccountScope): Promise<CompetitorRow[]>
  addCompetitor(
    scope: AccountScope,
    input: { domainNormalized: string; source: 'auto' | 'manual' },
  ): Promise<CompetitorRow>
  removeCompetitor(scope: AccountScope, competitorId: string): Promise<boolean>
  rankedDomains(input: { cacheKeys: readonly string[]; now: Date }): Promise<RankedDomainRow[]>
  /** The handle the queue call needs. Queuing a job is a write to the same database, not a query of a table. */
  database(): Db
}

const SNAPSHOT_SCOPE_REASON = 'a results page is keyed by the search, not by the store that asked'

export function makeKeywordStore(options: KeywordStoreOptions = {}): KeywordStore {
  const database = (): Db => options.database ?? db()

  return {
    persona: (scope) => readPersona(database(), scope),
    async ownDomain(scope) {
      return (await findDomainForAccount(database(), scope))?.domainNormalized
    },
    addKeyword: (scope, input) => addManualKeyword(database(), scope, input),
    removeKeyword: (scope, keywordId) => removeKeyword(database(), scope, keywordId),
    confirmedKeywords: (scope) => confirmedKeywords(database(), scope),
    listCompetitors: (scope) => listCompetitors(database(), scope),
    addCompetitor: (scope, input) => addCompetitor(database(), scope, input),
    removeCompetitor: (scope, competitorId) =>
      removeCompetitor(database(), scope, competitorId),
    rankedDomains: (input) =>
      rankedDomainsForQueries(database(), systemScope(SNAPSHOT_SCOPE_REASON), input),
    database,
  }
}
