import pg from 'pg'
import { env } from '../config/env.ts'

// bigint ids and numeric costs come back as strings by default; ids fit in a JS number for the life of this product.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v))
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v)

export type Db = pg.Pool
export type DbClient = pg.PoolClient | pg.Pool

export function createPool(connectionString = env('DATABASE_URL'), max = 10): Db {
  return new pg.Pool({ connectionString, max })
}
