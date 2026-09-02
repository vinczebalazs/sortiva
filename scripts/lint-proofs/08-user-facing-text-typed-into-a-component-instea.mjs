// One planted lint violation. `pnpm lint:prove` writes this file, runs the real
// lint command, and fails if the rule does not reject it.
//
// One case per file on purpose: five cards edited the single shared list in
// wave 1, and a bad merge there silently weakens the check that proves every
// other check still works. A lane adds a file here; nobody edits a shared one.
export default {
  name: 'user-facing text typed into a component instead of the string catalogue',
  file: 'packages/ui/src/__lintproof__/literal-text.tsx',
  source: [
    'export function Banner() {',
    '  return <p>Payment failed — update your card to keep articles coming</p>',
    '}',
    '',
  ].join('\n'),
  expectRule: 'sortiva/no-literal-jsx-text',
}
