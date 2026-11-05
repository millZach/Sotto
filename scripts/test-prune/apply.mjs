// Applies a prune manifest to a checkout: deletes the listed test cases by title, then whatever the
// deletions left empty or unused in the same file. Run it on a fresh main rather than resolving
// conflicts by hand: node scripts/test-prune/apply.mjs [manifest] [--check] (from the repository root)
// --check changes nothing and exits 1 if any listed case is missing (renamed or already gone).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { findCases, parse, ts } from './cases.mjs'

const argv = process.argv.slice(2)
const check = argv.includes('--check')
const manifestPath = argv.find(a => !a.startsWith('--')) ?? fileURLToPath(new URL('./manifest.json', import.meta.url))
const root = process.cwd()
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const keyOf = (suites, title, occurrence) => JSON.stringify([...suites, title, occurrence])

/**
 * Removes text ranges, last first, as whole lines. A blank line that separated the removed statement
 * from its neighbours goes with it, so no gap is left where a case was and none opens a block.
 */
function cut(text, ranges) {
  let out = text
  // Overlapping ranges (two neighbouring table rows) are merged first.
  const merged = []
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  for (const [start, end] of merged.reverse()) {
    const lineStart = out.lastIndexOf('\n', start - 1) + 1
    const onlyIndent = /^[ \t]*$/u.test(out.slice(lineStart, start))
    const from = onlyIndent ? lineStart : start
    let to = end
    const rest = out.slice(end).match(/^[ \t]*(?:;[ \t]*)?\r?\n/u)
    if (onlyIndent && rest) to = end + rest[0].length
    let before = out.slice(0, from)
    let after = out.slice(to)
    const blankBefore = /\n[ \t]*\r?\n$/u.test(before) || before === ''
    const blankAfter = /^[ \t]*\r?\n/u.test(after)
    const opensBlock = /[{([][ \t]*\r?\n$/u.test(before)
    const closesBlock = /^[ \t]*[})\]]/u.test(after)
    if (/^\s*$/u.test(after)) { before = before.replace(/\s*$/u, '\n'); after = '' } // the file ends on one line break
    else if (blankAfter && (blankBefore || opensBlock)) after = after.replace(/^[ \t]*\r?\n/u, '')
    else if (blankBefore && closesBlock) before = before.replace(/\r?\n[ \t]*\r?\n$/u, '\n')
    out = before + after
  }
  return out
}


const DIRECTIVE = /@vitest-environment|eslint-|@ts-|<reference /u

/**
 * The range of a statement with the comment lines directly above it (no blank line between). The comment at the
 * top of a file, and directives such as `// @vitest-environment node`, stay where they are.
 */
function withTrivia(source, entry) {
  if (entry.fullStart === 0) return [entry.start, entry.end]
  const lines = source.text.slice(entry.fullStart, entry.start).split('\n')
  // The last piece is the statement's own indentation; walk up the comment lines above it.
  let taken = 0
  for (let at = lines.length - 2; at >= 0; at--) {
    const line = lines[at].trim()
    if (!/^(\/\/|\/\*|\*)/u.test(line) || DIRECTIVE.test(line)) break
    taken++
  }
  if (!taken) return [entry.start, entry.end]
  const kept = lines.slice(0, lines.length - 1 - taken).join('\n')
  return [entry.fullStart + kept.length + (kept.length || lines.length - 1 - taken ? 1 : 0), entry.end]
}

/** Suites whose bodies hold no case or suite any more, innermost first, until none are left. */
function emptySuites(source) {
  const entries = findCases(source)
  return entries.filter(e => e.type === 'suite' && e.deletable && !entries.some(o => o !== e && o.start > e.start && o.end <= e.end && (o.type === 'case' || o.type === 'suite')))
}

function identifiersUsed(source, skip) {
  const used = new Set()
  const visit = node => {
    if (skip.has(node)) return
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const isDeclarationName = parent && (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent)) && parent.name === node
      // A name that labels a property rather than reading a binding: obj.name, { name: value }, name(): ..., a
      // property in a type, { name: alias } in a destructuring, an enum member, a JSX attribute, A.B in a type.
      const isPropertyName = parent && (
        (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent) ||
          ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isEnumMember(parent)) && parent.name === node ||
        ts.isBindingElement(parent) && parent.propertyName === node ||
        ts.isJsxAttribute(parent) && parent.name === node ||
        ts.isQualifiedName(parent) && parent.right === node)
      if (!isDeclarationName && !isPropertyName) used.add(node.text)
    }
    // JSX tag names are identifiers too, so components count as used; JSX itself keeps React's import.
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) used.add('React')
    ts.forEachChild(node, visit)
  }
  visit(source)
  return used
}

const PURE_INITIALIZER = node => !node || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isLiteralExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
  node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword ||
  (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) && PURE_INITIALIZER(node.expression) ||
  ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand) ||
  ts.isArrayLiteralExpression(node) && node.elements.every(e => PURE_INITIALIZER(e)) ||
  ts.isObjectLiteralExpression(node) && node.properties.every(p => ts.isPropertyAssignment(p) ? PURE_INITIALIZER(p.initializer) : ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) ||
  // Reading or joining a path, or parsing what was read, has no effect a test relies on.
  ts.isCallExpression(node) && READ_ONLY_CALLS.has(calleeName(node.expression)) && node.arguments.every(a => PURE_INITIALIZER(a) || ts.isIdentifier(a) || ts.isPropertyAccessExpression(a) || ts.isCallExpression(a) && PURE_INITIALIZER(a))

// Only these named calls count as reading rather than doing: a plain function by its name, a method by its object too.
const READ_ONLY_CALLS = new Set(['readFileSync', 'join', 'resolve', 'dirname', 'basename', 'relative', 'fileURLToPath', 'tmpdir', 'parseTokenBlocks',
  'JSON.parse', 'path.join', 'path.resolve', 'path.dirname', 'process.cwd', 'Object.entries', 'Object.keys', 'Object.values'])
function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) return `${expression.expression.text}.${expression.name.text}`
  return ''
}

/** The statement lists tidying looks in: the file's top level and each suite's body. */
function scopes(source) {
  const lists = [source.statements]
  for (const suite of findCases(source).filter(e => e.type === 'suite')) {
    const body = suite.node.arguments.find((a, i) => i > 0 && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)))
    if (body && ts.isBlock(body.body)) lists.push(body.body.statements)
  }
  return lists
}

// A for-of or for-in loop left with an empty body, over something that does nothing to read.
const isEmptyLoop = statement => (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) &&
  ts.isBlock(statement.statement) && statement.statement.statements.length === 0 &&
  (ts.isIdentifier(statement.expression) || PURE_INITIALIZER(statement.expression))

/**
 * Imports, declarations and emptied loops nothing in the file uses any more. Declarations go only when they are
 * functions, types or constants whose value does nothing to compute. An import goes when none of its names is used,
 * which also drops that module's initialization from the file; the gates run after applying catch a test that needed it.
 */
function tidy(path, text) {
  for (let round = 0; round < 20; round++) {
    const source = parse(path, text)
    const ranges = []
    for (const statement of scopes(source).flat()) {
      if (isEmptyLoop(statement)) { ranges.push(withTrivia(source, { fullStart: statement.getFullStart(), start: statement.getStart(source), end: statement.getEnd() })); continue }
      const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      if (exported) continue
      const others = identifiersUsed(source, new Set([statement]))
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause
        const names = []
        if (clause.name) names.push({ name: clause.name.text, node: clause.name })
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) names.push({ name: bindings.name.text, node: bindings })
        if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) names.push({ name: el.name.text, node: el })
        const unused = names.filter(n => !others.has(n.name))
        if (!unused.length) continue
        if (unused.length === names.length) { ranges.push(withTrivia(source, { fullStart: statement.getFullStart(), start: statement.getStart(source), end: statement.getEnd() })); continue }
        // Rewrite the clause without the unused names.
        const keep = names.filter(n => others.has(n.name))
        const def = keep.find(n => n.node === clause.name)
        const ns = keep.find(n => bindings && ts.isNamespaceImport(bindings) && n.node === bindings)
        const named = keep.filter(n => n !== def && n !== ns).map(n => n.node.getText(source))
        const parts = [def?.name, ns ? `* as ${ns.name}` : undefined, named.length ? `{ ${named.join(', ')} }` : undefined].filter(Boolean)
        const typeOnly = clause.isTypeOnly ? 'type ' : ''
        const rewritten = `import ${typeOnly}${parts.join(', ')} from ${statement.moduleSpecifier.getText(source)}`
        text = text.slice(0, statement.getStart(source)) + rewritten + text.slice(statement.moduleSpecifier.getEnd())
        ranges.length = 0
        break
      }
      let names = []
      if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        if (statement.name) names = [statement.name.text]
      } else if (ts.isVariableStatement(statement)) {
        const declarations = statement.declarationList.declarations
        if (!declarations.every(d => ts.isIdentifier(d.name) && PURE_INITIALIZER(d.initializer))) continue
        names = declarations.map(d => d.name.text)
      } else continue
      if (names.length && names.every(n => !others.has(n))) ranges.push(withTrivia(source, { fullStart: statement.getFullStart(), start: statement.getStart(source), end: statement.getEnd() }))
    }
    if (!ranges.length) {
      // A rewritten import restarts the round; otherwise nothing changed and we are done.
      const again = parse(path, text)
      if (again.text === source.text) return text
      continue
    }
    text = cut(text, ranges)
  }
  return text
}

/** The array literal an it.each(...) call takes its rows from, if it is written in place. */
function eachTable(call) {
  let node = call.expression
  while (node && !(ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'each')) {
    node = ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) ? node.expression : undefined
  }
  let rows = node?.arguments[0]
  while (rows && (ts.isAsExpression(rows) || ts.isSatisfiesExpression(rows) || ts.isParenthesizedExpression(rows))) rows = rows.expression
  return rows && ts.isArrayLiteralExpression(rows) ? rows : undefined
}

let missing = 0
let deletedCases = 0
let deletedFiles = 0
const report = []
const removed = []
for (const [file, plan] of Object.entries(manifest.files)) {
  const path = join(root, file)
  // A file marked whole still has every case matched, so a case added since the manifest was made keeps the file.
  if (!existsSync(path)) { report.push(`gone      ${file}`); missing += plan.cases.length; continue }
  let text = readFileSync(path, 'utf8')
  let source = parse(file, text)
  const entries = findCases(source)
  const byKey = new Map(entries.filter(e => e.type === 'case').map(e => [keyOf(e.suites, e.title, e.occurrence), e]))
  const ranges = []
  for (const c of plan.cases) {
    const entry = byKey.get(keyOf(c.suites, c.title, c.occurrence))
    if (!entry || !entry.deletable) { missing++; report.push(`missing   ${file} :: ${[...c.suites, c.title].join(' > ')}`); continue }
    if (c.rows) {
      // Remove only the listed rows of an it.each table, matched by their source text.
      const table = eachTable(entry.node)
      // Each listed row must match exactly one row of the table, and at least one row must stay.
      const matches = table ? c.rows.map(row => table.elements.filter(e => e.getText(source) === row)) : []
      const elements = matches.map(found => found[0])
      if (!table || matches.some(found => found.length !== 1) || new Set(elements).size === table.elements.length) { missing++; report.push(`rows      ${file} :: ${c.title}`); continue }
      // Remove each run of neighbouring rows: up to the next kept row, or, for a run at the end, from the
      // kept row before it, so no comma is left behind.
      const gone = new Set(elements)
      const all = table.elements
      for (let at = 0; at < all.length; at++) {
        if (!gone.has(all[at]) || gone.has(all[at - 1])) continue
        let last = at
        while (gone.has(all[last + 1])) last++
        const next = all[last + 1]
        ranges.push(next ? [all[at].getStart(source), next.getStart(source)] : [all[at - 1].getEnd(), all[last].getEnd()])
      }
      continue
    }
    ranges.push(withTrivia(source, entry))
  }
  deletedCases += ranges.length
  if (check) continue
  text = cut(text, ranges)
  // Drop suites the deletions emptied, with their hooks, until none are left.
  for (;;) {
    source = parse(file, text)
    const empty = emptySuites(source)
    if (!empty.length) break
    text = cut(text, empty.map(e => withTrivia(source, e)))
  }
  if (!findCases(parse(file, text)).some(e => e.type === 'case')) { rmSync(path); removed.push(file); deletedFiles++; continue }
  if (plan.whole) report.push(`kept      ${file} (cases it now has are not on the manifest)`)
  writeFileSync(path, tidy(file, text))
}
// The shard sequencer's recorded times (tests/shardSequencer.ts) lose the files that are gone.
const durationsPath = join(root, 'tests/fixtures/testDurations.json')
if (removed.length && existsSync(durationsPath)) {
  const durations = JSON.parse(readFileSync(durationsPath, 'utf8'))
  for (const file of removed) delete durations[file]
  writeFileSync(durationsPath, JSON.stringify(durations, null, 2) + '\n')
}
process.stdout.write(report.join('\n') + (report.length ? '\n' : ''))
process.stdout.write(`${check ? 'would delete' : 'deleted'} ${deletedCases} cases and ${deletedFiles} files; ${missing} listed cases not found\n`)
if (missing && check) process.exitCode = 1
