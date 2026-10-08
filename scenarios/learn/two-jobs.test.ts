import { afterAll, beforeAll, expect, it } from 'vitest'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

it('two jobs for the same store never run at the same time', async () => {
  const store = await p.install('three-en')
  await p.settle()
  const spans: { start: number; end: number }[] = []
  let open = 0
  let overlapped = false
  p.hooks.jobStarted = async (storeId) => {
    if (storeId !== store.id) return
    open++
    if (open > 1) overlapped = true
    spans.push({ start: Date.now(), end: 0 })
    await new Promise((r) => setTimeout(r, 200))
  }
  p.hooks.jobFinished = (storeId) => {
    if (storeId === store.id) open--
  }
  await p.syncNow(store.id)
  await p.enqueueNightlySync(store.id)
  await p.settle()
  expect(spans.length).toBe(2)
  expect(overlapped).toBe(false)
})
