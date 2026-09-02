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
    }
  }

  return definitions
}

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
}

/**
 * What the project should hold for one definition. Kind-specific shaping lives
 * here so both the writer and the comparison work from one answer.
 */
export function bodyFor(definition: Definition): Record<string, unknown> {
  const base = { name: definition.name, description: describeWithMarker(definition) }
  switch (definition.kind) {
    case 'insight':
      return { ...base, query: definition.query ?? null }
    case 'dashboard':
      return { ...base, tiles: definition.tiles ?? [] }
    case 'alert':
      return {
        ...base,
        insight: definition.insight ?? null,
        threshold: definition.threshold ?? null,
        calculation_interval: definition.calculation_interval ?? 'hourly',
      }
    case 'group_type':
      return { ...base, group_type_index: definition.group_type_index ?? 0 }
  }
}

export type DriftReason = 'missing' | 'edited' | 'unmanaged'

export interface Drift {
  kind: DefinitionKind
  key: string
  reason: DriftReason
  /** One line an operator can act on. */
  detail: string
}

function differences(want: Record<string, unknown>, live: LiveObject): string[] {
  const found: string[] = []
  const actual: Record<string, unknown> = {
    name: live.name,
    description: live.description ?? '',
    ...live.payload,
  }
  for (const [field, expected] of Object.entries(want)) {
    if (canonical(actual[field]) !== canonical(expected)) found.push(field)
  }
  return found
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
): Promise<Drift[]> {
  const drift: Drift[] = []

  for (const kind of KINDS) {
    const wanted = definitions.filter((d) => d.kind === kind)
    const live = await api.list(kind)
    const byKey = new Map<string, LiveObject>()
    for (const object of live) {
      const key = keyFromDescription(object.description)
      if (key !== undefined) byKey.set(key, object)
    }

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
      const changed = differences(bodyFor(definition), found)
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
          detail: `${kind} "${key}" is in the project and carries our marker, but no definition file claims it. Its definition was deleted and the chart is still on somebody's screen.`,
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
 * Idempotent by construction: every object is found by its key marker, so a
 * second run finds everything already there and updates nothing. That is the
 * property worth having — a provisioner that duplicates on re-run is a
 * provisioner nobody dares run.
 */
export async function apply(
  api: PosthogAdminApi,
  definitions: readonly LoadedDefinition[],
): Promise<ApplyResult> {
  const result: ApplyResult = { created: [], updated: [], unchanged: [], skipped: [] }

  for (const kind of KINDS) {
    const wanted = definitions.filter((d) => d.kind === kind)
    if (wanted.length === 0) continue
    const live = await api.list(kind)
    const byKey = new Map<string, LiveObject>()
    for (const object of live) {
      const key = keyFromDescription(object.description)
      if (key !== undefined) byKey.set(key, object)
    }

    for (const definition of wanted) {
      const id = `${kind}:${definition.key}`
      const body = bodyFor(definition)
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
        await api.create(kind, body)
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

  private async request(
    path: string,
    init: { method: string; body?: unknown } = { method: 'GET' },
  ): Promise<unknown> {
    const { host, projectId, personalApiKey } = this.options
    const response = await fetch(`${host}/api/projects/${projectId}${path}`, {
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
        .map((field) => [field, (rest as Record<string, unknown>)[field]]),
    ),
  }
}
