import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { z } from 'zod'
import { CONFIG } from '../../core/config.ts'
import { MalformedOutputError, ModelRefusedError } from '../../core/errors.ts'
import type { Llm, LlmJsonRequest } from '../../core/llm.ts'
import { assertWithinBudget } from '../../core/spend.ts'
import type { Db } from '../../db/pool.ts'
import { stableHash } from '../../core/hash.ts'

export type AnthropicOptions = { apiKey: string; baseURL?: string; model?: string }

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

export function priceOf(usage: Usage): number {
  const { input, output } = CONFIG.modelPrice
  const inTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1
  return (inTokens * input + usage.output_tokens * output) / 1_000_000
}

// Thinking is billed as output, so the estimate assumes a long answer; the ledger keeps the real figure.
function estimate(system: string, user: string, maxTokens: number): number {
  const inputTokens = (system.length + user.length) / 3
  return (inputTokens * CONFIG.modelPrice.input + Math.min(maxTokens, 6000) * CONFIG.modelPrice.output) / 1_000_000
}

export class AnthropicLlm implements Llm {
  private readonly client: Anthropic
  private readonly model: string

  constructor(private readonly db: Db, options: AnthropicOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: 2 })
    this.model = options.model ?? CONFIG.model
  }

  async json<S extends z.ZodType>(request: LlmJsonRequest<S>): Promise<z.infer<S>> {
    const format = zodOutputFormat(request.schema)
    const maxTokens = request.maxTokens ?? 16_000
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request.user }]

    let lastError = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      const body = {
        model: this.model,
        max_tokens: maxTokens,
        system: request.system,
        messages,
        output_config: { effort: request.effort, format: { type: format.type, schema: format.schema } },
      }
      const text = await this.call(request, body)
      const parsed = parse(text, request.schema)
      if (parsed.ok) return parsed.value
      lastError = parsed.error
      // A shape failure gets one correction turn showing the model what was wrong.
      messages.push({ role: 'assistant', content: text || '(empty answer)' })
      messages.push({ role: 'user', content: `That answer did not match the required JSON shape: ${parsed.error}. Answer again with the corrected JSON only.` })
    }
    throw new MalformedOutputError(`${request.prompt.name} returned malformed output twice: ${lastError}`)
  }

  private async call(request: LlmJsonRequest<z.ZodType>, body: Anthropic.MessageCreateParamsNonStreaming & Record<string, unknown>): Promise<string> {
    const requestHash = stableHash({ prompt: request.prompt, body })
    const cached = await this.db.query<{ response: Anthropic.Message }>(
      `select response from llm_calls where request_hash = $1 and status = 'done'`,
      [requestHash],
    )
    if (cached.rows[0]) return textOf(cached.rows[0].response)

    const estimated = estimate(request.system, JSON.stringify(body.messages), body.max_tokens)
    await assertWithinBudget(this.db, request.storeId, estimated)
    const { rows } = await this.db.query<{ id: number }>(
      `insert into llm_calls (store_id, request_hash, prompt_name, prompt_version, model, request, estimated_cost_usd)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [request.storeId, requestHash, request.prompt.name, request.prompt.version, this.model, JSON.stringify(body), estimated],
    )
    const callId = rows[0]!.id

    let response: Anthropic.Message
    try {
      response = await this.client.messages.create(body)
    } catch (error) {
      await this.db.query(`update llm_calls set status = 'failed', completed_at = now(), cost_usd = 0 where id = $1`, [callId])
      throw error
    }
    const cost = priceOf(response.usage)
    if (response.stop_reason === 'refusal') {
      await this.db.query(`update llm_calls set status = 'failed', response = $2, cost_usd = $3, completed_at = now() where id = $1`, [callId, JSON.stringify(response), cost])
      throw new ModelRefusedError(`${request.prompt.name}: the model declined to answer`)
    }
    await this.db.query(
      `update llm_calls set status = 'done', response = $2, cost_usd = $3, completed_at = now() where id = $1`,
      [callId, JSON.stringify(response), cost],
    )
    if (response.stop_reason === 'max_tokens') return ''
    return textOf(response)
  }
}

function textOf(message: Anthropic.Message): string {
  return message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
}

function parse<S extends z.ZodType>(text: string, schema: S): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  const result = schema.safeParse(json)
  return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.message.slice(0, 500) }
}
