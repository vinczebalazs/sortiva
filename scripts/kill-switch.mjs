#!/usr/bin/env node
/**
 * `pnpm switch list` / `pnpm switch raise ...` / `pnpm switch lower ...` — the
 * brakes, by hand.
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
 * Runs under `tsx`; the repo consumes workspace packages as TypeScript source.
 */
import { closeDb, db as database } from '../packages/db/src/client.ts'
import { accountScope, systemScope } from '../packages/db/src/scope.ts'
import {
  listActiveFlags,
  resetAccountFlag,
  resetGlobalFlag,
  tripAccountFlag,
  tripGlobalFlag,
} from '../packages/db/src/repositories/system.ts'
import { KILL_SWITCHES, incidentFrom, killSwitch, reviewReset } from '../packages/core/src/ops/kill-switches.ts'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const [command, ...rest] = argv

function usage(code) {
  console.log(`Usage:
  pnpm switch list
  pnpm switch raise <flag> --actor <you> --reason "<why>" [--account <id>]
  pnpm switch lower <flag> --actor <you> [--second <colleague>] [--account <id>]

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

const db = database()
const system = systemScope('kill switches are about the whole product')

try {
  if (command === 'list') {
    const open = (await listActiveFlags(db, system)).map(incidentFrom)
    if (open.length === 0) {
      console.log('Nothing is paused.')
    } else {
      console.log(`${open.length} switch(es) up:\n`)
      for (const incident of open) {
        console.log(`  ${incident.flag}${incident.accountId ? ` (account ${incident.accountId})` : ''}`)
        console.log(`    raised:  ${incident.raisedAt.toISOString()} by ${incident.raisedBy}${incident.automatic ? ' (automatic)' : ''}`)
        console.log(`    because: ${incident.reason}`)
        console.log()
      }
    }
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
