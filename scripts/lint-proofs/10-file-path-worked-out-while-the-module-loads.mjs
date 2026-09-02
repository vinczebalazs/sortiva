// One planted lint violation. `pnpm lint:prove` writes this file, runs the
// real lint command, and fails if the rule does not reject it.
//
// This is the shape that made the product answer 500 on every request: a module
// working out where its own file sits on disk *while it loads*. It has to be
// planted inside `packages/rules`, because that is one of the two directories
// the rule is switched on for.
export default {
  name: 'a file path worked out from import.meta.url while the module loads (packages/rules)',
  file: 'packages/rules/src/__lintproof__/module-load-path.ts',
  source: [
    "import { dirname, join } from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    '',
    "export const CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'signals.config.yaml')",
    '',
  ].join('\n'),
  expectRule: 'sortiva/no-module-load-path-resolution',
}
