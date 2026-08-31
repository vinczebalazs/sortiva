import { customType } from 'drizzle-orm/pg-core'

/**
 * tech §2.1 — "Postgres stays small": `raw_body_html` is compressed, and
 * "`store_pages.body_ref` is compressed like `raw_body_html`". tech §2.1 also
 * rules out any blob store ("Postgres is the cache"), so the compressed bytes
 * live in the column rather than behind a reference. drizzle-orm 0.38 has no
 * `bytea` column builder; this is the one place it is declared.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})
