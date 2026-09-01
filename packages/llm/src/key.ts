import { createHash } from 'node:crypto'

/**
 * The cache key is `(prompt_version, model_id, sha256(rendered prompt))`. The
 * prompt is serialised canonically so message order and role are
 * part of the hash and nothing else is.
 *
 * Its own file, rather than living in `client.ts`, so the test double can key
 * the same way the live client does without importing the Anthropic SDK —
 * mirroring `packages/providers/src/seo/key.ts`, which is what makes the SEO
 * double's billable-call count mean the same thing as production's.
 */
export function llmCacheKey(
  promptVersion: string,
  modelId: string,
  system: string | undefined,
  messages: readonly { role: string; content: string }[],
): string {
  const rendered = JSON.stringify({ system: system ?? null, messages })
  const digest = createHash('sha256').update(rendered, 'utf8').digest('hex')
  return `llm:${promptVersion}:${modelId}:${digest}`
}
