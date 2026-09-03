/**
 * Slug generation — main §9.2: "stable once published; refreshes never
 * change a live slug." Code-generated from the target keyword rather than
 * left to the model, so it is deterministic and can be checked for
 * uniqueness before the draft is written.
 */

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Appends `-2`, `-3`, ... only if the plain slug collides with one this account already has. */
export function stableSlug(targetKeyword: string, existingSlugs: ReadonlySet<string>): string {
  const base = slugify(targetKeyword) || 'article'
  if (!existingSlugs.has(base)) return base
  let n = 2
  while (existingSlugs.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}
