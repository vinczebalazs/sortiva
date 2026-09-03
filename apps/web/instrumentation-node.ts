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

export async function startServerRuntime() {

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

  // The automatic brakes: one sweep that reads our own counters and pauses
  // whatever crossed a ceiling — the day's vendor spending, the share of drafts
  // the quality judge is rejecting, the share of publish attempts failing, and
  // a store's daily allowance of a paid analysis it triggers by clicking.
  // Handed the database factory rather than a handle, so registering it here
  // opens no connection — the pool appears the first time the sweep runs.
  const { registerOpsTasks, installKillSwitchReader } = await import('@sortiva/jobs')
  const { db } = await import('@sortiva/db')
  // Registering a task is what puts it behind the kill switches; this is how
  // the wrapper that reads them reaches the database. The reader is consulted
  // when a job runs, not when it is registered, so this may sit anywhere above
  // the worker start — but the worker refuses to start if it was never called,
  // because a process whose jobs consult no switches looks exactly like a
  // healthy one.
  installKillSwitchReader(db)
  // The sweep is handed the analytics client so a trip is announced as well as
  // enforced. It is told, never asked: the switch is a database write and the
  // event that follows cannot prevent or undo it, so a trip still fires with
  // the vendor unreachable.
  registerOpsTasks(db, { analytics })

  // Onboarding. This is what makes a claimed domain actually start moving: the
  // claim writes the run and its steps and queues nothing, so until a handler
  // exists here the steps sit untouched. The dependencies are built by the
  // Shopify composition root rather than here, because deciding which Shopify —
  // the real one or the in-memory stand-in used without credentials — is its
  // job, not the entry point's.
  const { registerIngestionTasks } = await import('@sortiva/jobs/ingestion/dispatch')
  const { registerReminderTasks } = await import('@sortiva/jobs/ingestion/reminder')
  // Pricing a search term the merchant typed. Its own task rather than part of
  // onboarding, because it is queued from a form long after onboarding is over
  // and runs ahead of the sweeps so the chip on their screen fills in.
  const { registerKeywordEnrichTask } = await import('@sortiva/jobs/ingestion/enrich')
  const { adminClient, ingestionDeps, notificationEmitter, seoProvider } = await import(
    './app/api/shopify/_lib/config'
  )
  registerIngestionTasks(ingestionDeps)
  registerReminderTasks(db, notificationEmitter)
  registerKeywordEnrichTask(ingestionDeps)

  // Search Console: the nightly pull of each connected store's clicks,
  // impressions and positions, and the one-time import of its history. Handed
  // the factories rather than handles for the same reason as above, and handed
  // the one Google client and the one token cipher the process has — a second
  // cipher would be a second place a merchant's Google credentials are read.
  const { registerGscTasks } = await import('@sortiva/jobs')
  const { dbPool } = await import('@sortiva/db')
  const { GscOAuthProvider, TokenCipher } = await import('@sortiva/providers')
  const googleClient = new GscOAuthProvider()
  registerGscTasks({
    getDb: db,
    getPool: dbPool,
    provider: googleClient,
    codec: new TokenCipher(),
  })

  // The store's own pages — its collections, products, static pages and blog
  // posts — read into the inventory the Opportunity Engine consults before it
  // proposes writing anything. Without a handler here the walk can be asked for
  // and never happens.
  //
  // The connection store is rebuilt per call rather than once: building it needs
  // a live database handle, and registering a task must not open one. Nothing
  // schedules this yet — the nightly reconciliation sweep is the caller, and it
  // belongs to the catalog lane; `sweepInventory` is what it calls.
  const { registerInventoryTasks } = await import('@sortiva/jobs')
  const { makeConnectionStore } = await import('./app/api/shopify/_lib/bindings')
  const { tokenCipher } = await import('./app/api/shopify/_lib/config')
  const shopifyConnections = () => makeConnectionStore(db(), tokenCipher())
  registerInventoryTasks({
    getDb: db,
    getPool: dbPool,
    // The process's one Admin client, so the store's request budget is spent
    // once rather than once per caller.
    admin: adminClient(),
    connections: {
      read: (accountId) => shopifyConnections().read(accountId),
      readToken: (accountId) => shopifyConnections().readToken(accountId),
      markInvalid: (accountId, at) => shopifyConnections().markInvalid(accountId, at),
    },
  })

  // What a merchant changes in their store, and the nightly re-read that
  // catches what the change messages dropped. Without handlers here, Shopify's
  // messages pile up unprocessed and the two jobs the schedule already names —
  // the nightly reconciliation and the landing-page takings — answer to nobody.
  const { registerShopifyWebhookTasks, registerCatalogSweepTasks, sweepInventory } = await import(
    '@sortiva/jobs'
  )
  registerShopifyWebhookTasks({ ingestion: ingestionDeps, analytics })
  registerCatalogSweepTasks({
    ingestion: ingestionDeps,
    analytics,
    // The store's own pages, on the same clock and the same budget. Owned by the
    // inventory lane, called from here because one nightly pass over a store
    // belongs in one place.
    syncInventory: () =>
      sweepInventory({
        getDb: db,
        getPool: dbPool,
        admin: adminClient(),
        connections: {
          read: (accountId) => shopifyConnections().read(accountId),
          readToken: (accountId) => shopifyConnections().readToken(accountId),
          markInvalid: (accountId, at) => shopifyConnections().markInvalid(accountId, at),
        },
      }),
  })

  // The weekly refit of each store's own click curve — how often its listings
  // actually get clicked at each Google position, which is what "ranks well,
  // nobody clicks" is judged against. The crontab already named this job; until
  // now nothing answered to the name.
  //
  // Rebuilding the intents a store is searched for is deliberately not here: it
  // has to be current at the moment the weekly signal scan reads it, so the scan
  // calls `rebuildQueryClustersForAccount` rather than a schedule of its own.
  const { registerScanTasks, registerSignalScanTasks } = await import('@sortiva/jobs')
  registerScanTasks({ getDb: db, getPool: dbPool })

  // The Opportunity Engine's own three cadences (main §7.5): the onboarding
  // activation run, the weekly signal scan, and the crontab's own
  // per-account-local-clock sweeps for both — the same shared composition
  // root every other lane's tasks already come from here.
  registerSignalScanTasks({
    getDb: db,
    getPool: dbPool,
    seo: seoProvider(),
    notifications: notificationEmitter(),
    capture: analytics,
  })

  // Email: the minute-by-minute drain that turns each queued row into a job,
  // the job that sends one, and the two sweeps that schedule mail on a clock —
  // the monthly summary and the seven-day "where did you publish this" reminder.
  //
  // The renderer is built here and nowhere else. It is the one thing in the
  // process that pulls React and the string catalogue together, and keeping it
  // out of the jobs package is what stops a background worker importing a
  // component tree it has no other use for.
  const { registerEmailTasks, registerMonthlySummaryTask, registerExportUrlReminderTask } =
    await import('@sortiva/jobs')
  const { ReactEmailRenderer } = await import('@sortiva/providers/email/render')
  const { emailProvider } = await import('./app/api/webhooks/resend/_lib/config')
  registerEmailTasks({
    getDb: db,
    getPool: dbPool,
    provider: emailProvider(),
    renderer: new ReactEmailRenderer(),
  })
  registerMonthlySummaryTask({ getDb: db, notifications: notificationEmitter() })
  registerExportUrlReminderTask({ getDb: db, notifications: notificationEmitter() })

  // Ending accounts, honouring store redaction requests, and keeping the
  // database from growing forever. Two jobs, and they are the reason a deleted
  // account is actually deleted rather than merely marked:
  //
  //  - `account_close` tells Stripe, Shopify and Google that a merchant has
  //    gone. It is a job and not part of the delete request because a Stripe
  //    call may never sit in a request path, and because a queued step is
  //    retried and dead-letters where somebody is alerted.
  //  - the nightly retention sweep erases deleted accounts once their
  //    seven-day domain hold has passed, erases a store's data when its
  //    merchant asks Shopify to have it erased, and prunes each table by age.
  //    The crontab has named this job since M0; until now nothing answered to
  //    the name, which meant nothing was ever pruned.
  //
  // The token cipher is the process's one cipher, so a merchant's credentials
  // are decrypted in exactly one place on the way out to be handed back.
  const { registerAccountCloseTask, registerRetentionTask } = await import('@sortiva/jobs')
  const { makeAccountLifecycleStore } = await import('@sortiva/db')
  const { stripeProvider } = await import('./app/api/billing/_lib/config')
  const { shopifyOauthProvider } = await import('./app/api/shopify/_lib/config')
  const { decodeGscTokens } = await import('@sortiva/core')
  registerAccountCloseTask({
    getPool: dbPool,
    store: () =>
      makeAccountLifecycleStore({
        openShopifyToken: (cipher) => tokenCipher().decrypt(cipher),
        // Google's grant is stored as four fields in one blob. Revoking the
        // refresh token revokes the access token with it, so that is the one
        // worth handing back.
        openGoogleRefreshToken: (cipher) =>
          decodeGscTokens(tokenCipher(), cipher).refreshToken,
      }),
    billing: () => ({
      cancelNow: (subscriptionId) => stripeProvider().cancelSubscription(subscriptionId),
    }),
    revoker: () => ({
      revokeShopify: ({ shopHandle, accessToken }) =>
        shopifyOauthProvider().revokeAccess({ shop: shopHandle, accessToken }),
      revokeGoogle: (refreshToken) => googleClient.revoke(refreshToken),
    }),
  })
  registerRetentionTask({ getDb: db, getPool: dbPool })

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
