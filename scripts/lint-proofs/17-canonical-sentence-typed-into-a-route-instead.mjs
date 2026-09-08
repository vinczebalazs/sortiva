// One planted lint violation. `pnpm lint:prove` writes this file, runs the real
// lint command, and fails if the rule does not reject it.
//
// This is the shape the JSX rule cannot see: not a screen, but a route handler
// answering a request with a sentence the product may not reword. The pause
// line lived in two places for exactly as long as nothing looked here.
//
// The planted copy is deliberately not identical — a hyphen for the dash, a
// dropped full stop — because a paste that was then tidied is the realistic way
// the second copy drifts, and the rule compares the words rather than the
// characters.
export default {
  name: 'a canonical sentence typed into a route handler instead of looked up by key',
  file: 'apps/web/app/api/__lintproof__/canonical-copy.ts',
  source: [
    'export function paused(): Response {',
    '  return Response.json({',
    '    error: {',
    "      code: 'service_paused',",
    "      message: 'Delayed - we paused this action rather than continue with lower-quality or stale data',",
    '    },',
    '  })',
    '}',
    '',
  ].join('\n'),
  expectRule: 'sortiva/no-canonical-copy-outside-catalogue',
}
