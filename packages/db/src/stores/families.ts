import { db, type Db } from '../client'
import { findFamily, listFamilies, type FamilyRecord } from '../repositories/families'
import type { AccountScope } from '../scope'

/**
 * Reading a store's product families from outside this package.
 *
 * A route handler is called by its framework, so nothing of ours can hand it a
 * database. It could import the handle — and that is exactly how a query ends
 * up running without naming the account whose data it touches, which is why the
 * lint rule forbids it. So it takes this port instead: the handle stays inside
 * the package that owns it, every method still demands an `AccountScope`, and
 * a test hands in its own isolated database.
 */
export interface FamilyStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
}

export interface FamilyStore {
  /** One family, or nothing — including when it belongs to somebody else. */
  find(scope: AccountScope, familyId: string): Promise<FamilyRecord | undefined>
  list(scope: AccountScope): Promise<FamilyRecord[]>
}

export function makeFamilyStore(options: FamilyStoreOptions = {}): FamilyStore {
  const database = (): Db => options.database ?? db()

  return {
    find(scope, familyId) {
      return findFamily(database(), scope, familyId)
    },
    list(scope) {
      return listFamilies(database(), scope)
    },
  }
}
