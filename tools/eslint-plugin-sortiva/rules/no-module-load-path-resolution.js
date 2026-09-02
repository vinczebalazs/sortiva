/**
 * **A module may not work out where it sits on disk while it is being loaded.**
 *
 * `import.meta.url` is the address of the file the code was written in. That is
 * a real place on disk only when the code runs from the repository tree; in the
 * production web build it is not, and turning it into a path throws.
 *
 * Doing that at the top of a module means the throw happens when the module is
 * *imported*. The web server's start-up hook imports, directly or by a chain of
 * barrels, most of this repository — and Next answers every request with a 500
 * when its start-up hook throws. That is not a hypothetical: the product served
 * nothing but errors for days, while the build and every test stayed green,
 * because tests run from the repository tree where the address really is a path.
 *
 * Inside a function the same expression is fine, because it runs when something
 * actually needs the file, by which time either it works or one clearly-named
 * error is raised to one caller. So the rule is about *when*, not *whether*.
 *
 * The exception a reader will look for: a function that is called immediately
 * where it is defined is still module-load work wearing a function's clothes,
 * and is reported.
 */

/** The three ways a module can ask where it is: `import.meta.url`, and Node 20.11's two shortcuts for the same thing. */
const ADDRESS_PROPERTIES = new Set(['url', 'dirname', 'filename'])

function isFunction(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  )
}

/** `(() => …)()` and `(function () { … })()` — defined and run on the spot, so its body is module-load code. */
function isImmediatelyInvoked(fn, parent) {
  return Boolean(parent) && parent.type === 'CallExpression' && parent.callee === fn
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban working a file path out of `import.meta.url` while a module is loading; do it on first use instead.',
    },
    schema: [],
    messages: {
      moduleLoad:
        '`import.meta.{{property}}` is read while this module loads. Bundled for production it is not a path on disk, so this throws on import — and an import that throws inside the server start-up hook makes every route answer 500. Move it into the function that needs the file, so it runs on first use.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    return {
      // `import.meta` is the node; the `.url` on the end of it is its parent.
      MetaProperty(node) {
        if (node.meta?.name !== 'import' || node.property?.name !== 'meta') return

        const access = node.parent
        if (!access || access.type !== 'MemberExpression' || access.object !== node) return
        const property = access.computed
          ? access.property?.type === 'Literal' && access.property.value
          : access.property?.name
        if (typeof property !== 'string' || !ADDRESS_PROPERTIES.has(property)) return

        const ancestors = sourceCode.getAncestors ? sourceCode.getAncestors(node) : context.getAncestors()
        for (let i = ancestors.length - 1; i >= 0; i -= 1) {
          const ancestor = ancestors[i]
          if (!isFunction(ancestor)) continue
          // A function body runs when it is called — unless it is called right
          // where it is written, which is module-load work again.
          if (isImmediatelyInvoked(ancestor, ancestors[i - 1])) break
          return
        }

        context.report({ node: access, messageId: 'moduleLoad', data: { property } })
      },
    }
  },
}
