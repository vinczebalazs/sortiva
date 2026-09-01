/**
 * Every threshold number lives in `packages/rules` (signals.config.yaml), so
 * there is one place to change what the system believes and one hash that
 * records which numbers produced a result. This rule is the half that catches a
 * number quietly reappearing as a comparison somewhere else.
 */

const DEFAULT_FIELD_TERMS = ['volume', 'position', 'impression', 'impressions', 'click', 'clicks', 'ctr']

/** `avgPosition` -> `avg_position`, so camelCase and snake_case match the same term list. */
function toSnake(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

function lastSegment(node) {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression') {
    if (node.computed) {
      return node.property.type === 'Literal' && typeof node.property.value === 'string'
        ? node.property.value
        : null
    }
    return node.property.type === 'Identifier' ? node.property.name : null
  }
  if (node.type === 'ChainExpression') return lastSegment(node.expression)
  if (node.type === 'TSNonNullExpression') return lastSegment(node.expression)
  return null
}

function numericLiteralValue(node) {
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value
  if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
    return numericLiteralValue(node.argument)
  }
  return null
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban numeric comparisons against volume/position/impression/CTR fields outside packages/rules.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          fieldTerms: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      thresholdLiteral:
        'Threshold literal {{value}} compared against `{{field}}`. Every number that decides detection, scoring or a gate lives in packages/rules (signals.config.yaml) and is read through the typed accessor.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {}
    const terms = new Set(options.fieldTerms ?? DEFAULT_FIELD_TERMS)

    function fieldTermOf(node) {
      const segment = lastSegment(node)
      if (!segment) return null
      const snake = toSnake(segment)
      // Match the whole identifier or its trailing word: `position`, `avg_position`.
      const words = snake.split('_')
      if (terms.has(snake)) return segment
      const tail = words[words.length - 1]
      if (tail && terms.has(tail)) return segment
      return null
    }

    return {
      BinaryExpression(node) {
        if (!['<', '<=', '>', '>=', '===', '!==', '==', '!='].includes(node.operator)) return
        const candidates = [
          [node.left, node.right],
          [node.right, node.left],
        ]
        for (const [fieldSide, literalSide] of candidates) {
          const value = numericLiteralValue(literalSide)
          if (value === null) continue
          const field = fieldTermOf(fieldSide)
          if (!field) continue
          context.report({
            node,
            messageId: 'thresholdLiteral',
            data: { value: String(value), field },
          })
          return
        }
      },
    }
  },
}
