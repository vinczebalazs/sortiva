import { BundleNotBuildable, checkPublishedUrl, confirmPublishedUrlRequestSchema } from '@sortiva/core'
import {
  findArticleById,
  findDomainForAccount,
  setPublishedUrlGuarded,
  type Db,
} from '@sortiva/db'
// Deep imports, not the `@sortiva/jobs` barrel — see the identical note in
// `apps/web/app/api/calendar/_lib/handlers.ts`, which hit the build failure
// this avoids.
import {
  ArticleHasNoBody,
  ArticleNotFound,
  buildBundleForArticle,
} from '@sortiva/jobs/publish/bundle'
import { t } from '@sortiva/ui/strings/translate'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * The two things export mode is: downloading the finished article, and telling
 * us where you published it.
 *
 * Both handlers are parse → call → serialise. The interesting decisions are
 * elsewhere: what a bundle contains is `packages/core/src/publish`, when the
 * store's rows are read is `packages/jobs/src/publish`, and whether an address
 * belongs to this merchant is one shared function used here and in the browser.
 */

export interface DeliveryDeps {
  readonly db: Db
  readonly now?: () => Date
}

export type RouteCtx = { readonly params: Promise<{ articleId: string }> }

function notFound(): Response {
  return Response.json(
    { error: { code: 'article_not_found', message: t('content.articles.export.gone') } },
    { status: 404 },
  )
}

/**
 * Why the merchant cannot have this article yet, in words they can act on.
 *
 * A missing product is the interesting one: the article names something the
 * store no longer sells, and handing it over would publish a hole. It is a 409
 * rather than a 500 because nothing is broken — the shop changed.
 */
function notBuildable(error: BundleNotBuildable): Response {
  const message =
    error.reason === 'missing_product'
      ? t('content.articles.export.productGone')
      : t('content.articles.export.notReady')
  return Response.json({ error: { code: error.errorClass, message } }, { status: 409 })
}

export function makeExportArticleHandler(deps: DeliveryDeps): AccountHandler<RouteCtx> {
  return async (_request, { scope, route }) => {
    const { articleId } = await route.params
    try {
      const bundle = await buildBundleForArticle(
        { db: deps.db, ...(deps.now ? { now: deps.now } : {}) },
        { accountId: scope.accountId, articleId },
      )
      // The three files as JSON rather than one file per request: the merchant
      // presses one of three buttons and expects a file each time, and the
      // values in all three come from a single reading of the store — three
      // requests could straddle a price change and disagree with each other.
      return Response.json({ files: bundle.files })
    } catch (error) {
      if (error instanceof ArticleNotFound) return notFound()
      if (error instanceof ArticleHasNoBody) {
        return Response.json(
          {
            error: {
              code: error.errorClass,
              message: t('content.articles.export.notWritten'),
            },
          },
          { status: 409 },
        )
      }
      if (error instanceof BundleNotBuildable) return notBuildable(error)
      throw error
    }
  }
}

/**
 * The two ways an address can be wrong need different fixes — a typo, and the
 * right shape on the wrong site — so they are told apart rather than both
 * called invalid. The wording is the catalogue's, the same sentence the browser
 * shows before the request is ever made.
 */
function rejected(problem: 'malformed' | 'off_domain', domain: string): Response {
  return Response.json(
    {
      error: {
        code: problem === 'malformed' ? 'url_malformed' : 'url_off_domain',
        message:
          problem === 'malformed'
            ? t('content.articles.urlMalformed')
            : t('content.articles.urlInvalid', { domain }),
      },
    },
    { status: 422 },
  )
}

export function makeConfirmPublishedUrlHandler(deps: DeliveryDeps): AccountHandler<RouteCtx> {
  return async (request, { scope, route }) => {
    const { articleId } = await route.params
    const parsed = confirmPublishedUrlRequestSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return Response.json(
        { error: { code: 'url_malformed', message: t('content.articles.urlMalformed') } },
        { status: 422 },
      )
    }

    // Attribution is by address, so an address on somebody else's site would
    // credit this store with another store's search traffic. The claimed
    // domain is the account's own and is read here rather than trusted from
    // the request.
    const domain = await findDomainForAccount(deps.db, scope)
    if (!domain) {
      return Response.json(
        {
          error: {
            code: 'domain_not_claimed',
            message: t('content.articles.export.needsDomain'),
          },
        },
        { status: 409 },
      )
    }

    const check = checkPublishedUrl(parsed.data.url, domain.domainNormalized)
    if (!check.ok) return rejected(check.problem, domain.domainNormalized)

    const updated = await setPublishedUrlGuarded(
      deps.db,
      scope,
      articleId,
      check.url,
      deps.now?.() ?? new Date(),
    )
    if (updated) return Response.json({ ok: true })

    // The guard matched nothing. Which of the two it was matters to the
    // merchant: an article that is gone, or one that has not been handed over
    // yet — there is nothing to confirm the address of until it has.
    const article = await findArticleById(deps.db, scope, articleId)
    if (!article) return notFound()
    return Response.json(
      {
        error: {
          code: 'article_not_published',
          message: t('content.articles.export.notPublished'),
        },
      },
      { status: 409 },
    )
  }
}
