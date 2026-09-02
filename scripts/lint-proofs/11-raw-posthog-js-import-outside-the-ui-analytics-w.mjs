// One planted lint violation. `pnpm lint:prove` writes this file, runs the
// real lint command, and fails if the rule does not reject it.
//
// The browser talks to the analytics vendor itself, so the only thing stopping
// a screen from capturing a product title is that a screen cannot reach the
// vendor's library — every event goes through the property table in
// `packages/ui/src/analytics`. This proves that door is actually shut.
export default {
  name: 'raw posthog-js import outside the UI analytics wrapper (invariant 26)',
  file: 'packages/ui/src/__lintproof__/raw-posthog-js-import.ts',
  source: [
    "import posthog from 'posthog-js'",
    '',
    "export const leak = () => posthog.capture('article_read', { body: 'the whole draft' })",
    '',
  ].join('\n'),
  expectRule: 'sortiva/no-direct-provider-sdk',
}
