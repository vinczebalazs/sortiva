// One planted lint violation. `pnpm lint:prove` writes this file, runs the
// real lint command, and fails if the rule does not reject it.
//
// One case per file on purpose: five cards edited the single shared list in
// wave 1, and a bad merge there silently weakens the check that proves every
// other check still works. A lane adds a file here; nobody edits a shared one.
export default {
    // R4 / remediation D10 item 3. The banned names are derived from
    // `packages/db/src/schema`, so these two cases are the proof that the
    // derivation reaches tables added after the rule was written: `spend_events`
    // is schema wave 2 and `idempotency_ledger` is mini-wave 2b, and the
    // hand-written list this replaced named neither.
    name: 'raw wave-2 table import outside packages/db (account scoping, D5 + D10)',
    file: 'packages/core/src/__lintproof__/raw-wave2-table.ts',
    source: [
      "import { spendEvents } from '@sortiva/db'",
      '',
      'export default spendEvents',
      '',
    ].join('\n'),
    expectRule: 'sortiva/no-raw-db-access',
  }
