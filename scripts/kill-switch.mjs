#!/usr/bin/env node
/**
 * `pnpm switch list` / `pnpm switch raise ...` / `pnpm switch lower ...` /
 * `pnpm switch note ...` / `pnpm switch history` — the brakes, by hand.
 *
 * Raising a switch stops work; it never takes reading away. A merchant whose
 * account is paused keeps every screen, every article and every chart they had
 * a minute earlier — pausing is about what we do *for* them, not about what
 * they may see.
 *
 * Lowering a global switch takes two named people. A global switch was raised
 * because something was wrong for everybody, and one person deciding alone that
 * it is over is how an incident gets closed because it was inconvenient rather
 * than because it was fixed. Both names go on the record.
 *
 * Nothing here can lower an automatic trip on the product's behalf: `auto` is
 * refused as an operator name. A trip means a person has to look.
 *
 * `note` is where what that person found gets written down. A switch row says
 * what tripped and when; it has nowhere to say what turned out to be wrong,
 * which often is not known until days later. Notes are signed for the same
 * reason flips are, and `auto` is refused as an author too. They take one name
 * rather than two even on a global incident: writing down what you saw is not
 * the decision that the incident is over, and a note that needs a colleague
 * present is a note that does not get written.
 *
 * `history` exists because `list` shows only what is stopped *now*. Lowering a
 * switch updates its row rather than deleting it, so a closed incident and its
 * notes are still there — `history` is how they are read back, and how an
 * operator gets the id needed to add a note to an incident that has since been
 * closed.
 *
 * Runs under `tsx`; the repo consumes workspace packages as TypeScript source.
 */
import { closeDb, db as database } from '../packages/db/src/client.ts'
import { accountScope, systemScope } from '../packages/db/src/scope.ts'
import {
  addIncidentFinding,
  findActiveAccountFlag,
  findActiveGlobalFlag,
  findFlagById,
  listActiveFlags,
  listFindingsForFlags,
  listIncidentFindings,
  listRecentFlags,
  resetAccountFlag,
  resetGlobalFlag,
  tripAccountFlag,
  tripGlobalFlag,
} from '../packages/db/src/repositories/system.ts'
import {
  KILL_SWITCHES,
  incidentFrom,
  killSwitch,
  reviewFinding,
  reviewReset,
} from '../packages/core/src/ops/kill-switches.ts'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const [command, ...rest] = argv

function usage(code) {
  console.log(`Usage:
  pnpm switch list
  pnpm switch raise <flag> --actor <you> --reason "<why>" [--account <id>]
  pnpm switch lower <flag> --actor <you> [--second <colleague>] [--account <id>]
  pnpm switch note <flag> --actor <you> --finding "<what you found>" [--account <id>]
  pnpm switch note --incident <id> --actor <you> --finding "<what you found>"
  pnpm switch history [<flag>] [--account <id>] [--limit <n>]

"list" shows what is stopped right now. "history" shows incidents that have
been closed as well, which is where a note about one of them is read back and
where its --incident id comes from.

Switches:`)
  for (const definition of KILL_SWITCHES) {
    console.log(`  ${definition.flag.padEnd(30)} ${definition.stops}`)
    if (definition.resetNeedsTwoOperators) {
      console.log(`  ${''.padEnd(30)} lowering this one needs a second operator.`)
    }
  }
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

/** How many incidents `history` shows when the operator does not say. */
const DEFAULT_HISTORY = 20

/**
 * One incident, with whatever anybody worked out about it underneath.
 *
 * The id is printed on every line-up because it is the only handle on an
 * incident once its switch is down: names find open switches, and a closed one
 * can only be named by id.
 */
function printIncident(row, notes) {
  const incident = incidentFrom(row)
  console.log(`  ${incident.flag}${incident.accountId ? ` (account ${incident.accountId})` : ''}`)
  console.log(`    incident: ${row.id}`)
  console.log(`    raised:  ${incident.raisedAt.toISOString()} by ${incident.raisedBy}${incident.automatic ? ' (automatic)' : ''}`)
  console.log(`    because: ${incident.reason}`)
  if (incident.closedAt) {
    console.log(`    closed:  ${incident.closedAt.toISOString()} by ${incident.closedBy}`)
  }
  if (notes.length === 0) {
    console.log('    found:   nothing written down yet.')
  } else {
    for (const note of notes) {
      console.log(`    found:   ${note.createdAt.toISOString()} ${note.author}: ${note.finding}`)
    }
  }
  console.log()
}

const db = database()
const system = systemScope('kill switches are about the whole product')

try {
  if (command === 'list') {
    const rows = await listActiveFlags(db, system)
    if (rows.length === 0) {
      console.log('Nothing is paused.')
    } else {
      const notes = await listFindingsForFlags(db, system, rows.map((row) => row.id))
      console.log(`${rows.length} switch(es) up:\n`)
      for (const row of rows) printIncident(row, notes.get(row.id) ?? [])
    }
  } else if (command === 'history') {
    const flag = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined
    if (flag && !killSwitch(flag)) {
      console.error(`FAIL  "${flag}" is not a switch this product raises.`)
      process.exit(1)
    }
    const limit = Number(option('limit') ?? DEFAULT_HISTORY)
    if (!Number.isInteger(limit) || limit < 1) {
      console.error('FAIL  --limit takes a whole number of incidents.')
      process.exit(1)
    }
    const rows = await listRecentFlags(db, system, {
      flag,
      accountId: option('account'),
      limit,
    })
    if (rows.length === 0) {
      console.log('No incidents match.')
    } else {
      const notes = await listFindingsForFlags(db, system, rows.map((row) => row.id))
      console.log(`${rows.length} incident(s), newest first:\n`)
      for (const row of rows) printIncident(row, notes.get(row.id) ?? [])
    }
  } else if (command === 'note') {
    const review = reviewFinding({
      author: option('actor') ?? '',
      finding: option('finding') ?? '',
    })
    if (!review.ok) {
      console.error(`FAIL  ${review.detail}`)
      process.exit(1)
    }

    const incidentId = option('incident')
    let target
    if (incidentId) {
      target = await findFlagById(db, system, incidentId)
      if (!target) {
        console.error(`FAIL  No incident has id ${incidentId}. \`pnpm switch history\` lists them.`)
        process.exit(1)
      }
    } else {
      const flag = rest[0]
      const accountId = option('account')
      const definition = flag ? killSwitch(flag) : undefined
      if (!definition) {
        console.error(`FAIL  "${flag ?? ''}" is not a switch this product raises.`)
        usage(1)
      }
      if (definition.scope === 'account' && !accountId) {
        console.error(`FAIL  ${flag} is about one store; pass --account <id>.`)
        process.exit(1)
      }
      target =
        definition.scope === 'global'
          ? await findActiveGlobalFlag(db, system, flag)
          : await findActiveAccountFlag(db, accountScope(accountId), flag)
      if (!target) {
        // Naming a switch means "the incident that is open on it", and there
        // is none. The one it was raised about last is still on the record and
        // still takes notes; it just has to be named by id, because "the last
        // one" is a guess about which incident the operator meant.
        console.error(
          `FAIL  ${flag} is not up, so there is no open incident to note.\n` +
            `      \`pnpm switch history ${flag}\` shows the closed ones; note one with --incident <id>.`,
        )
        process.exit(1)
      }
    }

    await addIncidentFinding(db, system, {
      opsFlagId: target.id,
      author: review.author,
      finding: review.finding,
    })
    const all = await listIncidentFindings(db, system, target.id)
    console.log(
      `NOTED  ${target.flag} (incident ${target.id}), by ${review.author}. ${all.length} note(s) on this incident.`,
    )
  } else if (command === 'raise' || command === 'lower') {
    const flag = rest[0]
    const actor = option('actor')
    const accountId = option('account')
    const definition = flag ? killSwitch(flag) : undefined
    if (!definition) {
      console.error(`FAIL  "${flag ?? ''}" is not a switch this product raises.`)
      usage(1)
    }
    if (!actor) {
      console.error('FAIL  --actor is required: every flip is recorded with who did it.')
      process.exit(1)
    }
    if (definition.scope === 'account' && !accountId) {
      console.error(`FAIL  ${flag} is about one store; pass --account <id>.`)
      process.exit(1)
    }

    if (command === 'raise') {
      const reason = option('reason')
      if (!reason) {
        console.error('FAIL  --reason is required: the next person to look has to know why.')
        process.exit(1)
      }
      const row =
        definition.scope === 'global'
          ? await tripGlobalFlag(db, system, { flag, actor, reason, trippedBy: 'manual' })
          : await tripAccountFlag(db, accountScope(accountId), {
              flag,
              actor,
              reason,
              trippedBy: 'manual',
            })
      console.log(row ? `RAISED  ${flag}. ${definition.stops}` : `ALREADY UP  ${flag}. Nothing changed.`)
    } else {
      const review = reviewReset({ flag, operator: actor, secondOperator: option('second') })
      if (!review.ok) {
        console.error(`FAIL  ${review.detail}`)
        process.exit(1)
      }
      const row =
        definition.scope === 'global'
          ? await resetGlobalFlag(db, system, { flag, resetBy: review.resetBy })
          : await resetAccountFlag(db, accountScope(accountId), { flag, resetBy: review.resetBy })
      console.log(row ? `LOWERED  ${flag}, by ${review.resetBy}.` : `NOT UP  ${flag} was not raised. Nothing changed.`)
    }
  } else {
    usage(2)
  }
} finally {
  await closeDb()
}
