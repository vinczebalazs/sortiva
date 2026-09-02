import { ProductsScreen, type FamiliesResponse, type ProductsResponse } from '@sortiva/ui'
import '@sortiva/ui/styles/onboarding.css'
import '@sortiva/ui/styles/products.css'
import { getJson, requestContext } from '../_lib/api'

/**
 * Products — what we know about the catalogue, and the work only the merchant
 * can do.
 *
 * Two reads because the contract has two: the catalogue and its tasks in one,
 * the families in another. They are asked for together rather than in sequence,
 * since neither depends on the other and the page draws in one frame.
 *
 * The onboarding stylesheet is loaded alongside this screen's own because the
 * family list is the confirmation screen's component, reused rather than
 * rebuilt — the spec asks for the same list and the same report modal in both
 * places.
 *
 * A read that failed renders the screen with nothing in it rather than an error
 * page: an empty catalogue reads as "your store is still being read", which is
 * true often enough to beat a failure.
 */

export const dynamic = 'force-dynamic'

const EMPTY: ProductsResponse = {
  richness: { band: 'sparse', productsMissingDetails: 0 },
  counts: { products: 0, families: 0 },
  merchantTasks: [],
  products: [],
  cursor: null,
}

export default async function ProductsPage() {
  const request = await requestContext()
  const [data, families] = await Promise.all([
    getJson<ProductsResponse>('/api/products', request),
    getJson<FamiliesResponse>('/api/products/families', request),
  ])

  return <ProductsScreen data={data ?? EMPTY} families={families ?? { families: [] }} />
}
