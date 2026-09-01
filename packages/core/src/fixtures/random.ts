/**
 * A seeded PRNG, because every fixture in this directory must be deterministic:
 * the eight worked-example scenarios are *acceptance* fixtures, and an
 * acceptance test
 * whose input differs between runs cannot fail for a reason you can act on.
 *
 * mulberry32 — small, fast, and stable across Node versions, which
 * `Math.random()` is explicitly not.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() needs a non-empty list')
  return items[Math.floor(random() * items.length)]!
}

export function intBetween(random: () => number, min: number, max: number): number {
  return Math.floor(min + random() * (max - min + 1))
}

/** Rounded to one decimal, matching how GSC reports average position. */
export function positionAround(random: () => number, centre: number, spread: number): number {
  return Math.round((centre + (random() - 0.5) * 2 * spread) * 10) / 10
}
