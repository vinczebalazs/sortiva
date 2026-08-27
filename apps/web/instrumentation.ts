/**
 * tech §2.1 — the Graphile Worker runs in-process with the Next.js server in
 * v1. Next calls `register()` once per server process on the Node runtime,
 * which is the only startup hook the App Router offers.
 *
 * Safe because main §14.3 already made a killed worker a non-event: every step
 * is resumable, checkpointed and effectively-once, and the §14.3.9 chaos test
 * proves interrupted jobs converge.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { bootstrapWorker } = await import('@sortiva/jobs')
  await bootstrapWorker()
}
