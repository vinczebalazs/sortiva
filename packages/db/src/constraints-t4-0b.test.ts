import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  CHECK_VIOLATION,
  databaseAvailable,
  insertAccount,
  pgErrorCode,
  setupTestDb,
  truncateAll,
  type TestDb,
} from './testing'

/**
 * T4.0b: a finished draft had nowhere to live. `articles` carried a title, a
 * slug and a state, and no column for the words — so an article the pipeline
 * had written, checked and grounded existed for the length of one job run and
 * was then gone, which left the judge with nothing to grade and the review
 * screen with nothing to show.
 *
 * `body_json` holds the draft in the shape the writer produced it — intro,
 * sections, FAQ — rather than rendered prose, on the founder's decision
 * (`DECISIONS.md`, 2026-09-03, FOUNDER). `meta_description` sits beside the
 * title because publishing and export read it as a field of their own.
 *
 * Migration only: nothing writes either column yet. These tests prove the
 * shape against a real Postgres, the way `constraints-t4-0a.test.ts` does for
 * the store-page mini-wave before it.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('articles.body_json (T4.0b — a draft has somewhere to be stored)', () => {
  let ctx: TestDb
  let pool: pg.Pool

  beforeAll(async () => {
    ctx = await setupTestDb('constraints_t4_0b')
    pool = ctx.pool
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
  })

  async function anArticle(slug = 'best-trail-shoes'): Promise<string> {
    const accountId = await insertAccount(pool, `${slug}@example.com`)
    // A topic must come from an opportunity, and an article from a topic — the
    // chain that makes an article traceable back to why it was written.
    const { rows: opportunity } = await pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, rules_version)
       VALUES ($1,'uncovered_commercial_query','query_cluster',$2,'[]'::jsonb,'high',
          80, 70, 'uncovered_commercial_query.default', 'create', 'abc123')
       RETURNING id`,
      [accountId, `cluster:${slug}`],
    )
    const { rows: topic } = await pool.query<{ id: string }>(
      `INSERT INTO topics (account_id, opportunity_id, title, intent_class, source, scheduled_date)
       VALUES ($1,$2,'Best trail shoes','buying_guide','auto','2026-10-01')
       RETURNING id`,
      [accountId, opportunity[0]!.id],
    )
    const { rows: article } = await pool.query<{ id: string }>(
      `INSERT INTO articles (account_id, topic_id, title, slug)
       VALUES ($1,$2,'Best trail shoes',$3)
       RETURNING id`,
      [accountId, topic[0]!.id, slug],
    )
    return article[0]!.id
  }

  it('lets an article exist before its draft does', async () => {
    // The row is created first so a claim has something to hang off; the words
    // arrive later, when the writer has run.
    const id = await anArticle()
    const { rows } = await pool.query<{ body_json: unknown; meta_description: string | null }>(
      `SELECT body_json, meta_description FROM articles WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ body_json: null, meta_description: null })
  })

  it('stores the draft with its parts still separate', async () => {
    const id = await anArticle()
    const draft = {
      intro: 'Wide feet change which trail shoe fits.',
      sections: [{ heading: 'How we picked', body: 'Last width, drop, and outsole.' }],
      faq: [{ question: 'Do trail shoes stretch?', answer: 'The upper gives a little; the last does not.' }],
    }
    await pool.query(`UPDATE articles SET body_json = $2::jsonb, meta_description = $3 WHERE id = $1`, [
      id,
      JSON.stringify(draft),
      'Trail shoes that fit wide feet, picked on last width and drop.',
    ])

    const { rows } = await pool.query<{ body_json: typeof draft }>(
      `SELECT body_json FROM articles WHERE id = $1`,
      [id],
    )
    // Read back as an object, not a string to be parsed — which is the whole
    // reason this is jsonb rather than compressed text.
    expect(rows[0]!.body_json).toEqual(draft)
  })

  it('can be asked about one part without reading the whole article', async () => {
    // What the structure buys. A judge grading section by section, or a later
    // query across articles, does not have to pull and parse every body.
    const id = await anArticle()
    await pool.query(`UPDATE articles SET body_json = $2::jsonb WHERE id = $1`, [
      id,
      JSON.stringify({ intro: 'x', sections: [{ heading: 'How we picked', body: 'y' }], faq: [] }),
    ])
    const { rows } = await pool.query<{ heading: string }>(
      `SELECT body_json -> 'sections' -> 0 ->> 'heading' AS heading FROM articles WHERE id = $1`,
      [id],
    )
    expect(rows[0]!.heading).toBe('How we picked')
  })

  it('refuses a draft that is not an object', async () => {
    // Rendered prose, or a bare list of sections, stored by something that
    // decided the shape did not matter. Every reader would then have to guess.
    const id = await anArticle()
    const error = await pool
      .query(`UPDATE articles SET body_json = $2::jsonb WHERE id = $1`, [id, JSON.stringify('# Best trail shoes')])
      .catch((e) => e)
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION)

    const alsoRefused = await pool
      .query(`UPDATE articles SET body_json = $2::jsonb WHERE id = $1`, [id, JSON.stringify([{ heading: 'a' }])])
      .catch((e) => e)
    expect(pgErrorCode(alsoRefused)).toBe(CHECK_VIOLATION)
  })

  it('still allows clearing a draft back to nothing', async () => {
    // A discarded draft leaves the article row in place — it is referenced by
    // claims and by the topic that produced it.
    const id = await anArticle()
    await pool.query(`UPDATE articles SET body_json = '{}'::jsonb WHERE id = $1`, [id])
    await pool.query(`UPDATE articles SET body_json = NULL WHERE id = $1`, [id])
    const { rows } = await pool.query<{ body_json: unknown }>(`SELECT body_json FROM articles WHERE id = $1`, [id])
    expect(rows[0]!.body_json).toBeNull()
  })
})
