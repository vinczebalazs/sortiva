import { readFileSync, readdirSync } from 'node:fs'
import type { FixtureStore } from '../../fakes/fake-shopify/state.ts'

const dir = new URL('./stores/', import.meta.url)

export const FIXTURE_NAMES = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))

export function fixture(name: string): FixtureStore {
  return JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'))
}

/** A store with `count` plain, factual products, for walking a catalogue across many pages. */
export function largeCatalog(count: number, domain = 'large-catalogue.myshopify.com'): FixtureStore {
  return {
    shop: {
      name: 'Large Catalogue Hardware',
      myshopifyDomain: domain,
      primaryDomainHost: 'large-catalogue.example',
      defaultLocale: 'en',
      country: 'GB',
      ianaTimezone: 'Europe/London',
      currencyCode: 'GBP',
    },
    collections: [{ handle: 'screws', title: 'Screws' }],
    products: Array.from({ length: count }, (_, i) => ({
      handle: `wood-screw-${i + 1}`,
      title: `Wood screw ${3 + (i % 4)} × ${20 + i} mm, box of 100`,
      productType: 'Screw',
      vendor: 'Large Catalogue',
      descriptionHtml: `<p>Zinc-plated steel, countersunk head, Pozidriv drive. Length ${20 + i} mm, gauge ${3 + (i % 4)} mm. 100 per box.</p>`,
      price: { min: `${(4 + i / 100).toFixed(2)}` },
      images: [{ url: `https://cdn.shopify.com/s/files/1/0609/0009/files/screw-${i + 1}.jpg`, width: 1000, height: 1000 }],
      collections: ['screws'],
    })),
  }
}
