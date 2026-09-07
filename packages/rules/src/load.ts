import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv, { type ErrorObject } from 'ajv'
import { parse as parseYaml } from 'yaml'
import {
  RulesOverrideError,
  assertOverrideValue,
  describeScope,
  overrideApplies,
  patchFromKey,
  sortOverrides,
  type RulesOverrideRow,
  type RulesOverrideScope,
} from './overrides'
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

/** One override that survived the fold: the number it changed, and where the winning row was aimed. */
export interface AppliedOverride {
  readonly key: string
  readonly value: unknown
  readonly scope: RulesOverrideScope
  readonly updatedBy: string
}

export interface ResolvedRules {
  /** The numbers this store is actually judged by. */
  readonly layer: RulesLayer
  /**
   * What to stamp on the decisions this layer produces. The bare file hash when
   * nothing was overridden; the file hash plus a marker for the overrides when
   * something was. See `resolve` for why.
   */
  readonly rulesVersion: string
  /** Empty when the store is on the repo file's numbers. Ordered by key. */
  readonly appliedOverrides: readonly AppliedOverride[]
}

export interface ResolveOptions {
  locale?: string | null
  /** Only rows aimed at this page type, plus the rows that name none, are folded in. */
  pageType?: string | null
  /** Rows read from `rules_overrides`. Order does not matter; `resolve` sorts them. */
  overrides?: readonly RulesOverrideRow[]
  /** The store the rows were read for. Rows aimed at a different account are refused rather than dropped. */
  accountId?: string | null
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
  /**
   * The locale layer with `rules_overrides` rows folded on top, and the version
   * to stamp on whatever it decides.
   *
   * **Why the version is not always the file hash.** `rules_version` exists so a
   * decision can be explained later by the numbers that produced it, and the
   * learning loop and every audit read it as exactly that. The file hash covers
   * the repo file — defaults and every locale layer. It cannot cover a database
   * row, so a store carrying an override that stamped the plain file hash would
   * be claiming it was judged by numbers it was not judged by. So an overridden
   * store stamps `<file hash>+ov.<16 hex of the overrides>`: the base stays
   * legible and comparable, and two stores given the same overrides stamp the
   * same string, which keeps a breakdown by `rules_version` meaningful. A store
   * on the repo file's numbers stamps exactly what it stamps today.
   *
   * Throws `RulesOverrideError` if any row is malformed. Refusing is deliberate:
   * a threshold that quietly fails to apply is worse than one never set.
   */
  resolve(options?: ResolveOptions): ResolvedRules
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
  // turns a typo in an override into a refusal to serve any threshold at all,
  // instead of a value that is silently never read.
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

  function forLocale(locale?: string | null): RulesLayer {
    if (!locale) return doc.defaults
    const exact = resolved.get(locale)
    if (exact) return exact
    const language = locale.split(/[-_]/)[0]?.toLowerCase()
    if (language) {
      const byLanguage = resolved.get(language)
      if (byLanguage) return byLanguage
    }
    return doc.defaults
  }

  function resolve(options: ResolveOptions = {}): ResolvedRules {
    const base = forLocale(options.locale)
    const rows = options.overrides ?? []
    if (rows.length === 0) {
      return { layer: base, rulesVersion, appliedOverrides: [] }
    }

    const wanted: RulesOverrideScope = {
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
      ...(options.pageType ? { pageType: options.pageType } : {}),
    }

    // A row that does not apply here is a mistake in the read, not a row to
    // skip: the caller asked the table for this store's rows and got somebody
    // else's. Ignoring it would hide a scoping bug behind correct-looking
    // behaviour.
    const misaimed = rows.filter((row) => !overrideApplies(row.scope, wanted))
    if (misaimed.length > 0) {
      throw new RulesOverrideError(
        `rules_overrides rows were supplied that do not apply to ${describeScope(wanted)}`,
        misaimed.map((row) => `${row.key} (aimed at ${describeScope(row.scope)})`),
      )
    }

    // Least specific first, so the narrowest row is the one left standing.
    const winners = new Map<string, AppliedOverride>()
    let layer = base
    for (const row of sortOverrides(rows)) {
      const path = assertOverrideValue(doc.defaults, row.key, row.value)
      layer = deepMerge(layer, patchFromKey(path, row.value) as DeepPartial<RulesLayer>)
      winners.set(row.key, {
        key: row.key,
        value: row.value,
        scope: row.scope,
        updatedBy: row.updatedBy,
      })
    }

    // The same reasoning as the locale layers above: a row can be individually
    // well-formed and still produce a layer the product cannot run on — a ratio
    // above 1, a position band that starts after it ends, a click curve with a
    // hole in it. Refusing here is what stops a store being judged by numbers
    // nobody checked.
    if (!layerValidate(layer)) {
      throw new RulesOverrideError(
        `rules_overrides for ${describeScope(wanted)} produce an invalid set of thresholds`,
        formatErrors(layerValidate.errors, ''),
      )
    }
    try {
      assertStandardCurveComplete(layer, `overrides for ${describeScope(wanted)}`)
    } catch (error) {
      throw new RulesOverrideError(
        `rules_overrides for ${describeScope(wanted)} produce an invalid set of thresholds`,
        [error instanceof Error ? error.message : String(error)],
      )
    }

    const appliedOverrides = [...winners.values()].sort((a, b) => (a.key < b.key ? -1 : 1))

    // Hashed over what actually applied — the winning key/value pairs — and not
    // over the rows, so two stores given the same override stamp the same
    // version and a breakdown by `rules_version` groups them together.
    const fingerprint = createHash('sha256')
      .update(
        appliedOverrides.map((applied) => `${applied.key}=${JSON.stringify(applied.value)}`).join('\n'),
        'utf8',
      )
      .digest('hex')
      .slice(0, OVERRIDE_FINGERPRINT_CHARS)

    return { layer, rulesVersion: `${rulesVersion}+ov.${fingerprint}`, appliedOverrides }
  }

  return {
    rulesVersion,
    version: doc.version,
    defaults: doc.defaults,
    localeKeys: Object.keys(locales),
    forLocale,
    resolve,
  }
}

/**
 * How much of the override hash goes into the stamp. Long enough that two
 * different override sets colliding is not a thing that happens; short enough
 * that an operator can read the stamp off a row and compare it by eye.
 */
const OVERRIDE_FINGERPRINT_CHARS = 16

/** True for a version stamped on a decision made with `rules_overrides` in play. */
export function versionCarriesOverrides(version: string): boolean {
  return version.includes('+ov.')
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
