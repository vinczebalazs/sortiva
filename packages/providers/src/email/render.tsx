import * as React from 'react'
import { render, toPlainText } from '@react-email/render'
import type { EmailBlock, EmailContent, EmailRenderer } from '@sortiva/core'
import { createTranslate, type Translate } from '@sortiva/ui/strings/translate'
import type { StringKey, UiLanguage } from '@sortiva/ui/strings/catalog'
import { MonthlySummaryEmail } from './templates/monthly-summary'
import { NoticeEmail } from './templates/notice'

/**
 * Copy keys in, an email out.
 *
 * Two things are worth knowing. The plain-text alternative is derived from the
 * same rendered markup rather than written twice, so it cannot drift from the
 * HTML — a mail client that shows text sees the same words in the same order.
 * And every sentence is looked up in the string catalogue here, at send time, so
 * a copy fix reaches mail queued before it was made.
 */

export interface ReactEmailRendererOptions {
  /** V1 ships English only; the seam is here so a second language is a catalogue, not a refactor. */
  readonly language?: UiLanguage
}

export class ReactEmailRenderer implements EmailRenderer {
  private readonly t: Translate

  constructor(options: ReactEmailRendererOptions = {}) {
    this.t = createTranslate(options.language)
  }

  /** Resolves one block. Exposed so the denominator check can read the same copy. */
  say(block: EmailBlock): string {
    return this.t(block.key as StringKey, block.params)
  }

  async render(content: EmailContent) {
    const subject = this.say(content.subject)
    const paragraphs = content.blocks.map((block) => this.say(block))
    const footerReason = this.t('email.layout.footerReason')
    const unsubscribe = content.unsubscribeUrl
      ? {
          label: this.t(
            content.templateId === 'monthly-summary'
              ? 'email.layout.summaryUnsubscribe'
              : 'email.layout.unsubscribe',
          ),
          url: content.unsubscribeUrl,
        }
      : undefined
    const cta = content.cta
      ? { label: this.say(content.cta.label), url: content.cta.url }
      : undefined

    const element =
      content.templateId === 'monthly-summary' ? (
        <MonthlySummaryEmail
          previewText={this.say(content.preview)}
          heading={this.say(content.heading)}
          paragraphs={paragraphs}
          sections={(content.sections ?? []).map((section) => ({
            heading: this.say(section.heading),
            lines: section.lines.map((line) => this.say(line)),
          }))}
          footerReason={footerReason}
          {...(cta ? { cta } : {})}
          {...(unsubscribe ? { unsubscribe } : {})}
        />
      ) : (
        <NoticeEmail
          previewText={this.say(content.preview)}
          heading={this.say(content.heading)}
          paragraphs={paragraphs}
          footerReason={footerReason}
          {...(cta ? { cta } : {})}
          {...(unsubscribe ? { unsubscribe } : {})}
        />
      )

    const html = await render(element)
    return { subject, html, text: toPlainText(html) }
  }
}

/** The catalogue lookup on its own, for the copy checks that must not render anything. */
export function copyLookup(language?: UiLanguage): (key: string) => string {
  const t = createTranslate(language)
  return (key) => t(key as StringKey)
}
