/**
 * The job worker runs in-process with the web server in v1. Next calls
 * `register()` once per server process on the Node runtime, which is the only
 * startup hook the App Router offers.
 *
 * Safe because a killed worker is already a non-event: every step is resumable,
 * checkpointed and effectively-once, and the chaos test proves interrupted jobs
 * converge.
 *
 * This file is also the process's **composition root**: the one place that knows
 * which concrete adapters exist and builds them (see
 * `@sortiva/core/runtime/services`). Everything below it is handed a port. Later
 * cards add their shared services to the same bundle, here, rather than
 * constructing a second client of their own somewhere deeper.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Every secret-shaped environment variable is registered with the
  // log scrubber before anything can log, so a token that reaches an exception
  // message is redacted wherever it appears. Must run first.
  const { registerEnvSecrets, PosthogServerCapture } = await import('@sortiva/providers')
  registerEnvSecrets()

  // Everything observable is an analytics event captured server-side.
  // One client per process: it batches events, and a second client would mean a
  // second batch the shutdown drain below never flushes. `initAppServices` runs
  // the factory at most once, so that cannot happen even if this hook does.
  const { initAppServices } = await import('@sortiva/core/runtime/services')
  const { analytics } = initAppServices(() => ({ analytics: new PosthogServerCapture() }))

  // Both shutdown paths below depend on the process being started with
  // NEXT_MANUAL_SIG_HANDLE=1: without it Next installs its own SIGTERM handler
  // and exits before either the job drain or the analytics flush can finish
  // (measured; DECISIONS 2026-09-01 R5). `railway.toml` sets it on the start
  // command. The flip side is that Next no longer exits on the signal by itself,
  // so one of the two paths below must always register a handler that does.
  // The nightly subscription reconciliation is already in the worker's crontab;
  // this is where its handler joins the registry. Lanes
  // register their tasks here, before the worker reads the list.
  const { registerBillingTasks } = await import('./app/api/webhooks/stripe/_lib/tasks')
  registerBillingTasks()

  // The automatic brakes on money: a sweep that sums the day's vendor spending
  // out of our own ledger and pauses whatever crossed a ceiling. Handed the
  // database factory rather than a handle, so registering it here opens no
  // connection — the pool appears the first time the sweep actually runs.
  const { registerOpsTasks } = await import('@sortiva/jobs')
  const { db } = await import('@sortiva/db')
  registerOpsTasks(db)

  // Onboarding. This is what makes a claimed domain actually start moving: the
  // claim writes the run and its steps and queues nothing, so until a handler
  // exists here the steps sit untouched. The dependencies are built by the
  // Shopify composition root rather than here, because deciding which Shopify —
  // the real one or the in-memory stand-in used without credentials — is its
  // job, not the entry point's.
  const { registerIngestionTasks } = await import('@sortiva/jobs/ingestion/dispatch')
  const { registerReminderTasks } = await import('@sortiva/jobs/ingestion/reminder')
  const { ingestionDeps, notificationEmitter } = await import('./app/api/shopify/_lib/config')
  registerIngestionTasks(ingestionDeps)
  registerReminderTasks(db, notificationEmitter)

  // Search Console: the nightly pull of each connected store's clicks,
  // impressions and positions, and the one-time import of its history. Handed
  // the factories rather than handles for the same reason as above, and handed
  // the one Google client and the one token cipher the process has — a second
  // cipher would be a second place a merchant's Google credentials are read.
  const { registerGscTasks } = await import('@sortiva/jobs')
  const { dbPool } = await import('@sortiva/db')
  const { GscOAuthProvider, TokenCipher } = await import('@sortiva/providers')
  registerGscTasks({
    getDb: db,
    getPool: dbPool,
    provider: new GscOAuthProvider(),
    codec: new TokenCipher(),
  })

  const { bootstrapWorker, flushAnalytics } = await import('@sortiva/jobs')
  const worker = await bootstrapWorker({ analytics })

  if (!worker) {
    // With the worker running, its drain owns the shutdown flush — it fires
    // after in-flight jobs finish, so their events go too. With the worker off
    // (local UI work today; a web-only Railway service if the worker ever
    // splits) nothing else would empty the batch, and the last
    // events before every deploy would be lost — the failure this wiring exists
    // to prevent.
    const drain = () => {
      void flushAnalytics(analytics).then(() => process.exit(0))
    }
    process.once('SIGTERM', drain)
    process.once('SIGINT', drain)
  }
}
