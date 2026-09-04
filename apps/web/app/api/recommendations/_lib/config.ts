import { db, dbPool, PostgresCostLedger, PostgresRequestCache } from '@sortiva/db'
import {
  LlmJudgeLite,
  OPTIMIZE_JUDGE_CRITERIA,
  type RecommendationLabels,
  type SeoDataProvider,
} from '@sortiva/core'
import {
  DataForSeoProvider,
  GuardedPageFetcher,
  MockSeoDataProvider,
  PosthogServerCapture,
} from '@sortiva/providers'
// Deep import to the file, not the `@sortiva/llm` barrel — the barrel's whole
// export surface is loaded by the server's start-up hook, and pulling it in
// here is how earlier cards broke the build (see DECISIONS 2026-09-01 T1.3).
import { loadPrompt } from '@sortiva/llm/prompts'
// Deep imports to the files, not the `@sortiva/jobs` barrel, for the reason
// `./handlers.ts` records: the barrel drags the worker runtime and the
// threshold config's file loader into a route bundle that has no filesystem.
import { DbNotificationEmitter } from '@sortiva/jobs/notify/emitter'
import type { IntentGapTaskDeps } from '@sortiva/jobs/optimize/intent-gap-tasks'
import type { OptimizeTaskDeps } from '@sortiva/jobs/optimize/tasks'
import { rules } from '@sortiva/rules'
// The string catalogue, not the component barrel: `@sortiva/ui`'s index pulls
// React components into a route bundle that renders none of them.
import { t } from '@sortiva/ui/strings/index'
// The process's one instrumented model client, exported by the generation
// lane's own composition root. A second client here would be a second place a
// merchant's model spend is recorded and a second set of cached answers.
import { processLlm } from '../../articles/_lib/config'
import type { RecommendationsDeps } from './handlers'

/**
 * Every word in the downloaded document, read from the one catalogue all
 * user-facing copy lives in. The renderer in `packages/core` takes them as an
 * argument precisely so that it holds no copy of its own.
 */
function downloadLabels(): RecommendationLabels {
  return {
    documentTitle: t('optimize.download.title'),
    page: t('optimize.download.page'),
    search: t('optimize.download.search'),
    intentNote: t('optimize.download.intentNote'),
    titleTag: t('optimize.download.titleTag'),
    metaDescription: t('optimize.download.metaDescription'),
    headings: t('optimize.download.headings'),
    sections: t('optimize.download.sections'),
    faq: t('optimize.download.faq'),
    internalLinks: t('optimize.download.internalLinks'),
    linksFrom: t('optimize.download.linksFrom'),
    linksTo: t('optimize.download.linksTo'),
    current: t('optimize.download.current'),
    suggested: t('optimize.download.suggested'),
    basedOn: t('optimize.download.basedOn'),
    notSet: t('optimize.download.notSet'),
    headingAdd: t('optimize.download.headingAdd'),
    headingRewrite: t('optimize.download.headingRewrite'),
    trustLine: t('optimize.download.trustLine'),
  }
}

export function recommendationsDeps(): RecommendationsDeps {
  return { db: db(), labels: downloadLabels() }
}

/**
 * Everything the two background jobs behind this API are built from.
 *
 * Both are *asked for* rather than scheduled: the improve-this-page button
 * queues one, and the weekly page comparison queues the other. Neither has a
 * caller of ours to be handed its infrastructure by — a queue task is called by
 * the worker — so naming the concrete database, model client, search vendor and
 * page fetcher happens here.
 *
 * **Nothing below opens a database connection.** The pool is created lazily by
 * `db()` and connects on its first query, and every one of those queries
 * happens inside a running job. Registering a task at server start must not
 * talk to Postgres: the web server would then be unable to serve a page because
 * a background job's database was briefly unreachable.
 */

let capture: PosthogServerCapture | undefined
let seo: SeoDataProvider | undefined

function optimizeCapture(): PosthogServerCapture {
  capture ??= new PosthogServerCapture()
  return capture
}

/**
 * The search vendor, chosen by `SEO_PROVIDER_MODE` and by nothing else — the
 * same small selection `apps/web/app/api/shopify/_lib/config.ts` and
 * `apps/web/app/api/calendar/topics/_lib/config.ts` each make for themselves,
 * duplicated here rather than imported across another lane's directory.
 *
 * Unlike the model client above it, a second instance of this costs nothing:
 * what stops a repeated search being paid for twice is the request cache, and
 * what the daily ceiling is computed from is the spend ledger, and both of
 * those are tables rather than anything held inside the object.
 */
function optimizeSeoProvider(): SeoDataProvider {
  if (seo) return seo
  seo =
    process.env.SEO_PROVIDER_MODE === 'mock'
      ? new MockSeoDataProvider({}, optimizeCapture())
      : new DataForSeoProvider({
          cache: new PostgresRequestCache(db()),
          capture: optimizeCapture(),
          ledger: new PostgresCostLedger(db()),
        })
  return seo
}

/**
 * What one press of "Generate recommendations" is carried out with.
 *
 * The grader is a factory taking the account whose work is being graded,
 * because attribution needs one and the job knows it only when it starts. It is
 * given the recommendation criteria and its own prompt rather than the article
 * judge's: a page recommendation is a short structured artefact, and asking
 * whether it says something new to the world is the wrong question of a page
 * that already ranks.
 */
export function optimizeTaskDeps(): OptimizeTaskDeps {
  return {
    // The advisory lock needs a raw connection it can hold for the length of a
    // generation, so the pool rather than the query builder — as a factory, so
    // registering the task creates nothing.
    getPool: dbPool,
    deps: {
      db: db(),
      seo: optimizeSeoProvider(),
      // The one guarded fetcher: every outbound page read in the product goes
      // through it, so the SSRF protections are not something a caller can
      // forget.
      pageFetcher: new GuardedPageFetcher(),
      llm: processLlm(),
      coveragePrompt: loadPrompt('intent-gap', 1),
      recommendationPrompt: loadPrompt('optimize-reco', 1),
      judge: (accountId: string) =>
        new LlmJudgeLite({
          llm: processLlm(),
          prompt: loadPrompt('optimize-judge', 1),
          criteria: OPTIMIZE_JUDGE_CRITERIA,
          config: rules().defaults.gates.draft_grading,
          accountId,
        }),
      // The bell, for the one thing a finished generation has to tell a
      // merchant. Given the factory rather than a handle, for the same reason
      // `getPool` is.
      notifications: new DbNotificationEmitter(db),
    },
  }
}

/**
 * What the weekly page comparison is carried out with — the paid pass that
 * reads what ranks above a store's page and records what those pages settle
 * that the store's does not.
 *
 * The same model client and the same search vendor as the button's generation,
 * deliberately: the two buy the same kind of thing for the same store, and one
 * cache and one spend record across both is what stops the second of them
 * paying again for an answer the first already has.
 */
export function intentGapTaskDeps(): IntentGapTaskDeps {
  return {
    getDb: db,
    getPool: dbPool,
    seo: optimizeSeoProvider(),
    pageFetcher: new GuardedPageFetcher(),
    llm: processLlm(),
    prompt: loadPrompt('intent-gap', 1),
  }
}
