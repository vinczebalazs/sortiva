/**
 * The companion to `no-direct-provider-sdk`, for vendors that have no SDK to
 * ban.
 *
 * DataForSEO is a plain HTTPS endpoint: there is no package name to forbid, so
 * the sibling rule leaves it as the one unguarded paid vendor, and any file in
 * the repo could `fetch('https://api.dataforseo.com/...')` directly — bypassing
 * the request cache, the endpoint-to-price map, and the cost record the spend
 * caps read. This rule bans the host string itself outside the one
 * wrapper directory that owns it, in string literals and template literals
 * alike, which closes that hole.
 */

const DEFAULT_HOSTS = [
  {
    host: 'api.dataforseo.com',
    allow: ['packages/providers/src/seo/'],
    wrapper: 'SeoDataProvider (@sortiva/providers)',
  },
  {
    // The sibling rule bans the `@anthropic-ai/sdk` package, which is how anyone
    // would reasonably call this vendor — but nothing stopped a plain `fetch` to
    // the same address, which would be uncached, uncosted, and absent from the
    // spend ledger the caps read.
    host: 'api.anthropic.com',
    allow: ['packages/llm/src/'],
    wrapper: 'LlmClient (@sortiva/llm)',
  },
]

function normalise(filename) {
  return filename.split('\\').join('/')
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban a paid vendor’s host name outside the single wrapper that owns it, for vendors with no SDK to ban (invariant 25).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          hosts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                host: { type: 'string' },
                allow: { type: 'array', items: { type: 'string' } },
                wrapper: { type: 'string' },
              },
              required: ['host', 'allow'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawHost:
        'Direct reference to `{{host}}`. This vendor host may only appear inside {{allow}}; everywhere else goes through {{wrapper}}, which is what applies the request cache, the price map and the spend record. (invariant 25)',
    },
  },
  create(context) {
    const hosts = context.options[0]?.hosts ?? DEFAULT_HOSTS
    const filename = normalise(context.filename ?? context.getFilename())

    function check(node, text) {
      if (typeof text !== 'string') return
      for (const entry of hosts) {
        if (!text.includes(entry.host)) continue
        if (entry.allow.some((dir) => filename.includes(dir))) return
        context.report({
          node,
          messageId: 'rawHost',
          data: {
            host: entry.host,
            allow: entry.allow.join(', '),
            wrapper: entry.wrapper ?? 'its wrapper package',
          },
        })
        return
      }
    }

    return {
      Literal(node) {
        check(node, node.value)
      },
      TemplateElement(node) {
        check(node, node.value?.cooked ?? node.value?.raw)
      },
    }
  },
}
