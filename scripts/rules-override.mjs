#!/usr/bin/env node
/**
 * `pnpm rules list` / `pnpm rules set ...` / `pnpm rules clear ...` — moving one
 * of the numbers the product judges by, for one store, without a deploy.
 *
 * Every threshold lives in `packages/rules/signals.config.yaml`, with a global
 * layer and a per-language one. `rules_overrides` is the layer above that: one
 * row moves one number for one store, one language or one page type, and the
 * narrowest row wins.
 *
 * Nothing here is applied on trust. A key that names no threshold, a value of
 * the wrong kind, and a value that would leave the store with a set of numbers
 * the product cannot run on are all refused before anything is written — a
 * threshold that quietly fails to apply is worse than one that was never set.
 *
 * A number is also refused when nothing would read it. Only some of the
 * product reads a store's overrides; the rest takes the repo file's numbers
 * whatever the table says. Setting one of those used to succeed and change
 * nothing, which is worse than a refusal, because the operator then believes
 * it is in force. `packages/rules/src/reach.ts` is the record of which is
 * which, and this is what refuses against it.
 *
 * Every write is recorded with the name of the person who made it: `auto` is
 * refused, because the product does not move its own thresholds. A row aimed at
 * every store changes every store's decisions at once, so it takes two named
 * people, the same way lowering a global kill switch does.
 *
 * Runs under `tsx`; the repo consumes workspace packages as TypeScript source.
 */
import { closeDb, db as database } from '../packages/db/src/client.ts'
import { systemScope } from '../packages/db/src/scope.ts'
import {
  clearRulesOverride,
  listRulesOverrides,
  setRulesOverride,
} from '../packages/db/src/repositories/rules.ts'
import { rules } from '../packages/rules/src/load.ts'
import { describeScope } from '../packages/rules/src/overrides.ts'
import { reachOf } from '../packages/rules/src/reach.ts'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const [command, ...rest] = argv

const AUTOMATIC_ACTOR = 'auto'

function usage(code) {
  console.log(`Usage:
  pnpm rules list [--account <id>]
  pnpm rules set <key> <value> --actor <you> [--account <id>] [--locale <tag>] [--page-type <type>] [--second <colleague>] [--partial]
  pnpm rules clear <key> --actor <you> [--account <id>] [--locale <tag>] [--page-type <type>] [--second <colleague>]

A key is the dotted name of one number, e.g.
  gates.demand_floor.monthly_search_volume_min
  signals.striking_distance.position_max

A value is read as JSON, so 250 is a number, true is a flag and anything else is
a piece of text.

Aim a row with --account, --locale or --page-type. The narrowest row wins: one
store beats one language, which beats one page type. A row with no aim at all
changes every store, and needs a second named person.

Not every number can be moved this way. Some are read from the repo file by
every piece of code that uses them, and a row aiming at one of those would
change nothing at all — those are refused, naming what reads them. Some are
read both ways; those are refused too, saying which half would not move, and
--partial sets one anyway once you have read that. Clearing a row is never
refused.`)
  process.exit(code)
}

if (!command || command === '--help' || command === '-h') usage(2)
if (!process.env.DATABASE_URL) {
  console.error('FAIL  DATABASE_URL is not set')
  process.exit(1)
}

function option(name) {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? undefined : rest[at + 1]
}

function flag(name) {
  return rest.includes(`--${name}`)
}

/**
 * Whether this number is read by anything that looks at the store's rows.
 *
 * `ignored` means every reader takes the repo file's value, so the row would
 * be stored and never consulted. `partial` means some readers resolve the
 * store's rows and some do not, so the change is real but smaller than it
 * looks — which is its own way of misleading somebody, and why it takes an
 * explicit --partial rather than a warning nobody reads.
 */
function reachRefusal(key) {
  const entry = reachOf(key)
  if (!entry || entry.reach === 'honoured') return undefined
  if (entry.reach === 'ignored') {
    return `Nothing would read "${key}" from this row.\n${entry.note}\nSetting it would change nothing. Moving this number needs a change to the code that reads it.`
  }
  if (flag('partial')) return undefined
  return `"${key}" is only read from a store's overrides by some of the code that uses it.\n${entry.note}\nPass --partial to set it anyway, knowing that.`
}

/** Short marker for the listing, so a row that is not doing what it looks like is visible. */
function reachWarning(key) {
  const entry = reachOf(key)
  if (!entry || entry.reach === 'honoured') return undefined
  return entry.reach === 'ignored'
    ? `NOT READ: ${entry.note}`
    : `PARTLY READ: ${entry.note}`
}

/** A row's aim, as the operator gave it. Every unset part means "not narrowed by that". */
function targetFromOptions() {
  return {
    accountId: option('account') ?? null,
    locale: option('locale') ?? null,
    pageType: option('page-type') ?? null,
  }
}

function scopeOf(target) {
  return {
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.locale ? { locale: target.locale } : {}),
    ...(target.pageType ? { pageType: target.pageType } : {}),
  }
}

function sameAim(row, target) {
  return (
    (row.accountId ?? null) === (target.accountId ?? null) &&
    (row.locale ?? null) === (target.locale ?? null) &&
    (row.pageType ?? null) === (target.pageType ?? null)
  )
}

/**
 * Who is on the record for this change. A row with no aim moves the numbers for
 * every store at once, which is the same weight as lowering a global kill
 * switch, so it takes two people rather than one person's confidence.
 */
function reviewWrite(target) {
  const first = (option('actor') ?? '').trim()
  const second = (option('second') ?? '').trim()

  if (first === '') {
    return { ok: false, detail: '--actor is required: every change is recorded with who made it.' }
  }
  if (first === AUTOMATIC_ACTOR) {
    return {
      ok: false,
      detail: 'A threshold is moved by a named person. The product never moves its own.',
    }
  }
  const global = !target.accountId && !target.locale && !target.pageType
  if (!global) return { ok: true, updatedBy: first }

  if (second === '' || second === AUTOMATIC_ACTOR) {
    return {
      ok: false,
      detail:
        'A row with no aim changes the numbers for every store, so two named people have to agree. Pass --second, or aim it with --account or --locale.',
    }
  }
  if (second === first) return { ok: false, detail: 'The second person has to be someone else.' }
  return { ok: true, updatedBy: `${first} + ${second}` }
}

/** The argument as JSON where it is JSON, and as plain text where it is not. */
function readValue(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Refuses a row the product could not act on, naming what is wrong with it.
 * Checks the candidate against the rows already in force at the same aim, so a
 * pair of rows that are each fine but contradict each other is caught here
 * rather than at the store's next scan.
 */
function refusalFor(target, candidates) {
  try {
    rules().resolve({
      ...(target.accountId ? { accountId: target.accountId } : {}),
      ...(target.locale ? { locale: target.locale } : {}),
      ...(target.pageType ? { pageType: target.pageType } : {}),
      overrides: candidates,
    })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function asOverrideRow(row) {
  return {
    scope: scopeOf({ accountId: row.accountId, locale: row.locale, pageType: row.pageType }),
    key: row.key,
    value: row.value,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
  }
}

const db = database()
const system = systemScope('rules_overrides holds rows that belong to every store')

try {
  if (command === 'list') {
    const accountId = option('account')
    const rows = await listRulesOverrides(db, system, accountId ? { accountId } : {})
    if (rows.length === 0) {
      console.log(
        accountId
          ? 'Nothing is overridden for that store. It is judged by the numbers in the repo.'
          : 'Nothing is overridden anywhere. Every store is judged by the numbers in the repo.',
      )
    } else {
      console.log(`${rows.length} override(s):\n`)
      for (const row of rows) {
        const aim = describeScope(asOverrideRow(row).scope)
        const refusal = refusalFor(
          { accountId: row.accountId, locale: row.locale, pageType: row.pageType },
          [asOverrideRow(row)],
        )
        console.log(`  ${row.key} = ${JSON.stringify(row.value)}`)
        console.log(`    for:     ${aim}`)
        console.log(`    set by:  ${row.updatedBy} at ${new Date(row.updatedAt).toISOString()}`)
        const warning = reachWarning(row.key)
        if (warning) console.log(`    ${warning}`)
        if (refusal) {
          console.log(`    REFUSED: ${refusal.split('\n')[0]}`)
          console.log("             This store's scan will fail until it is corrected or cleared.")
        }
        console.log()
      }
      console.log(
        'A decision made with any of these in force is stamped with a version ending in "+ov.",',
      )
      console.log('so it can never be mistaken for one made on the numbers in the repo.')
    }
  } else if (command === 'set' || command === 'clear') {
    const key = rest[0]
    if (!key || key.startsWith('--')) {
      console.error('FAIL  name the threshold to change, e.g. gates.demand_floor.monthly_search_volume_min')
      usage(1)
    }
    const target = targetFromOptions()
    const review = reviewWrite(target)
    if (!review.ok) {
      console.error(`FAIL  ${review.detail}`)
      process.exit(1)
    }

    if (command === 'set') {
      const rawValue = rest[1]
      if (rawValue === undefined || rawValue.startsWith('--')) {
        console.error(`FAIL  give the value to set ${key} to.`)
        process.exit(1)
      }
      const notRead = reachRefusal(key)
      if (notRead) {
        console.error(`FAIL  ${notRead}`)
        console.error('Nothing was written.')
        process.exit(1)
      }

      const value = readValue(rawValue)
      const candidate = {
        scope: scopeOf(target),
        key,
        value,
        updatedBy: review.updatedBy,
        updatedAt: new Date(),
      }
      const alreadyAtThisAim = (await listRulesOverrides(db, system))
        .filter((row) => sameAim(row, target) && row.key !== key)
        .map(asOverrideRow)

      const refusal = refusalFor(target, [...alreadyAtThisAim, candidate])
      if (refusal) {
        console.error(`FAIL  ${refusal}`)
        console.error('Nothing was written.')
        process.exit(1)
      }

      const written = await setRulesOverride(db, system, {
        ...target,
        key,
        value,
        updatedBy: review.updatedBy,
      })
      console.log(`SET  ${written.key} = ${JSON.stringify(written.value)} for ${describeScope(scopeOf(target))}.`)
      console.log('It applies from the next scan of every store it aims at; nothing already decided is revisited.')
    } else {
      const removed = await clearRulesOverride(db, system, { ...target, key })
      if (removed.length === 0) {
        console.log(`NOT SET  ${key} was not overridden for ${describeScope(scopeOf(target))}. Nothing changed.`)
      } else {
        console.log(`CLEARED  ${key} for ${describeScope(scopeOf(target))}, by ${review.updatedBy}.`)
        console.log('Every store it aimed at goes back to the numbers in the repo at its next scan.')
      }
    }
  } else {
    usage(2)
  }
} finally {
  await closeDb()
}
