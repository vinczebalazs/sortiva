import { describe, expect, it } from 'vitest'
import { emptyFactSheet } from '../distill/schema'
import { attributeSimilarity, parseKeyedTag, productAttributes } from './attributes'
import { differentiationAxes, participatesInSimilarity } from './cluster'
import { clusterByTitleWords, fallbackWarranted } from './fallback'
import { shoeStoreFixture, untypedShoeStoreFixture } from './fixture'
import { groupProducts, assignToExistingFamily, type GroupingInput } from './group'
import { detectLogicalProducts, stripVariantTokens } from './splitVariants'
import { isPromoTaxonomyName, taxonomyKeyFor } from './taxonomy'

/** The substance floor from `packages/rules`, as the job hands it down. */
const OPTIONS = { populatedFieldsPerProductMin: 4 }

function product(overrides: Partial<GroupingInput> & { productId: string }): GroupingInput {
  return {
    title: 'Product',
    factSheet: emptyFactSheet(),
    populatedFields: 6,
    ...overrides,
  }
}

describe('attribute names', () => {
  it('reads an axis name out of a merchant tag written as a key and a value', () => {
    expect(parseKeyedTag('terrain:technical')).toEqual({ name: 'terrain', value: 'technical' })
    expect(parseKeyedTag('Width = Wide')).toEqual({ name: 'width', value: 'wide' })
  })

  it('names no axis for a bare tag, because "sale" is not an attribute', () => {
    expect(parseKeyedTag('sale')).toBeUndefined()
    expect(parseKeyedTag(':wide')).toBeUndefined()
    expect(parseKeyedTag('width:')).toBeUndefined()
  })

  it("prefers the merchant's own word to ours when both name the same attribute", () => {
    const attributes = productAttributes({
      productId: 'p1',
      title: 'Boot',
      factSheet: { ...emptyFactSheet(), material: 'suede' },
      populatedFields: 4,
      tags: ['material:full-grain leather'],
    })
    expect(attributes.attributes.get('material')).toEqual(['full-grain leather'])
    expect(attributes.sources.get('material')).toBe('tag')
  })

  it('reads two products stating nothing as unknown rather than as the same product', () => {
    const bare = (id: string) =>
      productAttributes({
        productId: id,
        title: id,
        factSheet: emptyFactSheet(),
        populatedFields: 0,
      })
    expect(attributeSimilarity(bare('a'), bare('b'))).toEqual({
      nameOverlap: 0,
      valueAgreement: 0,
      differingNames: [],
    })
  })
})

describe("the store's own option definitions", () => {
  it('names an axis the merchant chose, with every value they offer', () => {
    const attributes = productAttributes({
      productId: 'p1',
      title: 'Trail Shoe',
      factSheet: emptyFactSheet(),
      populatedFields: 4,
      options: [{ name: 'Terrain', values: ['Trail', 'Road'] }],
    })
    expect(attributes.attributes.get('terrain')).toEqual(['road', 'trail'])
    expect(attributes.sources.get('terrain')).toBe('product_option')
  })

  it('wins the name over a tag and over the sheet, being the only one nothing inferred', () => {
    const attributes = productAttributes({
      productId: 'p1',
      title: 'Boot',
      factSheet: { ...emptyFactSheet(), material: 'suede' },
      populatedFields: 4,
      tags: ['material:full-grain leather'],
      options: [{ name: 'Material', values: ['Nubuck'] }],
    })
    expect(attributes.attributes.get('material')).toEqual(['nubuck'])
    expect(attributes.sources.get('material')).toBe('product_option')
  })

  it('ignores the option Shopify invents for a product with nothing to choose', () => {
    // Left in, every product in every store would carry one attribute they all
    // share and agree on, and two unrelated products would look identical.
    const bare = (id: string) =>
      productAttributes({
        productId: id,
        title: id,
        factSheet: emptyFactSheet(),
        populatedFields: 0,
        options: [{ name: 'Title', values: ['Default Title'] }],
      })
    expect(bare('a').attributes.size).toBe(0)
    expect(attributeSimilarity(bare('a'), bare('b')).nameOverlap).toBe(0)
  })

  it('still merges split variants that differ on an option, which is the whole premise', () => {
    const shoe = (id: string, colour: string) =>
      productAttributes({
        productId: id,
        title: `Trailblazer Shoe — ${colour}`,
        factSheet: { ...emptyFactSheet(), material: 'mesh', care: 'wipe clean', origin: 'vietnam' },
        populatedFields: 5,
        options: [{ name: 'Colour', values: [colour] }],
      })
    const groups = detectLogicalProducts([shoe('p1', 'Red'), shoe('p2', 'Blue')])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.memberIds).toEqual(['p1', 'p2'])
  })

  it('becomes a differentiation axis for a family whose members offer different values', () => {
    const shoe = (id: string, terrain: string) =>
      productAttributes({
        productId: id,
        title: `Shoe ${id}`,
        factSheet: { ...emptyFactSheet(), material: 'mesh' },
        populatedFields: 5,
        options: [{ name: 'Terrain', values: [terrain] }],
      })
    const { axes, sources } = differentiationAxes([
      shoe('a', 'Trail'),
      shoe('b', 'Road'),
      shoe('c', 'Fell'),
    ])
    expect(axes).toContain('terrain')
    expect(sources['terrain']).toBe('product_option')
  })
})

describe('the promo blocklist', () => {
  it('rejects a name that is only about when we are selling something', () => {
    for (const name of ['Summer Sale', 'New Arrivals', 'Featured', 'Best Sellers', 'All Products']) {
      expect(isPromoTaxonomyName(name)).toBe(true)
    }
  })

  it('keeps a name that still says what the products are', () => {
    for (const name of ['Trail Running Shoes', 'Summer Dresses', 'Gift Wrap', 'Wholesale Boots']) {
      expect(isPromoTaxonomyName(name)).toBe(false)
    }
  })

  it('groups nothing on a blocklisted taxonomy name', () => {
    expect(taxonomyKeyFor({ productType: 'Summer Sale' })).toBeNull()
    expect(taxonomyKeyFor({ productType: 'Trail Running Shoes' })).toBe('trail running shoes')
  })
})

describe('split-variant detection', () => {
  it('strips the variant words out of a title and names what it stripped', () => {
    const stripped = stripVariantTokens('Trailblazer Shoe — Red')
    expect(stripped.residual).toBe('trailblazer shoe')
    expect(stripped.tokens).toEqual([{ name: 'color', value: 'red', source: 'variant_token' }])
  })

  it('leaves a fragment alone when only part of it is a variant word', () => {
    // "Red Rock" is a product name, not a red Rock.
    expect(stripVariantTokens('Red Rock Sandal').residual).toBe('red rock sandal')
  })

  it('merges rows that are one product published four times', () => {
    const shoe = (id: string, color: string) =>
      productAttributes({
        productId: id,
        title: `Trailblazer Shoe — ${color}`,
        factSheet: { ...emptyFactSheet(), material: 'mesh', care: 'wipe clean', origin: 'vietnam' },
        populatedFields: 5,
      })
    const groups = detectLogicalProducts([
      shoe('p1', 'Red'),
      shoe('p2', 'Blue'),
      shoe('p3', 'Green'),
      shoe('p4', 'Black'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.memberIds).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(groups[0]?.axes).toEqual(['color'])
  })

  it('refuses the merge when the titles collide but the fact sheets do not', () => {
    const groups = detectLogicalProducts([
      productAttributes({
        productId: 'p1',
        title: 'Trailblazer 2 — Red',
        factSheet: { ...emptyFactSheet(), material: 'mesh', care: 'wipe clean', origin: 'vietnam' },
        populatedFields: 5,
      }),
      productAttributes({
        productId: 'p2',
        title: 'Trailblazer 2 — Leather',
        factSheet: {
          ...emptyFactSheet(),
          material: 'full-grain leather',
          care: 'wax annually',
          origin: 'portugal',
        },
        populatedFields: 5,
      }),
    ])
    expect(groups.map((group) => group.memberIds)).toEqual([['p1'], ['p2']])
  })
})

describe('the sparse-product guardrail', () => {
  const sparse = product({
    productId: 'sparse',
    title: 'Mystery Item',
    factSheet: { ...emptyFactSheet(), material: 'mesh' },
    populatedFields: 1,
  })

  it('keeps a product below the substance floor out of similarity merging', () => {
    expect(
      participatesInSimilarity(
        productAttributes({ ...sparse, factSheet: sparse.factSheet, populatedFields: 1 }),
        OPTIONS,
      ),
    ).toBe(false)
  })

  it('leaves a sparse product a family of one even where a rich family would take it', () => {
    const rich = (id: string, terrain: string) =>
      product({
        productId: id,
        title: `Trailhead ${id}`,
        tags: [`terrain:${terrain}`, 'width:standard'],
        factSheet: { ...emptyFactSheet(), material: 'mesh', care: 'wipe clean', origin: 'vietnam' },
        populatedFields: 5,
      })

    const plan = groupProducts([rich('a', 'technical'), rich('b', 'mixed'), rich('c', 'fire road'), sparse], OPTIONS)
    const home = plan.families.find((family) => family.memberProductIds.includes('sparse'))
    expect(home?.memberProductIds).toEqual(['sparse'])
  })

  it('still lets the merchant place a sparse product, because that is a statement rather than a guess', () => {
    const typed = { ...sparse, productType: 'Trail Running Shoes' }
    const plan = groupProducts(
      [
        typed,
        product({ productId: 'p1', title: 'Trailhead 1', productType: 'Trail Running Shoes' }),
        product({ productId: 'p2', title: 'Trailhead 2', productType: 'Trail Running Shoes' }),
      ],
      OPTIONS,
    )
    const home = plan.families.find((family) => family.memberProductIds.includes('sparse'))
    expect(home?.groupingSource).toBe('collection')
    expect(home?.memberProductIds).toHaveLength(3)
  })
})

describe('forty shoes', () => {
  const plan = groupProducts(shoeStoreFixture(), OPTIONS)

  it('is forty products', () => {
    expect(shoeStoreFixture()).toHaveLength(40)
  })

  it('becomes between four and six families', () => {
    expect(plan.families.length).toBeGreaterThanOrEqual(4)
    expect(plan.families.length).toBeLessThanOrEqual(6)
  })

  it("records the merchant's own words as the trail family's axes", () => {
    const trail = plan.families.find((family) => family.name === 'Trail Running Shoes')
    expect(trail).toBeDefined()
    expect([...trail!.axes].sort()).toEqual(['drop', 'terrain', 'width'])
  })

  it('carries the axis values a comparison would be built from', () => {
    const trail = plan.families.find((family) => family.name === 'Trail Running Shoes')!
    expect(trail.mergedFacts.axisValues['terrain']).toEqual(['fire road', 'mixed', 'technical'])
    expect(trail.mergedFacts.axisValues['width']).toEqual(['standard', 'wide'])
  })

  it('keeps what the whole family agrees on out of its axes', () => {
    const trail = plan.families.find((family) => family.name === 'Trail Running Shoes')!
    expect(trail.mergedFacts.shared['material']).toEqual(['engineered mesh'])
    expect(trail.axes).not.toContain('material')
  })

  it('records provenance and a confidence band for every family', () => {
    for (const family of plan.families) {
      expect(family.groupingSource).toBeTruthy()
      expect(['low', 'medium', 'high']).toContain(family.confidence)
    }
    expect(plan.families.every((family) => family.groupingSource === 'collection')).toBe(true)
    expect(plan.families.every((family) => family.confidence === 'high')).toBe(true)
  })

  it('places every product exactly once', () => {
    const placed = plan.families.flatMap((family) => family.memberProductIds)
    expect(placed).toHaveLength(40)
    expect(new Set(placed).size).toBe(40)
  })

  it('produces the same families whatever order the rows arrive in', () => {
    const shuffled = [...shoeStoreFixture()].reverse()
    const again = groupProducts(shuffled, OPTIONS)
    expect(again.families.map((family) => family.name)).toEqual(
      plan.families.map((family) => family.name),
    )
    expect(again.families.map((family) => family.axes)).toEqual(
      plan.families.map((family) => family.axes),
    )
  })

  it('counts the substance behind each family, which is what the gate later reads', () => {
    const trail = plan.families.find((family) => family.name === 'Trail Running Shoes')!
    expect(trail.mergedFacts.contributingProducts).toBe(12)
    expect(trail.mergedFacts.distinctFacts).toBeGreaterThan(0)
  })
})

describe('a store with no taxonomy at all', () => {
  it('still groups, and says so with a weaker signal', () => {
    const plan = groupProducts(untypedShoeStoreFixture(), OPTIONS)
    expect(plan.families.every((family) => family.groupingSource !== 'collection')).toBe(true)
    expect(plan.families.length).toBeLessThan(40)
  })

  it("names its axes in the fact sheet's vocabulary, having none of the merchant's", () => {
    const plan = groupProducts(untypedShoeStoreFixture(), OPTIONS)
    const axes = new Set(plan.families.flatMap((family) => family.axes))
    // No `terrain`, `drop` or `width`: those names were the merchant's tags,
    // and this store has none. What is left is what our own sheet can name.
    expect(axes.has('terrain')).toBe(false)
    expect(axes.has('width')).toBe(false)
    for (const axis of axes) {
      expect(['material', 'care', 'origin']).toContain(axis)
    }
  })
})

describe('the last-resort fallback', () => {
  it('is not reached when most of the store grouped cleanly', () => {
    expect(fallbackWarranted(2, 40)).toBe(false)
    expect(fallbackWarranted(30, 40)).toBe(true)
  })

  it('groups on the words the titles share', () => {
    const bare = (id: string, title: string) =>
      productAttributes({ productId: id, title, factSheet: emptyFactSheet(), populatedFields: 0 })
    const clusters = clusterByTitleWords([
      bare('a', 'Ridgeline Trail Shoe'),
      bare('b', 'Trailblazer Trail Shoe'),
      bare('c', 'Harbour Wool Scarf'),
    ])
    expect(clusters.map((cluster) => cluster.map((member) => member.productId))).toEqual([
      ['a', 'b'],
      ['c'],
    ])
  })

  it('flags what it produced as low confidence and names the method it really used', () => {
    const bare = (id: string, title: string) =>
      product({ productId: id, title, factSheet: emptyFactSheet(), populatedFields: 0 })
    const plan = groupProducts(
      [
        bare('a', 'Ridgeline Trail Shoe'),
        bare('b', 'Trailblazer Trail Shoe'),
        bare('c', 'Ridgeline Trail Boot'),
      ],
      OPTIONS,
    )
    const grouped = plan.families.filter((family) => family.memberProductIds.length > 1)
    expect(grouped.length).toBeGreaterThan(0)
    for (const family of grouped) {
      expect(family.groupingSource).toBe('embedding')
      expect(family.confidence).toBe('low')
      expect(family.mergedFacts.method).toBe('title_tokens')
    }
  })
})

describe('one edited product', () => {
  const members = shoeStoreFixture()
    .slice(0, 3)
    .map((input) =>
      productAttributes({
        productId: input.productId,
        title: input.title,
        factSheet: input.factSheet,
        populatedFields: input.populatedFields,
        ...(input.tags ? { tags: input.tags } : {}),
        taxonomyKey: 'trail running shoes',
      }),
    )

  it('lands in the family the merchant filed it under, without regrouping the store', () => {
    const home = assignToExistingFamily(
      product({
        productId: 'new',
        title: 'Trailhead 13',
        productType: 'Trail Running Shoes',
        tags: ['terrain:mixed', 'drop:6mm', 'width:wide'],
      }),
      [{ name: 'Trail Running Shoes', members }],
      OPTIONS,
    )
    expect(home).toBe('Trail Running Shoes')
  })

  it('asks for a full regroup rather than guessing when nothing fits', () => {
    const home = assignToExistingFamily(
      product({ productId: 'new', title: 'Mystery', populatedFields: 0 }),
      [{ name: 'Trail Running Shoes', members }],
      OPTIONS,
    )
    expect(home).toBeUndefined()
  })
})

describe('axes', () => {
  it('are not claimed on a family too small to have any', () => {
    const two = [
      productAttributes({
        productId: 'a',
        title: 'A',
        factSheet: emptyFactSheet(),
        populatedFields: 5,
        tags: ['terrain:technical'],
      }),
      productAttributes({
        productId: 'b',
        title: 'B',
        factSheet: emptyFactSheet(),
        populatedFields: 5,
        tags: ['terrain:mixed'],
      }),
    ]
    expect(differentiationAxes(two).axes).toEqual([])
  })
})
