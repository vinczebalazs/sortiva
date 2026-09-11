import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accountScope,
  insertDomainRow,
  markAccountDeleted,
  sessions,
  type Db,
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { DOMAIN_RELEASE_GRACE_DAYS, domainReleaseAt, silentLogger } from '@sortiva/core'
import { runRetentionSweep } from './retention'

/**
 * The sweep against a real database, because every claim it makes is a claim
 * about rows.
 *
 * The centrepiece is the seven-day hold on a deleted account's domain. It is
 * the one promise here a merchant would notice being broken in either
 * direction: released too early and a squatter takes the domain of someone who
 * deleted their account by mistake; never released and the promise was a lie.
 * So it is tested from both sides of the deadline rather than by reading a
 * timestamp back.
 */

const DAY = 86_400_000
/**
 * The moment the account in these tests was deleted, always eight days before
 * now rather than a date typed in.
 *
 * The rows these tests prune are aged against the *database's* clock (`now() -
 * 31 days`), while the sweep runs against the clock the test hands it. A fixed
 * date drifts away from the real one every day it is not edited, and this file
 * went red one morning in September 2026 when the gap grew past the retention
 * window — a failure that said nothing about the sweep.
 */
const DELETED_AT = new Date(Date.now() - 8 * DAY)

let harness: TestDb
let db: Db

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('retention_sweep')
  db = harness.db
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
})

function deps(now: Date) {
  return { getDb: () => db, getPool: () => harness.pool, log: silentLogger, now: () => now }
}

async function deletedAccountWithDomain(domain: string): Promise<string> {
  const accountId = await insertAccount(harness.pool, `owner-${domain}@example.com`)
  await insertDomainRow(db, accountScope(accountId), domain)
  const written = await markAccountDeleted(db, accountScope(accountId), {
    at: DELETED_AT,
    domainReleaseAt: domainReleaseAt(DELETED_AT),
  })
  expect(written, 'the deletion was not recorded').toBe(true)
  return accountId
}

/** Whether somebody else could take the domain right now. */
async function claimableByAnother(domain: string): Promise<boolean> {
  const other = await insertAccount(harness.pool, `rival-${domain}-${Date.now()}@example.com`)
  const row = await insertDomainRow(db, accountScope(other), domain)
  if (row) {
    // Put it back, so a probe does not change the answer for the next one.
    await harness.pool.query('delete from domains where account_id = $1', [other])
  }
  await harness.pool.query('delete from accounts where id = $1', [other])
  return row !== undefined
}

describe('the seven-day hold on a deleted account’s domain', () => {
  it('still refuses the domain to anyone else on day 6', async () => {
    await deletedAccountWithDomain('sixdays.example')
    const day6 = new Date(DELETED_AT.getTime() + 6 * DAY)

    const report = await runRetentionSweep(deps(day6))

    expect(report.accountsErased).toBe(0)
    expect(await claimableByAnother('sixdays.example')).toBe(false)
  })

  it('frees the domain on day 8', async () => {
    await deletedAccountWithDomain('eightdays.example')
    const day8 = new Date(DELETED_AT.getTime() + 8 * DAY)

    const report = await runRetentionSweep(deps(day8))

    expect(report.accountsErased).toBe(1)
    expect(await claimableByAnother('eightdays.example')).toBe(true)
  })

  it('erases the account itself, not only the claim', async () => {
    const accountId = await deletedAccountWithDomain('gone.example')
    await runRetentionSweep(deps(new Date(DELETED_AT.getTime() + 8 * DAY)))
    const { rows } = await harness.pool.query('select id from accounts where id = $1', [accountId])
    expect(rows).toEqual([])
  })

  it('leaves a live account alone however old it is', async () => {
    // The erase is guarded on the deletion having actually been asked for, so a
    // bug in a caller cannot erase somebody who is still using the product.
    const accountId = await insertAccount(harness.pool, 'live@example.com')
    await insertDomainRow(db, accountScope(accountId), 'live.example')
    await runRetentionSweep(deps(new Date(DELETED_AT.getTime() + 400 * DAY)))
    const { rows } = await harness.pool.query('select id from accounts where id = $1', [accountId])
    expect(rows).toHaveLength(1)
  })

  it('holds for the number of days the policy says, not a number written here twice', () => {
    expect(DOMAIN_RELEASE_GRACE_DAYS).toBe(7)
  })
})

describe('pruning by age', () => {
  async function webhookAged(id: string, days: number): Promise<void> {
    await harness.pool.query(
      `insert into webhook_events (webhook_id, source, topic, payload, received_at, status)
       values ($1, 'shopify', 'products/update', '{"shop_handle":"acme"}'::jsonb, now() - ($2 || ' days')::interval, 'processed')`,
      [id, String(days)],
    )
  }

  async function notificationAged(accountId: string, key: string, days: number): Promise<void> {
    await harness.pool.query(
      `insert into notifications (account_id, type, dedupe_key, payload_json, created_at)
       values ($1, 'article_published', $2, '{}'::jsonb, now() - ($3 || ' days')::interval)`,
      [accountId, key, String(days)],
    )
  }

  async function emailAged(accountId: string, key: string, days: number): Promise<void> {
    await harness.pool.query(
      `insert into email_sends (account_id, type, dedupe_key, template_version, state, queued_at)
       values ($1, 'article_published', $2, 'v1', 'sent', now() - ($3 || ' days')::interval)`,
      [accountId, key, String(days)],
    )
  }

  async function count(table: string): Promise<number> {
    const { rows } = await harness.pool.query<{ n: string }>(`select count(*)::text as n from ${table}`)
    return Number(rows[0]!.n)
  }

  it('deletes what is past its window and keeps what is not', async () => {
    const accountId = await insertAccount(harness.pool, 'keeper@example.com')
    await webhookAged('old-delivery', 31)
    await webhookAged('recent-delivery', 29)
    await notificationAged(accountId, 'old', 91)
    await notificationAged(accountId, 'recent', 89)
    await emailAged(accountId, 'old', 366)
    await emailAged(accountId, 'recent', 364)
    await harness.pool.query(
      `insert into request_cache (cache_key, kind, response_json, expires_at)
       values ('stale', 'llm', '{}'::jsonb, now() - interval '1 hour'),
              ('fresh', 'llm', '{}'::jsonb, now() + interval '1 hour')`,
    )
    await harness.pool.query(
      `insert into verification_tokens (identifier, token, expires)
       values ('a@example.com', 'dead', now() - interval '1 hour'),
              ('b@example.com', 'live', now() + interval '1 hour')`,
    )
    await harness.pool.query(
      `insert into gsc_daily (account_id, date, page, clicks, impressions)
       values ($1, (now() - interval '600 days')::date, 'https://x/a', 1, 1),
              ($1, (now() - interval '100 days')::date, 'https://x/b', 1, 1)`,
      [accountId],
    )

    const report = await runRetentionSweep(deps(new Date()))

    expect(report.pruned).toMatchObject({
      webhook_events: 1,
      notifications: 1,
      email_sends: 1,
      request_cache: 1,
      verification_tokens: 1,
      gsc_daily: 1,
    })
    expect(await count('webhook_events')).toBe(1)
    expect(await count('notifications')).toBe(1)
    expect(await count('email_sends')).toBe(1)
    expect(await count('request_cache')).toBe(1)
    expect(await count('verification_tokens')).toBe(1)
    expect(await count('gsc_daily')).toBe(1)
  })

  it('is idempotent: a second run the same night deletes nothing', async () => {
    const accountId = await insertAccount(harness.pool, 'twice@example.com')
    await webhookAged('old-delivery', 31)
    await notificationAged(accountId, 'old', 91)
    await emailAged(accountId, 'old', 366)
    await deletedAccountWithDomain('twice.example')

    const now = new Date(DELETED_AT.getTime() + 8 * DAY)
    const first = await runRetentionSweep(deps(now))
    const second = await runRetentionSweep(deps(now))

    expect(first.accountsErased).toBe(1)
    expect(first.pruned).toMatchObject({ webhook_events: 1, notifications: 1, email_sends: 1 })
    // Not "deleted the same rows again" — there is nothing left to find. That
    // is the whole idempotency argument for a sweep with no cursor to keep.
    expect(second.accountsErased).toBe(0)
    expect(second.pruned).toEqual({
      webhook_events: 0,
      notifications: 0,
      email_sends: 0,
      request_cache: 0,
      verification_tokens: 0,
      gsc_daily: 0,
      gsc_query_daily: 0,
      sessions: 0,
    })
  })

  it('never touches the record of paid work', async () => {
    // `idempotency_ledger` is the evidence that billable work was already done.
    // Deleting a row lets a redelivered job do it again and re-bill for it, so
    // the sweep may not reach it — by account, by age, or at all today.
    const accountId = await insertAccount(harness.pool, 'ledger@example.com')
    await harness.pool.query(
      `insert into idempotency_ledger (idempotency_key, output_ref, completed_at)
       values ('catalog_sync:1', '{}'::jsonb, now() - interval '900 days')`,
    )
    await harness.pool.query(
      `insert into spend_events (account_id, vendor, call_type, usd_cost, outcome, occurred_at)
       values ($1, 'dataforseo', 'serp', 0.02, 'succeeded', now() - interval '900 days')`,
      [accountId],
    )

    await runRetentionSweep(deps(new Date()))

    expect(await count('idempotency_ledger')).toBe(1)
    expect(await count('spend_events')).toBe(1)
  })
})

/**
 * A session is one signed-in browser. It lapses on a date fixed when the
 * merchant signed in, and now that a session lasts a month rather than a day,
 * a row nobody can use sits thirty times longer in the table every signed-in
 * request reads.
 */
describe('clearing sessions that have lapsed', () => {
  async function sessionExpiring(
    accountId: string,
    token: string,
    interval: string,
  ): Promise<void> {
    await harness.pool.query(
      `insert into sessions (session_token, account_id, expires)
       values ($1, $2, now() + ($3)::interval)`,
      [token, accountId, interval],
    )
  }

  async function tokensLeft(): Promise<string[]> {
    const { rows } = await harness.pool.query<{ session_token: string }>(
      'select session_token from sessions order by session_token',
    )
    return rows.map((r) => r.session_token)
  }

  it('removes what has lapsed and leaves every session still good', async () => {
    const accountId = await insertAccount(harness.pool, 'signed-in@example.com')
    await sessionExpiring(accountId, 'lapsed-yesterday', '-1 day')
    await sessionExpiring(accountId, 'lapsed-a-minute-ago', '-1 minute')
    // The one that matters: a live session is not the same thing as a session
    // signed in today. Deleting by age rather than by the row's own date would
    // sign this merchant out with a day of their month still to run.
    await sessionExpiring(accountId, 'lapses-tomorrow', '1 day')
    await sessionExpiring(accountId, 'lapses-in-a-month', '30 days')

    const report = await runRetentionSweep(deps(new Date()))

    expect(report.pruned.sessions).toBe(2)
    expect(await tokensLeft()).toEqual(['lapses-in-a-month', 'lapses-tomorrow'])
  })

  it('is idempotent: the second run the same night finds nothing lapsed', async () => {
    const accountId = await insertAccount(harness.pool, 'twice-swept@example.com')
    await sessionExpiring(accountId, 'lapsed', '-1 hour')
    await sessionExpiring(accountId, 'live', '10 days')

    const now = new Date()
    expect((await runRetentionSweep(deps(now))).pruned.sessions).toBe(1)
    expect((await runRetentionSweep(deps(now))).pruned.sessions).toBe(0)
    expect(await tokensLeft()).toEqual(['live'])
  })

  it('cannot cost the night its obligations if the delete fails', async () => {
    // The reason this step is written last. Erasing an account whose seven-day
    // hold has passed is a promise with a deadline; tidying lapsed sessions is
    // housekeeping. A sweep that died here and therefore never erased the
    // account would be a worse defect than the one this card fixes.
    await deletedAccountWithDomain('obligation.example')
    const other = await insertAccount(harness.pool, 'bystander@example.com')
    await sessionExpiring(other, 'lapsed', '-1 hour')

    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'delete') return Reflect.get(target, prop, receiver)
        return (table: unknown) => {
          if (table === sessions) throw new Error('the sessions delete failed')
          return target.delete(table as never)
        }
      },
    }) as Db

    const now = new Date(DELETED_AT.getTime() + 8 * DAY)
    await expect(
      runRetentionSweep({ ...deps(now), getDb: () => broken }),
    ).rejects.toThrow('the sessions delete failed')

    const { rows } = await harness.pool.query<{ n: string }>(
      'select count(*)::text as n from accounts',
    )
    // Only the bystander is left: the deleted account was erased before the
    // sweep ever reached the step that blew up.
    expect(rows[0]!.n).toBe('1')
    expect(await tokensLeft()).toEqual(['lapsed'])
  })
})

describe('honouring a store redaction request', () => {
  const RECEIVED_AT = new Date('2026-09-02T09:00:00.000Z')

  async function storeWithData(
    handle: string,
    options: { connectedAt?: Date; live?: boolean } = {},
  ): Promise<string> {
    const accountId = await insertAccount(harness.pool, `${handle}@example.com`)
    await harness.pool.query(
      `insert into shopify_conns (account_id, shop_handle, access_token, granted_scopes, connected_at, invalidated_at)
       values ($1, $2, 'cipher', '{read_products}', $3, $4)`,
      [
        accountId,
        handle,
        options.connectedAt ?? new Date(RECEIVED_AT.getTime() - DAY),
        options.live ? null : RECEIVED_AT,
      ],
    )
    await harness.pool.query(
      `insert into products (account_id, shopify_product_id, title) values ($1, '1', 'A candle')`,
      [accountId],
    )
    return accountId
  }

  async function redactionArrived(handle: string, webhookId: string, at = RECEIVED_AT) {
    await harness.pool.query(
      `insert into webhook_events (webhook_id, source, topic, payload, received_at, status)
       values ($1, 'shopify', 'shop/redact', $2::jsonb, $3, 'processed')`,
      // The envelope only. The receiver copies the store handle out of a request
      // header, and this sweep reads that and never the message body.
      [webhookId, JSON.stringify({ shop_handle: handle }), at],
    )
  }

  async function productCount(accountId: string): Promise<number> {
    const { rows } = await harness.pool.query<{ n: string }>(
      'select count(*)::text as n from products where account_id = $1',
      [accountId],
    )
    return Number(rows[0]!.n)
  }

  it('erases the store’s data and leaves the merchant’s own account standing', async () => {
    const accountId = await storeWithData('acme')
    await redactionArrived('acme', 'wh-1')

    const report = await runRetentionSweep(deps(new Date(RECEIVED_AT.getTime() + DAY)))

    expect(report.storesRedacted).toBe(1)
    expect(await productCount(accountId)).toBe(0)
    const { rows } = await harness.pool.query('select id from accounts where id = $1', [accountId])
    expect(rows, 'the account itself is not what was asked to be erased').toHaveLength(1)
  })

  it('is idempotent: the second night finds nothing to honour', async () => {
    await storeWithData('twice-store')
    await redactionArrived('twice-store', 'wh-2')
    const at = new Date(RECEIVED_AT.getTime() + DAY)

    expect((await runRetentionSweep(deps(at))).storesRedacted).toBe(1)
    // Erasing the store also deletes its connection row, so the next pass finds
    // no account behind that handle. No marker to maintain, and none to lose.
    expect((await runRetentionSweep(deps(at))).storesRedacted).toBe(0)
  })

  it('leaves a store the merchant has since reconnected alone', async () => {
    // The dangerous case: a merchant uninstalls, Shopify asks us to erase, and
    // they reinstall the next day. Erasing then would wipe the store they just
    // reconnected, every night, until the request aged out.
    const accountId = await storeWithData('returning', {
      live: true,
      connectedAt: new Date(RECEIVED_AT.getTime() + DAY),
    })
    await redactionArrived('returning', 'wh-3')

    const report = await runRetentionSweep(deps(new Date(RECEIVED_AT.getTime() + 2 * DAY)))

    expect(report.storesRedacted).toBe(0)
    expect(await productCount(accountId)).toBe(1)
  })

  it('honours the request before the prune that would delete the record of it', async () => {
    // The trap this ordering exists for: the only durable record of a redaction
    // request is the stored delivery, and the same sweep deletes stored
    // deliveries at thirty days — which is when the obligation matures.
    const old = new Date(Date.now() - 29.5 * DAY)
    const accountId = await storeWithData('nearly-expired', {
      connectedAt: new Date(old.getTime() - DAY),
    })
    await redactionArrived('nearly-expired', 'wh-4', old)

    const report = await runRetentionSweep(deps(new Date()))

    expect(report.storesRedacted).toBe(1)
    expect(await productCount(accountId)).toBe(0)
  })

  it('ignores a delivery for a store nobody here holds', async () => {
    await redactionArrived('a-stranger', 'wh-5')
    expect((await runRetentionSweep(deps(new Date(RECEIVED_AT.getTime() + DAY)))).storesRedacted).toBe(0)
  })
})
