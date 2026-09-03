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

export interface CreateArticleInput extends ShopifyStoreCredentials {
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
  findArticleByMarker(
    input: ShopifyStoreCredentials & { blogId: string; marker: string },
  ): Promise<RemoteArticle | undefined>
}
