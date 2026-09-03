import {
  familyGroupingSourceForScreen,
  countPopulatedFields,
  type ConfirmProfileStore,
  type FamilyGroupingSource,
  type ProfileEdits,
  type RichnessInput,
} from '@sortiva/core'
import { db, type Db } from '../client'
import { productFactsForAccount } from '../repositories/distill'
import { listFamilies, type FamilyRecord } from '../repositories/families'
import { findDomainForAccount, transitionDomainState } from '../repositories/domains'
import { listTopProducts, reorderTopProducts, type TopProductRow } from '../repositories/catalog'
import { confirmAllKeywords } from '../repositories/keywords'
import { confirmPersonaEdits, readPersona, type StoredPersona } from '../repositories/persona'
import { findGscConnForAccount } from '../repositories/search'
import { accountScope, type AccountScope } from '../scope'

/**
 * Everything the confirmation screen — and, after "Confirm profile", Settings
 * → Store profile — reads and writes in one place (main §6.8; ui §3.7, §9.2;
 * the profile response schema).
 *
 * Reading is five tables joined at the API layer rather than one query,
 * because they answer five different questions the screen asks in one glance:
 * who the store is, what it sells most of, what it is called for, who it
 * competes with, how it is filed, and how much it says about itself.
 */

/** A family's badge on the screen. `packages/core`'s mapping note lives beside `familyGroupingSourceForScreen`. */
export interface ProfileFamily {
  readonly id: string
  readonly name: string
  readonly memberCount: number
  readonly differentiationAxes: readonly string[]
  readonly groupingSource: 'taxonomy' | 'fact_clustering' | 'embedding'
  readonly lowConfidence: boolean
}

export interface ProfileSearchConsole {
  readonly connected: boolean
  readonly property: string | null
}

export interface ProfileStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
}

export interface ProfileStore extends ConfirmProfileStore {
  persona(scope: AccountScope): Promise<StoredPersona | undefined>
  topProducts(scope: AccountScope): Promise<TopProductRow[]>
  families(scope: AccountScope): Promise<ProfileFamily[]>
  /**
   * The raw material of the richness roll-up, one entry per fact sheet held.
   * `packages/rules` — where the substance floor `rollUpRichness` is judged
   * against lives — is not a dependency of this package, so the roll-up itself
   * runs one layer up, in `apps/web`, which already reaches for that config
   * (T2.6's keyword step made the same call for the same reason).
   */
  richnessInputs(scope: AccountScope): Promise<RichnessInput[]>
  searchConsole(scope: AccountScope): Promise<ProfileSearchConsole>
}

export function makeProfileStore(options: ProfileStoreOptions = {}): ProfileStore {
  const database = (): Db => options.database ?? db()

  return {
    persona: (scope) => readPersona(database(), scope),
    topProducts: (scope) => listTopProducts(database(), scope),

    async families(scope) {
      const rows = await listFamilies(database(), scope)
      return rows.map(toProfileFamily)
    },

    async richnessInputs(scope) {
      const sheets = await productFactsForAccount(database(), scope)
      return sheets.map((sheet) => ({
        populatedFields: countPopulatedFields(sheet.factSheet),
        factCount: sheet.factCount,
      }))
    },

    async searchConsole(scope) {
      const row = await findGscConnForAccount(database(), scope)
      const connected = row !== undefined && row.property !== '' && row.invalidatedAt === null
      return { connected, property: connected ? row.property : null }
    },

    async transition(accountId, from, to) {
      const row = await transitionDomainState(database(), accountScope(accountId), [...from], to)
      return row?.state
    },

    async domainState(accountId) {
      const row = await findDomainForAccount(database(), accountScope(accountId))
      return row?.state
    },

    async writeEdits(accountId, edits: ProfileEdits, now) {
      const scope = accountScope(accountId)
      // One transaction: a crash between these must not confirm a keyword list
      // the merchant never saw next to the description they actually
      // submitted, and must not leave the best-seller order half applied.
      await database().transaction(async (tx) => {
        await confirmPersonaEdits(tx, scope, edits, now)
        await reorderTopProducts(tx, scope, edits.topProductIds)
        await confirmAllKeywords(tx, scope)
      })
    },
  }
}

function toProfileFamily(row: FamilyRecord): ProfileFamily {
  return {
    id: row.id,
    name: row.name,
    memberCount: row.memberCount,
    differentiationAxes: row.differentiationAxes,
    groupingSource: familyGroupingSourceForScreen(row.groupingSource as FamilyGroupingSource),
    lowConfidence: row.confidence === 'low',
  }
}
