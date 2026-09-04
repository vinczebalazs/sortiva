import {
  axesFromSections,
  outOfStockLongEnough,
  type DriftObservation,
  type DriftedReference,
} from '@sortiva/core'
import type { FamilyAxesRow, ReferencedProductRow } from '@sortiva/db'

/**
 * Reading a store's own rows as "these published articles have stopped being
 * true".
 *
 * Deliberately a function of what was read rather than a thing that reads: the
 * awkward part of drift is the judgement, not the queries, and a judgement with
 * no database under it can be tested against a dozen fixtures in milliseconds.
 */

export interface DriftInputs {
  readonly accountId: string
  /** Every product mention in every published article. */
  readonly references: readonly ReferencedProductRow[]
  /** Shopify ids the store has told us are gone. */
  readonly deletedShopifyIds: ReadonlySet<string>
  /** When each product's stock last moved, by Shopify id. */
  readonly stockMovedAt: ReadonlyMap<string, Date>
  /** What each range currently differs by. */
  readonly familyAxes: readonly FamilyAxesRow[]
  readonly outOfStockDaysMin: number
  readonly now: Date
}

/** Whether anyone can currently buy any version of this product. */
export function anyVariantAvailable(variants: unknown): boolean {
  if (!Array.isArray(variants)) return false
  return variants.some(
    (variant) =>
      variant !== null &&
      typeof variant === 'object' &&
      (variant as { available?: unknown }).available === true,
  )
}

/** The section headings a stored article body carries, wherever the writer put them. */
export function sectionHeadingsOf(body: unknown): readonly string[] {
  if (!body || typeof body !== 'object') return []
  const sections = (body as { sections?: unknown }).sections
  if (!Array.isArray(sections)) return []
  return sections
    .map((section) =>
      section && typeof section === 'object'
        ? (section as { heading?: unknown }).heading
        : undefined,
    )
    .filter((heading): heading is string => typeof heading === 'string')
}

function referenceOf(row: ReferencedProductRow): DriftedReference {
  return {
    placeholderKey: row.placeholderKey,
    productId: row.productId,
    productTitle: row.productTitle ?? row.placeholderKey,
    refType: row.refType,
  }
}

/**
 * One observation per article per kind of thing that went wrong.
 *
 * Grouped that way rather than one per broken product because the repair, the
 * card the merchant reads and the record of what changed are all per article —
 * a guide whose three recommendations were all withdrawn is one problem with
 * one page, not three.
 */
export function detectDrift(inputs: DriftInputs): readonly DriftObservation[] {
  const byArticle = new Map<string, ReferencedProductRow[]>()
  for (const row of inputs.references) {
    const list = byArticle.get(row.articleId) ?? []
    list.push(row)
    byArticle.set(row.articleId, list)
  }

  const axesByFamily = new Map(inputs.familyAxes.map((row) => [row.familyId, row.differentiationAxes]))
  const observations: DriftObservation[] = []

  for (const [articleId, rows] of byArticle) {
    const first = rows[0]!
    const shared = {
      accountId: inputs.accountId,
      articleId,
      articleTitle: first.articleTitle,
    }

    const gone = rows.filter(
      (row) => row.shopifyProductId !== null && inputs.deletedShopifyIds.has(row.shopifyProductId),
    )
    if (gone.length > 0) {
      observations.push({
        ...shared,
        kind: 'product_deleted',
        references: gone.map(referenceOf),
        occurredAt: inputs.now.toISOString(),
      })
    }

    // A product that has gone is already covered above, and covering it twice
    // would hand the merchant two cards about the same sentence.
    const stale = rows.filter((row) => {
      if (!row.shopifyProductId || inputs.deletedShopifyIds.has(row.shopifyProductId)) return false
      if (anyVariantAvailable(row.variants)) return false
      return outOfStockLongEnough(
        inputs.stockMovedAt.get(row.shopifyProductId) ?? null,
        inputs.now,
        inputs.outOfStockDaysMin,
      )
    })
    if (stale.length > 0) {
      observations.push({
        ...shared,
        kind: 'product_out_of_stock',
        references: stale.map(referenceOf),
        occurredAt: (
          stale
            .map((row) => inputs.stockMovedAt.get(row.shopifyProductId!))
            .filter((at): at is Date => at !== undefined)
            .sort((a, b) => a.getTime() - b.getTime())[0] ?? inputs.now
        ).toISOString(),
      })
    }

    const writtenWith = axesFromSections(sectionHeadingsOf(first.articleBody))
    if (writtenWith.length > 0) {
      const nowIs = [
        ...new Set(
          rows
            .map((row) => row.familyId)
            .filter((id): id is string => id !== null)
            .flatMap((id) => [...(axesByFamily.get(id) ?? [])]),
        ),
      ]
      // Only a range we can currently see counts. An article whose families
      // have all been deleted has a different problem, and inventing an
      // "everything moved" verdict out of an empty list would rewrite it for
      // the wrong reason.
      if (nowIs.length > 0 && !sameAxes(writtenWith, nowIs)) {
        observations.push({
          ...shared,
          kind: 'family_axes_changed',
          references: [],
          occurredAt: inputs.now.toISOString(),
          axes: { writtenWith, nowIs },
        })
      }
    }
  }

  return observations
}

/** Order is a writing decision, not a difference in what the range is. */
function sameAxes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((value, index) => value === right[index])
}
