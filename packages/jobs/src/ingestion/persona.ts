import {
  buildPersona,
  type FamilyBrief,
  type PersonaPrompt,
  type ShopLocaleSettings,
  type StorePageBrief,
} from '@sortiva/core'
import {
  accountScope,
  countCatalogProducts,
  ensureAccountTimezone,
  familiesForPersona,
  listTopProducts,
  upsertPersona,
} from '@sortiva/db'
import { TerminalFailure } from '../runtime/errors'
import { inputVersion } from '../runtime/idempotency'
import type { StepContext } from '../runtime/runStep'
import { storeRichness } from './distill'
import type { IngestionDeps } from './deps'
import type { StepDefinition } from './steps'

/**
 * Step six: deciding who this store is.
 *
 * Up to here the pipeline has been arithmetic — read the catalogue, extract the
 * facts, group the facts. This is the first step that forms a judgement, and
 * everything after it inherits that judgement: the language we write in, the
 * reader we write for, the register we write in, the market we buy search data
 * for, and the clock we publish on.
 *
 * Because of that reach, the two values that are most expensive to get wrong
 * are not left to the model. A store's language and country are worked out from
 * evidence the merchant themselves produced — their Shopify settings, their
 * own markup, their web address — and the model's reading is consulted only
 * where that evidence said nothing. The model's real job is the part no chain
 * of evidence could do: saying, in two to four sentences, what this shop
 * actually is.
 *
 * It spends one model call, on the stronger tier, and names no model of its
 * own: substituting a cheaper one for a busy hour is precisely the quiet
 * quality loss the product refuses to make. The call goes through the single
 * instrumented wrapper, so it is cached on its rendered prompt before the
 * answer is processed — a step killed between the model answering and the
 * profile being written replays the stored completion rather than paying again,
 * and gets *the same* persona rather than a second opinion.
 */

/** Where the store's own account of itself is looked for, in order. */
const ABOUT_PATHS = ['/pages/about', '/pages/about-us', '/pages/our-story', '/about']

/**
 * The homepage is small; a storefront's markup is not. The persona reads the
 * page's prose and its language tags, neither of which is at the bottom.
 */
const PAGE_BUDGET = { timeoutMs: 8_000, maxBytes: 600_000, maxRedirects: 3 }

export interface PersonaStepOutput {
  readonly language: string
  /** Which link in the evidence chain settled it — `shop_settings`, `html_lang`, …, or `model`. */
  readonly languageSource: string
  readonly country: string
  readonly countrySource: string
  /** The publish clock the country implies, and whether it was a table entry or a fallback. */
  readonly timezone: string
  readonly timezoneSource: string
  /** True when the store already had a timezone and kept it. */
  readonly timezoneKept: boolean
  readonly familiesDescribed: number
  readonly topSellersDescribed: number
  readonly productsDescribed: number
  /** Which of the store's own pages were readable. Onboarding continues without them. */
  readonly pagesRead: readonly string[]
  readonly richnessScore: number
  readonly promptVersion: string
  readonly modelId: string
  readonly cacheHit: boolean
}

export const personaStep: StepDefinition = {
  /**
   * The families, the best sellers and the size of the catalogue — the upstream
   * artefacts this step is a reading of.
   *
   * Deliberately *not* the store's own pages. A merchant who rewords their
   * about page has not changed what they sell, and keying on page text would
   * buy a fresh call on the stronger tier every time a homepage banner rotated.
   * The consequence to accept is the mirror of that: a store that re-brands
   * without touching its catalogue keeps yesterday's description until
   * something upstream moves, and the merchant can correct it at confirmation.
   */
  async inputVersion(deps, accountId) {
    const scope = accountScope(accountId)
    const families = (await familiesForPersona(deps.db, scope))
      .map((family) => `${family.name}|${family.memberCount}|${[...family.differentiationAxes].sort().join(',')}`)
      .sort()
    const sellers = (await listTopProducts(deps.db, scope))
      .map((row) => `${row.productId}|${row.rank}`)
      .sort()
    const products = await countCatalogProducts(deps.db, scope)
    return inputVersion({ families, sellers, products })
  },

  async execute(deps, ctx): Promise<PersonaStepOutput> {
    const llm = requireLlm(deps)
    const prompt = requirePrompt(deps)
    const scope = accountScope(ctx.accountId)
    const domain = await requireDomain(deps, ctx.accountId)

    const families = await familiesForPersona(deps.db, scope)
    const topSellers = await listTopProducts(deps.db, scope)
    const productsDescribed = await countCatalogProducts(deps.db, scope)

    const pages = await readOwnPages(deps, ctx, domain)
    const shop = await readShopSettings(deps, ctx)

    const result = await buildPersona(
      { llm, prompt },
      {
        accountId: ctx.accountId,
        domain,
        brief: {
          productCount: productsDescribed,
          families: families.map(toFamilyBrief),
          topSellers: topSellers.map((row) => ({ title: row.title, rank: row.rank })),
          pages: pages.map((page) => ({ kind: page.kind, text: page.text })),
        },
        evidence: {
          ...(shop ? { shop } : {}),
          ...(pages[0] ? { homepageHtml: pages[0].html } : {}),
          domain,
        },
      },
    )

    const richness = await storeRichness(deps, scope)
    const now = deps.now?.() ?? new Date()

    await upsertPersona(
      deps.db,
      scope,
      {
        description: result.persona.description,
        productCategories: result.persona.productCategories,
        language: result.persona.language,
        country: result.persona.country,
        audience: result.persona.audience,
        tone: result.persona.tone,
        richnessScore: richness.score,
        promptVersion: result.persona.promptVersion,
        modelId: result.persona.modelId,
      },
      now,
    )

    // Written after the profile, because the zone follows from the country the
    // profile just settled on, and a settings row naming a country we did not
    // store would be a clock nobody could explain.
    const timezone = await ensureAccountTimezone(deps.db, scope, result.timezone.timezone, now)

    const output: PersonaStepOutput = {
      language: result.persona.language,
      languageSource: result.persona.languageSource,
      country: result.persona.country,
      countrySource: result.persona.countrySource,
      timezone,
      timezoneSource: result.timezone.source,
      timezoneKept: timezone !== result.timezone.timezone,
      familiesDescribed: families.length,
      topSellersDescribed: topSellers.length,
      productsDescribed,
      pagesRead: pages.map((page) => page.kind),
      richnessScore: richness.score,
      promptVersion: result.persona.promptVersion,
      modelId: result.persona.modelId,
      cacheHit: result.cacheHit,
    }

    // Codes, counts and provenance. Never the description, the categories or the
    // audience: those are our words about a merchant's business, they live in
    // one row, and a log line is not that row.
    ctx.log.info('persona.completed', {
      language: output.language,
      language_source: output.languageSource,
      country: output.country,
      country_source: output.countrySource,
      timezone: output.timezone,
      timezone_source: output.timezoneSource,
      timezone_kept: output.timezoneKept,
      families_described: output.familiesDescribed,
      top_sellers_described: output.topSellersDescribed,
      products_described: output.productsDescribed,
      pages_read: output.pagesRead.length,
      richness_score: output.richnessScore,
      cache_hit: output.cacheHit,
    })

    return output
  },
}

function toFamilyBrief(family: {
  name: string
  memberCount: number
  differentiationAxes: readonly string[]
  mergedFacts: FamilyBrief['mergedFacts']
}): FamilyBrief {
  return {
    name: family.name,
    memberCount: family.memberCount,
    differentiationAxes: family.differentiationAxes,
    mergedFacts: family.mergedFacts,
  }
}

interface FetchedPage extends StorePageBrief {
  /** Kept for its language tags, which are markup rather than prose. */
  readonly html: string
}

/**
 * The store's own account of itself: its homepage, and its about page if it has
 * one at any of the addresses Shopify's own page editor suggests.
 *
 * Best effort, deliberately. A homepage that times out or an about page that
 * does not exist is an ordinary state of the web, not a reason to stall a
 * merchant's onboarding — the catalogue is the substance of the persona and it
 * is already in our own tables. What is lost is some of the brand's voice, and
 * the merchant reads and corrects the result before anything is written.
 */
async function readOwnPages(
  deps: IngestionDeps,
  ctx: StepContext,
  domain: string,
): Promise<FetchedPage[]> {
  const pages: FetchedPage[] = []

  const home = await fetchPage(deps, `https://${domain}/`)
  if (home) pages.push({ kind: 'homepage', text: textOf(home), html: home })
  else ctx.log.info('persona.page_unreadable', { page: 'homepage' })

  for (const path of ABOUT_PATHS) {
    const about = await fetchPage(deps, `https://${domain}${path}`)
    if (!about) continue
    pages.push({ kind: 'about', text: textOf(about), html: about })
    break
  }

  return pages
}

async function fetchPage(deps: IngestionDeps, url: string): Promise<string | undefined> {
  try {
    const page = await deps.fetcher.fetch({ url, budget: PAGE_BUDGET })
    return page.status === 200 ? page.body : undefined
  } catch {
    return undefined
  }
}

/**
 * A page's readable prose.
 *
 * Deliberately its own small reduction rather than the distillation module's,
 * which is bounded to a product description's budget and belongs to the funnel
 * a description passes through. This one keeps the markup out and lets the
 * brief's own limit decide the length.
 */
function textOf(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|iframe|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|table|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, (_m, name: string) =>
      ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name.toLowerCase()] ?? ' ',
    )
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim()
}

/**
 * What the merchant configured their storefront as, read back from Shopify.
 *
 * The strongest evidence in the chain, and still optional. If the token has
 * gone stale or Shopify is having an hour, the persona is built from the
 * store's own markup and address instead — the sync that needs that token has
 * its own reconnect path, and stalling the profile here would take a store off
 * the road for a metadata read it can do without.
 */
async function readShopSettings(
  deps: IngestionDeps,
  ctx: StepContext,
): Promise<ShopLocaleSettings | undefined> {
  try {
    const connection = await deps.connections.read(ctx.accountId)
    if (!connection || connection.invalidatedAt !== null) return undefined
    const auth = await deps.connections.authFor(ctx.accountId)
    if (!auth) return undefined

    const shop = await deps.shop.getShop(auth)
    return {
      primaryLocale: shop.primaryLocale,
      countryCode: shop.countryCode,
      currency: shop.currency,
    }
  } catch (error) {
    ctx.log.info('persona.shop_settings_unavailable', {
      error_class: error instanceof Error ? error.name : 'unknown',
    })
    return undefined
  }
}

async function requireDomain(deps: IngestionDeps, accountId: string): Promise<string> {
  const domain = await deps.domains.readNormalized(accountId)
  if (!domain) {
    throw new TerminalFailure('no_domain', 'This account has not claimed a domain.')
  }
  return domain
}

function requireLlm(deps: IngestionDeps) {
  if (!deps.llm) {
    throw new TerminalFailure(
      'no_llm_client',
      'The persona needs the instrumented model client; the process did not supply one.',
    )
  }
  return deps.llm
}

function requirePrompt(deps: IngestionDeps): PersonaPrompt {
  if (!deps.personaPrompt) {
    throw new TerminalFailure(
      'no_persona_prompt',
      'The persona needs its versioned prompt; the process did not supply one.',
    )
  }
  return deps.personaPrompt
}
