import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('no table has a column for customer or order data, so the GDPR answer "we hold none" stays true', () => {
  const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')
  const columns = [...schema.matchAll(/^\s+([a-z_]+)\s+(?:bigint|text|integer|boolean|jsonb|numeric|timestamptz|date|smallint|double)/gm)].map((m) => m[1]!)
  expect(columns.length).toBeGreaterThan(50)
  const forbidden = columns.filter((c) => /customer|order|email|phone|address|first_name|last_name/.test(c))
  expect(forbidden).toEqual([])
})
