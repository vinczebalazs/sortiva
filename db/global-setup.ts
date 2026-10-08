import { ensureTemplate } from './test-db.ts'

export default async function setup(): Promise<void> {
  await ensureTemplate()
}
