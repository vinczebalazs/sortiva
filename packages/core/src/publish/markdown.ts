import MarkdownIt from 'markdown-it'

/**
 * Turning the writer's Markdown into the HTML that goes into a merchant's
 * storefront.
 *
 * The writer produces Markdown — internal links, comparison tables, step lists,
 * paragraph breaks — and the quality gate checks it as Markdown. Until this
 * existed the builder escaped that text and wrapped each section in a single
 * paragraph tag, so every one of those reached the shop as literal characters:
 * `[our sizing guide](/pages/sizing)` printed with its brackets, a table
 * printed as rows of pipes, and the whole section run together as one
 * paragraph. Nobody had looked at a published article, which is how it survived.
 *
 * **Three deliberate settings, and each is a safety decision rather than a
 * preference.** This HTML goes straight into somebody else's shop, and the
 * source it is built from is model output about a merchant's own product copy —
 * text we did not write and cannot fully predict.
 *
 *  - `html: false` — raw HTML in the source is **escaped, not passed through**.
 *    A model that emits a `<script>` tag, or a product description that carried
 *    one into the prompt, produces visible text rather than a tag in a
 *    merchant's storefront.
 *  - `linkify: false` — a bare address stays text. Turning every string that
 *    looks like a URL into a link means the article can link somewhere nobody
 *    chose, including somewhere that does not exist.
 *  - `typographer: false` — no quote or dash substitution. What the judge graded
 *    is what publishes.
 *
 * On top of that, link targets are restricted to the schemes a shop article can
 * legitimately use. markdown-it already refuses `javascript:` and friends; this
 * narrows it further to an allowlist, so the question is "is this one of the
 * four things a link may be" rather than "is this one of the schemes we
 * remembered to ban".
 */

/** What a link in a published article may point at. Everything else is not rendered as a link at all. */
const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:']

const renderer = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
})

renderer.validateLink = (url: string): boolean => {
  const trimmed = url.trim()
  // A relative link — `/pages/sizing`, `#faq` — is how an article links inside
  // the merchant's own shop, and is the most common link it carries.
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) return true
  try {
    return ALLOWED_LINK_SCHEMES.includes(new URL(trimmed).protocol)
  } catch {
    // Not parseable as an absolute address and not relative: a bare word, or
    // something malformed. Not a link.
    return false
  }
}

/** Enable the table syntax the writer is told it may use. Everything else is CommonMark. */
renderer.enable(['table'])

/**
 * The article body as an HTML **fragment** — no `<html>`, no `<body>`, no
 * styling. A merchant pastes it into their own editor, or we post it as a
 * Shopify article body, and the theme around it supplies the document.
 */
export function renderArticleMarkdown(markdown: string): string {
  return renderer.render(markdown).trim()
}
