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

  /** Somebody opening the chart in the analytics UI and changing it. */
  handEdit(kind: DefinitionKind, key: string, change: Partial<LiveObject>): void {
    const rows = this.objects.get(kind) ?? []
    const index = rows.findIndex((r) => keyFromDescription(r.description) === key)
    if (index === -1) throw new Error(`nothing here with key ${key}`)
    rows[index] = { ...rows[index]!, ...change }
  }

  count(kind: DefinitionKind): number {
    return (this.objects.get(kind) ?? []).length
  }
}

const definitions = loadDefinitions(DEFINITIONS_DIR)

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
    const result = await apply(project, definitions)

    expect(result.created.length).toBeGreaterThan(0)
    expect(result.updated).toEqual([])
    expect(project.count('dashboard')).toBe(
      definitions.filter((d) => d.kind === 'dashboard').length,
    )
  })

  it('creates no duplicates when it is run again', async () => {
    const project = new FakeProject()
    await apply(project, definitions)
    const dashboardsAfterFirst = project.count('dashboard')
    const insightsAfterFirst = project.count('insight')
    const alertsAfterFirst = project.count('alert')

    const second = await apply(project, definitions)

    expect(second.created).toEqual([])
    expect(second.updated).toEqual([])
    expect(second.unchanged.length).toBeGreaterThan(0)
    expect(project.count('dashboard')).toBe(dashboardsAfterFirst)
    expect(project.count('insight')).toBe(insightsAfterFirst)
    expect(project.count('alert')).toBe(alertsAfterFirst)
  })

  it('writes nothing at all on the second run', async () => {
    const project = new FakeProject()
    await apply(project, definitions)
    const writesAfterFirst = project.writes.length

    await apply(project, definitions)

    expect(project.writes.length).toBe(writesAfterFirst)
  })

  it('says out loud that it cannot create a group type, rather than reporting one it did not make', async () => {
    const project = new FakeProject()
    const result = await apply(project, definitions)

    expect(result.skipped.map((s) => s.id)).toEqual(['group_type:domain'])
    expect(result.skipped[0]?.why).toContain('there is no API that creates one')
  })

  it('puts back a chart somebody deleted', async () => {
    const project = new FakeProject()
    await apply(project, definitions)
    project.handEdit('dashboard', 'cost-per-domain', { description: 'somebody removed the marker' })

    const result = await apply(project, definitions)

    expect(result.created).toContain('dashboard:cost-per-domain')
  })
})

describe('check mode', () => {
  it('passes against a project the provisioner just made', async () => {
    const project = new FakeProject()
    await apply(project, definitions)

    expect(exceptGroupType(await checkDrift(project, definitions))).toEqual([])
  })

  it('fails on a dashboard somebody renamed in the analytics UI', async () => {
    const project = new FakeProject()
    await apply(project, definitions)
    project.handEdit('dashboard', 'cost-per-domain', { name: 'Cost (Ali\'s copy)' })

    const drift = exceptGroupType(await checkDrift(project, definitions))

    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ kind: 'dashboard', key: 'cost-per-domain', reason: 'edited' })
    expect(drift[0]?.detail).toContain('name')
    expect(drift[0]?.detail).toContain('The repo is the truth')
  })

  it('fails on a chart whose query somebody changed', async () => {
    const project = new FakeProject()
    await apply(project, definitions)
    project.handEdit('insight', 'cost-top-spenders', {
      payload: { query: { kind: 'TrendsQuery', series: [] } },
    })

    const drift = exceptGroupType(await checkDrift(project, definitions))

    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ reason: 'edited' })
    expect(drift[0]?.detail).toContain('query')
  })

  it('fails on an alert whose threshold somebody quietly raised', async () => {
    // The one that matters: an alert loosened in the UI stops firing, and
    // nothing anywhere else looks wrong.
    const project = new FakeProject()
    await apply(project, definitions)
    project.handEdit('alert', 'alert-preview-spend-over-cap', {
      payload: {
        insight: 'preview-spend-per-day',
        threshold: { type: 'absolute', bounds: { upper: 10000 } },
        calculation_interval: 'hourly',
      },
    })

    const drift = exceptGroupType(await checkDrift(project, definitions))

    expect(drift.map((d) => d.key)).toEqual(['alert-preview-spend-over-cap'])
    expect(drift[0]?.detail).toContain('threshold')
  })

  it('fails when something we asked for is not there at all', async () => {
    const project = new FakeProject()

    const drift = await checkDrift(project, definitions)

    expect(drift.length).toBeGreaterThan(0)
    expect(drift.every((d) => d.reason === 'missing')).toBe(true)
    expect(drift[0]?.detail).toContain('--apply')
  })

  it('reports the domain group type as missing until an event carries it', async () => {
    const project = new FakeProject()
    await apply(project, definitions)

    const drift = (await checkDrift(project, definitions)).filter((d) => d.kind === 'group_type')

    expect(drift).toHaveLength(1)
    expect(drift[0]?.detail).toContain('every breakdown by domain is empty until one does')
  })

  it('fails on a chart of ours that no file claims any more', async () => {
    const project = new FakeProject()
    await apply(project, definitions)
    const withoutOne = definitions.filter((d) => d.key !== 'cost-per-domain')

    const drift = await checkDrift(project, withoutOne)

    expect(drift.map((d) => d.reason)).toContain('unmanaged')
  })

  it('ignores a chart somebody built by hand that was never ours', async () => {
    // Exploring in the analytics UI is fine. Only what carries our marker is
    // ours to keep in step.
    const project = new FakeProject()
    await apply(project, definitions)
    await project.create('dashboard', { name: 'Ali\'s scratch dashboard', description: 'poking about' })

    expect(exceptGroupType(await checkDrift(project, definitions))).toEqual([])
  })

  it('never writes while checking', async () => {
    const project = new FakeProject()
    await apply(project, definitions)
    const writes = project.writes.length
    project.handEdit('dashboard', 'funnel', { name: 'changed' })

    await checkDrift(project, definitions)

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
