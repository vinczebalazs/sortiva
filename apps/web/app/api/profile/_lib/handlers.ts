import {
  addCompetitorRequestSchema,
  addKeywordRequestSchema,
  confirmProfile,
  confirmProfileRequestSchema,
  createLogger,
  rankCompetitorCandidates,
  rollUpRichness,
  serpSnapshotKey,
  validateCompetitorDomain,
  validateKeywordTerm,
  type Logger,
  type PosthogCapture,
} from '@sortiva/core'
import {
  BUSINESS_COMPETITOR_CAP,
  CompetitorCapReached,
  makeKeywordStore,
  makeProfileStore,
  type AccountScope,
  type KeywordStore,
  type ProfileFamily,
  type ProfileStore,
  type TopProductRow,
} from '@sortiva/db'
import { enqueueKeywordEnrichment } from '@sortiva/jobs/ingestion/enrich'
import { PosthogServerCapture } from '@sortiva/providers'
import { rules } from '@sortiva/rules'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * The two lists a merchant edits on the confirmation screen and, afterwards,
 * in settings: their search terms and the handful of businesses they are
 * compared against.
 *
 * Two rules shape every handler here.
 *
 * **No vendor call happens in a request.** Adding a term writes the row
 * unpriced and asks the queue — on a lane that runs ahead of the sweeps — to go
 * and price it. The screen shows a loading state against that one chip. A
 * request that spends money is a request a double-click can spend twice, and a
 * slow vendor would be a slow page.
 *
 * **The five-competitor cap is enforced here and in the database, and the
 * database is the authority.** The count below turns "you already have five"
 * into a specific message; the trigger is what makes it true when two requests
 * arrive at once. Either refusal produces the same answer, so the merchant is
 * never told two different things about one rule.
 */

/** Whether a domain has a DNS record, for the "is that a real address" check on a typed competitor. */
export interface DomainResolver {
  resolves(domain: string): Promise<boolean>
}

export interface ProfileDeps {
  readonly store: KeywordStore
  readonly profileStore: ProfileStore
  readonly log: Logger
  /**
   * Optional. When absent, a typed domain is accepted on its spelling alone —
   * a resolver having a bad second must not stand between a merchant and their
   * own competitor list.
   */
  readonly resolver?: DomainResolver
  /** The `profile_confirmed` funnel step. Optional so the route runs without telemetry. */
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

let capture: PosthogServerCapture | undefined

/** One process-wide capture client, the same instance every route in this file shares. */
function profileCapture(): PosthogServerCapture {
  capture ??= new PosthogServerCapture()
  return capture
}

export function profileDeps(): ProfileDeps {
  return {
    store: makeKeywordStore(),
    profileStore: makeProfileStore(),
    log: createLogger({ base: { component: 'profile' } }),
    capture: profileCapture(),
  }
}

// ── The confirmation screen itself ───────────────────────────────────────────

/**
 * `GET /api/profile` — every section of the confirmation screen, and, once
 * confirmed, the identical Settings → Store profile screen (main §6.8; ui
 * §3.7, §9.2).
 *
 * A store with no persona yet has not reached the review step: `profile_not_ready`
 * is the same refusal the keyword and competitor routes already give a store
 * in that position, so the screen reads one error shape everywhere it can hit
 * one.
 */
export function makeGetProfileHandler(deps: ProfileDeps): AccountHandler {
  return async (_request, { scope }) => {
    const persona = await deps.profileStore.persona(scope)
    if (!persona) return conflict('profile_not_ready', 'Your store profile is still being built.')

    const [topProducts, keywords, competitors, suggestions, families, richnessInputs, searchConsole] =
      await Promise.all([
        deps.profileStore.topProducts(scope),
        deps.store.listKeywords(scope),
        deps.store.listCompetitors(scope),
        competitorSuggestions(deps, scope),
        deps.profileStore.families(scope),
        deps.profileStore.richnessInputs(scope),
        deps.profileStore.searchConsole(scope),
      ])

    // The same judgement, and the same two config numbers, distillation
    // stamps on the persona and the Opportunity Engine's substance check reads
    // later (main §6.3) — recomputed here rather than trusted from a column so
    // it can never say something different from what a fresh count would.
    const floor = rules().defaults.gates.substance_floor
    const richness = rollUpRichness(richnessInputs, {
      populatedFieldsPerProductMin: floor.populated_fields_per_product_min,
      marginMultiple: floor.margin_multiple,
    })

    return Response.json({
      description: persona.description,
      language: persona.language,
      country: persona.country,
      audience: persona.audience,
      tone: persona.tone,
      topProducts: topProducts.map(serialiseTopProduct),
      keywords: keywords.map(serialiseKeyword),
      competitors: competitors.map((row) => ({
        id: row.id,
        domain: row.domainNormalized,
        source: row.source,
      })),
      competitorSuggestions: suggestions,
      families: families.map(serialiseFamily),
      richness: { band: richness.band, productsMissingDetails: richness.productsMissingDetails },
      searchConsole,
      confirmed: persona.confirmedAt !== null,
    })
  }
}

/**
 * `POST /api/profile/confirm` — the one action that ends onboarding.
 *
 * `packages/core`'s `confirmProfile` does the actual work (the guarded
 * transition, the edits, the funnel capture); this only parses the body and
 * turns its three outcomes into the shapes the screen reads: success, the
 * `profile_already_confirmed` conflict the route contract names, and
 * `profile_not_ready` for a confirm that arrives before ingestion has reached
 * the review step at all.
 */
export function makeConfirmProfileHandler(deps: ProfileDeps): AccountHandler {
  return async (request, { scope }) => {
    const body = await readJson(request)
    if (body === undefined) {
      return badRequest('invalid_body', 'Send the profile you want confirmed.')
    }

    const parsed = confirmProfileRequestSchema.safeParse(body)
    if (!parsed.success) {
      return badRequest('invalid_body', 'That profile is missing something required.')
    }

    const domain = await deps.store.ownDomain(scope)

    const result = await confirmProfile(
      { store: deps.profileStore, ...(deps.capture ? { capture: deps.capture } : {}) },
      {
        accountId: scope.accountId,
        domain: domain ?? '',
        edits: {
          description: parsed.data.description,
          language: parsed.data.language,
          country: parsed.data.country,
          audience: parsed.data.audience,
          tone: parsed.data.tone,
          topProductIds: parsed.data.topProductIds,
        },
      },
    )

    switch (result.kind) {
      case 'confirmed':
        deps.log.info('profile.confirmed', { account_id: scope.accountId })
        return Response.json({ ok: true })
      case 'already_confirmed':
        return conflict('profile_already_confirmed', 'This profile is already confirmed.')
      case 'not_ready':
        return conflict('profile_not_ready', 'Your store profile is still being built.')
    }
  }
}

// ── Keywords ────────────────────────────────────────────────────────────────

export function makeAddKeywordHandler(deps: ProfileDeps): AccountHandler {
  return async (request, { scope }) => {
    const body = await readJson(request)
    if (body === undefined) {
      return badRequest('invalid_body', 'Send a JSON body naming the search term.')
    }

    const parsed = addKeywordRequestSchema.safeParse(body)
    if (!parsed.success) return badRequest('invalid_body', 'A keyword is a search term.')

    const validated = validateKeywordTerm(parsed.data.term)
    if (!validated.ok) {
      return badRequest(
        'invalid_keyword',
        validated.reason === 'empty'
          ? 'Type the search term you want us to look at.'
          : 'That is longer than a search term.',
      )
    }

    const persona = await deps.store.persona(scope)
    if (!persona) {
      return conflict('profile_not_ready', 'Your store profile is still being built.')
    }

    const row = await deps.store.addKeyword(scope, {
      term: validated.term,
      language: persona.language,
      country: persona.country,
    })

    // Queued, never awaited: the merchant gets their chip immediately and the
    // metrics land on it when the vendor answers.
    await enqueueKeywordEnrichment(deps.store.database(), {
      accountId: scope.accountId,
      term: row.term,
    })
    deps.log.info('profile.keyword_added', { account_id: scope.accountId, source: row.source })

    return Response.json(serialiseKeyword(row))
  }
}

export function makeRemoveKeywordHandler(
  deps: ProfileDeps,
): AccountHandler<{ params: Promise<{ keywordId: string }> }> {
  return async (_request, { scope, route }) => {
    const { keywordId } = await route.params
    const removed = await deps.store.removeKeyword(scope, keywordId)
    if (!removed) return notFound('keyword_not_found', 'That keyword is already gone.')
    return Response.json({ ok: true })
  }
}

// ── Competitors ─────────────────────────────────────────────────────────────

export function makeAddCompetitorHandler(deps: ProfileDeps): AccountHandler {
  return async (request, { scope }) => {
    const body = await readJson(request)
    if (body === undefined) {
      return badRequest('invalid_body', 'Send a JSON body naming the competitor.')
    }

    const parsed = addCompetitorRequestSchema.safeParse(body)
    if (!parsed.success) return badRequest('invalid_body', 'A competitor is a web address.')

    const persona = await deps.store.persona(scope)
    const ownDomain = await ownDomainFor(deps, scope)
    if (!ownDomain || !persona) {
      return conflict('profile_not_ready', 'Your store profile is still being built.')
    }

    // Spelling first, then the lookup — there is no point resolving something
    // that is not a web address, and no point resolving the merchant's own
    // store.
    const shape = validateCompetitorDomain({
      domain: parsed.data.domain,
      ownDomain,
      overrideBlocklist: true,
    })
    if (!shape.ok) return refusal(shape.rejected.reason)

    const validated = validateCompetitorDomain({
      domain: parsed.data.domain,
      ownDomain,
      ...(parsed.data.overrideBlocklist === undefined
        ? {}
        : { overrideBlocklist: parsed.data.overrideBlocklist }),
      ...(deps.resolver ? { resolves: await resolves(deps, shape.domain) } : {}),
    })
    if (!validated.ok) return refusal(validated.rejected.reason)

    try {
      const row = await deps.store.addCompetitor(scope, {
        domainNormalized: validated.domain,
        source: 'manual',
      })
      deps.log.info('profile.competitor_added', {
        account_id: scope.accountId,
        override_used: parsed.data.overrideBlocklist === true,
      })
      return Response.json({ id: row.id, domain: row.domainNormalized, source: row.source })
    } catch (error) {
      if (error instanceof CompetitorCapReached) {
        return conflict(
          'competitor_limit_reached',
          `You already have ${BUSINESS_COMPETITOR_CAP} competitors. Remove one to add another.`,
        )
      }
      throw error
    }
  }
}

export function makeRemoveCompetitorHandler(
  deps: ProfileDeps,
): AccountHandler<{ params: Promise<{ competitorId: string }> }> {
  return async (_request, { scope, route }) => {
    const { competitorId } = await route.params
    const removed = await deps.store.removeCompetitor(scope, competitorId)
    if (!removed) return notFound('competitor_not_found', 'That competitor is already gone.')
    return Response.json({ ok: true })
  }
}

/**
 * The domains ranking alongside the store for the terms it confirmed, offered
 * as suggestions.
 *
 * Read-only by construction: it reads stored results pages, counts, and returns
 * names and numbers. Nothing here writes to the competitor list — a suggestion
 * becomes a competitor only through the add route above, which is a merchant's
 * click. Exported for the profile screen (`T2.7`), which renders these
 * underneath the list.
 */
export interface CompetitorSuggestion {
  readonly domain: string
  /** How many of the merchant's own confirmed searches this domain ranks for. */
  readonly appearsInQueries: number
}

export async function competitorSuggestions(
  deps: ProfileDeps,
  scope: AccountScope,
  now: Date = new Date(),
): Promise<CompetitorSuggestion[]> {
  const persona = await deps.store.persona(scope)
  const ownDomain = await ownDomainFor(deps, scope)
  if (!persona || !ownDomain) return []

  const discovery = rules().forLocale(null).discovery
  const terms = await deps.store.confirmedKeywords(scope)
  if (terms.length === 0) return []

  const locale = { language: persona.language, country: persona.country }
  const cacheKeys = terms.map((row) =>
    serpSnapshotKey({
      query: row.term,
      locale,
      depth: discovery.competitors.serp_position_max,
    }),
  )

  const ranked = await deps.store.rankedDomains({ cacheKeys, now })
  const existing = await deps.store.listCompetitors(scope)

  return rankCompetitorCandidates({
    ranked,
    ownDomain,
    existingDomains: existing.map((row) => row.domainNormalized),
    positionMax: discovery.competitors.serp_position_max,
    appearsInKeywordsMin: discovery.competitors.appears_in_keywords_min,
    limit: discovery.competitors.auto_proposed_max,
  }).map((candidate) => ({
    domain: candidate.domain,
    appearsInQueries: candidate.appearsInKeywords,
  }))
}

async function ownDomainFor(deps: ProfileDeps, scope: AccountScope): Promise<string | undefined> {
  return deps.store.ownDomain(scope)
}

async function resolves(deps: ProfileDeps, domain: string): Promise<boolean | undefined> {
  try {
    return await deps.resolver?.resolves(domain)
  } catch {
    // The lookup itself failed. Nobody looked, which is not the same as "it
    // does not exist" and must not be treated as it.
    return undefined
  }
}

/**
 * A refused competitor, in the shape the confirmation screen already reads:
 * 409 for the two states the merchant can act on directly, and any other
 * refusal of a well-formed domain as the marketplace warning with its "add
 * anyway" beside it.
 */
function refusal(reason: 'invalid' | 'own_domain' | 'blocklisted' | 'unresolvable'): Response {
  switch (reason) {
    case 'own_domain':
      return conflict('competitor_is_own_domain', 'That is your own store.')
    case 'blocklisted':
      return Response.json(
        {
          error: {
            code: 'competitor_on_blocklist',
            message:
              'That looks like a marketplace rather than a competitor. Add it anyway if you meant to.',
          },
        },
        { status: 422 },
      )
    case 'unresolvable':
      return badRequest('competitor_unresolvable', 'We could not find a site at that address.')
    default:
      return badRequest('invalid_body', 'That does not look like a website address.')
  }
}

function serialiseKeyword(row: {
  id: string
  term: string
  volume: number | null
  difficulty: number | null
  source: 'auto' | 'manual'
  enrichedAt: Date | null
}) {
  return {
    id: row.id,
    term: row.term,
    monthlySearchVolume: row.volume,
    difficulty: row.difficulty,
    source: row.source,
    enrichmentState: row.enrichedAt === null ? ('pending' as const) : ('enriched' as const),
  }
}

/**
 * The best-seller list, in the shape `topProductSchema` names.
 *
 * Two of its fields are honestly empty rather than invented: `imageUrl`,
 * because no column stores one (the catalogue sync reads Shopify's `images`
 * field, main §6.2, but nothing here persists it yet), and `pinned`, because
 * `top_products` has no column recording a pin distinct from plain rank —
 * "pin to top" is, today, indistinguishable from a merchant simply dragging a
 * row to position one. Both are flagged in `DECISIONS.md` for the next schema
 * wave rather than guessed at here. `revenueBand` is the same kind of gap:
 * ui §3.7 item 2 asks for a band, not an amount, and no band boundaries are
 * defined anywhere in the specs or `packages/rules` — inventing cutoffs here
 * would be inventing a product decision, so it stays `null`.
 */
function serialiseTopProduct(row: TopProductRow) {
  return {
    id: row.productId,
    title: row.title,
    imageUrl: null,
    source: row.source,
    pinned: false,
    revenueBand: null,
  }
}

/** A family's screen row. `familyGroupingSourceForScreen` carries the note on why four database values become three. */
function serialiseFamily(family: ProfileFamily) {
  return {
    id: family.id,
    label: family.name,
    memberCount: family.memberCount,
    axes: family.differentiationAxes,
    groupingSource: family.groupingSource,
    lowConfidence: family.lowConfidence,
  }
}

async function readJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

function badRequest(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 400 })
}

function conflict(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 409 })
}

function notFound(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 404 })
}
