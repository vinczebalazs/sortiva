import {
  createLogger,
  countPopulatedFields,
  emptyFactSheet,
  familiesResponseSchema,
  FAMILY_GROUPING_REPORTED_EVENT,
  groupingReportEventProperties,
  mapKeywordToFamilies,
  missingFactFields,
  productsResponseSchema,
  recordGroupingReport,
  reportGroupingRequestSchema,
  richnessBandFor,
  rollUpRichness,
  substanceInventory,
  accountAttribution,
  type FactSheet,
  type Logger,
  type PosthogCapture,
  type RichnessThresholds,
} from '@sortiva/core'
import {
  makeFamilyStore,
  type AccountScope,
  type CatalogProductRow,
  type FamilyStore,
  type OpportunityRow,
  type ProductsStore,
  type ProfileFamily,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * The one thing a merchant can do about a wrong grouping in v1.
 *
 * Families are read-only — no split, no merge, no rename — so this route is the
 * whole of the escape hatch. It accepts, records, and says so; nothing changes
 * about the family, which is what the screen tells the merchant too.
 */

export interface ReportGroupingDeps {
  readonly families: FamilyStore
  readonly log: Logger
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

export function makeReportGroupingHandler(deps: ReportGroupingDeps): AccountHandler {
  return async (request, { scope }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest('invalid_body', 'Send a JSON body naming the family and the reason.')
    }

    const parsed = reportGroupingRequestSchema.safeParse(body)
    if (!parsed.success) {
      return badRequest(
        'invalid_body',
        'A report names the family it is about and says what is wrong with it.',
      )
    }

    // Read through the account scope, so a family id belonging to another
    // merchant answers "not found" rather than confirming that it exists.
    const family = await deps.families.find(scope, parsed.data.familyId)
    if (!family) {
      return Response.json(
        { error: { code: 'family_not_found', message: 'That grouping is gone.' } },
        { status: 404 },
      )
    }

    const report = {
      accountId: scope.accountId,
      familyId: family.id,
      memberCount: family.memberCount,
      groupingSource: family.groupingSource,
      reason: parsed.data.reason,
    }
    recordGroupingReport(deps.log, report)

    // Three facts leave for analytics and the merchant's own words do not: they
    // are prose about their own catalogue, and no event may carry store content.
    deps.capture?.capture({
      event: FAMILY_GROUPING_REPORTED_EVENT,
      attribution: accountAttribution(scope.accountId),
      properties: groupingReportEventProperties(report),
    })

    return Response.json({ ok: true })
  }
}

export function reportGroupingDeps(): ReportGroupingDeps {
  return { families: makeFamilyStore(), log: createLogger({ base: { component: 'products' } }) }
}

function badRequest(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 400 })
}

// ── The Products screen's two reads ──────────────────────────────────────────

/**
 * What we know about a merchant's catalogue, and the work only they can do
 * about it.
 *
 * Everything here is derived from the catalogue as it stands *now* rather than
 * read back from what a scan recorded, and that is the point: a merchant who
 * has just filled in a product's material sees it leave the list on their next
 * visit instead of at the next scan. The alternative would be showing them a
 * chore they have already done.
 */
export interface ProductsDeps {
  readonly store: ProductsStore
}

/**
 * `GET /api/products` — the richness header, the merchant tasks, and the table.
 *
 * A store with no products answers with empty lists and a zeroed header, not an
 * error: nothing has gone wrong, we simply have not read the catalogue yet.
 */
export function makeGetProductsHandler(deps: ProductsDeps): AccountHandler {
  return async (_request, { scope }) => {
    const [catalog, families, open, shopHandle] = await Promise.all([
      deps.store.catalog(scope),
      deps.store.families(scope),
      deps.store.openOpportunities(scope),
      deps.store.shopHandle(scope),
    ])

    const thresholds = substanceThresholds()

    // The same roll-up, over the same inputs, that the confirmation screen and
    // Settings → Store profile already show. Two independent counts of "how
    // much do we know about this store" would eventually disagree, and a
    // merchant told two different things has been told one wrong thing.
    const richness = rollUpRichness(
      catalog
        .filter((row): row is CatalogProductRow & { factSheet: FactSheet } => row.factSheet !== null)
        .map((row) => ({
          populatedFields: countPopulatedFields(row.factSheet),
          factCount: row.factCount,
        })),
      thresholds,
    )

    const merchantTasks = await buildMerchantTasks(deps, scope, {
      open,
      families,
      catalog,
      shopHandle: shopHandleOf(shopHandle),
    })

    return Response.json(
      productsResponseSchema.parse({
        richness: { band: richness.band, productsMissingDetails: richness.productsMissingDetails },
        counts: { products: catalog.length, families: families.length },
        merchantTasks,
        products: catalog.map((row) => serialiseProductRow(row, thresholds)),
        // Nothing is held back, so there is no next page to ask for. The
        // contract declares no query parameter a cursor could be handed back
        // in, and the screen filters the table in the browser — a page would
        // silently hide the very products the sparse filter exists to find.
        cursor: null,
      }),
    )
  }
}

/**
 * `GET /api/products/families` — the read-only family list.
 *
 * Read-only is the whole design, not an unfinished state: grouping decides what
 * a single article is allowed to span, so a merchant splitting or merging
 * families would be editing what the engine may write about. Telling us a
 * grouping is wrong (the sibling `POST .../report`) is the escape hatch.
 */
export function makeGetFamiliesHandler(deps: ProductsDeps): AccountHandler {
  return async (_request, { scope }) => {
    const families = await deps.store.families(scope)
    return Response.json(familiesResponseSchema.parse({ families: families.map(serialiseFamily) }))
  }
}

function substanceThresholds(): RichnessThresholds {
  const floor = rules().defaults.gates.substance_floor
  return {
    populatedFieldsPerProductMin: floor.populated_fields_per_product_min,
    marginMultiple: floor.margin_multiple,
  }
}

/**
 * A product with no fact sheet reads as "we know nothing about this yet" —
 * every field missing, no facts, sparse. Not a claim that the merchant wrote a
 * bad description: distillation may simply not have reached it. The three bands
 * the screen has admit no fourth word for that, and calling an unread product
 * rich would be the worse of the two errors.
 */
function serialiseProductRow(row: CatalogProductRow, thresholds: RichnessThresholds) {
  const sheet = row.factSheet ?? emptyFactSheet()
  return {
    id: row.id,
    title: row.title,
    familyId: row.familyId,
    factCount: row.factCount,
    richnessBand: richnessBandFor(countPopulatedFields(sheet), thresholds),
    missingFields: [...missingFactFields(sheet)],
    lastSyncedAt: row.syncedAt.toISOString(),
  }
}

function serialiseFamily(family: ProfileFamily) {
  return {
    id: family.id,
    label: family.name,
    memberCount: family.memberCount,
    axes: [...family.differentiationAxes],
    groupingSource: family.groupingSource,
    lowConfidence: family.lowConfidence,
  }
}

interface MerchantTaskInputs {
  readonly open: readonly OpportunityRow[]
  readonly families: readonly ProfileFamily[]
  readonly catalog: readonly CatalogProductRow[]
  readonly shopHandle: string | null
}

/**
 * The knowledge gaps, as work.
 *
 * A HOLD is an opportunity we believe in and cannot honestly act on, because
 * the store's own product pages do not say enough. The checklist is recomputed
 * from today's catalogue rather than read back from the scan that raised the
 * hold — the scan stores how *many* products fell short, never which ones — so
 * this repeats the scan's own reasoning: which families the search is about,
 * which of their products fail the substance floor, and what each is missing.
 *
 * Only `catalog_richness_gap` gets a product checklist. It is the one signal
 * that produces a HOLD today, and a future hold about something else would have
 * a different entity behind its reference; inventing a product list for it
 * would be inventing the wrong list rather than showing none.
 */
async function buildMerchantTasks(
  deps: ProductsDeps,
  scope: AccountScope,
  inputs: MerchantTaskInputs,
) {
  const holds = inputs.open.filter((row) => row.recommendedAction === 'hold')
  if (holds.length === 0) return []

  const shopifyIds = new Map(inputs.catalog.map((row) => [row.id, row.shopifyProductId]))
  const mappingFamilies = inputs.families.map((family) => ({
    id: family.id,
    name: family.name,
    differentiationAxes: family.differentiationAxes,
  }))

  const familyIdsPerHold = new Map<string, readonly string[]>()
  for (const hold of holds) {
    familyIdsPerHold.set(
      hold.id,
      hold.signalType === 'catalog_richness_gap'
        ? mapKeywordToFamilies(hold.entityRef, mappingFamilies)
        : [],
    )
  }

  // One read for every family any hold points at, then partitioned in memory:
  // several holds on one store routinely land on the same families, and a query
  // per hold would re-read the same rows.
  const wanted = [...new Set([...familyIdsPerHold.values()].flat())]
  const substance = await deps.store.substanceForFamilies(scope, wanted)
  const byFamily = new Map<string, typeof substance>()
  for (const product of substance) {
    const bucket = byFamily.get(product.familyId) ?? []
    bucket.push(product)
    byFamily.set(product.familyId, bucket)
  }

  const floor = rules().defaults.gates.substance_floor

  return holds.map((hold) => {
    const familyIds = familyIdsPerHold.get(hold.id) ?? []
    const products = familyIds.flatMap((familyId) => byFamily.get(familyId) ?? [])
    const shortfalls =
      products.length === 0 ? [] : substanceInventory(products, floor).shortfalls

    return {
      opportunityId: hold.id,
      // The keyword the hold is about, which is exactly the label the
      // Opportunities screen shows for the same row.
      blockingTitle: hold.entityRef,
      impact: hold.impact,
      products: shortfalls.map((shortfall) => ({
        id: shortfall.productId,
        title: shortfall.title,
        missingFields: [...shortfall.missingFields],
        shopifyAdminUrl: adminUrl(inputs.shopHandle, shopifyIds.get(shortfall.productId)),
      })),
      // Nothing in the product records when a merchant task was finished. A
      // resolved hold leaves as an expiry whose stated reason ("the evidence no
      // longer holds") is also what a keyword losing its volume produces, so
      // reading one as "you completed this" would congratulate merchants for
      // work they never did.
      completedAt: null,
    }
  })
}

/** Shopify stores the connection under the shop's handle; some callers have written the full host. */
function shopHandleOf(stored: string | null): string | null {
  if (!stored) return null
  const handle = stored.trim().toLowerCase().replace(/\.myshopify\.com$/, '')
  return /^[a-z0-9][a-z0-9-]{0,59}$/.test(handle) ? handle : null
}

/**
 * The deep link into the merchant's own admin for one product.
 *
 * Empty when we have no connection to build one from — an export-only store, or
 * one that has never connected. The screen drops a link it cannot recognise as
 * a Shopify admin address and renders the product as a plain row, which is the
 * right outcome: there is nowhere honest to send them.
 */
function adminUrl(shopHandle: string | null, shopifyProductId: string | undefined): string {
  if (!shopHandle || !shopifyProductId || !/^\d+$/.test(shopifyProductId)) return ''
  return `https://admin.shopify.com/store/${shopHandle}/products/${shopifyProductId}`
}
