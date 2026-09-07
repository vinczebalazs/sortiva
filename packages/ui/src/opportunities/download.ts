import { t as defaultTranslate, type Translate } from '../strings'
import { recommendationFieldLabel } from './list'
import type { OpportunityDetail, Recommendation } from './types'

/**
 * The page recommendation as a file the merchant can take away.
 *
 * The recommendation is the deliverable — nothing is written to the store, so
 * what leaves this screen in the merchant's hands is the whole product of an
 * OPTIMIZE. It has to survive being pasted into a document, mailed to whoever
 * actually edits the shop, and read a week later, which is why both a plain
 * Markdown form and a self-contained HTML one are produced rather than a link
 * back to a drawer that will have moved on.
 *
 * Both are built here as strings, with no browser anywhere near them, so what
 * the merchant downloads is exactly what a test reads.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export interface DownloadFile {
  readonly filename: string
  readonly mimeType: string
  readonly content: string
}

/** A filename from the entity, safe on every operating system we can be opened on. */
export function recommendationFilename(label: string, extension: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'recommendation'
  return `sortiva-${slug}.${extension}`
}

export function recommendationMarkdown(
  detail: OpportunityDetail,
  t: Translate = defaultTranslate,
): string {
  const recommendation = detail.recommendation
  const lines: string[] = [`# ${detail.opportunity.entityRef.label}`, '']

  if (recommendation?.intentNote) {
    lines.push(`## ${t('opportunities.rec.intentNote')}`, '', recommendation.intentNote, '')
  }

  for (const field of recommendation?.fields ?? []) {
    lines.push(`## ${recommendationFieldLabel(field.field, t)}`, '')
    lines.push(`**${t('opportunities.rec.current')}**`, '')
    lines.push(field.current ?? t('opportunities.rec.currentEmpty'), '')
    lines.push(`**${t('opportunities.rec.suggested')}**`, '')
    lines.push(field.suggested, '')
    // The file outlives the screen, so the one line a model wrote itself
    // carries its label with it rather than reading as ours.
    if (field.evidence) {
      lines.push(`> ${t('opportunities.rec.modelWritten')} ${field.evidence}`, '')
    }
  }

  const linksIn = recommendation?.internalLinksIn ?? []
  const linksOut = recommendation?.internalLinksOut ?? []
  if (linksIn.length > 0) {
    lines.push(`## ${t('opportunities.rec.linksIn')}`, '')
    for (const link of linksIn) lines.push(`- ${link.fromUrl} — ${link.anchor}`)
    lines.push('')
  }
  if (linksOut.length > 0) {
    lines.push(`## ${t('opportunities.rec.linksOut')}`, '')
    for (const link of linksOut) lines.push(`- ${link.toUrl} — ${link.anchor}`)
    lines.push('')
  }

  // The file leaves our hands, so it carries the same warning the screen does:
  // nobody applied any of this to the store.
  lines.push(`_${t('opportunities.rec.neverApplies')}_`, '')

  return lines.join('\n')
}

export function recommendationHtml(
  detail: OpportunityDetail,
  t: Translate = defaultTranslate,
): string {
  const recommendation = detail.recommendation
  const title = escapeHtml(detail.opportunity.entityRef.label)
  const parts: string[] = [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8">',
    `<title>${title}</title>`,
    '</head>',
    '<body>',
    `<h1>${title}</h1>`,
  ]

  if (recommendation?.intentNote) {
    parts.push(`<h2>${escapeHtml(t('opportunities.rec.intentNote'))}</h2>`)
    parts.push(`<p>${escapeHtml(recommendation.intentNote)}</p>`)
  }

  for (const field of recommendation?.fields ?? []) {
    parts.push(`<section><h2>${escapeHtml(recommendationFieldLabel(field.field, t))}</h2>`)
    parts.push(
      `<p><strong>${escapeHtml(t('opportunities.rec.current'))}</strong><br>${escapeHtml(
        field.current ?? t('opportunities.rec.currentEmpty'),
      )}</p>`,
    )
    parts.push(
      `<p><strong>${escapeHtml(t('opportunities.rec.suggested'))}</strong><br>${escapeHtml(
        field.suggested,
      )}</p>`,
    )
    if (field.evidence) {
      parts.push(
        `<blockquote><strong>${escapeHtml(t('opportunities.rec.modelWritten'))}</strong> ${escapeHtml(
          field.evidence,
        )}</blockquote>`,
      )
    }
    parts.push('</section>')
  }

  const linkList = (heading: string, links: readonly { url: string; anchor: string }[]) =>
    links.length === 0
      ? ''
      : `<h2>${escapeHtml(heading)}</h2><ul>${links
          .map((link) => `<li>${escapeHtml(link.url)} — ${escapeHtml(link.anchor)}</li>`)
          .join('')}</ul>`

  parts.push(
    linkList(
      t('opportunities.rec.linksIn'),
      (recommendation?.internalLinksIn ?? []).map((link) => ({
        url: link.fromUrl,
        anchor: link.anchor,
      })),
    ),
  )
  parts.push(
    linkList(
      t('opportunities.rec.linksOut'),
      (recommendation?.internalLinksOut ?? []).map((link) => ({
        url: link.toUrl,
        anchor: link.anchor,
      })),
    ),
  )

  parts.push(`<p><em>${escapeHtml(t('opportunities.rec.neverApplies'))}</em></p>`)
  parts.push('</body></html>')

  return parts.filter((part) => part !== '').join('\n')
}

export function recommendationFiles(
  detail: OpportunityDetail,
  t: Translate = defaultTranslate,
): readonly DownloadFile[] {
  const label = detail.opportunity.entityRef.label
  return [
    {
      filename: recommendationFilename(label, 'md'),
      mimeType: 'text/markdown',
      content: recommendationMarkdown(detail, t),
    },
    {
      filename: recommendationFilename(label, 'html'),
      mimeType: 'text/html',
      content: recommendationHtml(detail, t),
    },
  ]
}

/** True only where there is something worth downloading. */
export function hasRecommendationOutput(recommendation: Recommendation | null): boolean {
  return recommendation?.state === 'ready' && recommendation.fields.length > 0
}
