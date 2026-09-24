/**
 * Session replay records a film of the page — every scroll, every click, the
 * text on screen — and plays it back to us later. On a merchant's screens the
 * text on screen is their catalogue, their draft articles and their search
 * data, so a replay of one of those screens is a copy of their store held on a
 * vendor's servers. It is off, and this file is where "off" is decided.
 *
 * Every view the product has is listed below and says whether it renders a
 * merchant's store data. Two consequences:
 *
 * - **A store-data view can never be recorded.** `sessionReplay` answers `off`
 *   for one whatever else is configured, so switching replay on for a marketing
 *   page cannot reach a store screen by accident.
 * - **A view nobody classified counts as store data.** A new screen is off by
 *   default and stays off until someone writes down what it renders. The test
 *   beside this file walks the app's routes and fails on any view missing from
 *   the list, so "someone writes it down" is enforced rather than remembered.
 *
 * Nothing is recorded today: the enabled list is empty, and no card has asked
 * for replay. The list exists so that the day one is asked for, the store
 * screens are already fenced off.
 */

export type ViewContent = 'store_data' | 'no_store_data'

/**
 * Every route the app serves, and whether what it renders belongs to a
 * merchant's store.
 *
 * `/` is store data despite being a public page: the preview card on it renders
 * products read from whichever shop the visitor typed in.
 */
export const VIEW_CONTENT: Readonly<Record<string, ViewContent>> = {
  '/': 'store_data',
  // Onboarding happens on the dashboard, and every stage of it puts the
  // merchant's own store on screen: the address of their shop, the products
  // read out of it, their best sellers with revenue against them, and the
  // keywords and competitors drawn from all of it.
  '/dashboard': 'store_data',
  // Every opportunity names the page, product family or search it is about,
  // all of which are the merchant's own.
  '/opportunities': 'store_data',
  // The calendar names every topic we plan to write for this store; the library
  // and the article itself are the store's own pages, written from its catalogue.
  '/content': 'store_data',
  '/content/articles': 'store_data',
  '/content/articles/[articleId]': 'store_data',
  // The catalogue itself: every product, its family, and the facts we hold about
  // each one. There is nothing on this screen that is not the merchant's own.
  '/products': 'store_data',
  // Their search traffic, their articles' results, and the queries their store
  // is found for — the closest thing the product holds to commercial data.
  '/performance': 'store_data',
  '/performance/search-console': 'store_data',
  '/signin': 'no_store_data',
  '/ui-gallery/banner-stack': 'no_store_data',
  // Redirects straight to `/settings/publishing`; renders nothing of its own.
  '/settings': 'no_store_data',
  // The blog picker lists the store's own Shopify blogs by name, and the
  // business-profile section shown here is the confirmation screen's data —
  // description, top sellers, keywords, competitors — all the merchant's own.
  '/settings/publishing': 'store_data',
  '/settings/profile': 'store_data',
  // Names the merchant's own claimed domain and its connection state.
  '/settings/connections': 'store_data',
  // Billing status, vacation mode, email preferences and interface language —
  // account configuration, not catalogue, calendar or search content.
  '/settings/account': 'no_store_data',
}

/**
 * Views replay is switched on for. Empty, deliberately — see the note above.
 * A store-data view in this list is still not recorded; `sessionReplay` ignores
 * the list for those.
 */
export const SESSION_REPLAY_VIEWS: readonly string[] = []

/** What a route renders. An unlisted route counts as store data. */
export function viewContent(route: string): ViewContent {
  return VIEW_CONTENT[route] ?? 'store_data'
}

/**
 * Whether this view may be recorded.
 *
 * `enabledViews` is a parameter so a test can try to switch a store screen on
 * and show that it stays off.
 */
export function sessionReplay(
  route: string,
  enabledViews: readonly string[] = SESSION_REPLAY_VIEWS,
): 'off' | 'on' {
  if (viewContent(route) === 'store_data') return 'off'
  return enabledViews.includes(route) ? 'on' : 'off'
}

/** The routes that render a merchant's store data — what the coverage test asserts over. */
export function storeDataViews(): readonly string[] {
  return Object.keys(VIEW_CONTENT).filter((route) => VIEW_CONTENT[route] === 'store_data')
}
