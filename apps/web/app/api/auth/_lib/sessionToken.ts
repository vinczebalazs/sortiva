import { createHash } from 'node:crypto'

/**
 * What we store in place of the value the browser holds.
 *
 * The browser's cookie is the credential: anything that can present it is signed
 * in. Storing that value verbatim would mean a leaked copy of the `sessions`
 * table — a backup on a laptop, a support export, a read-only replica somebody
 * has a connection string for — is a set of working sessions for every merchant
 * signed in at that moment. Storing a digest makes it a set of useless strings:
 * a digest cannot be turned back into the cookie it came from, and presenting
 * the digest itself matches nothing, because the lookup hashes what it is given
 * before it compares.
 *
 * Plain SHA-256, with no salt and no stretching, and that is deliberate. The
 * slow, salted hashes exist because passwords are short, guessable and reused;
 * this input is a 128-bit random value the library generates and nobody ever
 * types, so there is nothing to guess and no other site to reuse it on. A slow
 * hash here would only spend that cost on every signed-in request, which is the
 * one place this product cannot afford it.
 */
export function sessionTokenDigest(sessionToken: string): string {
  return createHash('sha256').update(sessionToken, 'utf8').digest('hex')
}
