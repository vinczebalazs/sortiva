import { readFileSync } from 'node:fs'
import { buildSchema, type GraphQLSchema } from 'graphql'
import { env } from '../../../config/env.ts'

export const PINNED_VERSION = env('SHOPIFY_API_VERSION')

let cached: GraphQLSchema | undefined

export function pinnedSchema(): GraphQLSchema {
  cached ??= buildSchema(readFileSync(new URL(`./${PINNED_VERSION}.graphql`, import.meta.url), 'utf8'))
  return cached
}
