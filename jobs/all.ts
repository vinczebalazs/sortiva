import { catalogChanges, catalogSync } from './catalog.ts'
import { dailyPick, findTopics } from './topics.ts'

export const ALL_JOBS = [catalogSync, catalogChanges, findTopics, dailyPick]
