import type { DownloadFile } from '../opportunities/download'
import { t as defaultTranslate, type Translate } from '../strings'

/**
 * Fetching the files a merchant is about to be handed, from the route that
 * builds them.
 *
 * Both Content screens used to assemble the download in the browser out of the
 * article-detail response. That response answers 200 with an empty body when
 * the article cannot be rendered — a referenced product has left the store, or
 * the writer has not finished — because the same page carries the quality
 * report and the override, and refusing the read would take those away too.
 *
 * So the screens handed over a title and nothing else, silently, in exactly the
 * case a merchant most needs to be told. The export route refuses that case and
 * says which product broke; this is what points at it.
 */

export type ArticleExport =
  | { readonly ok: true; readonly files: readonly DownloadFile[] }
  | { readonly ok: false; readonly message: string }

interface ExportBody {
  readonly files?: readonly DownloadFile[]
  readonly error?: { readonly code?: string; readonly message?: string }
}

export async function fetchArticleExport(
  articleId: string,
  t: Translate = defaultTranslate,
  fetcher: typeof fetch = fetch,
): Promise<ArticleExport> {
  try {
    const response = await fetcher(`/api/articles/${articleId}/export`, {
      headers: { accept: 'application/json' },
    })
    const body = (await response.json().catch(() => null)) as ExportBody | null

    if (response.ok && body?.files) return { ok: true, files: body.files }

    // The route's refusals are already merchant-facing sentences from this same
    // catalogue, so they are shown rather than mapped to a second copy of
    // themselves that could drift from the one the server sends.
    const message = body?.error?.message
    return { ok: false, message: message && message !== '' ? message : t('content.articles.export.failed') }
  } catch {
    return { ok: false, message: t('content.articles.export.failed') }
  }
}
