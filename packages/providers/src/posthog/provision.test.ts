import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DefinitionError,
  apply,
  bodyFor,
  checkDrift,
  keyFromDescription,
  loadDefinitions,
  type DefinitionKind,
  type Drift,
  type LiveObject,
  type LoadedDefinition,
  type PosthogAdminApi,
} from './provision'

/**
 * The provisioner, driven end to end against an analytics project that lives in
 * memory.
 *
 * The two properties worth having are both properties of *running it again*,
 * which is why they cannot be asserted and have to be exercised: applying twice
 * must leave one copy of everything, and a chart somebody edited in the vendor's
 * UI must fail the next check rather than quietly winning.
 *
 * The real definition files are loaded as well, so a dashboard pointing at an
 * insight that does not exist is caught here rather than by an empty dashboard
 * in production.
 */

const DEFINITIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'ops',
  'posthog',
  'definitions',
)

/** An analytics project with nothing in it, that remembers what it was told. */
class FakeProject implements PosthogAdminApi {
  private readonly objects = new Map<DefinitionKind, LiveObject[]>()
  private nextId = 1
  readonly writes: string[] = []

  async list(kind: DefinitionKind): Promise<LiveObject[]> {
    return [...(this.objects.get(kind) ?? [])]
  }

  async create(kind: DefinitionKind, body: Record<string, unknown>): Promise<LiveObject> {
    const { name, description, ...payload } = body
    const object: LiveObject = {
      id: this.nextId++,
      name: name as string,
      description: description as string,
      payload,
    }
    this.objects.set(kind, [...(this.objects.get(kind) ?? []), object])
    this.writes.push(`create ${kind}`)
    return object
  }

  async update(
    kind: DefinitionKind,
    id: string | number,
    body: Record<string, unknown>,
  ): Promise<LiveObject> {
    const rows = this.objects.get(kind) ?? []
    const index = rows.findIndex((r) => r.id === id)
    if (index === -1) throw new Error(`no ${kind} with id ${String(id)}`)
    const { name, description, ...payload } = body
    const updated: LiveObject = {
      id,
      name: name as string,
      description: description as string,
      payload,
    }
    rows[index] = updated
    this.writes.push(`update ${kind}`)
    return updated
  }

  async users(): Promise<{ id: string | number; email: string }[]> {
    return [{ id: 900, email: 'Ops@Example.com' }]
  }

  /** Somebody opening the chart in the analytics UI and changing it. */
  handEdit(kind: DefinitionKind, key: string, change: Partial<LiveObject>): void {
    const rows = this.objects.get(kind) ?? []
    const target = kind === 'alert' ? this.alertFor(key) : undefined
    const index = rows.findIndex((r) =>
      target ? r === target : keyFromDescription(r.description) === key,
    )
    if (index === -1) throw new Error(`nothing here with key ${key}`)
    rows[index] = { ...rows[index]!, ...change }
  }

  /** Alerts carry no description in the real project, so one is found by the chart it watches. */
  alertFor(alertKey: string): LiveObject | undefined {
    const chartKey = definitions.find((d) => d.kind === 'alert' && d.key === alertKey)?.insight
    const chart = (this.objects.get('insight') ?? []).find(
      (r) => keyFromDescription(r.description) === chartKey,
    )
    return (this.objects.get('alert') ?? []).find((r) => chart && r.payload.insight === chart.id)
  }

  count(kind: DefinitionKind): number {
    return (this.objects.get(kind) ?? []).length
  }
}

const definitions = loadDefinitions(DEFINITIONS_DIR)

/** Matched against the project's users regardless of case, as email addresses are. */
const OPTIONS = { recipients: ['ops@example.com'] }

/**
 * The domain group type is the one thing the provisioner cannot make: the
 * analytics vendor creates it when the first event arrives carrying it. It is
 * therefore always reported as missing against an empty in-memory project, and
 * the cases below that are about dashboards drop it rather than pretend
 * otherwise. Its own behaviour is asserted separately.
 */
const exceptGroupType = (drift: readonly Drift[]): Drift[] =>
  drift.filter((d) => d.kind !== 'group_type')

function definition(kind: DefinitionKind, key: string): LoadedDefinition {
  const found = definitions.find((d) => d.kind === kind && d.key === key)
  if (!found) throw new Error(`no ${kind} defined as ${key}`)
  return found
}

describe('the definition files themselves', () => {
  it('declares the five dashboards the product was promised, plus reliability', () => {
    const dashboards = definitions.filter((d) => d.kind === 'dashboard').map((d) => d.key)
    expect(dashboards).toEqual(
      expect.arrayContaining([
        'funnel',
        'cost-per-domain',
        'preview-economics',
        'calibration',
        'opportunity-mix',
      ]),
    )
  })

  it('mirrors the thresholds our own code enforces, so a human sees what the code acted on', () => {
    const alerts = definitions.filter((d) => d.kind === 'alert').map((d) => d.key)
    expect(alerts).toEqual(
      expect.arrayContaining([
        'alert-domain-spend-over-cap',
        'alert-global-spend-over-cap',
        'alert-preview-spend-over-cap',
        'alert-judge-fail-rate',
        'alert-publish-abandoned',
        'alert-dlq-sustained',
        'alert-webhook-lag',
      ]),
    )
  })

  it('compares every alert against a plain number, never against the previous period', () => {
    // "percentage" reads like "a rate over 60%" and means "up 60% on the
    // previous period" to the vendor. The judge alert shipped that way and
    // would have fired on busy hours, not on bad drafts.
    for (const alert of definitions.filter((d) => d.kind === 'alert')) {
      expect((alert.threshold as { type: string }).type, alert.key).toBe('absolute')
    }
  })

  it('watches the judge fail rate as a rate, over whole days', () => {
    const alert = definition('alert', 'alert-judge-fail-rate')
    const query = definition('insight', alert.insight as string).query as {
      trendsFilter?: { formula?: string }
      breakdownFilter?: unknown
    }

    expect(query.trendsFilter?.formula).toBe('A / B')
    expect(query.breakdownFilter).toBeUndefined()
    expect((alert.threshold as { bounds: { upper: number } }).bounds.upper).toBeLessThanOrEqual(1)
    expect(alert.check_ongoing_interval).toBe(false)
  })

  it('watches all search-data spend for the global cap, not only what finished articles recorded', () => {
    const alert = definition('alert', 'alert-global-spend-over-cap')
    const query = definition('insight', alert.insight as string).query as {
      series: { event: string; math_property?: string }[]
      breakdownFilter?: unknown
    }

    expect(query.series).toEqual([
      expect.objectContaining({ event: 'dataforseo_request', math: 'sum', math_property: 'usd_cost' }),
    ])
    expect(query.breakdownFilter).toBeUndefined()
    expect(alert.check_ongoing_interval).toBe(true)
  })

  it('reserves the domain group for claimed domains and gives preview traffic a property', () => {
    const group = definition('group_type', 'domain')
    expect(group.description).toContain('domain_normalized')
    // The rule that keeps a stranger's browsing off a merchant's cost line.
    expect(group.description).toContain('target_domain')
  })

  it('refuses a dashboard that puts a chart on itself that nobody defined', () => {
    // The failure this catches applies cleanly and produces an empty dashboard,
    // which looks exactly like a working one on a quiet week.
    const directory = mkdtempSync(join(tmpdir(), 'sortiva-posthog-'))
    writeFileSync(
      join(directory, 'broken.json'),
      JSON.stringify({
        kind: 'dashboard',
        key: 'broken',
        name: 'Broken',
        description: 'points at nothing',
        tiles: ['not-a-real-insight'],
      }),
    )

    expect(() => loadDefinitions(directory)).toThrow(DefinitionError)
    expect(() => loadDefinitions(directory)).toThrow(/show an empty dashboard/)
  })

  it('refuses a chart description the analytics project would refuse mid-apply', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sortiva-posthog-'))
    writeFileSync(
      join(directory, 'long.json'),
      JSON.stringify({ kind: 'insight', key: 'long', name: 'Long', description: 'x'.repeat(390) }),
    )

    expect(() => loadDefinitions(directory)).toThrow(/too long/)
  })

  it('refuses two alerts on one chart, because the chart is how an alert is found again', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sortiva-posthog-'))
    const chart = { kind: 'insight', key: 'c', name: 'C', description: 'a chart', query: {} }
    const alert = { kind: 'alert', name: 'A', description: 'a', insight: 'c' }
    writeFileSync(
      join(directory, 'two.json'),
      JSON.stringify([chart, { ...alert, key: 'a1' }, { ...alert, key: 'a2' }]),
    )

    expect(() => loadDefinitions(directory)).toThrow(/both watch "c"/)
  })

  it('refuses two definitions sharing a key, which is what would duplicate on apply', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sortiva-posthog-'))
    const one = { kind: 'insight', key: 'same', name: 'A', description: 'a' }
    writeFileSync(join(directory, 'a.json'), JSON.stringify(one))
    writeFileSync(join(directory, 'b.json'), JSON.stringify({ ...one, name: 'B' }))

    expect(() => loadDefinitions(directory)).toThrow(/duplicate insight:same/)
  })

  it('refuses an alert watching a chart that does not exist, because it would never fire', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sortiva-posthog-'))
    writeFileSync(
      join(directory, 'alert.json'),
      JSON.stringify({
        kind: 'alert',
        key: 'orphan',
        name: 'Orphan',
        description: 'watches nothing',
        insight: 'gone',
      }),
    )

    expect(() => loadDefinitions(directory)).toThrow(/An alert on nothing never fires/)
  })

  it('reads an empty directory as nothing declared, not as an error', () => {
    expect(loadDefinitions(mkdtempSync(join(tmpdir(), 'sortiva-posthog-')))).toEqual([])
  })
})

describe('applying the definitions', () => {
  it('creates everything the first time', async () => {
    const project = new FakeProject()
    const result = await apply(project, definitions, OPTIONS)

    expect(result.created.length).toBeGreaterThan(0)
    expect(result.updated).toEqual([])
    expect(project.count('dashboard')).toBe(
      definitions.filter((d) => d.kind === 'dashboard').length,
    )
  })

  it('creates no duplicates when it is run again', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    const dashboardsAfterFirst = project.count('dashboard')
    const insightsAfterFirst = project.count('insight')
    const alertsAfterFirst = project.count('alert')

    const second = await apply(project, definitions, OPTIONS)

    expect(second.created).toEqual([])
    expect(second.updated).toEqual([])
    expect(second.unchanged.length).toBeGreaterThan(0)
    expect(project.count('dashboard')).toBe(dashboardsAfterFirst)
    expect(project.count('insight')).toBe(insightsAfterFirst)
    expect(project.count('alert')).toBe(alertsAfterFirst)
  })

  it('writes nothing at all on the second run', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    const writesAfterFirst = project.writes.length

    await apply(project, definitions, OPTIONS)

    expect(project.writes.length).toBe(writesAfterFirst)
  })

  it('says out loud that it cannot create a group type, rather than reporting one it did not make', async () => {
    const project = new FakeProject()
    const result = await apply(project, definitions, OPTIONS)

    expect(result.skipped.map((s) => s.id)).toEqual(['group_type:domain'])
    expect(result.skipped[0]?.why).toContain('there is no API that creates one')
  })

  it('puts each chart on the dashboards that list it, by the id the project gave them', async () => {
    // The vendor ignores a chart list sent on a dashboard; placement only
    // sticks when it is written on the chart, as dashboard ids.
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    const dashboards = await project.list('dashboard')
    const charts = await project.list('insight')
    const idOf = (rows: LiveObject[], key: string) =>
      rows.find((r) => keyFromDescription(r.description) === key)?.id

    const chart = charts.find((r) => keyFromDescription(r.description) === 'cost-top-spenders')

    expect(chart?.payload.dashboards).toEqual([idOf(dashboards, 'cost-per-domain')])
    expect(dashboards.every((d) => !('tiles' in d.payload))).toBe(true)
  })

  it('points each alert at its chart by id, and emails the listed people by their user id', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    const charts = await project.list('insight')
    const alerts = definitions.filter((d) => d.kind === 'alert')

    expect(project.count('alert')).toBe(alerts.length)
    for (const alert of alerts) {
      const chart = charts.find((r) => keyFromDescription(r.description) === alert.insight)
      const live = project.alertFor(alert.key)
      expect(live?.payload.insight, alert.key).toBe(chart?.id)
      expect(live?.payload.subscribed_users, alert.key).toEqual([900])
      // The real project has nowhere to keep one.
      expect(live?.description, alert.key).toBeUndefined()
    }
  })

  it('refuses before writing anything when a recipient has no login in the project', async () => {
    const project = new FakeProject()

    await expect(
      apply(project, definitions, { recipients: ['stranger@example.com'] }),
    ).rejects.toThrow(/stranger@example.com is not among the analytics users/)
    expect(project.writes).toEqual([])
  })

  it('refuses to make alerts that email nobody', async () => {
    await expect(apply(new FakeProject(), definitions, {})).rejects.toThrow(/nobody receives them/)
  })

  it('sends a chart query in the wrapper the project stores it in', () => {
    const body = bodyFor(definition('insight', 'cost-top-spenders'))
    expect(body.query).toMatchObject({ kind: 'InsightVizNode', source: { kind: 'TrendsQuery' } })
  })

  it('puts back a chart somebody deleted', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    project.handEdit('dashboard', 'cost-per-domain', { description: 'somebody removed the marker' })

    const result = await apply(project, definitions, OPTIONS)

    expect(result.created).toContain('dashboard:cost-per-domain')
  })
})

describe('check mode', () => {
  it('passes against a project the provisioner just made', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)

    expect(exceptGroupType(await checkDrift(project, definitions, OPTIONS))).toEqual([])
  })

  it('fails on a dashboard somebody renamed in the analytics UI', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    project.handEdit('dashboard', 'cost-per-domain', { name: 'Cost (Ali\'s copy)' })

    const drift = exceptGroupType(await checkDrift(project, definitions, OPTIONS))

    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ kind: 'dashboard', key: 'cost-per-domain', reason: 'edited' })
    expect(drift[0]?.detail).toContain('name')
    expect(drift[0]?.detail).toContain('The repo is the truth')
  })

  it('passes when the project fills in settings no file mentions', async () => {
    // What the real project does to every chart the moment it is saved. Read
    // as an edit, it failed every chart on its first check.
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    const chart = (await project.list('insight')).find(
      (r) => keyFromDescription(r.description) === 'cost-top-spenders',
    )!
    const query = chart.payload.query as { source: Record<string, unknown> }
    project.handEdit('insight', 'cost-top-spenders', {
      payload: {
        ...chart.payload,
        query: {
          ...query,
          source: { ...query.source, interval: 'day', version: 4, properties: [] },
        },
      },
    })

    expect(exceptGroupType(await checkDrift(project, definitions, OPTIONS))).toEqual([])
  })

  it('fails on a chart somebody took off its dashboard', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    const chart = (await project.list('insight')).find(
      (r) => keyFromDescription(r.description) === 'cost-top-spenders',
    )!
    project.handEdit('insight', 'cost-top-spenders', {
      payload: { ...chart.payload, dashboards: [] },
    })

    const drift = exceptGroupType(await checkDrift(project, definitions, OPTIONS))

    expect(drift).toHaveLength(1)
    expect(drift[0]?.detail).toContain('dashboards')
  })

  it('fails on a chart whose query somebody changed', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    project.handEdit('insight', 'cost-top-spenders', {
      payload: { query: { kind: 'TrendsQuery', series: [] } },
    })

    const drift = exceptGroupType(await checkDrift(project, definitions, OPTIONS))

    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ reason: 'edited' })
    expect(drift[0]?.detail).toContain('query')
  })

  it('fails on an alert whose threshold somebody quietly raised', async () => {
    // The one that matters: an alert loosened in the UI stops firing, and
    // nothing anywhere else looks wrong.
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    const alert = project.alertFor('alert-preview-spend-over-cap')!
    project.handEdit('alert', 'alert-preview-spend-over-cap', {
      payload: {
        ...alert.payload,
        threshold: { configuration: { type: 'absolute', bounds: { upper: 10000 } } },
      },
    })

    const drift = exceptGroupType(await checkDrift(project, definitions, OPTIONS))

    expect(drift.map((d) => d.key)).toEqual(['alert-preview-spend-over-cap'])
    expect(drift[0]?.detail).toContain('threshold')
  })

  it('fails on an alert somebody renamed, and still recognises it as ours', async () => {
    // Recognised by its chart rather than its name, so a rename is an edit to
    // put back — not a missing alert that --apply would make a second copy of.
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    project.handEdit('alert', 'alert-webhook-lag', { name: 'webhooks slow-ish' })

    const drift = exceptGroupType(await checkDrift(project, definitions, OPTIONS))
    const second = await apply(project, definitions, OPTIONS)

    expect(drift).toMatchObject([{ key: 'alert-webhook-lag', reason: 'edited' }])
    expect(second.created).toEqual([])
    expect(second.updated).toEqual(['alert:alert-webhook-lag'])
  })

  it('fails on an alert on one of our charts that no file defines', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    const chart = (await project.list('insight')).find(
      (r) => keyFromDescription(r.description) === 'funnel-lure-to-activated',
    )!
    await project.create('alert', { name: 'my own alert', insight: chart.id })

    const drift = exceptGroupType(await checkDrift(project, definitions, OPTIONS))

    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ kind: 'alert', reason: 'unmanaged' })
    expect(drift[0]?.detail).toContain('funnel-lure-to-activated')
  })

  it('fails when something we asked for is not there at all', async () => {
    const project = new FakeProject()

    const drift = await checkDrift(project, definitions, OPTIONS)

    expect(drift.length).toBeGreaterThan(0)
    expect(drift.every((d) => d.reason === 'missing')).toBe(true)
    expect(drift[0]?.detail).toContain('--apply')
  })

  it('reports the domain group type as missing until an event carries it', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)

    const drift = (await checkDrift(project, definitions, OPTIONS)).filter((d) => d.kind === 'group_type')

    expect(drift).toHaveLength(1)
    expect(drift[0]?.detail).toContain('every breakdown by domain is empty until one does')
  })

  it('fails on a chart of ours that no file claims any more', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    const withoutOne = definitions.filter((d) => d.key !== 'cost-per-domain')

    const drift = await checkDrift(project, withoutOne, OPTIONS)

    expect(drift.map((d) => d.reason)).toContain('unmanaged')
  })

  it('ignores a chart somebody built by hand that was never ours', async () => {
    // Exploring in the analytics UI is fine. Only what carries our marker is
    // ours to keep in step.
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    await project.create('dashboard', { name: 'Ali\'s scratch dashboard', description: 'poking about' })

    expect(exceptGroupType(await checkDrift(project, definitions, OPTIONS))).toEqual([])
  })

  it('never writes while checking', async () => {
    const project = new FakeProject()
    await apply(project, definitions, OPTIONS)
    const writes = project.writes.length
    project.handEdit('dashboard', 'funnel', { name: 'changed' })

    await checkDrift(project, definitions, OPTIONS)

    expect(project.writes.length).toBe(writes)
  })
})

describe('the marker that ties a chart to its file', () => {
  it('goes in the description, where whoever opens the chart will see it', () => {
    const body = bodyFor(definition('dashboard', 'funnel'))
    expect(String(body.description)).toContain('edit ops/posthog/definitions, not this')
    expect(keyFromDescription(String(body.description))).toBe('funnel')
  })
})
