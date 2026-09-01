// One planted lint violation. `pnpm lint:prove` writes this file, runs the
// real lint command, and fails if the rule does not reject it.
//
// One case per file on purpose: five cards edited the single shared list in
// wave 1, and a bad merge there silently weakens the check that proves every
// other check still works. A lane adds a file here; nobody edits a shared one.
export default {
    name: 'threshold literal outside packages/rules (invariant 9)',
    file: 'packages/core/src/__lintproof__/threshold-literal.ts',
    source: [
      'export function shouldRefresh(position: number): boolean {',
      '  if (position < 15) {',
      '    return true',
      '  }',
      '  return false',
      '}',
      '',
    ].join('\n'),
    expectRule: 'sortiva/no-threshold-literals',
  }
