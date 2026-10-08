import type { z } from 'zod'

export type Effort = 'low' | 'medium' | 'high'

export type LlmJsonRequest<S extends z.ZodType> = {
  storeId: number | null
  prompt: { name: string; version: string }
  system: string
  user: string
  schema: S
  effort: Effort
  maxTokens?: number
}

/** The one door every model call goes through. Implemented in vendors/anthropic. */
export interface Llm {
  json<S extends z.ZodType>(request: LlmJsonRequest<S>): Promise<z.infer<S>>
}
