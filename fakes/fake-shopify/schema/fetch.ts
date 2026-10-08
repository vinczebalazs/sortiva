import { writeFileSync } from 'node:fs'
import { buildClientSchema, getIntrospectionQuery, printSchema, type IntrospectionQuery } from 'graphql'
import { env } from '../../../config/env.ts'

// Shopify publishes each Admin API version's schema at this address without a store token.
export const SCHEMA_ENDPOINT = (version: string) => `https://shopify.dev/admin-graphql-direct-proxy/${version}`

export async function fetchSchema(version: string): Promise<IntrospectionQuery> {
  const response = await fetch(SCHEMA_ENDPOINT(version), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true }) }),
  })
  if (!response.ok) throw new Error(`schema fetch for ${version} failed with HTTP ${response.status}`)
  const body = (await response.json()) as { data?: IntrospectionQuery; errors?: unknown }
  if (!body.data) throw new Error(`schema fetch for ${version} returned no data: ${JSON.stringify(body.errors)}`)
  return body.data
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = process.argv[2] ?? env('SHOPIFY_API_VERSION')
  const introspection = await fetchSchema(version)
  const dir = new URL('./', import.meta.url)
  writeFileSync(new URL(`${version}.graphql`, dir), printSchema(buildClientSchema(introspection)))
  console.log(`Wrote fakes/fake-shopify/schema/${version}.graphql`)
}
