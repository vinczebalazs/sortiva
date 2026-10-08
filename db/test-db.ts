import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { Logger, runMigrations } from 'graphile-worker'
import { env } from '../config/env.ts'
import { createPool, type Db } from './pool.ts'

const schemaFile = new URL('./schema.sql', import.meta.url)
const quietLogger = new Logger(() => () => {})

function adminUrl(): string {
  const url = new URL(env('DATABASE_URL'))
  url.pathname = '/postgres'
  return url.toString()
}

function urlFor(database: string): string {
  const url = new URL(env('DATABASE_URL'))
  url.pathname = `/${database}`
  return url.toString()
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

// A schema edit or a Graphile Worker upgrade changes the name, so a stale template is never reused.
function templateName(): string {
  const workerPackage = new URL('../node_modules/graphile-worker/package.json', import.meta.url)
  const workerVersion = JSON.parse(readFileSync(workerPackage, 'utf8')).version as string
  const hash = createHash('sha256').update(readFileSync(schemaFile)).update(workerVersion).digest('hex').slice(0, 12)
  return `sortiva_tpl_${hash}`
}

export async function applySchema(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    await client.query(readFileSync(schemaFile, 'utf8'))
  } finally {
    await client.end()
  }
  await runMigrations({ connectionString, logger: quietLogger })
}

export async function ensureTemplate(): Promise<string> {
  const name = templateName()
  await admin(async (client) => {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name])
    if (rowCount) return
    const building = `${name}_building_${process.pid}`
    await client.query(`drop database if exists "${building}" with (force)`)
    await client.query(`create database "${building}"`)
    try {
      await applySchema(urlFor(building))
      await client.query(`alter database "${building}" rename to "${name}"`)
    } catch (error) {
      await client.query(`drop database if exists "${building}" with (force)`).catch(() => {})
      throw error
    }
  })
  return name
}

export type TestDb = { pool: Db; url: string; name: string; drop: () => Promise<void> }

export async function createTestDb(): Promise<TestDb> {
  const template = await ensureTemplate()
  const name = `sortiva_test_${randomBytes(6).toString('hex')}`
  await admin((client) => client.query(`create database "${name}" template "${template}"`))
  const url = urlFor(name)
  const pool = createPool(url, 20)
  return {
    pool,
    url,
    name,
    drop: async () => {
      await pool.end()
      await admin((client) => client.query(`drop database if exists "${name}" with (force)`))
    },
  }
}
