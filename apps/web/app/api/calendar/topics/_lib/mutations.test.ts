import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { okSchema, topicSchema } from '@sortiva/core'
import { accountScope, insertMinimalOpportunity, insertTopic } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { renderTemplatedLine, t } from '@sortiva/ui'
import { withAccount } from '../../../auth/_lib/session'
import { makeMoveTopicHandler, makePinTopicHandler, makeVetoTopicHandler } from './mutations'

const available = await databaseAvailable()
const NOW = new Date('2026-03-10T08:00:00.000Z')

describe.skipIf(!available)('calendar topic mutations', () => {
  let harness: TestDb
  let accountId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_calendar_mutations')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'calendar-mutations@example.com')
  })

  async function seedTopic(
    date: string,
    opts: {
      pinned?: boolean
      state?: 'planned' | 'published'
      reasonTemplateKey?: string
      reasonParams?: Record<string, string | number>
    } = {},
  ) {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      harness.db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `q-${date}`,
        evidenceJson: [],
        recommendedAction: 'create',
        status: 'scheduled',
        reasonTemplateKey: opts.reasonTemplateKey ?? 'gate1.admitted',
        reasonParams: opts.reasonParams ?? {},
        limitedIntelligence: false,
        rulesVersion: 'a'.repeat(64),
      },
      NOW,
    )
    return insertTopic(
      harness.db,
      scope,
      {
        opportunityId: opportunity.id,
        title: `Topic ${date}`,
        targetKeyword: `keyword ${date}`,
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: opts.reasonTemplateKey ?? 'topic.auto',
        scheduledDate: date,
        pinned: opts.pinned ?? false,
        state: opts.state ?? 'planned',
      },
      NOW,
    )
  }

  const post = <Ctx>(handler: ReturnType<typeof withAccount<Ctx>>, id: string | null, topicId: string, body?: unknown) =>
    handler(
      new Request('http://localhost/x', { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
      { params: Promise.resolve({ topicId }) } as Ctx,
    )

  it('vetoes a planned topic', async () => {
    const topic = await seedTopic('2026-03-20')
    const handler = withAccount(makeVetoTopicHandler({ db: harness.db, now: () => NOW }), async () => accountId)

    const response = await post(handler, accountId, topic.id)
    expect(response.status).toBe(200)
    expect(okSchema.parse(await response.json())).toEqual({ ok: true })
  })

  it('404s a veto of a topic that does not exist', async () => {
    const handler = withAccount(makeVetoTopicHandler({ db: harness.db, now: () => NOW }), async () => accountId)
    const response = await post(handler, accountId, '00000000-0000-4000-8000-000000000000')
    expect(response.status).toBe(404)
  })

  it('409s a veto of an already-published topic with the frozen conflict code', async () => {
    const topic = await seedTopic('2026-03-20', { state: 'published' })
    const handler = withAccount(makeVetoTopicHandler({ db: harness.db, now: () => NOW }), async () => accountId)

    const response = await post(handler, accountId, topic.id)
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('topic_already_published')
  })

  it('moves a planned topic and returns it, matching topicSchema', async () => {
    const topic = await seedTopic('2026-03-20')
    const handler = withAccount(makeMoveTopicHandler({ db: harness.db, now: () => NOW }), async () => accountId)

    const response = await post(handler, accountId, topic.id, { date: '2026-03-25' })
    expect(response.status).toBe(200)
    const body = topicSchema.parse(await response.json())
    expect(body.scheduledFor).toBe('2026-03-25')
  })

  it('bites: the moved day keeps its numbers, so dragging a chip does not blank its sentence', async () => {
    // The screen re-renders the chip from this response. Sending the key with
    // an empty bag replaced a filled sentence with "around {volume} searches a
    // month" the instant a merchant dragged a day.
    const topic = await seedTopic('2026-03-20', {
      reasonTemplateKey: 'uncovered_commercial_query.create',
      reasonParams: { volume: 1900 },
    })
    const handler = withAccount(makeMoveTopicHandler({ db: harness.db, now: () => NOW }), async () => accountId)

    const body = topicSchema.parse(await (await post(handler, accountId, topic.id, { date: '2026-03-25' })).json())
    const line = renderTemplatedLine(body.why, t)
    expect(line.known).toBe(true)
    expect(line.text).toContain('1900')
    expect(line.text).not.toContain('{')
  })

  it('409s a drag onto a pinned day', async () => {
    const dragged = await seedTopic('2026-03-20')
    await seedTopic('2026-03-25', { pinned: true })
    const handler = withAccount(makeMoveTopicHandler({ db: harness.db, now: () => NOW }), async () => accountId)

    const response = await post(handler, accountId, dragged.id, { date: '2026-03-25' })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('topic_pinned')
  })

  it('pins a topic', async () => {
    const topic = await seedTopic('2026-03-20')
    const handler = withAccount(makePinTopicHandler({ db: harness.db, now: () => NOW }), async () => accountId)

    const response = await post(handler, accountId, topic.id, { pinned: true })
    expect(response.status).toBe(200)
    const body = topicSchema.parse(await response.json())
    expect(body.pinned).toBe(true)
  })
})
