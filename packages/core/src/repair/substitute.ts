/**
 * Finding something to put in the sentence where a withdrawn product used to
 * be.
 *
 * A published article says "the {{p1}} is the one to buy". `p1` is a pointer to
 * a product, not the product's name, so if the store withdraws that product the
 * page can be mended by pointing `p1` somewhere else — no new prose, no model
 * call, nothing a merchant has to read and approve. That is the whole reason
 * the mechanical repair path exists.
 *
 * It only works when the replacement is genuinely alike. A sentence written
 * about a 750 ml insulated steel bottle does not become true by pointing at a
 * plastic 350 ml one that happens to sit in the same family. So a candidate has
 * to carry enough of the same recorded facts before it is allowed to stand in;
 * below that line the repair is a rewrite and goes back through writing and
 * grading, which costs a day and is the right price.
 *
 * Nothing here is a judgement call by a model. The facts compared are the ones
 * distillation already extracted, and the comparison is a share of keys.
 */

/** A product as this comparison needs it: what it is called, whether it can be bought, and what we know about it. */
export interface SubstituteCandidate {
  readonly productId: string
  readonly title: string
  readonly familyId: string | null
  readonly available: boolean
  /** The fact-sheet keys distillation recorded for this product. */
  readonly factKeys: readonly string[]
}

export interface SubstituteChoice {
  readonly productId: string
  readonly title: string
  /** How much of the withdrawn product's fact sheet this one also carries, 0–1. */
  readonly overlap: number
}

/**
 * How much of the gone product's fact sheet a candidate also carries.
 *
 * Measured against the gone product's keys, not against the union: a candidate
 * we happen to know *more* about is not a worse stand-in, and scoring it as one
 * would push every repair towards the products with the thinnest data.
 *
 * A gone product with no recorded facts at all yields nothing rather than
 * everything — we know too little about it to say anything is like it.
 */
export function factOverlap(
  gone: readonly string[],
  candidate: readonly string[],
): number {
  if (gone.length === 0) return 0
  const have = new Set(candidate)
  const shared = gone.filter((key) => have.has(key)).length
  return shared / gone.length
}

/**
 * The best stand-in, or nothing.
 *
 * "Nothing" is a perfectly good answer and the common one on a small
 * catalogue — it routes the repair to a rewrite instead of quietly putting a
 * poor match in front of a reader.
 */
export function pickInFamilyEquivalent(
  gone: Pick<SubstituteCandidate, 'productId' | 'familyId' | 'factKeys'>,
  candidates: readonly SubstituteCandidate[],
  overlapMin: number,
): SubstituteChoice | undefined {
  if (!gone.familyId) return undefined

  const scored = candidates
    .filter(
      (candidate) =>
        candidate.productId !== gone.productId &&
        candidate.familyId === gone.familyId &&
        candidate.available,
    )
    .map((candidate) => ({
      productId: candidate.productId,
      title: candidate.title,
      overlap: factOverlap(gone.factKeys, candidate.factKeys),
    }))
    .filter((candidate) => candidate.overlap >= overlapMin)

  if (scored.length === 0) return undefined

  // Sorted rather than reduced so the answer does not depend on the order the
  // database happened to return rows in: two equally good stand-ins would
  // otherwise make the same repair produce different articles on two runs, and
  // the chaos test's "a restarted worker converges on the same end state"
  // would be false for a reason nobody would ever find.
  scored.sort((a, b) => b.overlap - a.overlap || (a.productId < b.productId ? -1 : 1))
  return scored[0]
}
