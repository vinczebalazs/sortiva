// One planted lint violation. `pnpm lint:prove` writes this file, runs the real
// lint command, and fails if the rule does not reject it.
//
// The attribute half of the rule is proved separately from the text half: a
// sentence in a tooltip or an accessible label is read by a person exactly like
// one between the tags, and it is the half most likely to be forgotten.
export default {
  name: 'user-facing text in a tooltip or label attribute instead of the string catalogue',
  file: 'packages/ui/src/__lintproof__/literal-attribute.tsx',
  source: [
    'export function LockedItem() {',
    '  return <span title="Available after your store is connected" />',
    '}',
    '',
  ].join('\n'),
  expectRule: 'sortiva/no-literal-jsx-text',
}
