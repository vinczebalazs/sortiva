// One planted lint violation. `pnpm lint:prove` writes this file, runs the
// real lint command, and fails if the rule does not reject it.
//
// One case per file on purpose: five cards edited the single shared list in
// wave 1, and a bad merge there silently weakens the check that proves every
// other check still works. A lane adds a file here; nobody edits a shared one.
export default {
    // DataForSEO has no SDK to ban,
    // so the sibling rule cannot see it; the host string is the thing fenced in.
    name: 'direct api.dataforseo.com call outside the SEO wrapper (invariant 25)',
    file: 'packages/llm/src/__lintproof__/dataforseo-host.ts',
    source: [
      'export async function keywordVolume(keyword: string): Promise<Response> {',
      "  return fetch('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', {",
      "    method: 'POST',",
      '    body: JSON.stringify([{ keywords: [keyword] }]),',
      '  })',
      '}',
      '',
    ].join('\n'),
    expectRule: 'sortiva/no-direct-vendor-http',
  }
