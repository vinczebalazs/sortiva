/**
 * tech §2.1 — the Graphile Worker runs in-process with the Next.js server in
 * v1. Next calls `register()` once per server process on the Node runtime,
 * which is the only startup hook the App Router offers.
 *
 * Safe because main §14.3 already made a killed worker a non-event: every step
 * is resumable, checkpointed and effectively-once, and the §14.3.9 chaos test
 * proves interrupted jobs converge.
 *
 * This file is also the process's **composition root**: the one place that knows
 * which concrete adapters exist and builds them (see
 * `@sortiva/core/runtime/services`). Everything below it is handed a port. Later
 * cards add their shared services to the same bundle, here, rather than
 * constructing a second client of their own somewhere deeper.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // tech §4 — every secret-shaped environment variable is registered with the
  // log scrubber before anything can log, so a token that reaches an exception
  // message is redacted wherever it appears. Must run first.
  const { registerEnvSecrets, PosthogServerCapture } = await import('@sortiva/providers')
  registerEnvSecrets()

  // main §14.7 — everything observable is a PostHog event captured server-side.
  // One client per process: it batches events, and a second client would mean a
  // second batch the shutdown drain below never flushes. `initAppServices` runs
  // the factory at most once, so that cannot happen even if this hook does.
  const { initAppServices } = await import('@sortiva/core/runtime/services')
  const { analytics } = initAppServices(() => ({ analytics: new PosthogServerCapture() }))

  // Both shutdown paths below depend on the process being started with
  // NEXT_MANUAL_SIG_HANDLE=1: without it Next installs its own SIGTERM handler
  // and exits before either the job drain or the analytics flush can finish
  // (measured; DECISIONS 2026-09-01 R5). The deploy config does not set it yet.
  // main §4.2, tech §3 — the nightly subscription reconciliation is already in
  // the worker's crontab; this is where its handler joins the registry. Lanes
  // register their tasks here, before the worker reads the list.
  const { registerBillingTasks } = await import('./app/api/webhooks/stripe/_lib/tasks')
  registerBillingTasks()

  const { bootstrapWorker, flushAnalytics } = await import('@sortiva/jobs')
  const worker = await bootstrapWorker({ analytics })

  if (!worker) {
    // With the worker running, its drain owns the shutdown flush — it fires
    // after in-flight jobs finish, so their events go too. With the worker off
    // (local UI work today; a web-only Railway service if the worker ever
    // splits, tech §2.1) nothing else would empty the batch, and the last
    // events before every deploy would be lost — the failure this wiring exists
    // to prevent.
    const drain = () => {
      void flushAnalytics(analytics).then(() => process.exit(0))
    }
    process.once('SIGTERM', drain)
    process.once('SIGINT', drain)
  }
}
