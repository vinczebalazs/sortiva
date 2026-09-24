import type { DeliveryMode } from '../content/types'

/**
 * What the Settings screens read. Hand-written here rather than derived from
 * the API's zod schemas, for the reason the sibling screens give: the schema
 * is the contract, this is one consumer's view of it, and `screen-contract.ts`
 * is what keeps the two from drifting apart unnoticed.
 *
 * `DeliveryMode` is imported rather than redeclared: it is the same
 * `'export' | 'auto'` value an article's own delivery already carries in
 * `packages/ui/src/content`. It is used below but deliberately not
 * re-exported from here — `content` already exports it from this package's
 * top-level barrel, and a second `export *` of the same name would collide.
 * A caller who needs the type imports it from `@sortiva/ui` same as any
 * other `content` export.
 */

export type PublishAs = 'live' | 'draft'
export type EmailDigestFrequency = 'off' | 'daily' | 'weekly'

/**
 * `AccountSettingsData` rather than `AccountSettings`: the Account *screen*
 * component (ui §9.4) is named `AccountSettings`, and the two would otherwise
 * share one identifier from this package's barrel.
 */
export interface AccountSettingsData {
  readonly delivery: DeliveryMode
  readonly shopifyPublishAs: PublishAs
  readonly publishHour: number
  readonly timezone: string
  readonly draftReview: boolean
  readonly autoRepair: boolean
  readonly vacationMode: boolean
  readonly uiLanguage: string | null
  readonly emailArticlePublished: boolean
  readonly emailDigestFrequency: EmailDigestFrequency
}

export interface ShopifyBlog {
  readonly id: string
  readonly title: string
  readonly handle: string
}

export type SubscriptionStatus =
  | 'active'
  /** Entitled without paying. No payment details, nothing to renew, nothing to fix. */
  | 'comped'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'none'

/** The slice of `GET /api/account` the Connections and Account screens need. */
export interface SettingsAccountView {
  readonly domain: { readonly normalized: string; readonly state: string } | null
  readonly subscription: {
    readonly status: SubscriptionStatus
    readonly cancelAtPeriodEnd: boolean
    readonly currentPeriodEnd: string | null
  }
  readonly limitedIntelligence: boolean
  readonly connections: {
    readonly shopify: 'none' | 'read' | 'read_write' | 'broken'
    readonly searchConsole: 'none' | 'connected' | 'broken'
    readonly lastScanAt: string | null
  }
}
