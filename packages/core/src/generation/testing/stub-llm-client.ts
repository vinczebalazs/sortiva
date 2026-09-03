import type { LlmClient, LlmRequest, LlmResult } from '../../contracts/llm'

/**
 * A local `LlmClient` double for this directory's tests, on the same
 * reasoning `topics/classify.test.ts` and `distill/distill.test.ts` already
 * state: `packages/llm` depends on `packages/core`, so importing its
 * `MockLlmClient` here would be a cycle. Test-only — not exported from
 * `generation/index.ts`.
 */
export class StubLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = []
  constructor(private readonly answer: unknown | ((request: LlmRequest) => unknown)) {}

  async complete<T>(request: LlmRequest): Promise<LlmResult<T>> {
    this.requests.push(request)
    const output = typeof this.answer === 'function' ? (this.answer as (r: LlmRequest) => unknown)(request) : this.answer
    return {
      output: output as T,
      text: JSON.stringify(output),
      modelId: 'claude-sonnet-5',
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: { inputTokens: 200, outputTokens: 400, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      usdCost: 0.004,
      latencyMs: 10,
      attempts: 1,
    }
  }
}
