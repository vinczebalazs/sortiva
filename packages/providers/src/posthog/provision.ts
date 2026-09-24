import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Dashboards, insights and alerts as files, applied to the analytics project by
 * a script rather than clicked together by hand.
 *
 * Why it is worth the machinery: a dashboard somebody built in the vendor's UI
 * cannot be code-reviewed, drifts the moment anyone edits it, and cannot be
 * recreated when the project is reset or a staging environment is spun up. So
 * the repo is the truth, and a chart nobody put in a file here does not
 * officially exist. Exploring in the UI is fine; anything the team relies on
 * gets promoted into a definition.
 *
 * Two properties carry the whole design:
 *
 * - **A stable `key`, not a name.** Everything is created-or-updated by key, so
 *   running the script twice converges instead of making a second copy. Names
 *   can be edited in the UI; the key cannot, because it lives in a marker the
 *   script writes into the object's description.
 * - **Check mode compares, never writes.** It is what runs on every merge, and
 *   it fails on any difference — an object missing, an object edited by hand,
 *   or an object in the project that no file claims. "Somebody tweaked it in
 *   the UI" is exactly the drift this exists to catch, so an edited chart fails
 *   the build rather than quietly winning.
 *
 * This module is the vendor-shaped half. It knows nothing about which
 * dashboards we want — that is `ops/posthog/definitions/*.json`.
 */

export type DefinitionKind = 'dashboard' | 'insight' | 'alert' | 'group_type'

const KINDS: readonly DefinitionKind[] = ['dashboard', 'insight', 'alert', 'group_type']

export interface Definition {
  kind: DefinitionKind
  /** Stable and unique within its kind. The create-or-update key. */
  key: string
  name: string
  description: string
  /** Everything else the kind needs: a query, a tile list, a threshold. */
  [field: string]: unknown
}

export interface LoadedDefinition extends Definition {
  sourceFile: string
}

/**
 * The analytics project refuses a longer chart description, and finds out only
 * halfway through an apply — after the charts before it were already written.
 */
const INSIGHT_DESCRIPTION_MAX = 400

/** Raised for anything wrong with the files themselves, with a message meant to be read. */
export class DefinitionError extends Error {}

/**
 * The marker that ties a live object back to its file.
 *
 * It goes in the description, where a person who opens the chart in the UI sees
 * it — which is the point: it says out loud that this was made from the repo
 * and that editing it here will fail the next build.
 */
export function marker(key: string): string {
  return `[managed by sortiva — edit ops/posthog/definitions, not this. key=${key}]`
}

export function describeWithMarker(definition: Definition): string {
  return `${definition.description}\n\n${marker(definition.key)}`
}

const MARKER_PATTERN = /\[managed by sortiva — edit ops\/posthog\/definitions, not this\. key=([^\]]+)\]/

export function keyFromDescription(description: string | null | undefined): string | undefined {
  return MARKER_PATTERN.exec(description ?? '')?.[1]
}

/** A stable fingerprint of what a definition asks for, so "is this still what we asked for" is one comparison. */
export function fingerprint(definition: Definition): string {
  const { sourceFile: _ignored, ...rest } = definition as LoadedDefinition
  return createHash('sha256').update(canonical(rest)).digest('hex').slice(0, 16)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * Reads every definition file, and refuses on anything that would make the
 * apply ambiguous: an unknown kind, a missing key, the same key twice, or a
 * dashboard whose tiles name an insight nobody defined.
 *
 * That last check is the one that pays for itself. A dashboard referring to a
 * chart that does not exist applies cleanly and produces an empty dashboard,
 * which looks like a working dashboard with nothing to show.
 */
export function loadDefinitions(directory: string): LoadedDefinition[] {
  if (!existsSync(directory)) return []
  const files = readdirSync(directory).filter((f) => f.endsWith('.json')).sort()
  const seen = new Map<string, string>()
  const definitions: LoadedDefinition[] = []

  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    } catch (error) {
      throw new DefinitionError(
        `${file}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    for (const raw of Array.isArray(parsed) ? parsed : [parsed]) {
      const definition = raw as Definition
      if (!KINDS.includes(definition.kind)) {
        throw new DefinitionError(
          `${file}: unknown kind "${String(definition.kind)}" (expected one of ${KINDS.join(', ')})`,
        )
      }
      if (!definition.key) {
        throw new DefinitionError(
          `${file}: every definition needs a stable "key" — it is what makes re-running converge instead of duplicating`,
        )
      }
      if (!definition.name) throw new DefinitionError(`${file}: ${definition.key} has no "name"`)
      if (!definition.description) {
        throw new DefinitionError(
          `${file}: ${definition.key} has no "description" — it is where the marker that identifies it lives, and where the next person finds out what the chart is for`,
        )
      }
      if (
        definition.kind === 'insight' &&
        describeWithMarker(definition).length > INSIGHT_DESCRIPTION_MAX
      ) {
        throw new DefinitionError(
          `${file}: ${definition.key}'s description is too long — with the marker added it is ${describeWithMarker(definition).length} characters, and the analytics project refuses a chart description over ${INSIGHT_DESCRIPTION_MAX}. Shorten it by ${describeWithMarker(definition).length - INSIGHT_DESCRIPTION_MAX}.`,
        )
      }
      const id = `${definition.kind}:${definition.key}`
      const first = seen.get(id)
      if (first !== undefined) {
        throw new DefinitionError(`${file}: duplicate ${id}, already defined in ${first}`)
      }
      seen.set(id, file)
      definitions.push({ ...definition, sourceFile: file })
    }
  }

  const insights = new Set(
    definitions.filter((d) => d.kind === 'insight').map((d) => d.key),
  )
  const alertOnChart = new Map<string, LoadedDefinition>()
  for (const definition of definitions) {
    if (definition.kind === 'dashboard') {
      for (const tile of (definition.tiles as string[] | undefined) ?? []) {
        if (!insights.has(tile)) {
          throw new DefinitionError(
            `${definition.sourceFile}: dashboard "${definition.key}" puts "${tile}" on itself, but no insight is defined with that key. It would apply cleanly and show an empty dashboard.`,
          )
        }
      }
    }
    if (definition.kind === 'alert') {
      const on = definition.insight as string | undefined
      if (!on || !insights.has(on)) {
        throw new DefinitionError(
          `${definition.sourceFile}: alert "${definition.key}" watches "${String(on)}", which is not a defined insight. An alert on nothing never fires.`,
        )
      }
      const other = alertOnChart.get(on)
      if (other) {
        throw new DefinitionError(
          `${definition.sourceFile}: alerts "${other.key}" and "${definition.key}" both watch "${on}". An alert is recognised in the project by the chart it watches, so one chart can carry one alert — give the second its own chart.`,
        )
      }
      alertOnChart.set(on, definition)
    }
  }

  return definitions
}

/**
 * Who alert emails go to, as a list of email addresses in the repo, so that
 * changing it is a reviewed edit like every other definition.
 */
export function loadRecipients(file: string): string[] {
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new DefinitionError(
      `${file}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === 'string' && e.includes('@'))) {
    throw new DefinitionError(`${file}: expected a list of email addresses`)
  }
  return parsed as string[]
}

/**
 * Turns the recipient list into the project's user ids — the only form an
 * alert accepts — and refuses rather than dropping anyone it cannot find,
 * because an alert that quietly emails nobody looks exactly like a quiet week.
 */
async function recipientIds(
  api: PosthogAdminApi,
  recipients: readonly string[],
): Promise<(string | number)[]> {
  if (recipients.length === 0) {
    throw new DefinitionError(
      'alerts are defined but nobody receives them: add an email address to ops/posthog/alert-recipients.json',
    )
  }
  const users = await api.users()
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]))
  const missing = recipients.filter((email) => !byEmail.has(email.toLowerCase()))
  if (missing.length > 0) {
    throw new DefinitionError(
      `alert recipient${missing.length === 1 ? '' : 's'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not among the analytics users this key can see (${users.map((u) => u.email).join(', ') || 'none'}). ` +
        'Alerts can only email people with a login in the analytics organisation. Invite them there; and unless the address is the key owner\'s own, ' +
        'the key needs access to the whole organisation (not one project) with the "Organization member: Read" scope, so the list can be read.',
    )
  }
  return sortIds(recipients.map((email) => byEmail.get(email.toLowerCase())!))
}

/**
 * Which of our definitions a live object is, if any.
 *
 * Charts, dashboards and group types carry their key in a marker in their
 * description. Alerts have no description, so an alert is ours when it watches
 * one of our charts, and it is whichever alert the files define on that chart —
 * which is why the files allow at most one per chart. An alert on one of our
 * charts that no file defines gets a key no definition has, so it reads as
 * unmanaged rather than vanishing.
 */
function keyOf(
  kind: DefinitionKind,
  object: LiveObject,
  definitions: readonly Definition[],
  chartKeyById: (id: unknown) => string | undefined,
): string | undefined {
  if (kind !== 'alert') return keyFromDescription(object.description)
  const chart = chartKeyById(object.payload.insight)
  if (chart === undefined) return undefined
  return (
    definitions.find((d) => d.kind === 'alert' && d.insight === chart)?.key ??
    `${UNCLAIMED_ALERT}${chart}`
  )
}

const UNCLAIMED_ALERT = 'unclaimed alert on '

/** One object as it exists in the analytics project, reduced to what we compare. */
export interface LiveObject {
  id: string | number
  name: string
  description: string | null
  /** Everything else the project holds for it, for the field-by-field comparison. */
  payload: Record<string, unknown>
}

/**
 * The vendor, as the two things this needs from it. An interface rather than a
 * fetch call so the whole apply-and-check cycle can be driven against an
 * in-memory project in a test — which is the only way "run it twice, get one
 * copy" is proved rather than asserted.
 */
export interface PosthogAdminApi {
  list(kind: DefinitionKind): Promise<LiveObject[]>
  create(kind: DefinitionKind, body: Record<string, unknown>): Promise<LiveObject>
  update(kind: DefinitionKind, id: string | number, body: Record<string, unknown>): Promise<LiveObject>
  /** The people an alert could email: everyone this key can see with a login in the project's organisation. */
  users(): Promise<{ id: string | number; email: string }[]>
}

/**
 * What `bodyFor` needs beyond the definition itself. The files refer to each
 * other by key, but the project only understands its own numeric ids, so a
 * reference can only be written once the thing it points at exists.
 */
export interface BodyContext {
  definitions: readonly Definition[]
  /** The live id of one of our objects, or undefined if it is not in the project yet. */
  idOf: (kind: DefinitionKind, key: string) => string | number | undefined
  /** The user ids alert emails go to. */
  recipients: readonly (string | number)[]
}

const NO_CONTEXT: BodyContext = { definitions: [], idOf: () => undefined, recipients: [] }

/**
 * Chart queries the vendor stores inside a visualisation wrapper. It wraps a
 * bare query itself on the way in, so sending the wrapped form is what makes
 * the stored query comparable with the file at all.
 */
const ALREADY_WRAPPED = new Set(['InsightVizNode', 'DataVisualizationNode', 'DataTableNode'])

function wrapQuery(query: unknown): unknown {
  if (!query || typeof query !== 'object') return query ?? null
  const kind = (query as { kind?: unknown }).kind
  if (typeof kind === 'string' && ALREADY_WRAPPED.has(kind)) return query
  return { kind: 'InsightVizNode', source: query }
}

/**
 * What the project should hold for one definition. Kind-specific shaping lives
 * here so both the writer and the comparison work from one answer.
 *
 * A dashboard carries no chart list: the vendor ignores one sent on a
 * dashboard. Placement is written from the other side, as the list of
 * dashboards each chart sits on — the only form it accepts.
 */
export function bodyFor(
  definition: Definition,
  context: BodyContext = NO_CONTEXT,
): Record<string, unknown> {
  const base = { name: definition.name, description: describeWithMarker(definition) }
  switch (definition.kind) {
    case 'insight': {
      const dashboards = context.definitions
        .filter(
          (d) =>
            d.kind === 'dashboard' &&
            ((d.tiles as string[] | undefined) ?? []).includes(definition.key),
        )
        .map((d) => context.idOf('dashboard', d.key))
        .filter((id): id is string | number => id !== undefined)
      return { ...base, query: wrapQuery(definition.query), dashboards: sortIds(dashboards) }
    }
    case 'dashboard':
      return base
    case 'alert':
      // Every alert here is "this line crossed this number". The vendor's
      // other conditions compare against the previous period instead, which is
      // not what any cap in our own code does.
      // No description: alerts have none in the project, so the file's
      // description is for whoever reads the file.
      return {
        name: definition.name,
        insight: context.idOf('insight', definition.insight as string) ?? null,
        subscribed_users: sortIds(context.recipients),
        condition: { type: 'absolute_value' },
        threshold: definition.threshold ? { configuration: definition.threshold } : null,
        config: {
          type: 'TrendsAlertConfig',
          // A chart with a formula has one line, the formula's, at index 0.
          series_index: definition.series_index ?? 0,
          // Off means only finished periods are judged. Right for a rate, where
          // a day three drafts old is noise; wrong for spend, which only rises
          // within a day, so a partial day over the cap is already over it.
          check_ongoing_interval: definition.check_ongoing_interval ?? false,
        },
        calculation_interval: definition.calculation_interval ?? 'hourly',
      }
    case 'group_type':
      return { ...base, group_type_index: definition.group_type_index ?? 0 }
  }
}

function sortIds<T>(ids: readonly T[]): T[] {
  return [...ids].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
}

export type DriftReason = 'missing' | 'edited' | 'unmanaged'

export interface Drift {
  kind: DefinitionKind
  key: string
  reason: DriftReason
  /** One line an operator can act on. */
  detail: string
}

/**
 * The fields where the project no longer holds what the file asks for.
 *
 * "Holds" means every value the file sets is there, unchanged — not that the
 * two are identical. The vendor fills in settings the files never mention (a
 * chart's interval, a query-format version, empty filter lists), and counting
 * those as edits made every chart fail the check the moment it was created.
 * The price: an edit in the UI to a setting no file mentions goes unnoticed.
 * Anything worth guarding is guarded by writing it into the file.
 */
function differences(want: Record<string, unknown>, live: LiveObject): string[] {
  const found: string[] = []
  const actual: Record<string, unknown> = {
    name: live.name,
    description: live.description ?? '',
    ...live.payload,
  }
  for (const [field, expected] of Object.entries(want)) {
    if (!holds(actual[field], expected)) found.push(field)
  }
  return found
}

function holds(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => holds(actual[i], item))
    )
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    return Object.entries(expected as Record<string, unknown>).every(
      ([key, value]) => value === undefined || holds((actual as Record<string, unknown>)[key], value),
    )
  }
  return canonical(actual) === canonical(expected)
}

/** Every object of ours in the project, by kind and key. Charts are read before the alerts that are recognised by them. */
async function snapshot(
  api: PosthogAdminApi,
  definitions: readonly Definition[],
): Promise<Map<DefinitionKind, Map<string, LiveObject>>> {
  const byKind = new Map<DefinitionKind, Map<string, LiveObject>>()
  const chartKeyById = (id: unknown) =>
    [...(byKind.get('insight') ?? new Map<string, LiveObject>())].find(
      ([, chart]) => String(chart.id) === String(id),
    )?.[0]
  for (const kind of KINDS) {
    const byKey = new Map<string, LiveObject>()
    for (const object of await api.list(kind)) {
      const key = keyOf(kind, object, definitions, chartKeyById)
      if (key !== undefined) byKey.set(key, object)
    }
    byKind.set(kind, byKey)
  }
  return byKind
}

/** Options the script passes; the recipient list is only needed when an alert is defined. */
export interface ProvisionOptions {
  recipients?: readonly string[]
}

async function resolveRecipients(
  api: PosthogAdminApi,
  definitions: readonly Definition[],
  options: ProvisionOptions,
): Promise<(string | number)[]> {
  if (!definitions.some((d) => d.kind === 'alert')) return []
  return recipientIds(api, options.recipients ?? [])
}

/**
 * Compares the project against the repo without touching either.
 *
 * Three ways to drift, and all three fail: something we asked for is not there;
 * something we asked for has been changed in the UI; or something the project
 * holds carries our marker and no file claims it any more — which means a
 * definition was deleted and the chart it made is still on somebody's screen.
 */
export async function checkDrift(
  api: PosthogAdminApi,
  definitions: readonly LoadedDefinition[],
  options: ProvisionOptions = {},
): Promise<Drift[]> {
  const drift: Drift[] = []
  const live = await snapshot(api, definitions)
  const context: BodyContext = {
    definitions,
    idOf: (kind, key) => live.get(kind)?.get(key)?.id,
    recipients: await resolveRecipients(api, definitions, options),
  }

  for (const kind of KINDS) {
    const wanted = definitions.filter((d) => d.kind === kind)
    const byKey = live.get(kind)!

    for (const definition of wanted) {
      const found = byKey.get(definition.key)
      if (!found) {
        drift.push({
          kind,
          key: definition.key,
          reason: 'missing',
          detail:
            kind === 'group_type'
              ? // Not something --apply can fix: a group type appears when the
                // first event carries it. It is still drift, and still fails,
                // because until it exists every cost-by-domain breakdown is
                // empty — which looks like "this store costs nothing".
                `group type "${definition.key}" (${definition.sourceFile}) is not in the project. It appears when the first event carries it, so this means no event has — every breakdown by ${definition.key} is empty until one does.`
              : `${kind} "${definition.key}" (${definition.sourceFile}) is not in the project. Run the provisioner with --apply.`,
        })
        continue
      }
      const changed = differences(bodyFor(definition, context), found)
      if (changed.length > 0) {
        drift.push({
          kind,
          key: definition.key,
          reason: 'edited',
          detail: `${kind} "${definition.key}" has been changed in the analytics UI (${changed.join(', ')}). The repo is the truth: put the change in ${definition.sourceFile}, or re-apply to undo it.`,
        })
      }
    }

    const claimed = new Set(wanted.map((d) => d.key))
    for (const [key] of byKey) {
      if (!claimed.has(key)) {
        drift.push({
          kind,
          key,
          reason: 'unmanaged',
          detail: key.startsWith(UNCLAIMED_ALERT)
            ? `an alert on our chart "${key.slice(UNCLAIMED_ALERT.length)}" is in the project, but no definition file defines one there. Somebody added it by hand, or its definition was deleted — and --apply will take it over if a definition for that chart is added.`
            : `${kind} "${key}" is in the project and carries our marker, but no definition file claims it. Its definition was deleted and the chart is still on somebody's screen.`,
        })
      }
    }
  }

  return drift
}

export interface ApplyResult {
  created: string[]
  updated: string[]
  unchanged: string[]
  /** Things the API cannot create, said out loud rather than reported as done. */
  skipped: { id: string; why: string }[]
}

/**
 * Writes the repo's definitions into the project, creating what is missing and
 * updating what has changed.
 *
 * Idempotent by construction: every object is found again by its key marker, or
 * for an alert by the chart it watches, so a second run finds everything
 * already there and updates nothing. That is the property worth having — a
 * provisioner that duplicates on re-run is a provisioner nobody dares run.
 */
export async function apply(
  api: PosthogAdminApi,
  definitions: readonly LoadedDefinition[],
  options: ProvisionOptions = {},
): Promise<ApplyResult> {
  const result: ApplyResult = { created: [], updated: [], unchanged: [], skipped: [] }
  // Kinds are applied in reference order — dashboards, then the charts placed
  // on them, then the alerts watching those charts — so every id a body needs
  // is already here when that body is built.
  const ids = new Map<string, string | number>()
  const context: BodyContext = {
    definitions,
    idOf: (kind, key) => ids.get(`${kind}:${key}`),
    // Before any write, so an unknown recipient stops the run with nothing
    // half-applied.
    recipients: await resolveRecipients(api, definitions, options),
  }
  const chartKeyById = (id: unknown) =>
    [...ids].find(([k, v]) => k.startsWith('insight:') && String(v) === String(id))?.[0].slice(
      'insight:'.length,
    )

  for (const kind of KINDS) {
    const wanted = definitions.filter((d) => d.kind === kind)
    if (wanted.length === 0) continue
    const live = await api.list(kind)
    const byKey = new Map<string, LiveObject>()
    for (const object of live) {
      const key = keyOf(kind, object, definitions, chartKeyById)
      if (key === undefined) continue
      byKey.set(key, object)
      ids.set(`${kind}:${key}`, object.id)
    }

    for (const definition of wanted) {
      const id = `${kind}:${definition.key}`
      const body = bodyFor(definition, context)
      const found = byKey.get(definition.key)

      if (!found && kind === 'group_type') {
        // The analytics vendor creates a group type the first time an event
        // arrives carrying it; there is no endpoint that makes one. Saying so
        // is honest — reporting it as created would be a lie that goes
        // unnoticed until somebody asks why a breakdown is empty.
        result.skipped.push({
          id,
          why: 'a group type appears when the first event carries it; there is no API that creates one. Nothing to do here — send an event.',
        })
        continue
      }

      if (!found) {
        const created = await api.create(kind, body)
        ids.set(id, created.id)
        result.created.push(id)
        continue
      }
      if (differences(body, found).length === 0) {
        result.unchanged.push(id)
        continue
      }
      await api.update(kind, found.id, body)
      result.updated.push(id)
    }
  }

  return result
}

const ENDPOINTS: Record<DefinitionKind, string> = {
  dashboard: 'dashboards',
  insight: 'insights',
  alert: 'alerts',
  group_type: 'groups_types',
}

/**
 * The real project, over its admin API.
 *
 * Deliberately thin: everything that decides anything is above, so the parts
 * worth testing are tested against an in-memory project and this is the only
 * piece that needs a live key to exercise.
 */
export class HttpPosthogAdminApi implements PosthogAdminApi {
  constructor(
    private readonly options: { host: string; projectId: string; personalApiKey: string },
  ) {}

  private request(
    path: string,
    init: { method: string; body?: unknown } = { method: 'GET' },
  ): Promise<unknown> {
    return this.requestFromRoot(`/api/projects/${this.options.projectId}${path}`, init)
  }

  private async requestFromRoot(
    path: string,
    init: { method: string; body?: unknown } = { method: 'GET' },
  ): Promise<unknown> {
    const { host, personalApiKey } = this.options
    const response = await fetch(`${host}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${personalApiKey}`,
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    if (!response.ok) {
      throw new Error(
        `the analytics project answered ${response.status} to ${init.method} ${path}: ${await response.text()}`,
      )
    }
    return response.json()
  }

  /**
   * The organisation's members when the key may read them. A key limited to one
   * project may not — the vendor refuses every organisation-level read for such
   * a key — and then the only person it can name is its own owner.
   */
  async users(): Promise<{ id: string | number; email: string }[]> {
    const project = (await this.request('/')) as { organization?: string }
    try {
      const page = (await this.requestFromRoot(
        `/api/organizations/${project.organization}/members/?limit=500`,
      )) as { results?: { user?: { id: number; email: string } }[] }
      return (page.results ?? []).flatMap((m) => (m.user ? [m.user] : []))
    } catch (error) {
      if (!(error instanceof Error) || !/answered 403/.test(error.message)) throw error
      const me = (await this.requestFromRoot('/api/users/@me/')) as { id: number; email: string }
      return [{ id: me.id, email: me.email }]
    }
  }

  async list(kind: DefinitionKind): Promise<LiveObject[]> {
    const page = (await this.request(`/${ENDPOINTS[kind]}/?limit=500`)) as {
      results?: Record<string, unknown>[]
    }
    return (page.results ?? []).map((row) => toLiveObject(kind, row))
  }

  async create(kind: DefinitionKind, body: Record<string, unknown>): Promise<LiveObject> {
    const row = (await this.request(`/${ENDPOINTS[kind]}/`, {
      method: 'POST',
      body,
    })) as Record<string, unknown>
    return toLiveObject(kind, row)
  }

  async update(
    kind: DefinitionKind,
    id: string | number,
    body: Record<string, unknown>,
  ): Promise<LiveObject> {
    const row = (await this.request(`/${ENDPOINTS[kind]}/${id}/`, {
      method: 'PATCH',
      body,
    })) as Record<string, unknown>
    return toLiveObject(kind, row)
  }
}

function toLiveObject(kind: DefinitionKind, row: Record<string, unknown>): LiveObject {
  const { id, name, description, ...rest } = row
  const fields = rest as Record<string, unknown>
  if (Array.isArray(fields.dashboards)) fields.dashboards = sortIds(fields.dashboards)
  // An alert is written with the chart's id and read back with the whole chart.
  const insight = fields.insight
  if (insight && typeof insight === 'object' && 'id' in insight) {
    fields.insight = (insight as { id: unknown }).id
  }
  // Recipients too: written as user ids, read back as whole users.
  if (Array.isArray(fields.subscribed_users)) {
    fields.subscribed_users = sortIds(
      fields.subscribed_users.map((u) => (u && typeof u === 'object' && 'id' in u ? u.id : u)),
    )
  }
  return {
    id: (id as string | number) ?? '',
    name: (name as string) ?? '',
    description: (description as string | null) ?? null,
    // Only the fields this kind is compared on. Everything else the project
    // keeps — created_at, the person who last opened it, cached results — is
    // not ours and must not read as drift.
    payload: Object.fromEntries(
      Object.keys(bodyFor({ kind, key: 'x', name: '', description: '' }))
        .filter((field) => field !== 'name' && field !== 'description')
        .map((field) => [field, fields[field]]),
    ),
  }
}
