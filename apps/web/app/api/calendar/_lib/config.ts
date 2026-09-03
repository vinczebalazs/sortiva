import { db } from '@sortiva/db'
import type { CalendarDeps } from './handlers'

export function calendarDeps(): CalendarDeps {
  return { db: db() }
}
