import { packFacts, type OptimizeEvidencePack } from './pack'
import type { OptimizeRecommendation } from './recommendation'

/**
 * The recommendation as something the merchant can take away: Markdown to
 * paste into their own notes, or HTML to open and read.
 *
 * Every word of the scaffolding — headings, the "current"/"suggested" labels,
 * the line saying we changed nothing in their store — is passed in by the
 * caller, which reads it from the string catalogue. Nothing here writes copy,
 * and nothing here is written by a model: the model's contribution is the
 * suggestions themselves, and they are quoted, never paraphrased.
 */

export interface RecommendationLabels {
  readonly documentTitle: string
  readonly page: string
  readonly search: string
  readonly intentNote: string
  readonly titleTag: string
  readonly metaDescription: string
  readonly headings: string
  readonly sections: string
  readonly faq: string
  readonly internalLinks: string
  readonly linksFrom: string
  readonly linksTo: string
  readonly current: string
  readonly suggested: string
  readonly basedOn: string
  readonly notSet: string
  readonly headingAdd: string
  readonly headingRewrite: string
  readonly trustLine: string
}

export interface RenderRecommendationInput {
  readonly recommendation: OptimizeRecommendation
  readonly pack: OptimizeEvidencePack
  readonly labels: RecommendationLabels
}

/** Addresses back to the plain-language labels the pack recorded for them. */
function factLabels(pack: OptimizeEvidencePack): Map<string, string> {
  return new Map(packFacts(pack).map((fact) => [fact.address, fact.label]))
}

function citations(labels: Map<string, string>, addresses: readonly string[]): string[] {
  return addresses.map((address) => labels.get(address) ?? address)
}

export function renderRecommendationMarkdown(input: RenderRecommendationInput): string {
  const { recommendation: rec, pack, labels } = input
  const facts = factLabels(pack)
  const lines: string[] = []

  lines.push(`# ${labels.documentTitle}`, '')
  lines.push(`**${labels.page}:** ${pack.page.url}`)
  lines.push(`**${labels.search}:** ${pack.targetQuery}`, '')
  lines.push(`## ${labels.intentNote}`, '', rec.intent_note, '')

  lines.push(`## ${labels.titleTag}`, '')
  lines.push(`- **${labels.current}:** ${rec.title_tag.current ?? labels.notSet}`)
  lines.push(`- **${labels.suggested}:** ${rec.title_tag.suggested}`, '')

  lines.push(`## ${labels.metaDescription}`, '')
  lines.push(`- **${labels.current}:** ${rec.meta_description.current ?? labels.notSet}`)
  lines.push(`- **${labels.suggested}:** ${rec.meta_description.suggested}`, '')

  if (rec.headings.length > 0) {
    lines.push(`## ${labels.headings}`, '')
    for (const heading of rec.headings) {
      const verb = heading.op === 'add' ? labels.headingAdd : labels.headingRewrite
      const where = heading.after ? ` (${heading.after})` : ''
      lines.push(`- ${verb}: H${heading.level} — ${heading.text}${where}`)
    }
    lines.push('')
  }

  if (rec.sections.length > 0) {
    lines.push(`## ${labels.sections}`, '')
    for (const section of rec.sections) {
      lines.push(`### ${section.heading}`, '', section.suggested_copy, '')
      const cited = citations(facts, section.facts_used)
      if (cited.length > 0) lines.push(`*${labels.basedOn}: ${cited.join(' · ')}*`, '')
    }
  }

  if (rec.faq.length > 0) {
    lines.push(`## ${labels.faq}`, '')
    for (const entry of rec.faq) {
      lines.push(`**${entry.q}**`, '', entry.a, '')
      const cited = citations(facts, entry.facts_used)
      if (cited.length > 0) lines.push(`*${labels.basedOn}: ${cited.join(' · ')}*`, '')
    }
  }

  const { add_from: from, add_to: to } = rec.internal_links
  if (from.length > 0 || to.length > 0) {
    lines.push(`## ${labels.internalLinks}`, '')
    if (from.length > 0) {
      lines.push(`**${labels.linksFrom}**`, '')
      for (const link of from) lines.push(`- ${link.url} — "${link.anchor}"`)
      lines.push('')
    }
    if (to.length > 0) {
      lines.push(`**${labels.linksTo}**`, '')
      for (const link of to) lines.push(`- ${link.url} — "${link.anchor}"`)
      lines.push('')
    }
  }

  lines.push('---', '', labels.trustLine, '')
  return lines.join('\n')
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Everything variable in the document is a merchant's own page text, a model's
 * suggestion or an address off a search result. All three are escaped: this
 * file is downloaded and opened in a browser, so an unescaped angle bracket in
 * a product description is a script running in the reader's browser.
 */
function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character)
}

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => `<p>${escape(block).replace(/\n/g, '<br />')}</p>`)
    .join('\n')
}

export function renderRecommendationHtml(input: RenderRecommendationInput): string {
  const { recommendation: rec, pack, labels } = input
  const facts = factLabels(pack)
  const body: string[] = []

  body.push(`<h1>${escape(labels.documentTitle)}</h1>`)
  body.push(
    `<p><strong>${escape(labels.page)}:</strong> ${escape(pack.page.url)}<br />` +
      `<strong>${escape(labels.search)}:</strong> ${escape(pack.targetQuery)}</p>`,
  )
  body.push(`<h2>${escape(labels.intentNote)}</h2>`, paragraphs(rec.intent_note))

  for (const [heading, field] of [
    [labels.titleTag, rec.title_tag],
    [labels.metaDescription, rec.meta_description],
  ] as const) {
    body.push(`<h2>${escape(heading)}</h2>`)
    body.push(
      '<dl>' +
        `<dt>${escape(labels.current)}</dt><dd>${escape(field.current ?? labels.notSet)}</dd>` +
        `<dt>${escape(labels.suggested)}</dt><dd>${escape(field.suggested)}</dd>` +
        '</dl>',
    )
  }

  if (rec.headings.length > 0) {
    body.push(`<h2>${escape(labels.headings)}</h2>`, '<ul>')
    for (const heading of rec.headings) {
      const verb = heading.op === 'add' ? labels.headingAdd : labels.headingRewrite
      const where = heading.after ? ` (${escape(heading.after)})` : ''
      body.push(`<li>${escape(verb)}: H${heading.level} — ${escape(heading.text)}${where}</li>`)
    }
    body.push('</ul>')
  }

  if (rec.sections.length > 0) {
    body.push(`<h2>${escape(labels.sections)}</h2>`)
    for (const section of rec.sections) {
      body.push(`<h3>${escape(section.heading)}</h3>`, paragraphs(section.suggested_copy))
      const cited = citations(facts, section.facts_used)
      if (cited.length > 0) {
        body.push(`<p><em>${escape(labels.basedOn)}: ${escape(cited.join(' · '))}</em></p>`)
      }
    }
  }

  if (rec.faq.length > 0) {
    body.push(`<h2>${escape(labels.faq)}</h2>`)
    for (const entry of rec.faq) {
      body.push(`<h3>${escape(entry.q)}</h3>`, paragraphs(entry.a))
      const cited = citations(facts, entry.facts_used)
      if (cited.length > 0) {
        body.push(`<p><em>${escape(labels.basedOn)}: ${escape(cited.join(' · '))}</em></p>`)
      }
    }
  }

  const { add_from: from, add_to: to } = rec.internal_links
  if (from.length > 0 || to.length > 0) {
    body.push(`<h2>${escape(labels.internalLinks)}</h2>`)
    for (const [heading, links] of [
      [labels.linksFrom, from],
      [labels.linksTo, to],
    ] as const) {
      if (links.length === 0) continue
      body.push(`<h3>${escape(heading)}</h3>`, '<ul>')
      for (const link of links) {
        body.push(`<li>${escape(link.url)} — “${escape(link.anchor)}”</li>`)
      }
      body.push('</ul>')
    }
  }

  body.push('<hr />', `<p>${escape(labels.trustLine)}</p>`)

  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8" />',
    `<title>${escape(labels.documentTitle)}</title>`,
    '</head><body>',
    ...body,
    '</body></html>',
    '',
  ].join('\n')
}
