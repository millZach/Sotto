// Shared test-case finder for the prune inventory and the prune apply step.
// A case is an it()/test() call (with any modifier chain: .each, .skipIf(x), .only, .concurrent, .fails);
// a suite is a describe() call. Each is keyed by its file, the source text of its enclosing suites'
// titles and of its own title, and its occurrence among cases with the same key, so a manifest made on
// one commit finds the same cases on another as long as their titles have not changed.
import ts from 'typescript'

const CASE_ROOTS = new Set(['it', 'test'])
const SUITE_ROOTS = new Set(['describe', 'suite'])

/** The identifier a call chain such as `it.skipIf(x).each(rows)` starts from, or undefined. */
function chainRoot(expression) {
  let node = expression
  for (;;) {
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node)) node = node.expression
    else if (ts.isCallExpression(node)) node = node.expression
    else if (ts.isTaggedTemplateExpression(node)) node = node.tag
    else return undefined
  }
}

function modifiers(expression) {
  const names = []
  let node = expression
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) { names.unshift(node.name.text); node = node.expression }
    else if (ts.isCallExpression(node)) node = node.expression
    else if (ts.isTaggedTemplateExpression(node)) node = node.tag
    else return names
  }
}

/** The statement that holds a call, if the call is the whole expression statement. */
function holdingStatement(call) {
  let node = call
  while (node.parent && (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent))) node = node.parent
  return node.parent && ts.isExpressionStatement(node.parent) ? node.parent : undefined
}

export function parse(path, text) {
  const kind = /\.tsx$/u.test(path) ? ts.ScriptKind.TSX : /\.jsx$/u.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/u.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
}

/**
 * Every suite and case in a file, in source order, with keys. Cases inside loops or helper functions are
 * found too; `dynamic` marks those whose call is not directly in a suite body or the file's top level.
 */
export function findCases(source) {
  const found = []
  const counts = new Map()
  const visit = (node, suites, dynamic) => {
    if (ts.isCallExpression(node)) {
      const root = chainRoot(node.expression)
      const isCase = root && CASE_ROOTS.has(root)
      const isSuite = root && SUITE_ROOTS.has(root)
      const titleArg = node.arguments[0]
      if ((isCase || isSuite) && titleArg && !ts.isCallExpression(node.parent) /* outer call of it.each(rows)(...) */) {
        const mods = modifiers(node.expression)
        const title = titleArg.getText(source)
        const statement = holdingStatement(node)
        const keyPath = [...suites.map(s => s.title), title]
        const key = JSON.stringify(keyPath)
        const occurrence = counts.get(key) ?? 0
        counts.set(key, occurrence + 1)
        const start = statement ?? node
        const entry = {
          type: isCase ? 'case' : 'suite',
          suites: suites.map(s => s.title),
          title,
          occurrence,
          modifiers: mods,
          dynamic,
          deletable: Boolean(statement),
          start: start.getStart(source, false),
          fullStart: start.getFullStart(),
          end: start.getEnd(),
          line: source.getLineAndCharacterOfPosition(start.getStart(source)).line + 1,
          endLine: source.getLineAndCharacterOfPosition(start.getEnd()).line + 1,
          leadingComments: (ts.getLeadingCommentRanges(source.text, start.getFullStart()) ?? []).map(r => source.text.slice(r.pos, r.end)).join('\n'),
          node,
        }
        found.push(entry)
        if (isSuite) {
          const body = node.arguments.find((a, i) => i > 0 && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)))
          if (body) ts.forEachChild(body, child => visit(child, [...suites, entry], false))
          return
        }
        return // a case's body holds no cases
      }
    }
    const nested = dynamic || ts.isFunctionLike(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node)
    ts.forEachChild(node, child => visit(child, suites, nested && !ts.isSourceFile(node)))
  }
  ts.forEachChild(source, child => visit(child, [], false))
  return found
}

export { ts }
