import { afterAll, beforeAll, expect, it } from 'vitest'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

it('"Sync now" while a sync is running is refused, and accepted again once it finishes', async () => {
  const store = await p.install('blog-en')
  await p.settle()

  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let reached!: () => void
  const reachedPage = new Promise<void>((r) => { reached = r })
  p.hooks.checkpoint = async (name) => {
    if (name === 'catalog_page') {
      reached()
      await held
    }
  }
  expect(await p.syncNow(store.id)).toBe('started')
  await reachedPage
  expect(await p.syncNow(store.id)).toBe('already_running')
  const progress = await p.syncProgress(store.id)
  expect(progress).toMatchObject({ running: true, total: 6 })
  release()
  p.hooks.checkpoint = undefined
  await p.settle()
  expect(await p.syncNow(store.id)).toBe('started')
  await p.settle()
  expect((await p.syncProgress(store.id)).running).toBe(false)
})
