// One planted lint violation. `pnpm lint:prove` writes this file, runs the
// real lint command, and fails if the rule does not reject it.
//
// One case per file on purpose: five cards edited the single shared list in
// wave 1, and a bad merge there silently weakens the check that proves every
// other check still works. A lane adds a file here; nobody edits a shared one.
export default {
    name: 'raw wave-2b table import outside packages/db (account scoping, D5 + D10)',
    file: 'packages/core/src/__lintproof__/raw-wave2b-table.ts',
    source: [
      "import { idempotencyLedger } from '@sortiva/db'",
      '',
      'export default idempotencyLedger',
      '',
    ].join('\n'),
    expectRule: 'sortiva/no-raw-db-access',
  }
