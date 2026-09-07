import { and, desc, eq, gte, isNull, lte, ne, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { ctrCurve, gscConns, gscDaily, gscQueryDaily, keywords, queryClusters } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

export type GscConnRow = typeof gscConns.$inferSelect

/**
 * A merchant's Search Console connection, and the two tables the search data
 * lands in.
 *
 * The connection row has a deliberate in-between state. Google's grant arrives
 * before the merchant has told us *which* of their properties this store is, and
 * both facts belong in the same row. So the row is written at the grant with an
 * empty property, and the property is filled in when they choose. Everything
 * that asks "is Search Console connected" treats an empty property as not
 * connected, which it is: we hold a key to a door nobody has pointed at yet.
 */

export async function findGscConnForAccount(
  db: Db,
  scope: AccountScope,
): Promise<GscConnRow | undefined> {
  const [row] = await db
    .select()
    .from(gscConns)
    .where(eq(gscConns.accountId, scope.accountId))
    .limit(1)
  return row
}

/**
 * Records a fresh grant. Reconnecting replaces the stored tokens and clears the
 * dead-grant marker, but leaves the chosen property alone — a merchant fixing a
 * broken connection is not asking to re-answer a question they already answered.
 */
export async function saveGscGrant(
  db: Db,
  scope: AccountScope,
  input: { tokens: string },
): Promise<GscConnRow> {
  const [row] = await db
    .insert(gscConns)
    .values({ accountId: scope.accountId, property: '', tokens: input.tokens })
    .onConflictDoUpdate({
      target: gscConns.accountId,
      set: { tokens: input.tokens, invalidatedAt: null },
    })
    .returning()
  if (!row) throw new Error('failed to record the Search Console grant')
  return row
}

/**
 * Fixes the property the merchant picked, and stamps the connection moment.
 *
 * `connected_at` is set here rather than at the grant because it is what the
 * performance chart is drawn from — "your search performance since connecting" —
 * and connecting, to a merchant, is the moment they finished choosing, not the
 * moment Google redirected them back.
 *
 * Guarded on the grant still being there: a merchant who disconnected in another
 * tab must not have a property written against a connection that no longer
 * exists.
 */
export async function selectGscProperty(
  db: Db,
  scope: AccountScope,
  input: { property: string; connectedAt: Date },
): Promise<GscConnRow | undefined> {
  const [row] = await db
    .update(gscConns)
    .set({ property: input.property, connectedAt: input.connectedAt, invalidatedAt: null })
    .where(eq(gscConns.accountId, scope.accountId))
    .returning()
  return row
}

/**
 * Records that the grant is gone. Reporting stops; nothing else does — the
 * content pipeline keeps running, because search reporting is an input to it,
 * never a dependency of it.
 *
 * Only the first such discovery moves the timestamp. That is what makes the
 * reconnect prompt land once instead of every time a sync retries.
 */
export async function markGscGrantInvalid(
  db: Db,
  scope: AccountScope,
  at: Date,
): Promise<GscConnRow | undefined> {
  const [row] = await db
    .update(gscConns)
    .set({ invalidatedAt: at })
    .where(and(eq(gscConns.accountId, scope.accountId), sql`${gscConns.invalidatedAt} is null`))
    .returning()
  return row
}

/**
 * Every account the nightly sync has something to fetch for: a property chosen
 * and a grant still alive. Crosses accounts by design — it is the sweep that
 * decides who to work for — so it takes a system scope, and each account's own
 * work is done under its own scope.
 */
export async function accountsWithLiveGscConnection(
  db: Db,
  _scope: SystemScope,
): Promise<string[]> {
  const rows = await db
    .select({ accountId: gscConns.accountId })
    .from(gscConns)
    .where(and(ne(gscConns.property, ''), isNull(gscConns.invalidatedAt)))
  return rows.map((row) => row.accountId)
}

export interface GscQueryDailyInput {
  readonly date: string
  readonly page: string
  readonly query: string
  readonly device: string
  readonly country: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
}

export interface GscDailyInput {
  readonly date: string
  readonly page: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
}

/**
 * Writes a batch of page-by-query rows, replacing any it already holds for the
 * same day, page, query, device and country.
 *
 * Replace rather than skip, because Google keeps revising recent days for about
 * a week and the later figure is the true one. It is also what makes the whole
 * import safe to redo: re-running a chunk that already landed writes the same
 * numbers over themselves rather than doubling them.
 */
export async function upsertGscQueryDaily(
  db: Db,
  scope: AccountScope,
  rows: readonly GscQueryDailyInput[],
): Promise<number> {
  if (rows.length === 0) return 0
  const values = rows.map((row) => ({
    accountId: scope.accountId,
    date: row.date,
    page: row.page,
    query: row.query,
    device: row.device,
    country: row.country,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position === null ? null : row.position.toFixed(2),
  }))
  await db
    .insert(gscQueryDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [
        gscQueryDaily.accountId,
        gscQueryDaily.date,
        gscQueryDaily.page,
        gscQueryDaily.query,
        gscQueryDaily.device,
        gscQueryDaily.country,
      ],
      set: {
        clicks: sql`excluded.clicks`,
        impressions: sql`excluded.impressions`,
        position: sql`excluded.position`,
      },
    })
  return values.length
}

/** Page-level totals for the same days, on the same replace-rather-than-skip terms. */
export async function upsertGscDaily(
  db: Db,
  scope: AccountScope,
  rows: readonly GscDailyInput[],
): Promise<number> {
  if (rows.length === 0) return 0
  const values = rows.map((row) => ({
    accountId: scope.accountId,
    date: row.date,
    page: row.page,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position === null ? null : row.position.toFixed(2),
  }))
  await db
    .insert(gscDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [gscDaily.accountId, gscDaily.date, gscDaily.page],
      set: {
        clicks: sql`excluded.clicks`,
        impressions: sql`excluded.impressions`,
        position: sql`excluded.position`,
      },
    })
  return values.length
}

/**
 * The two ways detection reads a store's search history back out.
 *
 * Both are aggregates, never raw rows. Search Console is stored one row per day,
 * page, search, device and country, and every question the opportunity engine
 * asks is about a window rather than a day — so the summing happens in the
 * database, where it is one pass over an index, rather than by pulling months of
 * rows into a job's memory.
 */

export interface GscWindow {
  /** Inclusive, `YYYY-MM-DD`. */
  readonly startDate: string
  /** Inclusive, `YYYY-MM-DD`. */
  readonly endDate: string
}

export interface GscPageQueryTotal {
  readonly page: string
  readonly query: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
}

/**
 * Every page-and-search pair the store was shown for in the window, busiest
 * first, with searches too rare to cluster already dropped.
 *
 * The rarity floor is applied here rather than after loading because it is what
 * bounds the result: a large store has hundreds of thousands of one-impression
 * searches, and none of them can change a decision. The caller passes the number
 * from `packages/rules` — this function holds no threshold of its own.
 */
export async function gscPageQueryTotals(
  db: Db,
  scope: AccountScope,
  window: GscWindow,
  minImpressions: number,
): Promise<GscPageQueryTotal[]> {
  const rows = await db
    .select({
      page: gscQueryDaily.page,
      query: gscQueryDaily.query,
      clicks: sql<string>`sum(${gscQueryDaily.clicks})`,
      impressions: sql<string>`sum(${gscQueryDaily.impressions})`,
      position: sql<
        string | null
      >`sum(${gscQueryDaily.position} * ${gscQueryDaily.impressions}) / nullif(sum(${gscQueryDaily.impressions}), 0)`,
    })
    .from(gscQueryDaily)
    .where(
      and(
        eq(gscQueryDaily.accountId, scope.accountId),
        gte(gscQueryDaily.date, window.startDate),
        lte(gscQueryDaily.date, window.endDate),
      ),
    )
    .groupBy(gscQueryDaily.page, gscQueryDaily.query)
    .having(sql`sum(${gscQueryDaily.impressions}) >= ${minImpressions}`)
    .orderBy(sql`sum(${gscQueryDaily.impressions}) desc`)

  return rows.map((row) => ({
    page: row.page,
    query: row.query,
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
    position: row.position === null ? null : Number(row.position),
  }))
}

export interface GscCurveSample {
  readonly query: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
}

/**
 * What the click curve is fitted from: one row per search per whole-number
 * position, with pages and days collapsed.
 *
 * Pages are collapsed because the curve is a statement about positions, not
 * about pages — the same search shown at position 3 on two different pages is
 * two observations of position 3. The search text survives so that searches for
 * the store's own name can be dropped before the fit, which is done in the
 * domain code where the brand words are worked out.
 */
export async function gscCurveSamples(
  db: Db,
  scope: AccountScope,
  window: GscWindow,
): Promise<GscCurveSample[]> {
  const bucket = sql<string>`round(${gscQueryDaily.position})`
  const rows = await db
    .select({
      query: gscQueryDaily.query,
      position: bucket,
      clicks: sql<string>`sum(${gscQueryDaily.clicks})`,
      impressions: sql<string>`sum(${gscQueryDaily.impressions})`,
    })
    .from(gscQueryDaily)
    .where(
      and(
        eq(gscQueryDaily.accountId, scope.accountId),
        gte(gscQueryDaily.date, window.startDate),
        lte(gscQueryDaily.date, window.endDate),
        sql`${gscQueryDaily.position} is not null`,
      ),
    )
    .groupBy(gscQueryDaily.query, bucket)

  return rows.map((row) => ({
    query: row.query,
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
    position: row.position === null ? null : Number(row.position),
  }))
}

export type QueryClusterRow = typeof queryClusters.$inferSelect

export interface QueryClusterInput {
  readonly headQuery: string
  readonly memberQueries: readonly string[]
}

/**
 * Writes the store's clusters, keeping each one's identity across rebuilds.
 *
 * A cluster is matched by its head search, and an existing one has its members
 * updated in place rather than being replaced. That is what makes `cluster_id`
 * durable: an article written from a cluster points back at that id, and
 * rebuilding the clusters every week must not orphan the lineage of everything
 * already published.
 *
 * A head that stops appearing keeps its row. Deleting it would silently break
 * that same reference, and a cluster the store is no longer shown for is a fact
 * worth keeping — the same posture the opportunity lifecycle takes, where expiry
 * never deletes.
 */
export async function upsertQueryClusters(
  db: Db,
  scope: AccountScope,
  clusters: readonly QueryClusterInput[],
): Promise<{ inserted: number; updated: number }> {
  if (clusters.length === 0) return { inserted: 0, updated: 0 }

  const existing = await db
    .select({ clusterId: queryClusters.clusterId, headQuery: queryClusters.headQuery })
    .from(queryClusters)
    .where(eq(queryClusters.accountId, scope.accountId))

  const byHead = new Map(existing.map((row) => [row.headQuery, row.clusterId]))

  let inserted = 0
  let updated = 0
  const fresh: { accountId: string; headQuery: string; memberQueries: string[] }[] = []

  for (const cluster of clusters) {
    const clusterId = byHead.get(cluster.headQuery)
    if (clusterId) {
      await db
        .update(queryClusters)
        .set({ memberQueries: [...cluster.memberQueries] })
        .where(eq(queryClusters.clusterId, clusterId))
      updated += 1
      continue
    }
    fresh.push({
      accountId: scope.accountId,
      headQuery: cluster.headQuery,
      memberQueries: [...cluster.memberQueries],
    })
  }

  if (fresh.length > 0) {
    await db.insert(queryClusters).values(fresh)
    inserted = fresh.length
  }

  return { inserted, updated }
}

export async function listQueryClusters(
  db: Db,
  scope: AccountScope,
): Promise<QueryClusterRow[]> {
  return db
    .select()
    .from(queryClusters)
    .where(eq(queryClusters.accountId, scope.accountId))
    .orderBy(queryClusters.headQuery)
}

/**
 * One cluster by its durable id — the lineage an article is written from. A
 * topic stores the id rather than the terms, so the generation cycle reads the
 * head search and its members back through here.
 */
export async function findQueryClusterById(
  db: Db,
  scope: AccountScope,
  clusterId: string,
): Promise<QueryClusterRow | undefined> {
  const [row] = await db
    .select()
    .from(queryClusters)
    .where(and(eq(queryClusters.accountId, scope.accountId), eq(queryClusters.clusterId, clusterId)))
    .limit(1)
  return row
}

export type CtrCurveRow = typeof ctrCurve.$inferSelect

export interface CtrCurveInput {
  readonly curveJson: Readonly<Record<string, number>>
  readonly sampleN: number
  readonly brandedExcluded: boolean
  readonly fittedAt?: Date
}

/**
 * Records a fit. Every refit is a new row, so the table is the history of what
 * the store's click behaviour looked like over time and the newest row is the
 * live one — which is what makes "the curve moved and the signal changed with
 * it" answerable after the fact.
 */
export async function insertCtrCurve(
  db: Db,
  scope: AccountScope,
  input: CtrCurveInput,
): Promise<CtrCurveRow> {
  const [row] = await db
    .insert(ctrCurve)
    .values({
      accountId: scope.accountId,
      curveJson: input.curveJson,
      sampleN: input.sampleN,
      brandedExcluded: input.brandedExcluded,
      ...(input.fittedAt ? { fittedAt: input.fittedAt } : {}),
    })
    .returning()
  if (!row) throw new Error('failed to record the fitted click curve')
  return row
}

/** The curve in force for this store: the most recent fit. */
export async function latestCtrCurve(
  db: Db,
  scope: AccountScope,
): Promise<CtrCurveRow | undefined> {
  const [row] = await db
    .select()
    .from(ctrCurve)
    .where(eq(ctrCurve.accountId, scope.accountId))
    .orderBy(desc(ctrCurve.fittedAt))
    .limit(1)
  return row
}

/**
 * The search terms the merchant confirmed during onboarding.
 *
 * Read here, in the search-intelligence repository, rather than in a keywords
 * one, because no keywords repository exists yet and creating the file the
 * store-intelligence lane will certainly want would collide with it. It is a
 * read of one column with no writes, so moving it later costs nothing.
 *
 * Clusters prefer these as their head, so what a merchant sees named on screen
 * is the term they themselves confirmed rather than whichever phrasing Google
 * happened to show the store for most.
 */
export async function confirmedKeywordTerms(db: Db, scope: AccountScope): Promise<string[]> {
  const rows = await db
    .select({ term: keywords.term })
    .from(keywords)
    .where(and(eq(keywords.accountId, scope.accountId), eq(keywords.confirmed, true)))
  return rows.map((row) => row.term)
}

// ── What the Performance screens read ───────────────────────────────────────

export interface GscDayTotal {
  /** `YYYY-MM-DD`. */
  readonly date: string
  readonly clicks: number
  readonly impressions: number
}

/**
 * One row per day the store has any search data for, oldest first.
 *
 * Days the store was shown on nothing are simply absent rather than returned as
 * noughts, because the two are different facts and the chart draws them
 * differently: a day with no row is a day Search Console never reported, and
 * filling it with a nought would draw a collapse in traffic that never
 * happened.
 */
export async function gscDayTotals(
  db: Db,
  scope: AccountScope,
  window: GscWindow,
): Promise<GscDayTotal[]> {
  const rows = await db
    .select({
      date: gscDaily.date,
      clicks: sql<string>`sum(${gscDaily.clicks})`,
      impressions: sql<string>`sum(${gscDaily.impressions})`,
    })
    .from(gscDaily)
    .where(
      and(
        eq(gscDaily.accountId, scope.accountId),
        gte(gscDaily.date, window.startDate),
        lte(gscDaily.date, window.endDate),
      ),
    )
    .groupBy(gscDaily.date)
    .orderBy(gscDaily.date)

  return rows.map((row) => ({
    date: row.date,
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
  }))
}

/** The last day this store has any search data for, or null when it has none. */
export async function latestGscDay(db: Db, scope: AccountScope): Promise<string | null> {
  const [row] = await db
    .select({ date: sql<string | null>`max(${gscDaily.date})` })
    .from(gscDaily)
    .where(eq(gscDaily.accountId, scope.accountId))
    .limit(1)
  return row?.date ?? null
}

export interface GscKeyTotal {
  /** The page address, or the search itself — whichever the caller asked to group by. */
  readonly key: string
  readonly clicks: number
  readonly impressions: number
  /** Impression-weighted, so a page shown ten thousand times is not averaged against one shown twice. */
  readonly position: number | null
}

/**
 * Every page the store was shown for over a window, busiest first.
 *
 * Read from the page-level totals rather than the page × search table, because
 * summing the finer table would double-count nothing but would cost a great
 * deal more for an answer Google already gave us at this grain.
 */
export async function gscPageTotals(
  db: Db,
  scope: AccountScope,
  window: GscWindow,
): Promise<GscKeyTotal[]> {
  const rows = await db
    .select({
      key: gscDaily.page,
      clicks: sql<string>`sum(${gscDaily.clicks})`,
      impressions: sql<string>`sum(${gscDaily.impressions})`,
      position: sql<
        string | null
      >`sum(${gscDaily.position} * ${gscDaily.impressions}) / nullif(sum(${gscDaily.impressions}), 0)`,
    })
    .from(gscDaily)
    .where(
      and(
        eq(gscDaily.accountId, scope.accountId),
        gte(gscDaily.date, window.startDate),
        lte(gscDaily.date, window.endDate),
      ),
    )
    .groupBy(gscDaily.page)
    .orderBy(sql`sum(${gscDaily.impressions}) desc`)

  return rows.map(toKeyTotal)
}

/** Every search the store was shown for over a window, busiest first. */
export async function gscQueryTotals(
  db: Db,
  scope: AccountScope,
  window: GscWindow,
): Promise<GscKeyTotal[]> {
  const rows = await db
    .select({
      key: gscQueryDaily.query,
      clicks: sql<string>`sum(${gscQueryDaily.clicks})`,
      impressions: sql<string>`sum(${gscQueryDaily.impressions})`,
      position: sql<
        string | null
      >`sum(${gscQueryDaily.position} * ${gscQueryDaily.impressions}) / nullif(sum(${gscQueryDaily.impressions}), 0)`,
    })
    .from(gscQueryDaily)
    .where(
      and(
        eq(gscQueryDaily.accountId, scope.accountId),
        gte(gscQueryDaily.date, window.startDate),
        lte(gscQueryDaily.date, window.endDate),
      ),
    )
    .groupBy(gscQueryDaily.query)
    .orderBy(sql`sum(${gscQueryDaily.impressions}) desc`)

  return rows.map(toKeyTotal)
}

function toKeyTotal(row: {
  key: string
  clicks: string
  impressions: string
  position: string | null
}): GscKeyTotal {
  return {
    key: row.key,
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
    position: row.position === null ? null : Number(row.position),
  }
}
