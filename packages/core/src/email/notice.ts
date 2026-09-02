import type { NotificationType } from '../contracts/opportunities'
import { notificationChannels } from '../notifications/matrix'
import { needsUnsubscribe } from './policy'
import type { EmailBlock, EmailContent } from './content'

/**
 * Every email that is not the monthly summary: a heading, a line or two, and one
 * thing to do. They differ in words, not in shape, which is why they share one
 * template and one version.
 *
 * Values that name something — an article, how many opportunities — are looked
 * up when the email is assembled and passed in here. Nothing is read out of the
 * stored notification row, which holds identifiers only.
 */

/** The kinds that get an email of their own, read from the matrix rather than listed twice. */
export type EmailableType = Exclude<NotificationType, 'monthly_summary_ready'>

/** What the assembling job managed to look up. Every field may be missing. */
export interface NoticeFacts {
  readonly title?: string
  readonly count?: number
}

export interface NoticeLinks {
  readonly actionUrl: string
  readonly unsubscribeUrl?: string
}

interface NoticeSpec {
  /** Filled from `NoticeFacts`; when the value is missing the generic wording is used. */
  readonly requires?: keyof NoticeFacts
  /** Which parts carry the value. The rest read the same however much we looked up. */
  readonly parameterised?: readonly ('subject' | 'body')[]
  /** Canonical sentences (main spec Appendix A) this email must restate verbatim. */
  readonly canonical?: readonly string[]
  /** Whether the canonical sentence opens the email or closes it. */
  readonly canonicalPosition?: 'lead' | 'trail'
}

const SPECS: Partial<Record<EmailableType, NoticeSpec>> = {
  oauth_reminder: {
    // tech §1.4 requires this email to restate the read-only promise: it is the
    // single biggest reason a merchant abandons the Shopify connect screen, and
    // this is the one message that reaches someone who has left.
    canonical: ['appendixA.shopifyReadOnlyTrust'],
  },
  ingestion_review_ready: {},
  opportunities_ready: {
    requires: 'count',
    // The canonical headline carries the number; the subject and the body read
    // the same whether or not we managed to count.
    parameterised: [],
    canonical: ['appendixA.opportunityHeadline'],
    canonicalPosition: 'lead',
  },
  article_published: { requires: 'title' },
  draft_ready_for_review: { requires: 'title' },
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
 * deleted. Same posture as the bell: keep the verb, lose the name — "a draft is
 * ready for your review" rather than the title of an article that is gone.
 */
function line(
  type: EmailableType,
  part: 'subject' | 'body',
  facts: NoticeFacts,
  spec: NoticeSpec,
): EmailBlock {
  const base = `email.${camel(type)}.${part}`
  const required = spec.requires
  const parts = spec.parameterised ?? ['subject', 'body']
  if (!required || !parts.includes(part)) return { key: base }
  const value = facts[required]
  if (value === undefined || value === '') return { key: `${base}.generic` }
  return { key: base, params: { [required]: value } }
}

export function noticeContent(
  type: EmailableType,
  facts: NoticeFacts,
  links: NoticeLinks,
): EmailContent {
  const spec = SPECS[type]
  if (!spec) {
    // The matrix says this kind never gets an email of its own — it is carried
    // by the monthly summary, or the merchant is already looking at the screen.
    throw new Error(
      `"${type}" has no email of its own (${notificationChannels(type).email}); nothing should be assembling one.`,
    )
  }

  const subject = line(type, 'subject', facts, spec)
  const blocks: EmailBlock[] = [line(type, 'body', facts, spec)]

  // A canonical sentence is dropped rather than rendered with a gap in it: an
  // email reading "We found {N} ways" is worse than one that never says it.
  const canFill = !spec.requires || facts[spec.requires] !== undefined
  if (canFill) {
    const canonical: EmailBlock[] = (spec.canonical ?? []).map((key) => ({
      key,
      // The catalogue names this gap `{count}`; the spec's canonical table
      // writes it `{N}`. Both are filled so the sentence renders whole
      // whichever spelling the copy uses.
      ...(facts.count !== undefined ? { params: { N: facts.count, count: facts.count } } : {}),
    }))
    if (spec.canonicalPosition === 'lead') blocks.unshift(...canonical)
    else blocks.push(...canonical)
  }

  return {
    templateId: 'notice',
    subject,
    // The line a mail client shows beside the subject. Never parameterised: it
    // is read in a list, before the message is opened.
    preview: { key: `email.${camel(type)}.preview` },
    heading: subject,
    blocks,
    cta: { label: { key: `email.${camel(type)}.cta` }, url: links.actionUrl },
    ...(needsUnsubscribe(type) && links.unsubscribeUrl
      ? { unsubscribeUrl: links.unsubscribeUrl }
      : {}),
  }
}

/** Which kinds have a notice email at all, for the tests and for the assembler. */
export const NOTICE_TYPES: readonly EmailableType[] = Object.keys(SPECS) as EmailableType[]

/** The canonical Appendix A keys each notice must reproduce, for the snapshot tests to hold. */
export function canonicalKeysFor(type: NotificationType): readonly string[] {
  const spec = SPECS[type as EmailableType]
  return spec?.canonical ?? []
}
