/**
 * Every LLM call goes through packages/llm; every SEO-data call through
 * `SeoDataProvider`;
 * every email through `EmailProvider`. Importing the vendor SDK anywhere but its
 * own wrapper directory is a lint error, so no call site can escape
 * instrumentation, caching, or cost accounting.
 */

const DEFAULT_SDKS = [
  { module: '@anthropic-ai/sdk', allow: ['packages/llm/'], wrapper: '@sortiva/llm' },
  { module: 'resend', allow: ['packages/providers/src/email/'], wrapper: 'EmailProvider (@sortiva/providers)' },
  { module: 'stripe', allow: ['packages/providers/src/stripe/'], wrapper: 'StripeProvider (@sortiva/providers)' },
  { module: 'posthog-node', allow: ['packages/providers/src/posthog/'], wrapper: 'PosthogCapture (@sortiva/providers)' },
  // The browser half of the same rule. A screen reaching the vendor's browser
  // library directly could capture anything at all, which is what the
  // per-event property table exists to make impossible.
  { module: 'posthog-js', allow: ['packages/ui/src/analytics/'], wrapper: 'UiAnalytics (@sortiva/ui)' },
  { module: '@shopify/shopify-api', allow: ['packages/providers/src/shopify/'], wrapper: 'ShopifyProvider (@sortiva/providers)' },
  { module: 'googleapis', allow: ['packages/providers/src/gsc/'], wrapper: 'GscProvider (@sortiva/providers)' },
]

function normalise(filename) {
  return filename.split('\\').join('/')
}

function matchesModule(specifier, moduleName) {
  return specifier === moduleName || specifier.startsWith(`${moduleName}/`)
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban raw provider SDK imports outside the single wrapper that owns them (invariant 25).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          sdks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                module: { type: 'string' },
                allow: { type: 'array', items: { type: 'string' } },
                wrapper: { type: 'string' },
              },
              required: ['module', 'allow'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawSdk:
        'Raw `{{module}}` import. This SDK may only be imported inside {{allow}}; everywhere else goes through {{wrapper}}. (invariant 25)',
    },
  },
  create(context) {
    const sdks = context.options[0]?.sdks ?? DEFAULT_SDKS
    const filename = normalise(context.filename ?? context.getFilename())

    function check(node, specifier) {
      if (typeof specifier !== 'string') return
      for (const sdk of sdks) {
        if (!matchesModule(specifier, sdk.module)) continue
        if (sdk.allow.some((dir) => filename.includes(dir))) return
        context.report({
          node,
          messageId: 'rawSdk',
          data: {
            module: sdk.module,
            allow: sdk.allow.join(', '),
            wrapper: sdk.wrapper ?? 'its wrapper package',
          },
        })
        return
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value)
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node, node.source.value)
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference?.type === 'TSExternalModuleReference') {
          check(node, node.moduleReference.expression.value)
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return
        const arg = node.arguments[0]
        if (arg && arg.type === 'Literal') check(node, arg.value)
      },
    }
  },
}
