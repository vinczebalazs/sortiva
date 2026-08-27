/**
 * Constitution code-structure rule: "Route handlers contain no domain logic:
 * parse -> call `core` -> serialise." Enforced as an import allowlist, because
 * a handler that cannot reach the DB, a provider SDK, or the rules module
 * cannot host domain logic in the first place.
 */

const DEFAULT_ALLOW = [
  '^next(/|$)',
  '^react(/|$)',
  '^zod$',
  '^@sortiva/core(/|$)',
  '^@sortiva/contracts(/|$)',
  // Serialisers and request plumbing colocated under apps/web/app/api or apps/web/lib/http.
  '^\\.{1,2}/.*(serial|http|_lib)',
]

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Route handlers may import only from core, contracts, serialisers and framework plumbing (CLAUDE.md code-structure rules).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        'Route handler imports `{{specifier}}`. Handlers parse -> call `@sortiva/core` -> serialise; domain logic, DB access and provider SDKs belong in core/db/providers.',
    },
  },
  create(context) {
    const patterns = (context.options[0]?.allow ?? DEFAULT_ALLOW).map((p) => new RegExp(p))

    function check(node, specifier) {
      if (typeof specifier !== 'string') return
      if (patterns.some((re) => re.test(specifier))) return
      context.report({ node, messageId: 'forbidden', data: { specifier } })
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value)
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node, node.source.value)
      },
    }
  },
}
