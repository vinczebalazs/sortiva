import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * main §14.2 — "prompts live in versioned files in the repo"; every artefact is
 * stamped with `prompt_version` + `model_id` so any output is reproducible and
 * drift is attributable. CLAUDE.md fixes the filename: `prompts/<name>.v<N>.md`.
 *
 * Versions are never edited in place. A prompt change is a new file at the next
 * version, which is what makes `prompt_version` on a stored artefact mean
 * something a year later — and what lets the eval suite (§14.2) run the old and
 * the new side by side.
 */

const PROMPTS_DIR = new URL('../prompts/', import.meta.url)

export interface Prompt {
  /** `<name>.v<N>` — the value stamped on artefacts and captured on every event. */
  readonly version: string
  readonly name: string
  readonly majorVersion: number
  readonly text: string
}

const cache = new Map<string, Prompt>()

export function loadPrompt(name: string, majorVersion: number): Prompt {
  const version = `${name}.v${majorVersion}`
  const hit = cache.get(version)
  if (hit) return hit

  const path = fileURLToPath(new URL(`${version}.md`, PROMPTS_DIR))
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `Prompt "${version}" not found at ${path}. Prompts are versioned files; bump the version rather than editing one in place (main §14.2).`,
      { cause: error },
    )
  }

  const prompt: Prompt = { version, name, majorVersion, text }
  cache.set(version, prompt)
  return prompt
}

/**
 * `{{name}}` substitution. Deliberately not a template engine: a prompt with
 * conditionals is a prompt whose stamped version no longer tells you what the
 * model was asked. An unknown placeholder is an error, not an empty string —
 * silently rendering "" is how a fact sheet gets built from nothing.
 */
export function renderPrompt(prompt: Prompt, vars: Record<string, string | number> = {}): string {
  const missing: string[] = []
  const rendered = prompt.text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key]
    if (value === undefined) {
      missing.push(key)
      return ''
    }
    return String(value)
  })
  if (missing.length > 0) {
    throw new Error(`Prompt ${prompt.version} has unfilled placeholders: ${missing.join(', ')}`)
  }
  return rendered
}

/** Test-only: drops the file cache. */
export function resetPromptCache(): void {
  cache.clear()
}
