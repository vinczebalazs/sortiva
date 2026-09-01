import { customType } from 'drizzle-orm/pg-core'

/**
 * Postgres has to stay small, so bulky page and product bodies are stored
 * compressed. There is no blob store, so the compressed bytes live in the
 * column rather than behind a reference. drizzle-orm 0.38 has no
 * `bytea` column builder; this is the one place it is declared.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})
