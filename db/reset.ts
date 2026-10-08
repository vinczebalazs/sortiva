import pg from 'pg'
import { env } from '../config/env.ts'
import { applySchema } from './test-db.ts'

// Until launch the schema is one file and the database is rebuilt from it on change.
const url = new URL(env('DATABASE_URL'))
const database = url.pathname.slice(1)
const adminUrl = new URL(url)
adminUrl.pathname = '/postgres'
const client = new pg.Client({ connectionString: adminUrl.toString() })
await client.connect()
await client.query(`drop database if exists "${database}" with (force)`)
await client.query(`create database "${database}"`)
await client.end()
await applySchema(url.toString())
console.log(`Rebuilt ${database} from db/schema.sql`)
