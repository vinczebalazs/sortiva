import { InvalidClaimDomain, normaliseClaimDomain } from '../domain/normalise'
import { isBlocklistedDomain } from './blocklist'

/**
 * What has to be true before a domain a merchant typed becomes one of their
 * five competitors, and what has to be true before a term they typed becomes
 * one of their keywords.
 *
 * Pure functions over strings. The cap is not checked here on purpose: it is a
 * fact about the account's rows, it is enforced by the database as well as by
 * us, and a validator that also counted would be a third place the number
 * lives.
 */

export type CompetitorRejection =
  /** Not a web address at all. */
  | { readonly reason: 'invalid'; readonly detail: string }
  /** The merchant's own store. Comparing a shop to itself is not a competitor. */
  | { readonly reason: 'own_domain' }
  /** A marketplace or a reference site. Refused *unless* the merchant says so deliberately. */
  | { readonly reason: 'blocklisted' }
  /** No DNS record. A typo, or a domain that no longer exists. */
  | { readonly reason: 'unresolvable' }

export type CompetitorValidation =
  | { readonly ok: true; readonly domain: string }
  | { readonly ok: false; readonly rejected: CompetitorRejection }

export interface ValidateCompetitorInput {
  readonly domain: string
  /** The store's own claimed domain, normalised. */
  readonly ownDomain: string
  /**
   * The merchant clicked "add anyway" on the marketplace warning. It waives the
   * blocklist and nothing else — a typo is still a typo and their own domain is
   * still their own domain.
   */
  readonly overrideBlocklist?: boolean
  /**
   * Whether the domain has a DNS record. Undefined means nobody looked, which
   * is treated as "no reason to refuse": the check is a courtesy against typos,
   * and a resolver having a bad second must not stand between a merchant and
   * their own competitor list.
   */
  readonly resolves?: boolean
}

/**
 * Normalised through exactly the same function as a claimed domain, so a
 * merchant who types `https://WWW.Rival.co.uk/shop` and one who types
 * `rival.co.uk` produce one row, and so the own-domain comparison is between
 * two values computed the same way rather than between two spellings.
 */
export function validateCompetitorDomain(input: ValidateCompetitorInput): CompetitorValidation {
  let domain: string
  try {
    domain = normaliseClaimDomain(input.domain).normalized
  } catch (error) {
    return {
      ok: false,
      rejected: {
        reason: 'invalid',
        detail: error instanceof InvalidClaimDomain ? error.reason : 'it is not a web address',
      },
    }
  }

  if (domain === input.ownDomain.trim().toLowerCase()) {
    return { ok: false, rejected: { reason: 'own_domain' } }
  }

  if (input.resolves === false) {
    return { ok: false, rejected: { reason: 'unresolvable' } }
  }

  if (!input.overrideBlocklist && isBlocklistedDomain(domain)) {
    return { ok: false, rejected: { reason: 'blocklisted' } }
  }

  return { ok: true, domain }
}

/** The longest search term we will store. Past this it is a sentence, and no vendor prices sentences. */
export const KEYWORD_MAX_LENGTH = 120

export type KeywordValidation =
  | { readonly ok: true; readonly term: string }
  | { readonly ok: false; readonly reason: 'empty' | 'too_long' }

/**
 * Search terms are stored lower-cased with their whitespace collapsed, because
 * that is the form the vendor is asked about and the form its answers come back
 * keyed on. Storing "Running Shoes" and asking about "running shoes" would make
 * the metrics we bought unattachable to the row we bought them for.
 */
export function validateKeywordTerm(input: string): KeywordValidation {
  const term = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (term === '') return { ok: false, reason: 'empty' }
  if (term.length > KEYWORD_MAX_LENGTH) return { ok: false, reason: 'too_long' }
  return { ok: true, term }
}
