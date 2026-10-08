import { redirect, type LoaderFunctionArgs } from 'react-router'

// Shopify opens the app URL with shop, host and locale in the query; keep them for the embedded page.
export const loader = ({ request }: LoaderFunctionArgs) => redirect(`/app${new URL(request.url).search}`)
