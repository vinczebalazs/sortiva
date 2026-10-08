import {
  GraphQLError,
  Kind,
  getNamedType,
  isAbstractType,
  isObjectType,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLNamedType,
  type GraphQLSchema,
  type SelectionSetNode,
  valueFromASTUntyped,
} from 'graphql'
import { gid, newId, parseGid, type ArticleRecord, type ProductRecord, type ShopState } from './state.ts'

// Scope each root field needs, from Shopify's access-scope reference.
export const ROOT_FIELD_SCOPES: Record<string, string | null> = {
  shop: null,
  currentAppInstallation: null,
  products: 'read_products',
  product: 'read_products',
  productsCount: 'read_products',
  collections: 'read_products',
  pages: 'read_content',
  blogs: 'read_content',
  blog: 'read_content',
  articles: 'read_content',
  article: 'read_content',
  blogCreate: 'write_content',
  articleCreate: 'write_content',
  articleUpdate: 'write_content',
}

type ConnectionArgs = { first?: number; last?: number; after?: string; before?: string; reverse?: boolean }

// Same cursor encoding as the captures from Shopify's demo shop.
const encodeCursor = (id: number) => Buffer.from(JSON.stringify({ last_id: id, last_value: String(id) })).toString('base64')
const decodeCursor = (cursor: string) => (JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as { last_id: number }).last_id

function connection<T extends { id: number }>(items: T[], args: ConnectionArgs, view: (item: T) => unknown) {
  let list = [...items].sort((a, b) => a.id - b.id)
  if (args.reverse) list.reverse()
  if (args.after) {
    const after = decodeCursor(args.after)
    const index = list.findIndex((i) => i.id === after)
    list = list.slice(index + 1)
  }
  const n = args.first ?? args.last ?? list.length
  const page = list.slice(0, n)
  const hasNextPage = list.length > page.length
  return {
    nodes: page.map(view),
    edges: page.map((item) => ({ cursor: encodeCursor(item.id), node: view(item) })),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: Boolean(args.after),
      startCursor: page.length ? encodeCursor(page[0]!.id) : null,
      endCursor: page.length ? encodeCursor(page[page.length - 1]!.id) : null,
    },
  }
}

function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function resolvers(shop: ShopState, opts: { now: () => number; listLagMs: number }) {
  const productView = (p: ProductRecord) => ({
    id: gid('Product', p.id),
    handle: p.handle,
    title: p.title,
    productType: p.productType ?? '',
    vendor: p.vendor ?? '',
    status: p.status ?? 'ACTIVE',
    tags: p.tags ?? [],
    descriptionHtml: p.descriptionHtml,
    onlineStoreUrl: (p.status ?? 'ACTIVE') === 'ACTIVE' ? `https://${shop.info.primaryDomainHost}/products/${p.handle}` : null,
    updatedAt: p.updatedAt,
    options: (p.options ?? [{ name: 'Title', values: ['Default Title'] }]).map((o) => ({
      name: o.name,
      values: o.values,
      optionValues: o.values.map((v) => ({ name: v })),
    })),
    priceRangeV2: {
      minVariantPrice: { amount: p.price.min, currencyCode: shop.info.currencyCode },
      maxVariantPrice: { amount: p.price.max ?? p.price.min, currencyCode: shop.info.currencyCode },
    },
    media: (args: ConnectionArgs) =>
      connection(
        (p.images ?? []).map((image, i) => ({ id: p.id * 100 + i, image })),
        args,
        ({ id, image }) => ({
          __typename: 'MediaImage',
          id: gid('MediaImage', id),
          image: { url: image.url, width: image.width, height: image.height, altText: image.altText ?? null },
        }),
      ),
    collections: (args: ConnectionArgs) =>
      connection(shop.collections.filter((c) => p.collectionIds.includes(c.id)), args, collectionView),
    metafields: (args: ConnectionArgs) =>
      connection((p.metafields ?? []).map((m, i) => ({ id: i + 1, ...m })), args, (m) => m),
  })

  const collectionView = (c: ShopState['collections'][number]) => ({
    id: gid('Collection', c.id),
    handle: c.handle,
    title: c.title,
    descriptionHtml: c.descriptionHtml,
  })

  const blogView = (b: ShopState['blogs'][number]) => ({
    id: gid('Blog', b.id),
    handle: b.handle,
    title: b.title,
    articles: (args: ConnectionArgs) => connection(listable().filter((a) => a.blogId === b.id), args, articleView),
  })

  const articleView = (a: ArticleRecord) => ({
    id: gid('Article', a.id),
    handle: a.handle,
    title: a.title,
    body: a.body,
    summary: a.summary,
    tags: a.tags,
    isPublished: a.isPublished,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    author: { name: a.authorName },
    blog: blogView(shop.blogs.find((b) => b.id === a.blogId)!),
    metafield: ({ namespace, key }: { namespace: string; key: string }) => {
      const m = a.metafields.find((x) => x.namespace === namespace && x.key === key)
      return m ? { ...m, id: gid('Metafield', a.id) } : null
    },
  })

  const listable = () => shop.articles.filter((a) => a.listableAt <= opts.now())

  const userError = (field: string[], message: string, code: string) => ({ field, message, code })

  type MetafieldInput = { namespace?: string; key?: string; value?: string; type?: string }
  type ArticleInput = {
    blogId?: string
    handle?: string
    title?: string
    body?: string
    summary?: string
    isPublished?: boolean
    tags?: string[]
    author?: { name?: string }
    metafields?: MetafieldInput[]
  }

  const applyMetafields = (article: ArticleRecord, inputs: MetafieldInput[] = []) => {
    for (const m of inputs) {
      const existing = article.metafields.find((x) => x.namespace === m.namespace && x.key === m.key)
      if (existing) existing.value = m.value ?? existing.value
      else article.metafields.push({ namespace: m.namespace ?? 'custom', key: m.key ?? '', type: m.type ?? 'single_line_text_field', value: m.value ?? '' })
    }
  }

  return {
    shop: () => ({
      name: shop.info.name,
      myshopifyDomain: shop.info.myshopifyDomain,
      ianaTimezone: shop.info.ianaTimezone,
      currencyCode: shop.info.currencyCode,
      primaryDomain: {
        host: shop.info.primaryDomainHost,
        url: `https://${shop.info.primaryDomainHost}`,
        localization: { defaultLocale: shop.info.defaultLocale, country: shop.info.country, alternateLocales: [] },
      },
      shopAddress: { countryCodeV2: shop.info.country },
    }),
    currentAppInstallation: () => ({ accessScopes: shop.grantedScopes.map((handle) => ({ handle, description: handle })) }),
    products: (args: ConnectionArgs) => connection(shop.products, args, productView),
    product: ({ id }: { id: string }) => {
      const p = shop.products.find((x) => x.id === parseGid(id, 'Product'))
      return p ? productView(p) : null
    },
    productsCount: () => ({ count: shop.products.length, precision: 'EXACT' }),
    collections: (args: ConnectionArgs) => connection(shop.collections, args, collectionView),
    pages: (args: ConnectionArgs) => connection(shop.pages, args, (p) => ({ ...p, id: gid('Page', p.id) })),
    blogs: (args: ConnectionArgs) => connection(shop.blogs, args, blogView),
    blog: ({ id }: { id: string }) => {
      const b = shop.blogs.find((x) => x.id === parseGid(id, 'Blog'))
      return b ? blogView(b) : null
    },
    articles: (args: ConnectionArgs) => connection(listable(), args, articleView),
    article: ({ id }: { id: string }) => {
      const a = shop.articles.find((x) => x.id === parseGid(id, 'Article'))
      return a ? articleView(a) : null
    },

    blogCreate: ({ blog }: { blog: { title?: string; handle?: string } }) => {
      if (!blog.title?.trim()) return { blog: null, userErrors: [userError(['blog', 'title'], "Title can't be blank", 'INVALID')] }
      const record = { id: newId(), title: blog.title, handle: blog.handle ?? slugify(blog.title) }
      shop.blogs.push(record)
      return { blog: blogView(record), userErrors: [] }
    },
    articleCreate: ({ article }: { article: ArticleInput }) => {
      if (!article.blogId) return { article: null, userErrors: [userError(['article', 'blogId'], 'Must reference a blog', 'BLOG_REFERENCE_REQUIRED')] }
      const blog = shop.blogs.find((b) => b.id === parseGid(article.blogId!, 'Blog'))
      if (!blog) return { article: null, userErrors: [userError(['article', 'blogId'], 'Blog does not exist', 'NOT_FOUND')] }
      if (!article.title?.trim()) return { article: null, userErrors: [userError(['article', 'title'], "Title can't be blank", 'BLANK')] }
      let handle = article.handle ?? slugify(article.title)
      const taken = (h: string) => shop.articles.some((a) => a.blogId === blog.id && a.handle === h)
      for (let i = 1; taken(handle); i++) handle = `${article.handle ?? slugify(article.title)}-${i}`
      const now = new Date(opts.now()).toISOString()
      const record: ArticleRecord = {
        id: newId(),
        blogId: blog.id,
        handle,
        title: article.title,
        body: article.body ?? '',
        summary: article.summary ?? null,
        tags: article.tags ?? [],
        isPublished: article.isPublished ?? false,
        authorName: article.author?.name ?? shop.info.name,
        metafields: [],
        createdAt: now,
        updatedAt: now,
        listableAt: opts.now() + opts.listLagMs,
      }
      applyMetafields(record, article.metafields)
      shop.articles.push(record)
      return { article: articleView(record), userErrors: [] }
    },
    articleUpdate: ({ id, article }: { id: string; article: ArticleInput }) => {
      const record = shop.articles.find((a) => a.id === parseGid(id, 'Article'))
      if (!record) return { article: null, userErrors: [userError(['id'], 'Article does not exist', 'NOT_FOUND')] }
      if (article.title !== undefined) record.title = article.title
      if (article.body !== undefined) record.body = article.body
      if (article.summary !== undefined) record.summary = article.summary
      if (article.isPublished !== undefined) record.isPublished = article.isPublished
      if (article.tags !== undefined) record.tags = article.tags
      if (article.handle !== undefined) record.handle = article.handle
      applyMetafields(record, article.metafields)
      record.updatedAt = new Date(opts.now()).toISOString()
      return { article: articleView(record), userErrors: [] }
    },
  }
}

/** Shopify's documented cost rules: scalars free, objects 1, connections sized by `first`/`last`, mutations 10. */
export function requestedCost(schema: GraphQLSchema, document: DocumentNode, variables: Record<string, unknown>): number {
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const d of document.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d)

  const argValue = (node: { value: Parameters<typeof valueFromASTUntyped>[0] }) => valueFromASTUntyped(node.value, variables)

  const selectionCost = (type: GraphQLNamedType, set: SelectionSetNode | undefined): number => {
    if (!set) return 0
    let total = 0
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) {
        if (sel.name.value.startsWith('__')) continue
        const parent = isObjectType(type) || isAbstractType(type) ? type : undefined
        const fieldDef = parent && 'getFields' in parent ? parent.getFields()[sel.name.value] : undefined
        if (!fieldDef) continue
        const named = getNamedType(fieldDef.type)
        if (!isObjectType(named) && !isAbstractType(named)) continue
        if (named.name.endsWith('Connection')) {
          const sizeArg = sel.arguments?.find((a) => a.name.value === 'first' || a.name.value === 'last')
          const size = sizeArg ? Number(argValue(sizeArg)) || 0 : 0
          const inner = selectionCost(named, sel.selectionSet)
          total += 2 + size * Math.max(inner, 1)
        } else {
          total += 1 + selectionCost(named, sel.selectionSet)
        }
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        const cond = sel.typeCondition ? (schema.getType(sel.typeCondition.name.value) ?? type) : type
        total += selectionCost(cond, sel.selectionSet)
      } else {
        const frag = fragments.get(sel.name.value)
        if (frag) total += selectionCost(schema.getType(frag.typeCondition.name.value) ?? type, frag.selectionSet)
      }
    }
    return total
  }

  let total = 0
  for (const d of document.definitions) {
    if (d.kind !== Kind.OPERATION_DEFINITION) continue
    if (d.operation === 'mutation') total += 10 * d.selectionSet.selections.length
    else total += selectionCost(schema.getQueryType()!, d.selectionSet)
  }
  return total
}

export function rootFieldNames(document: DocumentNode): string[] {
  const names: string[] = []
  for (const d of document.definitions) {
    if (d.kind !== Kind.OPERATION_DEFINITION) continue
    for (const sel of d.selectionSet.selections) if (sel.kind === Kind.FIELD) names.push(sel.name.value)
  }
  return names
}

export function accessDenied(field: string, scope: string): GraphQLError {
  return new GraphQLError(`Access denied for ${field} field. Required access: \`${scope}\` access scope.`, {
    extensions: { code: 'ACCESS_DENIED', requiredAccess: `\`${scope}\` access scope.` },
  })
}
