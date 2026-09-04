/**
 * The one seam through which anything is ever written to a merchant's shop.
 *
 * Everything behind it is Shopify's vocabulary — blogs, articles, metafields —
 * and everything in front of it is ours. Two things follow from keeping it a
 * seam rather than a set of calls scattered through the publishing job. The
 * publishing protocol can be tested against a double that can be made to fail
 * or die at any step, which is the only way to prove that a crash mid-publish
 * does not post twice. And there is exactly one file in the repository that
 * knows how to change something in a merchant's store, so "what can Sortiva
 * write?" has a readable answer.
 */

/** One of the store's blogs, as the picker shows it. */
export interface ShopifyBlog {
  readonly id: string
  readonly title: string
  readonly handle: string
}

/** An article as it exists on the merchant's shop right now. */
export interface RemoteArticle {
  readonly id: string
  readonly handle: string
  /** Where a reader would find it. Null while it is an unpublished Shopify draft. */
  readonly url: string | null
  /**
   * Our own marker, read back off the remote copy. This is what makes a remote
   * article identifiable as ours after a crash, when our own records may not
   * yet say we created it.
   */
  readonly marker: string | null
  /** False for an article posted as a Shopify draft, which no reader can see yet. */
  readonly published: boolean
}

export interface ShopifyStoreCredentials {
  readonly shop: string
  readonly accessToken: string
}

/**
 * The two per-store facts an article's public address is built from.
 *
 * Both are per account and the client that talks to Shopify is one per
 * process, so they travel with each call rather than being held anywhere.
 */
export interface ArticleAddressing {
  /**
   * The blog's name as it appears in its own web address. Shopify addresses a
   * post by the blog's *name*, not by its number. Recorded alongside the id
   * when the merchant picks the blog.
   */
  readonly blogHandle: string
  /**
   * The host the merchant's shoppers actually visit — the domain claimed at
   * signup, not the `myshopify.com` handle we talk to the Admin API through.
   *
   * Search Console reports a store's traffic under that host, so an article
   * recorded under the `myshopify` one can never be matched to the clicks it
   * earns: it would look like it had earned nothing, permanently.
   */
  readonly storefrontDomain: string
}

export interface CreateArticleInput extends ShopifyStoreCredentials, ArticleAddressing {
  readonly blogId: string
  readonly title: string
  /** The article body, already resolved against the store and stripped of internal markers. */
  readonly bodyHtml: string
  readonly handle: string
  readonly summary: string
  /**
   * Our marker for this article — stable across every revision of it, so the
   * shop stays searchable for the article rather than for one version of it.
   */
  readonly marker: string
  /** Whether the post goes live or waits as a Shopify draft for a last look. */
  readonly publishAs: 'live' | 'draft'
}

export interface UpdateArticleInput extends CreateArticleInput {
  /** The remote article we are revising. An update names it or does not happen. */
  readonly remoteArticleId: string
}

/**
 * The remote article is not there any more — the merchant deleted it in
 * Shopify's admin.
 *
 * Its own class because it is the one failure an update must never recover
 * from by creating a new post. A merchant who deleted an article meant to
 * delete it; silently putting it back is the single worst thing an automated
 * publisher can do.
 */
export class RemoteArticleGone extends Error {
  override readonly name = 'RemoteArticleGone'
  readonly retryable = false
  readonly errorClass = 'remote_article_gone'
  constructor(readonly remoteArticleId: string) {
    super(`the article we published as ${remoteArticleId} is no longer on the store`)
  }
}

export interface ShopifyPublishProvider {
  /**
   * The *second* consent screen — the same install flow, asking additionally
   * for permission to post. Separate from the read-only authorize URL rather
   * than a parameter on it, so no caller can turn the install screen into a
   * write request by passing the wrong argument.
   */
  publishAuthorizeUrl(input: { shop: string; redirectUri: string; state: string }): string

  listBlogs(input: ShopifyStoreCredentials): Promise<readonly ShopifyBlog[]>

  /** One click, for a store that has no blog to post to yet. */
  createBlog(input: ShopifyStoreCredentials & { title: string }): Promise<ShopifyBlog>

  createArticle(input: CreateArticleInput): Promise<RemoteArticle>

  /** Throws `RemoteArticleGone` rather than creating anything when the remote copy has been deleted. */
  updateArticle(input: UpdateArticleInput): Promise<RemoteArticle>

  /**
   * "Did our post actually land?" — the question the recovery sweep exists to
   * ask before it considers writing again.
   */
  findArticleByMarker(input: FindArticleByMarkerInput): Promise<RemoteArticle | undefined>
}

export interface FindArticleByMarkerInput extends ShopifyStoreCredentials, ArticleAddressing {
  readonly blogId: string
  readonly marker: string
  /**
   * Nothing posted before this moment can be ours: the claim on this
   * publication was opened here, and the post — if it happened at all —
   * happened after it.
   *
   * It is required rather than optional because without it the only honest
   * search is every article the blog has ever held, one request each. With it,
   * an established blog of thousands of posts is narrowed to the handful
   * written since we started, which is what makes asking the shop cheap enough
   * to do every five minutes.
   */
  readonly notBefore: Date
}

/**
 * We asked the shop and could not finish asking.
 *
 * Its own class, and thrown rather than swallowed, because of what the caller
 * would otherwise conclude. "Not found" is the answer that authorises sending
 * the article again; an incomplete search that reported "not found" would post
 * a second copy on a merchant's own site. So a search that ran out of pages
 * says so, and the sweep tries again rather than deciding.
 */
export class MarkerLookupIncomplete extends Error {
  override readonly name = 'MarkerLookupIncomplete'
  readonly retryable = true
  readonly errorClass = 'marker_lookup_incomplete'
  constructor(readonly marker: string) {
    super(`we could not finish asking the shop whether ${marker} is already there`)
  }
}
