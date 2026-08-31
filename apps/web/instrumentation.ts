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

  // tech §4 — every secret-shaped environment variable is registered with the
  // log scrubber before anything can log, so a token that reaches an exception
  // message is redacted wherever it appears. Must run first.
  const { registerEnvSecrets } = await import('@sortiva/providers')
  registerEnvSecrets()

  const { bootstrapWorker } = await import('@sortiva/jobs')
  await bootstrapWorker()
}
