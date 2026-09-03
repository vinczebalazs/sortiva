/**
 * Where a merchant says they published a downloaded article.
 *
 * This is the one field in the product where a wrong answer does something
 * worse than fail. Search performance is attributed by address: an address on
 * somebody else's site would credit this store with another store's traffic,
 * and every number the merchant then reads about their own results would be
 * borrowed. So the address is checked against the domain this account claimed
 * before it is stored, and the two ways of getting it wrong are told apart,
 * because they need different fixes: a typo, and the right shape on the wrong
 * site.
 *
 * The same check exists in the browser (`packages/ui`), which is where the
 * merchant sees the message. This one is the one that decides.
 */

export type PublishedUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly problem: 'malformed' | 'off_domain' }

/**
 * The claimed domain is stored as eTLD+1, so a blog on a subdomain of it —
 * `blog.example.com` — is the merchant's own site and is accepted. Anything
 * else is not.
 */
export function checkPublishedUrl(raw: string, claimedDomain: string): PublishedUrlCheck {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return { ok: false, problem: 'malformed' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, problem: 'malformed' }
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const claimed = claimedDomain.trim().toLowerCase().replace(/^www\./, '')
  if (claimed === '') return { ok: false, problem: 'off_domain' }
  if (host !== claimed && !host.endsWith(`.${claimed}`)) {
    return { ok: false, problem: 'off_domain' }
  }
  // Stored as the parser normalised it — lower-cased host, punycoded, default
  // port dropped — so that a Search Console page row and an address a merchant
  // typed by hand can be the same string.
  return { ok: true, url: parsed.toString() }
}
