/**
 * Every kind of response the fake produces, and where its form comes from. `recording` names a
 * file in recordings/ captured from our dev store with RECORD=1; until one exists the template
 * is unverified. `publishedBy` is the public source the form was taken from in the meantime.
 */
export type ResponseTemplate = {
  name: string
  recording: string
  publishedBy: string
}

const SCHEMA = 'pinned Admin API schema (fakes/fake-shopify/schema) and a capture from Shopify\'s public demo shop'
const DOCS_ERRORS = 'https://shopify.dev/docs/api/admin-graphql#status-and-error-codes'
const DOCS_TOKENS = 'https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange'
const DOCS_WEBHOOKS = 'https://shopify.dev/docs/api/webhooks/2026-07 (sample payloads, fakes/fake-shopify/published-samples)'

export const TEMPLATES: ResponseTemplate[] = [
  ...['shop', 'currentAppInstallation', 'products', 'product', 'productsCount', 'collections', 'pages', 'blogs', 'articles', 'article'].map((field) => ({
    name: `query.${field}`,
    recording: `query.${field}.json`,
    publishedBy: SCHEMA,
  })),
  ...['blogCreate', 'articleCreate', 'articleUpdate', 'articleUpdate.notFound'].map((field) => ({
    name: `mutation.${field}`,
    recording: `mutation.${field}.json`,
    publishedBy: 'pinned Admin API schema only; the demo shop refuses writes',
  })),
  { name: 'error.THROTTLED', recording: 'error.THROTTLED.json', publishedBy: 'error code named in the docs; body shape not published' },
  { name: 'error.MAX_COST_EXCEEDED', recording: 'error.MAX_COST_EXCEEDED.json', publishedBy: DOCS_ERRORS },
  { name: 'error.ACCESS_DENIED', recording: 'error.ACCESS_DENIED.json', publishedBy: 'error code named in the docs; body shape not published' },
  { name: 'http.401', recording: 'http.401.json', publishedBy: 'status only; body not published' },
  { name: 'http.404', recording: 'http.404.json', publishedBy: DOCS_ERRORS },
  { name: 'oauth.tokenExchange', recording: 'oauth.tokenExchange.json', publishedBy: DOCS_TOKENS },
  { name: 'oauth.refresh', recording: 'oauth.refresh.json', publishedBy: DOCS_TOKENS },
  { name: 'oauth.refresh.invalid', recording: 'oauth.refresh.invalid.json', publishedBy: DOCS_TOKENS },
  ...['products/create', 'products/update', 'products/delete', 'collections/update', 'collections/delete', 'app/uninstalled'].map((topic) => ({
    name: `webhook.${topic}`,
    recording: `webhook.${topic.replace('/', '.')}.json`,
    publishedBy: DOCS_WEBHOOKS,
  })),
]

// Shopify's release table: 2026-07 stays accessible until this moment.
export const PINNED_VERSION_RETIRES_AT = new Date('2027-07-16T15:00:00Z')
