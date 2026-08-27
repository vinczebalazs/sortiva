import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv, { type ErrorObject } from 'ajv'
import { parse as parseYaml } from 'yaml'
import type { DeepPartial, RulesDocument, RulesLayer } from './types.js'

const packageRoot = new URL('../', import.meta.url)

export const CONFIG_PATH = fileURLToPath(new URL('signals.config.yaml', packageRoot))
const SCHEMA_PATH = fileURLToPath(new URL('schema/signals.config.schema.json', packageRoot))

/** Thrown at load. main §7.10 / tech §2: the config is validated at worker start, so this fails startup. */
export class RulesConfigError extends Error {
  constructor(
    message: string,
    readonly detail: string[] = [],
  ) {
    super(detail.length > 0 ? `${message}\n  - ${detail.join('\n  - ')}` : message)
    this.name = 'RulesConfigError'
  }
}

export interface RulesConfig {
  /** sha256 of the config file's bytes. Stamped on every opportunity and gate decision (main §7.10). */
  readonly rulesVersion: string
  readonly version: number
  /** Global defaults, no locale layer applied. */
  readonly defaults: RulesLayer
  /** Locale keys this config actually overrides. */
  readonly localeKeys: readonly string[]
  /**
   * Thresholds for a store's locale. Resolution: exact tag ("da-DK"), then the
   * language subtag ("da"), then global defaults (main §7.10 layering).
   */
  forLocale(locale?: string | null): RulesLayer
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Later layers win. Arrays are replaced wholesale, never concatenated. */
function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (override === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    const existing = out[key]
    out[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing, value as DeepPartial<typeof existing>)
        : value
  }
  return out as T
}

function formatErrors(errors: ErrorObject[] | null | undefined, prefix: string): string[] {
  return (errors ?? []).map((e) => `${prefix}${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
}

export interface LoadOptions {
  /** Override the config file. Used by tests to prove invalid YAML fails and that the hash tracks content. */
  configPath?: string
  /** Read the document from a string instead of disk. Takes precedence over `configPath`. */
  source?: string
}

export function loadRulesConfig(options: LoadOptions = {}): RulesConfig {
  const path = options.configPath ?? CONFIG_PATH
  const raw = options.source ?? readFileSync(path, 'utf8')

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (error) {
    throw new RulesConfigError(`signals.config.yaml is not valid YAML (${path})`, [
      error instanceof Error ? error.message : String(error),
    ])
  }

  const ajv = new Ajv({ allErrors: true, strict: false })
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object
  const validate = ajv.compile(schema)

  if (!validate(parsed)) {
    throw new RulesConfigError(
      `signals.config.yaml failed schema validation (${path})`,
      formatErrors(validate.errors, ''),
    )
  }

  const doc = parsed as RulesDocument
  const locales = doc.locales ?? {}

  // A locale layer restates only what it changes, so it cannot be validated on
  // its own. Validating the *merged* result against the same schema is what
  // turns a typo in an override into a startup failure instead of a value that
  // is silently never read.
  const { definitions } = schema as { definitions: object }
  const layerValidate = ajv.compile({ definitions, $ref: '#/definitions/layer' })
  const resolved = new Map<string, RulesLayer>()
  for (const [key, override] of Object.entries(locales)) {
    const merged = deepMerge(doc.defaults, override)
    if (!layerValidate(merged)) {
      throw new RulesConfigError(
        `signals.config.yaml locale override "${key}" produces an invalid layer`,
        formatErrors(layerValidate.errors, `locales.${key}`),
      )
    }
    resolved.set(key, merged)
  }

  const rulesVersion = createHash('sha256').update(raw, 'utf8').digest('hex')

  return {
    rulesVersion,
    version: doc.version,
    defaults: doc.defaults,
    localeKeys: Object.keys(locales),
    forLocale(locale) {
      if (!locale) return doc.defaults
      const exact = resolved.get(locale)
      if (exact) return exact
      const language = locale.split(/[-_]/)[0]?.toLowerCase()
      if (language) {
        const byLanguage = resolved.get(language)
        if (byLanguage) return byLanguage
      }
      return doc.defaults
    },
  }
}

let cached: RulesConfig | undefined

/**
 * Process-wide config. tech §2: "Loaded once per process; no DB lookup in the
 * hot path."
 */
export function rules(): RulesConfig {
  cached ??= loadRulesConfig()
  return cached
}

/** Test-only: drops the process cache so a test can load a different document. */
export function resetRulesCache(): void {
  cached = undefined
}
