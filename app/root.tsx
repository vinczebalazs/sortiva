import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import tokens from './ui/tokens.css?url'

export const links = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' as const },
  { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap' },
  { rel: 'stylesheet', href: tokens },
]

export const loader = ({ request }: LoaderFunctionArgs) => {
  const embedded = new URL(request.url).pathname.startsWith('/app')
  return { embedded, apiKey: embedded ? (process.env.SHOPIFY_CLIENT_ID ?? '') : '' }
}

export default function Root() {
  const { embedded, apiKey } = useLoaderData<typeof loader>()
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {embedded && <meta name="shopify-api-key" content={apiKey} />}
        {embedded && <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />}
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}
