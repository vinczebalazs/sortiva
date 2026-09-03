import type { EvidencePackProduct } from './evidence-pack'

/**
 * Images: main §9.2, "product images from the catalog only... alt text
 * generated from the fact sheet. No AI image generation for now." This
 * module reads catalog URLs and nothing else — there is deliberately no
 * import here of any generative-image vendor SDK or image-proxying service,
 * and a grep test in this package's own test suite asserts that stays true.
 *
 * `EvidencePackProduct.images` is empty for every product today: `products`
 * has nowhere to persist a Shopify image URL (no column, no separate table —
 * see this card's session report). This function is still written against
 * the shape the pack will carry once that lands, so nothing here has to
 * change when it does.
 */

export interface CatalogImage {
  readonly url: string
  readonly alt: string
  readonly productId: string
}

function altTextFor(product: EvidencePackProduct): string {
  const material = product.factSheet.material
  return material ? `${product.title} — ${material}` : product.title
}

export function catalogImagesFor(products: readonly EvidencePackProduct[]): readonly CatalogImage[] {
  const images: CatalogImage[] = []
  for (const product of products) {
    for (const image of product.images) {
      images.push({ url: image.url, alt: altTextFor(product), productId: product.productId })
    }
  }
  return images
}
