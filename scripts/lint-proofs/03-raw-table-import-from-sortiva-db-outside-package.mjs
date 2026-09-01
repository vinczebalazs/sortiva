// One planted lint violation. `pnpm lint:prove` writes this file, runs the
// real lint command, and fails if the rule does not reject it.
//
// One case per file on purpose: five cards edited the single shared list in
// wave 1, and a bad merge there silently weakens the check that proves every
// other check still works. A lane adds a file here; nobody edits a shared one.
export default {
    name: 'raw table import from @sortiva/db outside packages/db (account scoping, D5)',
    file: 'packages/core/src/__lintproof__/raw-table-import.ts',
    source: [
      "import { db, notifications } from '@sortiva/db'",
      '',
      'export function unscoped() {',
      '  return db().select().from(notifications)',
      '}',
      '',
    ].join('\n'),
    expectRule: 'sortiva/no-raw-db-access',
  }
