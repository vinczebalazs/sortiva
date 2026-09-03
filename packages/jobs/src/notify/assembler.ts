import {
  monthlySummaryContent,
  noticeContent,
  unsubscribeUrl as buildUnsubscribeUrl,
  mintUnsubscribeToken,
  type EmailAssembler,
  type EmailContent,
  type EmailSendRecord,
  type HeldBackTopic,
  type MonthlySummaryFacts,
  type NoticeFacts,
  type EmailableType,
} from '@sortiva/core'
import {
  accountScope,
  findArticleById,
  findNotification,
  heldBackTopicsInMonth,
  opportunityMonthFacts,
  publishedArticleCountInMonth,
  type Db,
} from '@sortiva/db'

/**
 * Turns a queued row into the words to send.
 *
 * Everything an email names — an article's title, how many opportunities were
 * found, what the month contained — is looked up **now**, at send time. Stored
 * rows hold identifiers only, so this is the only moment those identifiers turn
 * into sentences. It also means an article deleted between queueing and sending
 * produces the generic wording rather than a name that is no longer true.
 */

export interface AssemblerDeps {
  readonly getDb: () => Db
  /** Public origin, for the links in the email. */
  readonly appUrl?: string
  /** Signs the one-click unsubscribe links. */
  readonly unsubscribeSecret?: string
  readonly now?: () => Date
}

function appUrlOf(deps: AssemblerDeps): string {
  return (deps.appUrl ?? process.env.APP_URL ?? 'https://sortiva.app').replace(/\/+$/, '')
}

/** Where each kind of email points. One screen per kind; no deep links into things that may be gone. */
const LANDING: Record<EmailableType, string> = {
  oauth_reminder: '/onboarding',
  ingestion_review_ready: '/onboarding/review',
  opportunities_ready: '/opportunities',
  new_opportunities_found: '/opportunities',
  optimize_recommendation_ready: '/opportunities',
  merchant_task_created: '/products',
  article_published: '/content',
  draft_ready_for_review: '/content',
  topic_held_by_gate: '/content',
  repair_needed: '/content',
  connection_lost_shopify: '/settings',
  connection_lost_gsc: '/settings',
  payment_failed: '/settings',
  export_url_reminder: '/content',
  // No screen to land on — the account is gone and read access was revoked
  // the moment deletion was requested (DECISIONS 2026-09-02 T8.3). This type
  // has no `SPECS` entry in `email/notice.ts` and no caller assembles it
  // through this job; the entry exists only because `LANDING` is total over
  // `EmailableType`.
  account_deletion_confirmed: '/',
}

export function makeEmailAssembler(deps: AssemblerDeps): EmailAssembler {
  const now = deps.now ?? (() => new Date())

  return {
    async assemble(record: EmailSendRecord): Promise<EmailContent | undefined> {
      const db = deps.getDb()
      const scope = accountScope(record.accountId)
      const appUrl = appUrlOf(deps)
      const secret = deps.unsubscribeSecret ?? process.env.AUTH_SECRET ?? ''

      const link = (target: 'email_article_published' | 'email_digest_frequency') =>
        secret
          ? buildUnsubscribeUrl(
              appUrl,
              mintUnsubscribeToken({ accountId: record.accountId, target }, secret),
            )
          : undefined

      if (record.type === 'monthly_summary_ready') {
        const facts = await monthlySummaryFacts(deps, record.accountId, record.dedupeKey)
        const unsubscribe = link('email_digest_frequency')
        // Without a signing secret there is no lawful way to send bulk mail, so
        // the summary is held rather than sent without an unsubscribe.
        if (!unsubscribe) return undefined
        return monthlySummaryContent(facts, {
          dashboardUrl: `${appUrl}/dashboard`,
          unsubscribeUrl: unsubscribe,
        })
      }

      const type = record.type as EmailableType
      const notification = await findNotification(db, scope, record.type, record.dedupeKey)
      const refs = (notification?.payloadJson ?? {}) as Record<string, string>

      const facts: NoticeFacts = {}
      const mutable = facts as { title?: string; count?: number }
      if (refs.article_id) {
        const title = await articleTitle(deps, record.accountId, refs.article_id)
        if (title) mutable.title = title
      }
      if (type === 'opportunities_ready') {
        const month = await opportunityMonthFacts(db, scope, monthWindow(now()))
        if (month.openOpportunityCount > 0) mutable.count = month.openOpportunityCount
      }

      const unsubscribe = link('email_article_published')
      return noticeContent(type, facts, {
        actionUrl: `${appUrl}${LANDING[type]}`,
        ...(unsubscribe ? { unsubscribeUrl: unsubscribe } : {}),
      })
    },
  }
}

/**
 * A stored notification names an article by id and never by title, so this is
 * where the id becomes words. An article deleted between queueing and sending
 * simply has no title, and the caller falls back to the generic wording rather
 * than naming something that is no longer there.
 *
 * The id is checked before it reaches the query: payloads are references, but
 * not every reference is a `uuid`, and handing Postgres a `topic-week` string
 * would raise a type error rather than return nothing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function articleTitle(
  deps: AssemblerDeps,
  accountId: string,
  articleId: string,
): Promise<string | undefined> {
  if (!UUID.test(articleId)) return undefined
  const article = await findArticleById(deps.getDb(), accountScope(accountId), articleId)
  return article?.title
}

function monthWindow(now: Date): { from: Date; to: Date } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return { from, to }
}

/** `YYYY-MM` to the month it names, as a UTC half-open window. */
export function periodWindow(period: string): { from: Date; to: Date } {
  const [year, month] = period.split('-').map(Number) as [number, number]
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(year, month, 1)),
  }
}

/**
 * Which sentence a held-back topic gets, chosen by the gate that stopped it
 * rather than by the exact fault it was stopped for.
 *
 * The calendar's rejection card is where a merchant sees the specific reason,
 * and it has the interpolation values to render one. The summary does not: the
 * per-fault sentences take parameters (which criterion failed, which passage),
 * those parameters are stored differently by each gate, and one gate's reason
 * keys have no entry in the string catalogue at all — a summary that pasted a
 * stored key straight in would either print `{failed_criteria}` to a merchant or
 * fail to send. So the email states the stage honestly and the card carries the
 * detail. See DECISIONS 2026-09-03 R-ARTICLES.
 */
const HELD_REASON_KEY: Record<number | 'unknown', string> = {
  1: 'email.monthlySummary.heldReason.gate1',
  2: 'email.monthlySummary.heldReason.gate2',
  3: 'email.monthlySummary.heldReason.gate3',
  unknown: 'email.monthlySummary.heldReason.unknown',
}

const MONTH_LABEL = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export async function monthlySummaryFacts(
  deps: AssemblerDeps,
  accountId: string,
  period: string,
): Promise<MonthlySummaryFacts> {
  const db = deps.getDb()
  const scope = accountScope(accountId)
  const window = periodWindow(period)
  const [opportunity, articlesPublished, held] = await Promise.all([
    opportunityMonthFacts(db, scope, window),
    publishedArticleCountInMonth(db, scope, window),
    heldBackTopicsInMonth(db, scope, window),
  ])

  const heldBack: readonly HeldBackTopic[] = held.map((topic) => ({
    title: topic.title,
    reasonKey: HELD_REASON_KEY[topic.gate] ?? HELD_REASON_KEY.unknown,
  }))

  return {
    period,
    periodLabel: MONTH_LABEL.format(window.from),
    articlesPublished,
    heldBack,
    optimizeRecommendationsGenerated: opportunity.optimizeRecommendationsGenerated,
    optimizeRecommendationsApplied: opportunity.optimizeRecommendationsApplied,
    // Always zero, and knowingly so: there is no repairs table in the schema
    // and nothing records a repair, so a real count cannot be taken until
    // `T5.3` builds one. The summary omits the line entirely at zero rather
    // than claiming none happened.
    repairsCompleted: 0,
    merchantTasksResolved: opportunity.merchantTasksResolved,
    nextOpportunities: opportunity.topOpportunities.map((row) => ({
      action: row.action as MonthlySummaryFacts['nextOpportunities'][number]['action'],
      subject: row.entityRef,
    })),
    openOpportunityCount: opportunity.openOpportunityCount,
  }
}
