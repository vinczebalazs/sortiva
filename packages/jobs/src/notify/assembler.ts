import {
  captureStubUsed,
  monthlySummaryContent,
  noticeContent,
  registerStub,
  unsubscribeUrl as buildUnsubscribeUrl,
  mintUnsubscribeToken,
  accountAttribution,
  type EmailAssembler,
  type EmailContent,
  type EmailSendRecord,
  type HeldBackTopic,
  type MonthlySummaryFacts,
  type NoticeFacts,
  type PosthogCapture,
  type EmailableType,
} from '@sortiva/core'
import {
  accountScope,
  findNotification,
  opportunityMonthFacts,
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

/**
 * Articles and quality-gate decisions live in tables schema wave 3 creates. Until
 * then a title cannot be looked up and a month cannot report what went live.
 *
 * Registered rather than silently returning nothing: a summary that reports an
 * empty month is indistinguishable from a store that had a quiet one, and the
 * difference matters enormously to whoever reads it.
 */
export const EMAIL_CONTENT_STUB = 'EmailFacts.articles'

registerStub({
  contract: EMAIL_CONTENT_STUB,
  filledBy: 'D — T4.0 (schema wave 3: articles, topics and gate decisions)',
  behaviour:
    'article titles fall back to the generic wording; the monthly summary reports no articles published and no topics held back',
  mustBeGoneBy: 'M4',
})

export interface AssemblerDeps {
  readonly getDb: () => Db
  /** Public origin, for the links in the email. */
  readonly appUrl?: string
  /** Signs the one-click unsubscribe links. */
  readonly unsubscribeSecret?: string
  readonly capture?: Pick<PosthogCapture, 'capture'>
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
        const title = await articleTitle(deps, record.accountId)
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

/** Undefined until schema wave 3 exists; the caller then uses the generic wording. */
async function articleTitle(deps: AssemblerDeps, accountId: string): Promise<string | undefined> {
  captureStubUsed(deps.capture, EMAIL_CONTENT_STUB, accountAttribution(accountId), {
    condition: 'article_title',
  })
  return undefined
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

const MONTH_LABEL = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export async function monthlySummaryFacts(
  deps: AssemblerDeps,
  accountId: string,
  period: string,
): Promise<MonthlySummaryFacts> {
  const db = deps.getDb()
  const scope = accountScope(accountId)
  const window = periodWindow(period)
  const opportunity = await opportunityMonthFacts(db, scope, window)

  // The published-and-held-back half of the month. Announced as a stub rather
  // than reported as a quiet month.
  captureStubUsed(deps.capture, EMAIL_CONTENT_STUB, accountAttribution(accountId), {
    condition: 'monthly_summary_content',
  })
  const articlesPublished = 0
  const heldBack: readonly HeldBackTopic[] = []

  return {
    period,
    periodLabel: MONTH_LABEL.format(window.from),
    articlesPublished,
    heldBack,
    optimizeRecommendationsGenerated: opportunity.optimizeRecommendationsGenerated,
    optimizeRecommendationsApplied: opportunity.optimizeRecommendationsApplied,
    repairsCompleted: 0,
    merchantTasksResolved: opportunity.merchantTasksResolved,
    nextOpportunities: opportunity.topOpportunities.map((row) => ({
      action: row.action as MonthlySummaryFacts['nextOpportunities'][number]['action'],
      subject: row.entityRef,
    })),
    openOpportunityCount: opportunity.openOpportunityCount,
  }
}
