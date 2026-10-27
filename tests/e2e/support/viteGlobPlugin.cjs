/**
 * A Babel plugin for Playwright's own transform (#1579), named in `playwright.config.ts`. Main's code reads its interface
 * catalogs with Vite's `import.meta.glob`, which only Vite's build and Vitest provide; a spec that runs main's code in
 * Playwright's Node process would otherwise stop at it. Each `import.meta.glob(patterns, options)` becomes a call to
 * `viteGlob` in `viteGlob.ts`, given the folder of the file it is in. Plain CommonJS, because Babel loads its plugins
 * with `require`, and Playwright compiles this repository's TypeScript to CommonJS, where `require` is defined.
 */
const path = require('node:path')

const helper = path.join(__dirname, 'viteGlob.ts')

module.exports = function viteGlobPlugin({ types: t }) {
  return {
    name: 'sotto-vite-glob',
    visitor: {
      CallExpression(call, state) {
        const callee = call.node.callee
        if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: 'glob' }) || !t.isMetaProperty(callee.object)
          || callee.object.meta.name !== 'import' || callee.object.property.name !== 'meta') return
        const viteGlob = t.memberExpression(t.callExpression(t.identifier('require'), [t.stringLiteral(helper)]), t.identifier('viteGlob'))
        call.replaceWith(t.callExpression(viteGlob, [t.stringLiteral(path.dirname(state.filename)), ...call.node.arguments]))
      },
    },
  }
}
