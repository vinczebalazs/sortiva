import { emptyFactSheet, type FactSheet } from '../distill/schema'
import type { GroupingInput } from './group'

/**
 * A shoe shop, as a store that has actually been read looks by the time
 * grouping sees it: forty products, four kinds of shoe, described the way real
 * merchants describe them.
 *
 * The point of the fixture is the axis names. `terrain`, `drop` and `width` are
 * not words this codebase knows — they are this merchant's words, carried in
 * their own tags (`terrain:technical`), and grouping recovers them because the
 * merchant wrote them, not because anything here has a list of shoe attributes.
 * A store that names its attributes differently gets its own names back; a
 * store that names none gets the fact sheet's field names instead.
 */

const TRAIL = {
  terrain: ['technical', 'fire road', 'mixed'],
  drop: ['4mm', '6mm', '8mm'],
  width: ['standard', 'wide'],
}

const ROAD = {
  cushioning: ['max', 'balanced', 'firm'],
  drop: ['6mm', '10mm'],
  width: ['standard', 'wide'],
}

const HIKING = {
  waterproofing: ['gore-tex', 'dwr', 'none'],
  ankle_height: ['mid', 'high'],
  width: ['standard', 'wide'],
}

const APPAREL = {
  weather: ['wet', 'cold', 'mild'],
  fit: ['relaxed', 'athletic'],
}

interface FamilySpec {
  readonly type: string
  readonly label: string
  readonly count: number
  readonly axes: Readonly<Record<string, readonly string[]>>
  readonly shared: Partial<FactSheet>
}

const FAMILIES: readonly FamilySpec[] = [
  {
    type: 'Trail Running Shoes',
    label: 'Trailhead',
    count: 12,
    axes: TRAIL,
    shared: { material: 'engineered mesh', care: 'brush clean, air dry', origin: 'vietnam' },
  },
  {
    type: 'Road Running Shoes',
    label: 'Tempo',
    count: 10,
    axes: ROAD,
    shared: { material: 'engineered mesh', care: 'machine wash cold', origin: 'vietnam' },
  },
  {
    type: 'Hiking Boots',
    label: 'Ridgeline',
    count: 9,
    axes: HIKING,
    shared: { material: 'full-grain leather', care: 'wipe clean, wax annually', origin: 'portugal' },
  },
  {
    type: 'Trail Apparel',
    label: 'Summit',
    count: 9,
    axes: APPAREL,
    shared: { material: 'recycled ripstop nylon', care: 'machine wash cold', origin: 'portugal' },
  },
]

/** Forty products across four kinds of shoe, deterministic and in a fixed order. */
export function shoeStoreFixture(): readonly GroupingInput[] {
  const products: GroupingInput[] = []
  let index = 0

  for (const family of FAMILIES) {
    const axisNames = Object.keys(family.axes)
    for (let member = 0; member < family.count; member += 1) {
      index += 1
      const tags = axisNames.map((axis) => {
        const values = family.axes[axis]!
        return `${axis}:${values[member % values.length]!}`
      })
      products.push({
        productId: `p-${String(index).padStart(3, '0')}`,
        title: `${family.label} ${member + 1}`,
        productType: family.type,
        tags: [...tags, 'ss26'],
        factSheet: { ...emptyFactSheet(), ...family.shared, fact_count: 3 },
        populatedFields: 3 + axisNames.length,
      })
    }
  }

  return products
}

/**
 * The same shop with its taxonomy taken away — no `product_type`, and tags that
 * say only when a thing went on sale. This is what a messy store looks like and
 * what the weaker signals have to work from.
 */
export function untypedShoeStoreFixture(): readonly GroupingInput[] {
  return shoeStoreFixture().map((product) => ({
    ...product,
    productType: null,
    tags: ['ss26'],
  }))
}
