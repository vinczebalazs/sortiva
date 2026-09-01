import { previewAttribution } from '../contracts/analytics'
import type { LlmRequest } from '../contracts/llm'
import { PREVIEW_MAX_OUTPUT_TOKENS, PREVIEW_TEMPERATURE } from './limits'
import type { PreviewPrompt } from './ports'

/**
 * One model call: a two-to-three sentence plain-language summary of what this
 * business does and sells, in the site's own language, at a low temperature and
 * a small output budget.
 *
 * Three things this function exists to make non-optional:
 *
 * - `callType: 'preview'`, which binds the call to the cheap tier and is what
 *   every spend record is broken down by.
 * - `previewAttribution`, which carries `target_domain` as a **property** and
 *   deliberately has no field for a domain group. That group is reserved for
 *   claimed domains — ten strangers previewing `nike.com` is not
 *   Nike-the-account costing us money.
 * - No JSON schema. Schema validation is for the calls that produce structured
 *   artefacts; the preview's output is one short paragraph of prose,
 *   and wrapping it in JSON would spend a tenth of a 150-token budget on
 *   punctuation. Emptiness and length are checked in `runPreview` instead.
 */
export function buildPreviewLlmRequest(input: {
  prompt: PreviewPrompt
  domain: string
  /** The registrable domain this spend is billed to, so it joins to a later signup. */
  billableDomain: string
  pageText: string
}): LlmRequest {
  return {
    callType: 'preview',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [
      {
        role: 'user',
        content: `Website: ${input.domain}\n\nExtracted page content:\n${input.pageText}`,
      },
    ],
    maxTokens: PREVIEW_MAX_OUTPUT_TOKENS,
    temperature: PREVIEW_TEMPERATURE,
    attribution: previewAttribution(input.domain, input.billableDomain),
  }
}
