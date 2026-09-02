/**
 * Every user-facing sentence lives in `packages/ui/strings/*.json` and is looked
 * up by key. A sentence typed straight into a component cannot be found by
 * anyone reviewing the product's copy, cannot be translated, and — for the
 * dozen sentences the specification pins word for word — cannot be held by the
 * snapshot that keeps them exact.
 *
 * So text typed between JSX tags is an error, as are the handful of attributes
 * a person actually reads: `title`, `alt`, `placeholder`, `aria-label` and the
 * rest.
 *
 * What is allowed through is anything that is not language: punctuation and
 * separators, non-breaking spaces, and single symbols. Those carry no meaning
 * to translate and putting `·` in a catalogue helps nobody.
 */

/** Attributes whose value a person reads on screen or hears read out. */
const HUMAN_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'label',
  'placeholder',
  'title',
])

/**
 * Text with no letters in it is punctuation, not copy. A lone letter or digit is
 * a bullet or an index, not a sentence.
 */
function isTranslatableText(raw) {
  const text = raw.trim()
  if (text.length === 0) return false
  // Anything without two consecutive word characters is a symbol or a
  // separator: `·`, `→`, `—`, `(`, `%`, `1`.
  return /\p{L}\p{L}/u.test(text)
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'User-facing text must come from packages/ui/strings, never be typed into a component.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          attributes: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      text: 'Literal text "{{text}}" in JSX. Add it to packages/ui/strings/en.json and render `t(\'some.key\')`.',
      attribute:
        'Literal `{{attribute}}` text "{{text}}". Add it to packages/ui/strings/en.json and render `t(\'some.key\')`.',
    },
  },
  create(context) {
    const attributes = new Set(context.options[0]?.attributes ?? HUMAN_ATTRIBUTES)

    function preview(text) {
      const trimmed = text.trim().replace(/\s+/g, ' ')
      return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed
    }

    return {
      JSXText(node) {
        if (!isTranslatableText(node.value)) return
        context.report({ node, messageId: 'text', data: { text: preview(node.value) } })
      },

      // `<p>{'typed text'}</p>` is the same thing with a step in between.
      JSXExpressionContainer(node) {
        if (node.parent?.type !== 'JSXElement' && node.parent?.type !== 'JSXFragment') return
        const expression = node.expression
        if (expression.type !== 'Literal' || typeof expression.value !== 'string') return
        if (!isTranslatableText(expression.value)) return
        context.report({ node, messageId: 'text', data: { text: preview(expression.value) } })
      },

      JSXAttribute(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : null
        if (!name || !attributes.has(name)) return

        const value = node.value
        let text = null
        if (value?.type === 'Literal' && typeof value.value === 'string') {
          text = value.value
        } else if (
          value?.type === 'JSXExpressionContainer' &&
          value.expression.type === 'Literal' &&
          typeof value.expression.value === 'string'
        ) {
          text = value.expression.value
        }

        if (text === null || !isTranslatableText(text)) return
        context.report({
          node,
          messageId: 'attribute',
          data: { attribute: name, text: preview(text) },
        })
      },
    }
  },
}
