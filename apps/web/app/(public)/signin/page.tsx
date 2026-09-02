import { SignIn } from '@sortiva/ui'

/**
 * Signing in and signing up are the same act — an account is created the first
 * time somebody arrives — so there is one screen rather than two.
 *
 * A visitor who came from the landing preview brings the address they typed
 * along in the link. It is carried forward only as a suggestion for the connect
 * step: a domain claim is exclusive, and one made on somebody's behalf could
 * lock a business out of its own address.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const domain = typeof params.domain === 'string' ? params.domain : null
  const next = typeof params.next === 'string' && params.next.startsWith('/') ? params.next : '/plan'

  return (
    <main className="sortiva-narrow">
      <SignIn previewedDomain={domain} next={next} />
    </main>
  )
}
