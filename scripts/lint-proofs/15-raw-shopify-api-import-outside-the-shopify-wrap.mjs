// One planted lint violation. `pnpm lint:prove` writes this file, runs the
// real lint command, and fails if the rule does not reject it.
//
// One case per file on purpose: five cards edited the single shared list in
// wave 1, and a bad merge there silently weakens the check that proves every
// other check still works. A lane adds a file here; nobody edits a shared one.
export default {
  name: 'raw @shopify/shopify-api import outside the Shopify wrapper (invariant 25)',
  file: 'packages/core/src/__lintproof__/raw-shopify-import.ts',
  source: [
    "import { shopifyApi } from '@shopify/shopify-api'",
    '',
    'export const shop = shopifyApi',
    '',
  ].join('\n'),
  expectRule: 'sortiva/no-direct-provider-sdk',
}
