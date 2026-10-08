/**
 * Compares two JSON values by structure: the same keys and the same JSON types, recursively.
 * Values are ignored. A null on either side matches anything, and an empty array matches
 * any array, because a fixture store and a real store differ in content, not in form.
 */
export function shapeDifferences(fake: unknown, real: unknown, path = '$'): string[] {
  if (fake === null || real === null || fake === undefined || real === undefined) return []
  const kind = (v: unknown) => (Array.isArray(v) ? 'array' : typeof v)
  if (kind(fake) !== kind(real)) return [`${path}: fake is ${kind(fake)}, real is ${kind(real)}`]
  if (Array.isArray(fake) && Array.isArray(real)) {
    if (!fake.length || !real.length) return []
    return shapeDifferences(fake[0], real[0], `${path}[0]`)
  }
  if (typeof fake === 'object' && typeof real === 'object') {
    const f = fake as Record<string, unknown>
    const r = real as Record<string, unknown>
    const out: string[] = []
    for (const key of new Set([...Object.keys(f), ...Object.keys(r)])) {
      if (!(key in f)) out.push(`${path}.${key}: missing from the fake`)
      else if (!(key in r)) out.push(`${path}.${key}: the fake has it, the real service does not`)
      else out.push(...shapeDifferences(f[key], r[key], `${path}.${key}`))
    }
    return out
  }
  return []
}
