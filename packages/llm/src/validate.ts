import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'

/**
 * main §14.2 — "Schema validation on every model call (distillation, persona,
 * seeds, judge): validate against a JSON Schema; … never 'parse what we can'."
 */

const ajv = new Ajv({ allErrors: true, strict: false })
const compiled = new WeakMap<object, ValidateFunction>()

function compile(schema: object): ValidateFunction {
  const hit = compiled.get(schema)
  if (hit) return hit
  const fn = ajv.compile(schema)
  compiled.set(schema, fn)
  return fn
}

function format(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
}

/**
 * Models routinely wrap JSON in a fenced block. Stripping the fence is not
 * "parsing what we can" — the payload inside is still parsed strictly, and a
 * truncated or malformed body fails.
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let body = text.trim()
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/)
  if (fence?.[1]) body = fence[1].trim()

  try {
    return { ok: true, value: JSON.parse(body) }
  } catch (error) {
    return { ok: false, error: `response is not valid JSON: ${(error as Error).message}` }
  }
}

export type ValidationOutcome =
  | { ok: true; value: unknown }
  | { ok: false; errors: string[] }

export function validateCompletion(text: string, schema: object | undefined): ValidationOutcome {
  if (!schema) return { ok: true, value: text }

  const parsed = extractJson(text)
  if (!parsed.ok) return { ok: false, errors: [parsed.error] }

  const validate = compile(schema)
  if (validate(parsed.value)) return { ok: true, value: parsed.value }
  return { ok: false, errors: format(validate.errors) }
}
