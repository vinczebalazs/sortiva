// Every document here is validated against the pinned Admin API schema by queries.test.ts.

export const MARKER_NAMESPACE = 'sortiva'
export const MARKER_KEY = 'article_id'

const PRODUCT_FIELDS = /* GraphQL */ `
  fragment ProductFields on Product {
    id
    handle
    title
    productType
    vendor
    status
    tags
    descriptionHtml
    onlineStoreUrl
    updatedAt
    options { name optionValues { name } }
    priceRangeV2 {
      minVariantPrice { amount currencyCode }
      maxVariantPrice { amount currencyCode }
    }
    media(first: 10) {
      nodes { ... on MediaImage { image { url width height altText } } }
    }
    collections(first: 10) { nodes { id handle title } }
    metafields(first: 10) { nodes { namespace key type value } }
  }
`

export const SHOP = /* GraphQL */ `
  query Shop {
    shop {
      name
      myshopifyDomain
      ianaTimezone
      currencyCode
      primaryDomain { host url localization { defaultLocale country } }
      shopAddress { countryCodeV2 }
    }
  }
`

export const APP_SCOPES = /* GraphQL */ `
  query AppScopes {
    currentAppInstallation { accessScopes { handle } }
  }
`

export const PRODUCTS_PAGE = /* GraphQL */ `
  query ProductsPage($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: ID) {
      nodes { ...ProductFields }
      pageInfo { hasNextPage endCursor }
    }
  }
  ${PRODUCT_FIELDS}
`

export const PRODUCT = /* GraphQL */ `
  query Product($id: ID!) {
    product(id: $id) { ...ProductFields }
  }
  ${PRODUCT_FIELDS}
`

export const PRODUCTS_COUNT = /* GraphQL */ `
  query ProductsCount {
    productsCount { count }
  }
`

export const COLLECTIONS_PAGE = /* GraphQL */ `
  query CollectionsPage($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: ID) {
      nodes { id handle title descriptionHtml }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const PAGES_PAGE = /* GraphQL */ `
  query PagesPage($first: Int!, $after: String) {
    pages(first: $first, after: $after, sortKey: ID) {
      nodes { id handle title body }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const BLOGS = /* GraphQL */ `
  query Blogs($first: Int!, $after: String) {
    blogs(first: $first, after: $after) {
      nodes { id handle title }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const ARTICLES_PAGE = /* GraphQL */ `
  query ArticlesPage($first: Int!, $after: String) {
    articles(first: $first, after: $after, sortKey: ID) {
      nodes {
        id
        handle
        title
        body
        isPublished
        blog { id handle }
        marker: metafield(namespace: "${MARKER_NAMESPACE}", key: "${MARKER_KEY}") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

// Newest first, so a marker search after a crash looks at the articles created around the crash.
export const RECENT_ARTICLES_WITH_MARKER = /* GraphQL */ `
  query RecentArticles($first: Int!, $after: String) {
    articles(first: $first, after: $after, sortKey: ID, reverse: true) {
      nodes {
        id
        handle
        createdAt
        body
        isPublished
        blog { id handle }
        marker: metafield(namespace: "${MARKER_NAMESPACE}", key: "${MARKER_KEY}") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const ARTICLE = /* GraphQL */ `
  query Article($id: ID!) {
    article(id: $id) {
      id
      handle
      title
      body
      isPublished
      blog { id handle }
      marker: metafield(namespace: "${MARKER_NAMESPACE}", key: "${MARKER_KEY}") { value }
    }
  }
`

export const BLOG_CREATE = /* GraphQL */ `
  mutation BlogCreate($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog { id handle title }
      userErrors { field message code }
    }
  }
`

export const ARTICLE_CREATE = /* GraphQL */ `
  mutation ArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id handle isPublished blog { id handle } }
      userErrors { field message code }
    }
  }
`

export const ARTICLE_UPDATE = /* GraphQL */ `
  mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id handle isPublished blog { id handle } }
      userErrors { field message code }
    }
  }
`

export const ALL_DOCUMENTS = {
  SHOP,
  APP_SCOPES,
  PRODUCTS_PAGE,
  PRODUCT,
  PRODUCTS_COUNT,
  COLLECTIONS_PAGE,
  PAGES_PAGE,
  BLOGS,
  ARTICLES_PAGE,
  RECENT_ARTICLES_WITH_MARKER,
  ARTICLE,
  BLOG_CREATE,
  ARTICLE_CREATE,
  ARTICLE_UPDATE,
}
