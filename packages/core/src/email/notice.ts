import type { NotificationType } from '../contracts/opportunities'
import { needsUnsubscribe } from './policy'
import type { EmailBlock, EmailContent } from './content'

/**
 * Every email that is not the monthly summary: a heading, one or two lines, and
 * one thing to do. They differ in words, not in shape, which is why they share
 * one template and one version.
 *
 * Values that name something — an article, a store, how many opportunities —
 * are looked up when the email is assembled and passed in here. Nothing is read
 * out of the stored notification row, which holds identifiers only.
 */

/** What the assembling job managed to look up. Every field may be missing. */
export interface NoticeFacts {
  readonly title?: string
  readonly domain?: string
  readonly count?: number
  readonly page?: string
}

export interface NoticeLinks {
  readonly actionUrl: string
  readonly unsubscribeUrl?: string
}

interface NoticeSpec {
  /** Filled from `NoticeFacts`; when a required value is missing the generic wording is used. */
  readonly requires?: keyof NoticeFacts
  /** Canonical sentences (main spec Appendix A) this email must restate verbatim. */
  readonly canonical?: readonly string[]
}

const SPECS: Record<Exclude<NotificationType, 'monthly_summary_ready'>, NoticeSpec> = {
  oauth_reminder: {
    // tech §1.4 requires this email to restate the read-only promise: it is the
    // single biggest reason a merchant abandons the Shopify connect screen, and
    // the reminder is the one message that reaches someone who left.
    canonical: ['appendixA.shopifyReadOnlyTrust'],
  },
  ingestion_review_ready: {},
  opportunities_ready: {
    requires: 'count',
    canonical: ['appendixA.opportunityHeadline'],
  },
  new_opportunities_found: {},
  optimize_recommendation_ready: {},
  merchant_task_created: {},
  article_published: { requires: 'title' },
  draft_ready_for_review: { requires: 'title' },
  topic_held_by_gate: { requires: 'title' },
  repair_needed: { requires: 'title' },
  connection_lost_shopify: {},
  connection_lost_gsc: {},
  payment_failed: {},
  export_url_reminder: { requires: 'title' },
}

function camel(type: NotificationType): string {
  return type.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * The generic wording, used when the thing the email is about has since been
 * deleted. Same posture as the bell: keep the verb, lose the name — "an article
 * is ready for your review" rather than the title of an article that is gone.
 */
function line(type: NotificationType, part: string, facts: NoticeFacts, spec: NoticeSpec): EmailBlock {
  const base = `email.${camel(type)}.${part}`
  const required = spec.requires
  if (!required) return { key: base }
  const value = facts[required]
  if (value === undefined || value === '') return { key: `${base}.generic` }
  return { key: base, params: { [required]: value } }
}

export function noticeContent(
  type: Exclude<NotificationType, 'monthly_summary_ready'>,
  facts: NoticeFacts,
  links: NoticeLinks,
): EmailContent {
  const spec = SPECS[type]
  const blocks: EmailBlock[] = [line(type, 'body', facts, spec)]
  for (const key of spec.canonical ?? []) blocks.push({ key })

  return {
    templateId: 'notice',
    subject: line(type, 'subject', facts, spec),
    preview: line(type, 'preview', facts, spec),
    heading: line(type, 'heading', facts, spec),
    blocks,
    cta: { label: { key: `email.${camel(type)}.cta` }, url: links.actionUrl },
    ...(needsUnsubscribe(type) && links.unsubscribeUrl
      ? { unsubscribeUrl: links.unsubscribeUrl }
      : {}),
  }
}

/** The canonical Appendix A keys each notice must reproduce, for the snapshot tests to hold. */
export function canonicalKeysFor(type: NotificationType): readonly string[] {
  if (type === 'monthly_summary_ready') return []
  return SPECS[type].canonical ?? []
}
