import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv, { type ErrorObject } from 'ajv'
import { parse as parseYaml } from 'yaml'
import type { DeepPartial, RulesDocument, RulesLayer } from './types'

/**
 * The fallback click curve is read by position, so a missing position would be
 * read as "nobody ever clicks here" rather than as a hole in the table — and a
 * store with no history of its own would then be told every one of its pages is
 * under-clicked. Checked while the document is read, so a hole is a refusal to
 * serve any threshold at all rather than a plausible-looking wrong answer.
 */
function assertStandardCurveComplete(layer: RulesLayer, label: string): void {
  const missing: string[] = []
  for (let position = 1; position <= layer.ctr_curve.max_position; position += 1) {
    if (typeof layer.ctr_curve.standard_curve[String(position)] !== 'number') {
      missing.push(String(position))
    }
  }
  if (missing.length > 0) {
    throw new RulesConfigError(
      `signals.config.yaml ${label} ctr_curve.standard_curve is missing positions`,
      missing,
    )
  }
}

/**
 * Where this package sits on disk, worked out **when a threshold is first
 * asked for** and never when this module is loaded.
 *
 * Two separate hazards are being avoided here, and both have bitten.
 *
 * A module's address is a real file path only when the code runs from the
 * repository tree. Bundled into the production web build it is not, so doing
 * this at the top level threw the instant anything imported this package — and
 * what imported it was the server's start-up hook, which Next treats as a
 * failed server. Every route answered 500, the landing page and the health
 * check included, while the build and the whole test suite stayed green.
 * Deferring the work to the first caller keeps the file out of the bundle,
 * which is the point of keeping the numbers in a file at all: they can be
 * changed without a deploy.
 *
 * The path is also *composed* rather than written as
 * `new URL('<literal>', import.meta.url)`. The bundler reads that exact form as
 * an asset reference it must resolve while building, and rewrites it to a
 * public URL with no disk behind it. Composing the same path is invisible to it
 * and resolves identically at runtime.
 */
function packageDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/** The config file this process will read. Resolved per call; callers cache the parsed document, not the path. */
export function configPath(): string {
  return join(packageDir(), 'signals.config.yaml')
}

function schemaPath(): string {
  return join(packageDir(), 'schema', 'signals.config.schema.json')
}

/** Reads one of the two files the config layer needs, turning "it is not there" into a sentence naming what is missing. */
function readConfigFile(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new RulesConfigError(
      `${what} could not be read at ${path}. Every threshold the product applies comes from this file; nothing can run without it.`,
      [error instanceof Error ? error.message : String(error)],
    )
  }
}

/**
 * Thrown on the first call that needs a threshold. Since the document is read
 * then rather than at start-up, this error is the only thing that says the
 * configuration is wrong — so it names the file and the path every time.
 */
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
  /** sha256 of the config file's bytes. Stamped on every opportunity and gate decision, so any result can be traced back to the exact numbers that produced it. */
  readonly rulesVersion: string
  readonly version: number
  /** Global defaults, no locale layer applied. */
  readonly defaults: RulesLayer
  /** Locale keys this config actually overrides. */
  readonly localeKeys: readonly string[]
  /**
   * Thresholds for a store's locale. Resolution: exact tag ("da-DK"), then the
   * language subtag ("da"), then global defaults.
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
  const path = options.configPath ?? configPath()
  const raw = options.source ?? readConfigFile(path, 'signals.config.yaml')

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (error) {
    throw new RulesConfigError(`signals.config.yaml is not valid YAML (${path})`, [
      error instanceof Error ? error.message : String(error),
    ])
  }

  const ajv = new Ajv({ allErrors: true, strict: false })
  const schema = JSON.parse(
    readConfigFile(schemaPath(), "signals.config.yaml's schema"),
  ) as object
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
    assertStandardCurveComplete(merged, `locale "${key}"`)
    resolved.set(key, merged)
  }

  assertStandardCurveComplete(doc.defaults, 'defaults')

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
 * Process-wide config: read from disk by the first caller that needs a number
 * and held from then on, so reading a threshold costs nothing after that and
 * merely importing this package costs nothing at all.
 */
export function rules(): RulesConfig {
  cached ??= loadRulesConfig()
  return cached
}

/** Test-only: drops the process cache so a test can load a different document. */
export function resetRulesCache(): void {
  cached = undefined
}
