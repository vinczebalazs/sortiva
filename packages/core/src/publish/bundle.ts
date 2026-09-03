import type { ArticleBody } from '../generation/draft'
import {
  renderPlaceholders,
  resolveProductReferences,
  unresolvedPlaceholders,
  type LiveProduct,
  type ProductReference,
  type ResolvedReference,
} from './resolve'

/**
 * What a merchant on export mode actually receives: the article as Markdown,
 * the same article as HTML, and a metadata block naming the title tag, slug,
 * meta description, target keyword and the images to use.
 *
 * Two rules shape the whole file.
 *
 * **Never image bytes.** The metadata carries image *addresses* on the store's
 * own Shopify CDN and nothing else. We do not proxy, copy or re-host a
 * merchant's photographs — an article that hotlinks the shop's own CDN costs us
 * no storage and no bandwidth, and an address anywhere else is dropped rather
 * than passed on, because an image we cannot account for is one we would be
 * telling the merchant to publish blind.
 *
 * **Never a stale value.** Prices, stock and product addresses are resolved
 * from the store as it is at the moment the bundle is built, from the
 * placeholders the draft carries in their place. If a referenced product has
 * gone, no bundle is produced at all: the download fails and says which
 * reference broke, rather than handing over an article with a hole in it.
 */

/** The one host a product image may be served from. */
export const SHOPIFY_CDN_HOST = 'cdn.shopify.com'

export interface BundleImage {
  readonly url: string
  readonly alt: string
}

export interface BundleArticle {
  readonly title: string
  readonly slug: string
  readonly metaDescription: string
  readonly targetKeyword: string | null
  readonly body: ArticleBody
}

export interface BuildBundleInput {
  readonly article: BundleArticle
  readonly references: readonly ProductReference[]
  /** The store's products as they are right now, keyed by our own product id. */
  readonly live: ReadonlyMap<string, LiveProduct>
  /** Catalog image addresses. Anything not on the Shopify CDN is dropped before it reaches the merchant. */
  readonly images: readonly BundleImage[]
}

export interface BundleFile {
  readonly filename: string
  readonly mimeType: string
  readonly content: string
}

export interface ExportBundle {
  readonly files: readonly BundleFile[]
  /** The values each reference resolved to, for recording what the merchant was handed. */
  readonly resolved: ReadonlyMap<string, ResolvedReference>
}

/**
 * A bundle that cannot be built, and exactly why.
 *
 * Not a generic failure: the merchant is told which product reference broke, so
 * "one of the products in this article no longer exists" is answerable rather
 * than mysterious. Terminal — retrying changes nothing until the catalogue or
 * the article does.
 */
export class BundleNotBuildable extends Error {
  readonly retryable = false
  readonly errorClass = 'bundle_not_buildable'

  constructor(
    readonly reason: 'missing_product' | 'unresolved_placeholder',
    readonly placeholders: readonly string[],
  ) {
    super(
      reason === 'missing_product'
        ? `the article references products that are no longer in the store: ${placeholders.join(', ')}`
        : `the article body carries markers no product reference explains: ${placeholders.join(', ')}`,
    )
    this.name = 'BundleNotBuildable'
  }
}

/**
 * Addresses on the store's own Shopify CDN, and nothing else.
 *
 * A malformed address is dropped for the same reason a foreign one is: what
 * reaches the merchant has to be something we can say is theirs.
 */
export function shopifyCdnImagesOnly(images: readonly BundleImage[]): readonly BundleImage[] {
  return images.filter((image) => {
    try {
      const url = new URL(image.url)
      return url.protocol === 'https:' && url.hostname.toLowerCase() === SHOPIFY_CDN_HOST
    } catch {
      return false
    }
  })
}

/**
 * The writer's own provenance markers — `[[c1]]`, naming the claim a sentence
 * rests on. They are how the quality gate checks that every checkable statement
 * is grounded, and they are internal: no reader ever sees one, so they come out
 * here, at the last moment before the article leaves us.
 */
function stripClaimMarkers(text: string): string {
  return text.replace(/\[\[\s*[a-zA-Z0-9_]+\s*\]\]/g, '')
}

function tidy(text: string): string {
  return text.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1').trim()
}

function markdownBody(article: BundleArticle, resolved: ReadonlyMap<string, ResolvedReference>): string {
  const render = (text: string) => tidy(renderPlaceholders(stripClaimMarkers(text), resolved, 'markdown'))
  const lines: string[] = [`# ${article.title}`, '', render(article.body.intro), '']
  for (const section of article.body.sections) {
    lines.push(`## ${section.heading}`, '', render(section.body), '')
  }
  if (article.body.faq.length > 0) {
    lines.push('## FAQ', '')
    for (const entry of article.body.faq) {
      lines.push(`### ${entry.question}`, '', render(entry.answer), '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The article as a fragment, not a page.
 *
 * A merchant pastes this into their own blog editor, which supplies the
 * document around it — a full `<html>` document with our own styling would
 * fight their theme rather than fit inside it.
 */
function htmlBody(article: BundleArticle, resolved: ReadonlyMap<string, ResolvedReference>): string {
  // Escaping happens before the markers are replaced, because a rendered
  // mention is deliberately HTML (a link) and escaping it afterwards would
  // print the tag rather than follow it.
  const render = (text: string) =>
    tidy(renderPlaceholders(escapeHtml(stripClaimMarkers(text)), resolved, 'html'))
  const parts: string[] = [`<h1>${escapeHtml(article.title)}</h1>`, `<p>${render(article.body.intro)}</p>`]
  for (const section of article.body.sections) {
    parts.push(`<h2>${escapeHtml(section.heading)}</h2>`, `<p>${render(section.body)}</p>`)
  }
  if (article.body.faq.length > 0) {
    parts.push('<h2>FAQ</h2>')
    for (const entry of article.body.faq) {
      parts.push(`<h3>${escapeHtml(entry.question)}</h3>`, `<p>${render(entry.answer)}</p>`)
    }
  }
  return `${parts.join('\n')}\n`
}

/** The metadata block: what to put in the page's own fields, plus the images to use. */
export interface BundleMetadata {
  readonly title: string
  readonly slug: string
  readonly metaDescription: string
  readonly targetKeyword: string | null
  readonly images: readonly BundleImage[]
  /** What each product mention was resolved to at the moment this bundle was built. */
  readonly productReferences: readonly {
    readonly placeholderKey: string
    readonly values: Readonly<Record<string, string>>
  }[]
}

/** A filename from the article's slug, safe on every operating system we can be opened on. */
export function bundleFilename(slug: string, extension: string): string {
  const safe =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'article'
  return `sortiva-${safe}.${extension}`
}

export function buildExportBundle(input: BuildBundleInput): ExportBundle {
  const { resolved, missing } = resolveProductReferences(input.references, input.live)
  if (missing.length > 0) throw new BundleNotBuildable('missing_product', missing)

  const wholeBody = [
    input.article.body.intro,
    ...input.article.body.sections.map((section) => section.body),
    ...input.article.body.faq.map((entry) => entry.answer),
  ].join('\n')
  const stranded = unresolvedPlaceholders(wholeBody, resolved)
  if (stranded.length > 0) throw new BundleNotBuildable('unresolved_placeholder', stranded)

  const images = shopifyCdnImagesOnly(input.images)
  const metadata: BundleMetadata = {
    title: input.article.title,
    slug: input.article.slug,
    metaDescription: input.article.metaDescription,
    targetKeyword: input.article.targetKeyword,
    images,
    productReferences: [...resolved.values()].map((reference) => ({
      placeholderKey: reference.placeholderKey,
      values: reference.values,
    })),
  }

  return {
    resolved,
    files: [
      {
        filename: bundleFilename(input.article.slug, 'md'),
        mimeType: 'text/markdown',
        content: markdownBody(input.article, resolved),
      },
      {
        filename: bundleFilename(input.article.slug, 'html'),
        mimeType: 'text/html',
        content: htmlBody(input.article, resolved),
      },
      {
        filename: bundleFilename(input.article.slug, 'json'),
        mimeType: 'application/json',
        content: `${JSON.stringify(metadata, null, 2)}\n`,
      },
    ],
  }
}
