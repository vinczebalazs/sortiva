import type { GenerationConfig } from '@sortiva/rules'
import type { EvidencePack } from './evidence-pack'

/**
 * What the draft must link to: main §9.2, "every article links the
 * referenced product/collection pages and at least one related earlier
 * article once any exist" — plus the existing-target check's own link task
 * (main §7.7 step 4), when the topic proceeded past a weak match.
 */
export interface InternalLinkTarget {
  readonly url: string
  readonly reason: 'existing_target_weak_match' | 'related_article'
}

export interface RelatedArticle {
  readonly url: string
  readonly title: string
}

export function internalLinkTargetsFor(
  pack: EvidencePack,
  relatedArticles: readonly RelatedArticle[],
): readonly InternalLinkTarget[] {
  const targets: InternalLinkTarget[] = pack.linkTasks.map((task) => ({
    url: task.url,
    reason: 'existing_target_weak_match',
  }))
  if (relatedArticles.length > 0) {
    targets.push({ url: relatedArticles[0]!.url, reason: 'related_article' })
  }
  return targets
}

/** Gate 3's own internal-link lint (main §9.2) needs a floor to check against; this is where the number lives (`packages/rules`). */
export function meetsInternalLinkMinimum(
  presentUrls: readonly string[],
  requiredTargets: readonly InternalLinkTarget[],
  config: GenerationConfig['internal_links'],
): boolean {
  const present = new Set(presentUrls)
  const satisfied = requiredTargets.filter((t) => present.has(t.url)).length
  return satisfied >= Math.min(config.min_count, requiredTargets.length)
}
