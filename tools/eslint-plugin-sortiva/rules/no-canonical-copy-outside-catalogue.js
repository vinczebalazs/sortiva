import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * A handful of sentences in this product may not be reworded — the pause line,
 * the plan's cap line, the read-only reassurance, and the rest of the canonical
 * copy table. They live in `packages/ui/strings/*.json` under keys beginning
 * `appendixA.`, one copy each, and a snapshot test holds every one of them
 * character for character.
 *
 * A second copy typed out somewhere else defeats that snapshot completely. The
 * snapshot still passes — it is looking at the catalogue, which nobody
 * touched — while the copy in the route or the job quietly says something
 * different, and the merchant sees whichever of the two their request happened
 * to reach.
 *
 * `no-literal-jsx-text` already stops this happening on a screen, but it only
 * reads JSX, so it never looks at a route handler, a queue task or a plain
 * helper — and a route handler answering a request with a sentence is exactly
 * where the second copy of the pause line was found.
 *
 * So: a string anywhere in the repository that reproduces one of these
 * sentences is an error, and the fix is to look it up by its key.
 *
 * **What counts as reproducing one.** Both sides are reduced to their words —
 * lower-cased, with punctuation and spacing thrown away — before comparing, so
 * a copy that swapped the dash, dropped the full stop or changed a capital is
 * caught too. What this cannot catch is a rewrite: a sentence that keeps the
 * meaning and changes the words is invisible here, and there is no honest way
 * for a lint rule to see it. What it does catch is the way the second copy
 * actually gets made, which is a paste.
 */

/**
 * The catalogue, read once, when a file is first linted rather than while this
 * module loads — a rule that throws on import takes the whole lint run with it.
 */
let canonical = null

function canonicalSentences() {
  if (canonical) return canonical
  const path = fileURLToPath(new URL('../../../packages/ui/strings/en.json', import.meta.url))
  const catalog = JSON.parse(readFileSync(path, 'utf8'))
  canonical = Object.entries(catalog)
    .filter(([key]) => key.startsWith('appendixA.'))
    .map(([key, value]) => ({ key, value, words: words(value) }))
    .filter((entry) => entry.words.length > 0)
  return canonical
}

/** Everything but the words, discarded: case, punctuation, dashes, spacing. */
function words(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Sentences the product may not reword live once, in packages/ui/strings, and are looked up by key.',
    },
    schema: [],
    messages: {
      copied:
        'This reproduces the canonical sentence `{{key}}`. There is one copy of it, in packages/ui/strings/en.json — render `t(\'{{key}}\')` instead of writing it out.',
    },
  },
  create(context) {
    const sentences = canonicalSentences()
    const shortest = Math.min(...sentences.map((entry) => entry.words.length))

    function check(node, text) {
      if (typeof text !== 'string' || text.length < shortest) return
      const candidate = words(text)
      if (candidate.length < shortest) return
      const hit = sentences.find((entry) => candidate.includes(entry.words))
      if (!hit) return
      context.report({ node, messageId: 'copied', data: { key: hit.key } })
    }

    return {
      Literal(node) {
        check(node, node.value)
      },
      // A sentence in backticks, with or without an interpolation in it.
      TemplateElement(node) {
        check(node, node.value.cooked)
      },
      // Screens are `no-literal-jsx-text`'s job, but that rule is switched off
      // for the component gallery, and a canonical sentence pasted there is
      // still a second copy.
      JSXText(node) {
        check(node, node.value)
      },
    }
  },
}
