import { defineConfig } from 'drizzle-kit'

/**
 * CLAUDE.md: migrations are forward-only, live in `packages/db/migrations`, and
 * are added **only by schema-wave cards**. drizzle-kit generates the SQL by
 * diffing the schema; the generated file is reviewed and committed as the
 * artefact — it is never regenerated in place once merged.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://sortiva:sortiva@localhost:54329/sortiva',
  },
  strict: true,
  verbose: true,
})
