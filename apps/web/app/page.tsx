import { t } from '@sortiva/ui'

// A placeholder until the landing page is built. Its one word comes from the
// string catalogue like every other, so the rule that keeps copy out of
// components has no exceptions to explain.
export default function Home() {
  return <main>{t('nav.brand')}</main>
}
