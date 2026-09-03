import { db } from '@sortiva/db'
import type { OpportunitiesDeps } from './handlers'

export function opportunitiesDeps(): OpportunitiesDeps {
  return { db: db() }
}
