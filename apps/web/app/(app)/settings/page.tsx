import { redirect } from 'next/navigation'

/** `/settings` has no content of its own; Publishing is first in the sub-nav. */
export default function SettingsIndexPage() {
  redirect('/settings/publishing')
}
