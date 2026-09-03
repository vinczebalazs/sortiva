import { accountAttribution } from '../contracts/analytics'
import type { LlmClient, LlmRequest } from '../contracts/llm'
import { INTENT_CLASSES, type IntentClass, type QueryCluster } from '../contracts/opportunities'

/**
 * Turns a merchant-typed calendar topic title into the `QueryCluster`
 * (search term, intent class, mapped family ids) Gate 1 and the manual-add
 * path need to run at all.
 *
 * `T4.1` flagged this as an unbuilt gap and named three shapes for it —
 * matching against known keywords, an LLM classification call, or a UI change
 * asking the merchant to pick a family. The founder chose the model call (see
 * DECISIONS 2026-09-03 T4.2): it runs once per manual add, on the hand-typed
 * path only, so it does not carry Gate 1's "~free" requirement — scan-produced
 * topics already arrive with clusters built from Search Console data
 * (`packages/jobs/src/scan/clusters.ts`) and never reach this function.
 */

/** One of the store's own product families, as the model is allowed to choose from. */
export interface FamilyChoice {
  readonly id: string
  readonly name: string
}

export interface TopicClassifyPrompt {
  /** e.g. `topic-classify.v1`; stamped on the spend record. */
  readonly version: string
  readonly text: string
}

export interface ClassifyManualTopicDeps {
  /** The single instrumented wrapper — invariant 25. */
  readonly llm: LlmClient
  readonly prompt: TopicClassifyPrompt
}

export interface ClassifyManualTopicInput {
  readonly accountId: string
  readonly title: string
  /** The store's own families. An empty list is valid — a store with nothing grouped yet always classifies to `familyIds: []`. */
  readonly families: readonly FamilyChoice[]
}

export type ClassifyManualTopicResult =
  | { readonly ok: true; readonly cluster: QueryCluster; readonly modelId: string; readonly promptVersion: string }
  /**
   * The call failed outright (transport, or two failed validation attempts),
   * or answered with something the schema does not rule out but that this
   * function refuses to trust anyway — e.g. every returned family id turning
   * out to be one this store does not have. Main §14.4's "degrade to pause,
   * never to lower quality" governs here: we do not guess a cluster from a
   * half-trustworthy answer, we say the classification could not be done.
   */
  | { readonly ok: false; readonly reason: string }

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['head', 'members', 'intentClass', 'familyIds'],
  properties: {
    head: { type: 'string', minLength: 1 },
    members: { type: 'array', items: { type: 'string' } },
    intentClass: { type: 'string', enum: [...INTENT_CLASSES] },
    familyIds: { type: 'array', items: { type: 'string' } },
  },
} as const

interface TopicClassifyOutput {
  readonly head: string
  readonly members: readonly string[]
  readonly intentClass: IntentClass
  readonly familyIds: readonly string[]
}

const MAX_OUTPUT_TOKENS = 400
/** Not a place for invention — the classification either matches the given families or it does not. */
const TEMPERATURE = 0

export function buildTopicClassifyRequest(input: {
  readonly prompt: TopicClassifyPrompt
  readonly accountId: string
  readonly title: string
  readonly families: readonly FamilyChoice[]
}): LlmRequest {
  const familiesBlock =
    input.families.length === 0
      ? '(this store has no product families yet)'
      : input.families.map((f) => `${f.id}: ${f.name}`).join('\n')

  return {
    callType: 'topic_classify',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [
      {
        role: 'user',
        content: `Topic title: ${input.title}\n\nStore's product families:\n${familiesBlock}`,
      },
    ],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: TEMPERATURE,
    schema: RESPONSE_SCHEMA,
    attribution: accountAttribution(input.accountId),
  }
}

export async function classifyManualTopic(
  deps: ClassifyManualTopicDeps,
  input: ClassifyManualTopicInput,
): Promise<ClassifyManualTopicResult> {
  let output: TopicClassifyOutput
  let modelId: string
  let promptVersion: string
  try {
    const result = await deps.llm.complete<TopicClassifyOutput>(
      buildTopicClassifyRequest({
        prompt: deps.prompt,
        accountId: input.accountId,
        title: input.title,
        families: input.families,
      }),
    )
    output = result.output
    modelId = result.modelId
    promptVersion = result.promptVersion
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  // The schema keeps `familyIds` to an array of strings, but a model can still
  // hand back an id this store does not have — the prompt says never to, but
  // the prompt is not a constraint. Filtering rather than trusting is what
  // keeps a hallucinated id from ever reaching `topics.family_ids`, which has
  // no foreign key to catch it.
  const knownIds = new Set(input.families.map((f) => f.id))
  const familyIds = output.familyIds.filter((id) => knownIds.has(id))

  const head = output.head.trim()
  if (head === '') {
    return { ok: false, reason: 'topic_classify returned an empty head term' }
  }

  return {
    ok: true,
    modelId,
    promptVersion,
    cluster: {
      head,
      members: output.members.map((m) => m.trim()).filter((m) => m !== ''),
      intentClass: output.intentClass,
      familyIds,
    },
  }
}
