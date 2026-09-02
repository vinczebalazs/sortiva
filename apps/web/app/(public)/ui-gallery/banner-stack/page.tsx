import { notFound } from 'next/navigation'
import { BannerStackPreview } from '@sortiva/ui/shell/BannerStack.preview'
import '@sortiva/ui/tokens.css'
import '@sortiva/ui/styles/shell.css'

/**
 * The shell's components in every state they have, on one page, for looking at.
 * It is not part of the product: outside development the route does not exist.
 */
export const dynamic = 'force-dynamic'

export default function BannerStackGalleryPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <BannerStackPreview />
}
