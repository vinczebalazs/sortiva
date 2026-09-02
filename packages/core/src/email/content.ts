import type { NotificationType } from '../contracts/opportunities'

/**
 * What an email says, as copy keys and the values that fill their gaps — never
 * as sentences.
 *
 * The same reason the bell stores references and renders at read time: the words
 * live in `packages/ui/strings`, so an email can be reworded or translated
 * without touching the code that decides what to say, and a snapshot test can
 * hold the canonical sentences character for character.
 *
 * The template turns this into HTML and into the plain-text alternative. It
 * chooses layout; it never chooses words.
 */

export interface EmailBlock {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface EmailSection {
  readonly heading: EmailBlock
  readonly lines: readonly EmailBlock[]
}

/**
 * Two templates, versioned in the repo and stamped on every `email_sends` row.
 * The monthly summary is its own shape — sections, a list of held-back topics —
 * and everything else is one notice: a heading, a few lines, one button.
 */
export type EmailTemplateId = 'monthly-summary' | 'notice'

export const TEMPLATE_VERSIONS: Readonly<Record<EmailTemplateId, string>> = {
  'monthly-summary': 'monthly-summary.v1',
  notice: 'notice.v1',
}

export interface EmailContent {
  readonly templateId: EmailTemplateId
  readonly subject: EmailBlock
  /** The line mail clients show beside the subject before the message is opened. */
  readonly preview: EmailBlock
  readonly heading: EmailBlock
  readonly blocks: readonly EmailBlock[]
  readonly sections?: readonly EmailSection[]
  readonly cta?: { readonly label: EmailBlock; readonly url: string }
  /** Present on the kinds a merchant is allowed to switch off, and absent on the rest. */
  readonly unsubscribeUrl?: string
}

export function templateVersion(content: EmailContent): string {
  return TEMPLATE_VERSIONS[content.templateId]
}

/**
 * Every copy key an email uses. The denominator rule is checked against the
 * copy these name, with their `{placeholders}` still in place — so it judges
 * what we wrote and never what a merchant called their article. A topic named
 * "A History of Wool" is not a denominator.
 */
export function copyKeysIn(content: EmailContent): string[] {
  const keys = [content.subject.key, content.preview.key, content.heading.key]
  for (const block of content.blocks) keys.push(block.key)
  for (const section of content.sections ?? []) {
    keys.push(section.heading.key)
    for (const line of section.lines) keys.push(line.key)
  }
  if (content.cta) keys.push(content.cta.label.key)
  return [...new Set(keys)]
}

/** The copy key prefix for one notification kind's notice email. */
export function noticeCopyKey(type: NotificationType, part: string): string {
  const camel = type.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  return `email.${camel}.${part}`
}
