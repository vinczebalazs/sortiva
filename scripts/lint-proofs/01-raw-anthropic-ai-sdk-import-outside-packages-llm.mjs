// One planted lint violation. `pnpm lint:prove` writes this file, runs the
// real lint command, and fails if the rule does not reject it.
//
// One case per file on purpose: five cards edited the single shared list in
// wave 1, and a bad merge there silently weakens the check that proves every
// other check still works. A lane adds a file here; nobody edits a shared one.
export default {
    name: 'raw @anthropic-ai/sdk import outside packages/llm (invariant 25)',
    file: 'packages/core/src/__lintproof__/raw-sdk-import.ts',
    source: [
      "import Anthropic from '@anthropic-ai/sdk'",
      '',
      'export const client = new Anthropic()',
      '',
    ].join('\n'),
    expectRule: 'sortiva/no-direct-provider-sdk',
  }
