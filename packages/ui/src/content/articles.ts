import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import type { DownloadFile } from '../opportunities/download'
import type {
  ArticleDetailResponse,
  ArticleState,
  ArticleSummary,
  DeliveryMode,
  OutcomeLabel,
  QualityReport,
} from './types'

/**
 * What the articles library decides before anything is drawn: which rows a
 * filter leaves, which articles are waiting on the merchant, what leaves the
 * screen as a file, and whether a pasted address can be believed.
 *
 * All of it is here rather than in the components because these are the rules
 * that would otherwise only be checkable by clicking, and two of them matter
 * enough to be tested on their own: an address on the wrong domain must not
 * reach attribution, or one store's article borrows another store's numbers;
 * and an exported article nobody told us the address of has to keep asking,
 * because it is invisible to every measurement we make until it does.
 */

export function articleStateLabel(state: ArticleState, t: Translate = defaultTranslate): string {
  return t(`content.articles.state.${state}` as StringKey)
}

export function deliveryLabel(delivery: DeliveryMode, t: Translate = defaultTranslate): string {
  return t(`content.articles.delivery.${delivery}` as StringKey)
}

/**
 * Winner, neutral, underperformer — and "too new" for everything younger than
 * the measurement window. A verdict before the window is up is noise dressed as
 * a judgement, so an unrated article reads as early rather than as a failure.
 */
export function outcomeLabel(label: OutcomeLabel, t: Translate = defaultTranslate): string {
  return t(`content.articles.label.${label}` as StringKey)
}

export interface ArticleCounts {
  readonly published: number
  readonly inReview: number
  readonly held: number
}

export function articleCounts(articles: readonly ArticleSummary[]): ArticleCounts {
  return {
    published: articles.filter((article) => article.state === 'published').length,
    inReview: articles.filter((article) => article.state === 'in_review').length,
    held: articles.filter((article) => article.state === 'rejected').length,
  }
}

/**
 * Articles waiting on the merchant rather than on us: a draft nobody has read,
 * one held back that they may still choose to publish, and an exported one
 * whose published address we were never told — which is the only one of the
 * three the merchant may not know is outstanding.
 */
export function needsAttention(article: ArticleSummary): boolean {
  if (article.state === 'in_review' || article.state === 'rejected') return true
  return (
    article.state === 'published' &&
    article.delivery === 'export' &&
    article.publishedUrl === null
  )
}

export interface ArticleFilter {
  readonly states?: readonly ArticleState[]
  readonly hasPerformance?: boolean
  readonly needsAttention?: boolean
}

export function filterArticles(
  articles: readonly ArticleSummary[],
  filter: ArticleFilter,
): readonly ArticleSummary[] {
  return articles.filter((article) => {
    if (filter.states && filter.states.length > 0 && !filter.states.includes(article.state)) {
      return false
    }
    if (filter.hasPerformance && article.performance === null) return false
    if (filter.needsAttention && !needsAttention(article)) return false
    return true
  })
}

// ── The address of an exported article ──────────────────────────────────────

export type PublishedUrlProblem = 'malformed' | 'off_domain'

export type PublishedUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly problem: PublishedUrlProblem }

/**
 * An exported article's address is what ties it to search data, so a wrong one
 * does not merely fail — it attributes somebody else's traffic to this store.
 * The check is therefore against the domain the account actually claimed, and
 * subdomains of it count, because a store blog often sits on one.
 */
export function checkPublishedUrl(raw: string, claimedDomain: string): PublishedUrlCheck {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return { ok: false, problem: 'malformed' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, problem: 'malformed' }
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const claimed = claimedDomain.toLowerCase().replace(/^www\./, '')
  if (host !== claimed && !host.endsWith(`.${claimed}`)) {
    return { ok: false, problem: 'off_domain' }
  }
  return { ok: true, url: parsed.toString() }
}

// ── The quality report ──────────────────────────────────────────────────────

/**
 * A criterion's name, in words. Anything the catalogue has no entry for is
 * spelled out from its own name rather than shown as a code — the judge's
 * criteria are the engine's to name, and a new one arriving before its wording
 * does is a real possibility.
 */
export function criterionLabel(criterion: string, t: Translate = defaultTranslate): string {
  try {
    return t(`content.article.quality.criterion.${criterion}` as StringKey)
  } catch {
    return criterion
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/^./, (char) => char.toUpperCase())
  }
}

/**
 * The criteria the override dialog has to restate.
 *
 * **This is read off the judge's own justifications, not worked out from the
 * scores.** The floors that decide a pass live in `packages/rules` with every
 * other threshold, and re-deriving them here would put a second copy of the
 * quality gate in a browser where nothing stamps it with a rules version — so
 * the screen does not compare a score to anything. What it has instead is the
 * judge's written objections, which is what the merchant is actually being
 * asked to overrule. Where a report carries none, every scored criterion is
 * named rather than none, because an override with nothing restated is exactly
 * the casual click the confirmation exists to prevent.
 */
export function failingCriteria(report: QualityReport | null): readonly string[] {
  if (!report) return []
  const explained = Object.keys(report.justifications)
  if (explained.length > 0) return explained
  return Object.keys(report.scores)
}

// ── What leaves the screen as a file ────────────────────────────────────────

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'article'
  )
}

export function articleFilename(title: string, extension: string): string {
  return `sortiva-${slugify(title)}.${extension}`
}

/**
 * A very small HTML-to-text pass, enough to make a Markdown file that reads.
 *
 * The article arrives as rendered HTML because that is what will publish, and
 * an export merchant needs the same thing in a form they can paste into a
 * different editor. This is not a converter and does not pretend to be: it
 * keeps headings, paragraphs and list items and drops the rest, which is what
 * the article's own structure is made of.
 */
export function articleMarkdown(detail: ArticleDetailResponse): string {
  const lines: string[] = [`# ${detail.article.title}`, '']
  const blocks = detail.html.matchAll(/<(h[1-6]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi)
  for (const block of blocks) {
    const tag = block[1]!.toLowerCase()
    const text = block[2]!
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text === '') continue
    if (tag === 'li') lines.push(`- ${text}`, '')
    else if (tag === 'p') lines.push(text, '')
    else lines.push(`${'#'.repeat(Number(tag[1]))} ${text}`, '')
  }
  return lines.join('\n').trimEnd().concat('\n')
}

/**
 * The metadata block: everything that has to be set on the page besides its
 * body, in one file, because an export merchant is setting it by hand in
 * another system and a field they never saw is a field they never set.
 */
export function articleMetadataBlock(detail: ArticleDetailResponse): string {
  return `${JSON.stringify(
    {
      title: detail.article.title,
      slug: detail.metadata.slug,
      targetKeyword: detail.metadata.targetKeyword,
      metaDescription: detail.metadata.metaDescription,
      families: detail.metadata.familyIds,
      products: detail.evidencePack.map((entry) => entry.productId),
    },
    null,
    2,
  )}\n`
}

export function articleFiles(detail: ArticleDetailResponse): readonly DownloadFile[] {
  const title = detail.article.title
  return [
    {
      filename: articleFilename(title, 'md'),
      mimeType: 'text/markdown',
      content: articleMarkdown(detail),
    },
    {
      filename: articleFilename(title, 'html'),
      mimeType: 'text/html',
      content: detail.html,
    },
    {
      filename: articleFilename(title, 'json'),
      mimeType: 'application/json',
      content: articleMetadataBlock(detail),
    },
  ]
}

/** The action bar an article's state earns. There is no `edit` in this union, and that is the point. */
export type ArticleAction =
  | 'approve'
  | 'discard'
  | 'publish_anyway'
  | 'request_refresh'
  | 'view_live'
  | 'download'
  | 'confirm_url'

export function articleActions(article: ArticleSummary): readonly ArticleAction[] {
  if (article.state === 'in_review') return ['approve', 'discard']
  if (article.state === 'rejected') return ['download', 'publish_anyway']
  if (article.state === 'published') {
    return article.delivery === 'export'
      ? ['download', 'confirm_url', 'request_refresh']
      : ['view_live', 'request_refresh']
  }
  return []
}
