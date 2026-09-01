import { previewAttribution } from '../contracts/analytics'
import type { LlmRequest } from '../contracts/llm'
import { PREVIEW_MAX_OUTPUT_TOKENS, PREVIEW_TEMPERATURE } from './limits'
import type { PreviewPrompt } from './ports'

/**
 * main §3.3 step 5 — "call **Claude Haiku** with a single prompt: produce a 2–3
 * sentence plain-language summary of what this business does and sells, in the
 * site's own language. Temperature low, max ~150 output tokens."
 *
 * Three things this function exists to make non-optional:
 *
 * - `callType: 'preview'`, which main §15 binds to Haiku and §14.7 requires on
 *   every `$ai_generation` capture.
 * - `previewAttribution`, which carries `target_domain` as a **property** and
 *   deliberately has no field for a domain group. main §14.7: the domain group
 *   is reserved for claimed domains — ten strangers previewing `nike.com` is
 *   not Nike-the-account costing us money.
 * - No JSON schema. §14.2's schema-validation rule names distillation, persona,
 *   seeds and the judge; the preview's output is one short paragraph of prose,
 *   and wrapping it in JSON would spend a tenth of a 150-token budget on
 *   punctuation. Emptiness and length are checked in `runPreview` instead.
 */
export function buildPreviewLlmRequest(input: {
  prompt: PreviewPrompt
  domain: string
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
    attribution: previewAttribution(input.domain),
  }
}
