/**
 * Every structured call is validated against a JSON Schema after the fact, and
 * until this existed the schema was never sent to the model — not as a tool,
 * not as a response format, not in the prompt text. Prompts told the model to
 * "match the schema exactly" and nothing gave it the means to: it had to guess
 * the property names and how they nested. The judge guessed wrong often enough
 * that one call in ten produced no answer at all, twice over, and ended in
 * `failed_validation` — in production, an article paused with no score.
 *
 * The fix is central rather than per prompt so that a prompt written next year
 * cannot forget it, and so the eleven prompts no eval set covers are fixed by
 * the same change as the one it does.
 *
 * It is appended to the **system** text on purpose: the request cache is keyed
 * on the system text among other things, so adding the schema changes every
 * key by construction and an answer cached before this change can never be
 * replayed against a request that now asks a slightly different question.
 */
export function systemWithSchema(
  system: string | undefined,
  schema: object | undefined,
): string | undefined {
  if (!schema) return system

  const block = [
    'Your entire reply must be one JSON value that validates against this JSON Schema:',
    '',
    JSON.stringify(schema, null, 2),
    '',
    'Use exactly the property names it gives, nested exactly as it nests them, and ' +
      'include every required one. Return that JSON and nothing else: no preamble, ' +
      'no markdown fence, no commentary.',
  ].join('\n')

  return system === undefined || system === '' ? block : `${system}\n\n${block}`
}
