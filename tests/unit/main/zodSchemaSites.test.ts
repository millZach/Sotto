// @vitest-environment node
/**
 * Where Sotto builds zod schemas inside a function. A zod 4 schema is expensive to make: its constructor sets up every
 * check and method, and an object schema compiles a parser of its own the first time it parses. Built once at module
 * scope, that cost is paid at start. Built inside a function, it is paid on every call. In October 2026 two schemas
 * built inside `CodexActivityProjection.childNotification` cost main 1.4 s a minute while Codex sub-agents worked, in
 * bursts of 370 ms, and the preload built a result schema on every call the window made over the files, tools and
 * themes bridges. Each such site looked harmless where it was written.
 *
 * This finds every schema built inside a function body in `src/main`, `src/shared`, `src/host`, `src/preload` and
 * `src/renderer` and holds the count per function to `tests/fixtures/zodSchemaSites.json`, where each function that
 * still builds one gives its reason. A reason is one of two kinds: the build runs once, at start or when something is
 * registered or initialised; or the schema needs the call's own values (a field's limits, the model a send asked for),
 * and the reason names what it depends on and how often it runs. A new site fails until it is built once at module
 * scope, or until the list gains it with its reason and the PR says why.
 *
 * What counts as building a schema: a call on zod's `z` namespace (`z.object(...)`, `z.iso.datetime()`, apart from the
 * helpers in `notBuilders`) or on a factory imported from zod by name (`import { object } from 'zod'`); a schema method
 * that returns a new schema (`.extend`, `.optional`, `.array` and the rest of `deriving`) called on a schema; and a call
 * to a schema factory, a function that returns a schema (`filesResultSchema(value)`), here or imported. A schema is one
 * of those, a name bound to one, a parameter typed as one, or a schema's `.shape` member; names are resolved lexically,
 * so a parameter that shadows a module-scope schema is not one, and an import is matched to the module it comes from.
 * A chain counts once, at its outermost call. The body of a `z.lazy` callback runs once, when the schema first needs it,
 * so it belongs to wherever `z.lazy` is.
 *
 * Left out on purpose, because guessing would be noise: schemas held in object or class fields (`this.schema`), passed
 * through untyped parameters, or returned by class methods; and `var` hoisting out of a block.
 *
 *   SOTTO_UPDATE_SCHEMA_SITES=1 npx vitest run tests/unit/main/zodSchemaSites.test.ts
 *
 * rewrites the counts and keeps the reasons; a function new to the list gets an empty reason, which fails until filled.
 * `SOTTO_SCHEMA_SITES_PRINT=1` prints every site with its line.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../..')
const listFile = join(root, 'tests/fixtures/zodSchemaSites.json')
const folders = ['src/main', 'src/shared', 'src/host', 'src/preload', 'src/renderer']
// End-to-end test hooks run only in test builds.
const skipped = ['src/main/e2e/', 'src/renderer/src/e2e/']
/** Reading and walking every file takes seconds on a busy runner; this deadline is never what the test asserts. */
const SCAN_DEADLINE_MS = 120_000

/** Members of `z` that are called but return no new schema. */
const notBuilders = new Set(['config', 'prettifyError', 'treeifyError', 'flattenError', 'formatError', 'parse', 'safeParse',
  'parseAsync', 'safeParseAsync', 'encode', 'decode', 'safeEncode', 'safeDecode', 'toJSONSchema', 'registry', 'locales'])
/** Schema methods that return a new schema rather than reading or parsing. */
const deriving = new Set(['optional', 'nullable', 'nullish', 'nonoptional', 'array', 'or', 'and', 'extend', 'safeExtend',
  'merge', 'pick', 'omit', 'partial', 'required', 'strict', 'strip', 'passthrough', 'loose', 'catchall', 'keyof',
  'refine', 'superRefine', 'check', 'with', 'overwrite', 'transform', 'pipe', 'default', 'prefault', 'catch', 'brand',
  'readonly', 'describe', 'meta', 'clone', 'min', 'max', 'length', 'size', 'nonempty', 'int', 'positive', 'nonnegative',
  'negative', 'nonpositive', 'gt', 'gte', 'lt', 'lte', 'multipleOf', 'step', 'finite', 'safe', 'regex', 'trim',
  'toLowerCase', 'toUpperCase', 'lowercase', 'uppercase', 'normalize', 'startsWith', 'endsWith', 'includes', 'email',
  'url', 'uuid', 'datetime', 'date', 'time', 'duration', 'ip', 'cidr', 'base64', 'jwt', 'exclude', 'extract', 'rest'])
/** A type annotation that names a zod schema type. */
const schemaType = /^((z|zod)\.(Zod|core\.\$Zod|Schema)|Zod[A-Z])/

type Source = { path: string; file: ts.SourceFile }
type Site = { fn: string; line: number; text: string }
/** What a name is bound to. `zod` is the `z` namespace; `zodFn` a factory imported from zod by name; `namespace` another module's `import * as`. */
type Binding = { kind: 'zod' | 'zodFn' | 'schema' | 'factory' | 'other' } | { kind: 'zodFn'; name: string } | { kind: 'namespace'; module: string }
type Kind = Binding['kind']
type Exports = Map<string, 'schema' | 'factory'>

class Scope {
  readonly names = new Map<string, Binding>()
  /** Names looked up here so far, so a binding learned after a use can say the walk must run again. */
  readonly read = new Set<string>()
  constructor(readonly parent?: Scope) {}
  lookup(name: string): Binding | undefined {
    const own = this.names.get(name)
    if (own) { this.read.add(name); return own }
    return this.parent?.lookup(name)
  }
  owner(name: string): Scope | undefined { return this.names.has(name) ? this : this.parent?.owner(name) }
}

/** Strips the wrappers that change nothing at run time. */
function bare(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression
  return node
}

const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
  || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)

/** A readable name for a function: `Class.method`, `name`, or the property or variable it is assigned to. */
function nameOf(node: ts.Node, file: ts.SourceFile): string {
  const own = (n: ts.Node): string | undefined => {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isFunctionExpression(n)) && n.name) return n.name.getText(file)
    if (ts.isConstructorDeclaration(n)) return 'constructor'
    if (ts.isPropertyDeclaration(n)) return n.name.getText(file)
    const parent = n.parent
    if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === n) return parent.name.getText(file)
    return undefined
  }
  const parts: string[] = []
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    if (isFunction(n) || ts.isPropertyDeclaration(n)) parts.unshift(own(n) ?? '(anonymous)')
    else if (ts.isClassLike(n)) parts.unshift(n.name?.text ?? '(class)')
    // A callback in a module-scope variable's initializer, such as a `.map` that builds a shape at load.
    else if (ts.isVariableDeclaration(n) && ts.isVariableStatement(n.parent.parent) && ts.isSourceFile(n.parent.parent.parent) && !isFunction(n.initializer ?? n)) parts.unshift(n.name.getText(file))
  }
  return parts.join('.')
}

/** The scanned file a relative import names, or undefined for a package or a file outside the scan. */
function resolveImport(from: string, specifier: string, paths: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = posix.normalize(posix.join(posix.dirname(from), specifier))
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].find(path => paths.has(path))
}

/**
 * What survives between walks of one file, so a name used before its declaration is known on the next walk. `stale`
 * says the last walk learned such a name.
 */
type Memo = { schemas: Set<ts.Node>; returns: Set<ts.Node>; stale: boolean }

/**
 * One walk of a file: its build sites, and what it exports. `imported` gives each scanned module's exports as last seen.
 */
function walk(source: Source, imported: (path: string) => Exports, paths: ReadonlySet<string>, memo: Memo): { sites: Site[]; exports: Exports } {
  const file = source.file
  const top = new Scope()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue
    const clause = statement.importClause
    if (!clause) continue
    const specifier = statement.moduleSpecifier.text
    if (/^zod(\/|$)/.test(specifier)) {
      if (clause.name) top.names.set(clause.name.text, { kind: 'zod' })
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) top.names.set(bindings.name.text, { kind: 'zod' })
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
        if (element.isTypeOnly) continue
        const name = (element.propertyName ?? element.name).text
        // Capitalised names are classes and types (`ZodError`, `ZodType`); the helpers build nothing.
        top.names.set(element.name.text, name === 'z' ? { kind: 'zod' } : /^[a-z]/.test(name) && !notBuilders.has(name) ? { kind: 'zodFn', name } : { kind: 'other' })
      }
      continue
    }
    const module = resolveImport(source.path, specifier, paths)
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) top.names.set(bindings.name.text, module ? { kind: 'namespace', module } : { kind: 'other' })
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      const kind = element.isTypeOnly || !module ? undefined : imported(module).get((element.propertyName ?? element.name).text)
      top.names.set(element.name.text, { kind: kind ?? 'other' })
    }
    if (clause.name) top.names.set(clause.name.text, { kind: 'other' })
  }

  const kindOf = (node: ts.Expression, scope: Scope): Kind | undefined => {
    node = bare(node)
    return ts.isIdentifier(node) ? scope.lookup(node.text)?.kind : undefined
  }
  const isLazyCallback = (node: ts.Node, scope: Scope): boolean => {
    const call = node.parent
    if (!call || !ts.isCallExpression(call) || !call.arguments.some(argument => argument === node)) return false
    const callee = bare(call.expression)
    if (ts.isIdentifier(callee)) { const binding = scope.lookup(callee.text); return binding?.kind === 'zodFn' && 'name' in binding && binding.name === 'lazy' }
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'lazy' && kindOf(callee.expression, scope) === 'zod'
  }
  /** Whether a call makes a new schema. */
  const builds = (call: ts.CallExpression, scope: Scope): boolean => {
    const callee = bare(call.expression)
    if (ts.isIdentifier(callee)) { const kind = scope.lookup(callee.text)?.kind; return kind === 'zodFn' || kind === 'factory' }
    if (!ts.isPropertyAccessExpression(callee)) return false
    const target = bare(callee.expression), member = callee.name.text
    const binding = ts.isIdentifier(target) ? scope.lookup(target.text) : undefined
    if (binding?.kind === 'zod') return !notBuilders.has(member)
    if (binding?.kind === 'namespace') return imported(binding.module).get(member) === 'factory'
    // `z.iso.datetime()`, `z.coerce.number()`: a factory one namespace down.
    if (ts.isPropertyAccessExpression(target) && kindOf(target.expression, scope) === 'zod') return true
    return deriving.has(member) && isSchema(target, scope)
  }
  /** Whether an expression is a schema. Only `.shape` passes schema-ness through a property; `enum.options` and the like do not. */
  const isSchema = (node: ts.Expression, scope: Scope): boolean => {
    node = bare(node)
    if (ts.isIdentifier(node)) return scope.lookup(node.text)?.kind === 'schema'
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const target = bare(node.expression)
      const binding = ts.isIdentifier(target) ? scope.lookup(target.text) : undefined
      if (binding?.kind === 'namespace') return ts.isPropertyAccessExpression(node) && imported(binding.module).get(node.name.text) === 'schema'
      return ts.isPropertyAccessExpression(target) && target.name.text === 'shape' && isSchema(target.expression, scope)
    }
    if (ts.isCallExpression(node)) return builds(node, scope)
    if (ts.isConditionalExpression(node)) return isSchema(node.whenTrue, scope) || isSchema(node.whenFalse, scope)
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return isSchema(node.right, scope)
      if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) return isSchema(node.left, scope) || isSchema(node.right, scope)
    }
    return false
  }
  const typedAsSchema = (node: ts.ParameterDeclaration, scopeOf: ts.Node): boolean => {
    if (!node.type) return false
    const text = node.type.getText(file)
    if (schemaType.test(text)) return true
    const parameters = (scopeOf as ts.Node & { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters
    const own = parameters?.find(parameter => parameter.name.text === text)
    return !!own?.constraint && schemaType.test(own.constraint.getText(file))
  }
  const bindNames = (name: ts.BindingName, scope: Scope, binding: Binding): void => {
    if (ts.isIdentifier(name)) { scope.names.set(name.text, binding); return }
    for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindNames(element.name, scope, { kind: 'other' })
  }
  /** Binds what a declaration turned out to be; a use before this point read the old binding, so the walk must run again. */
  const learn = (scope: Scope, name: string, kind: 'schema' | 'factory'): void => {
    if (scope.names.get(name)?.kind === kind) return
    if (scope.read.has(name)) memo.stale = true
    scope.names.set(name, { kind })
  }
  const remembered = (node: ts.Node): Binding => ({ kind: memo.returns.has(node) ? 'factory' : memo.schemas.has(node) ? 'schema' : 'other' })
  /** Binds what a block declares before walking it, so a later declaration shadows from the start, as `let` and `const` do. */
  const declare = (statements: readonly ts.Statement[], scope: Scope): void => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer && bare(declaration.initializer)
        bindNames(declaration.name, scope, remembered(init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : declaration))
      }
      else if (ts.isFunctionDeclaration(statement) && statement.name) scope.names.set(statement.name.text, remembered(statement))
      else if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) scope.names.set(statement.name.text, { kind: 'other' })
    }
  }

  const sites: Site[] = []
  const visit = (node: ts.Node, scope: Scope, owner: ts.Node | undefined, fn: ts.Node | undefined, inBuild: boolean): void => {
    if (isFunction(node)) {
      const lazy = isLazyCallback(node, scope)
      const inner = new Scope(scope)
      for (const parameter of node.parameters) bindNames(parameter.name, inner, { kind: typedAsSchema(parameter, node) ? 'schema' : 'other' })
      for (const parameter of node.parameters) if (parameter.initializer) visit(parameter.initializer, inner, lazy ? owner : node, node, false)
      const body = node.body, ownerHere = lazy ? owner : node
      if (body && ts.isBlock(body)) { declare(body.statements, inner); for (const statement of body.statements) visit(statement, inner, ownerHere, node, false) }
      else if (body) { visit(body, inner, ownerHere, node, false); if (isSchema(body, inner)) memo.returns.add(node) }
      // A declaration is known as a factory from here on in this walk, and from the start of its scope in the next.
      if (ts.isFunctionDeclaration(node) && node.name && memo.returns.has(node)) learn(scope.owner(node.name.text) ?? scope, node.name.text, 'factory')
      return
    }
    // An instance field's initializer runs for every instance, as a constructor does.
    if (ts.isPropertyDeclaration(node) && !node.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) {
      if (node.initializer) visit(node.initializer, scope, node, fn, false)
      return
    }
    if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      const inner = new Scope(scope); declare(node.statements, inner)
      for (const statement of node.statements) visit(statement, inner, owner, fn, inBuild)
      return
    }
    if (ts.isCaseBlock(node)) {
      const inner = new Scope(scope)
      for (const clause of node.clauses) declare(clause.statements, inner)
      ts.forEachChild(node, child => visit(child, inner, owner, fn, inBuild))
      return
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCatchClause(node)) {
      const inner = new Scope(scope)
      const declared = ts.isCatchClause(node) ? node.variableDeclaration : node.initializer
      if (declared && ts.isVariableDeclarationList(declared)) for (const declaration of declared.declarations) bindNames(declaration.name, inner, { kind: 'other' })
      else if (declared && ts.isVariableDeclaration(declared)) bindNames(declared.name, inner, { kind: 'other' })
      ts.forEachChild(node, child => visit(child, inner, owner, fn, inBuild))
      return
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visit(node.initializer, scope, owner, fn, inBuild)
      if (ts.isIdentifier(node.name)) {
        const init = node.initializer && bare(node.initializer)
        const target = scope.owner(node.name.text) ?? scope
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) { if (memo.returns.has(init)) learn(target, node.name.text, 'factory') }
        else if (init && isSchema(init, scope)) { memo.schemas.add(node); learn(target, node.name.text, 'schema') }
      }
      return
    }
    if (ts.isReturnStatement(node) && node.expression) {
      visit(node.expression, scope, owner, fn, inBuild)
      if (fn && isSchema(node.expression, scope)) memo.returns.add(fn)
      return
    }
    if (!inBuild && owner && ts.isCallExpression(node) && builds(node, scope)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      sites.push({ fn: nameOf(owner, file), line: line + 1, text: node.getText(file).replace(/\s+/g, ' ').slice(0, 120) })
      // The rest of this chain and its arguments are the same build; a function inside them is its own owner.
      ts.forEachChild(node, child => visit(child, scope, owner, fn, true))
      return
    }
    ts.forEachChild(node, child => visit(child, scope, owner, fn, inBuild))
  }
  declare(file.statements, top)
  for (const statement of file.statements) visit(statement, top, undefined, undefined, false)

  const exports: Exports = new Map()
  const exportAs = (exported: string, kind: Kind | undefined): void => { if (kind === 'schema' || kind === 'factory') exports.set(exported, kind) }
  for (const statement of file.statements) {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    if (exported && ts.isFunctionDeclaration(statement) && statement.name) exportAs(statement.name.text, top.names.get(statement.name.text)?.kind)
    if (exported && ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) exportAs(declaration.name.text, top.names.get(declaration.name.text)?.kind)
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? resolveImport(source.path, statement.moduleSpecifier.text, paths) : undefined
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text
        exportAs(element.name.text, statement.moduleSpecifier ? from === undefined ? undefined : imported(from).get(local) : top.names.get(local)?.kind)
      }
    }
  }
  return { sites, exports }
}

/** Whether a file imports or re-exports a scanned module's schema or factory, by name or through its namespace. */
function importsSchemas(source: Source, imported: (path: string) => Exports, paths: ReadonlySet<string>): boolean {
  return source.file.statements.some(statement => {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return false
    const module = resolveImport(source.path, statement.moduleSpecifier.text, paths)
    const exports = module ? imported(module) : undefined
    if (!exports?.size) return false
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause
    if (!bindings || ts.isNamespaceImport(bindings) || ts.isNamespaceExport(bindings)) return true
    return bindings.elements.some(element => !element.isTypeOnly && exports.has((element.propertyName ?? element.name).text))
  })
}

/** Files in an order that puts what a file imports before it, where the imports allow one. */
function importOrder(sources: readonly Source[], paths: ReadonlySet<string>): Source[] {
  const byPath = new Map(sources.map(source => [source.path, source]))
  const done = new Set<string>(), order: Source[] = []
  const place = (source: Source): void => {
    if (done.has(source.path)) return
    done.add(source.path)
    for (const statement of source.file.statements) {
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined
      const module = specifier && resolveImport(source.path, specifier, paths)
      if (module) place(byPath.get(module)!)
    }
    order.push(source)
  }
  for (const source of sources) place(source)
  return order
}

/**
 * Every build site in these sources, by file and function. A file is walked again only when a module it imports
 * exports something new, or when its own walk learned a name it could not know the first time.
 */
export function census(sources: readonly Source[]): Map<string, Map<string, Site[]>> {
  const paths = new Set(sources.map(source => source.path))
  const exportsOf = new Map<string, Exports>(), signatures = new Map<string, string>()
  const empty: Exports = new Map()
  const imported = (path: string): Exports => exportsOf.get(path) ?? empty
  const memos = new Map<string, Memo>(), lastSeen = new Map<string, string>(), sitesOf = new Map<string, Site[]>()
  const dependencies = new Map(sources.map(source => [source.path, source.file.statements.flatMap(statement => {
    const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined
    const module = specifier && resolveImport(source.path, specifier, paths)
    return module ? [module] : []
  })]))
  const order = importOrder(sources, paths)
  for (let pass = 0, changed = true; changed && pass < 6; pass++) {
    changed = false
    for (const source of order) {
      const seen = dependencies.get(source.path)!.map(path => signatures.get(path) ?? '').join('|')
      if (lastSeen.get(source.path) === seen) continue
      lastSeen.set(source.path, seen)
      // A file that neither mentions zod nor imports a schema or a factory has nothing to find.
      if (!source.file.text.includes('zod') && !importsSchemas(source, imported, paths)) { sitesOf.set(source.path, []); continue }
      const memo = memos.get(source.path) ?? { schemas: new Set(), returns: new Set(), stale: false }
      memos.set(source.path, memo)
      memo.stale = false
      let result = walk(source, imported, paths, memo)
      for (let again = 0; memo.stale && again < 4; again++) { memo.stale = false; result = walk(source, imported, paths, memo) }
      sitesOf.set(source.path, result.sites)
      const signature = JSON.stringify([...result.exports].sort())
      if (signature !== (signatures.get(source.path) ?? '[]')) { exportsOf.set(source.path, result.exports); signatures.set(source.path, signature); changed = true }
    }
  }
  const result = new Map<string, Map<string, Site[]>>()
  for (const source of sources) {
    for (const site of sitesOf.get(source.path) ?? []) {
      const byFunction = result.get(source.path) ?? new Map<string, Site[]>()
      byFunction.set(site.fn, [...byFunction.get(site.fn) ?? [], site])
      result.set(source.path, byFunction)
    }
  }
  return result
}

function files(folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry => {
    const path = `${folder}/${entry.name}`
    if (entry.isDirectory()) return files(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !skipped.some(prefix => path.startsWith(prefix)) ? [path] : []
  })
}
const parse = (path: string, text: string): Source =>
  ({ path, file: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) })

type Listed = Record<string, Record<string, { count: number; reason: string }>>

const exception = 'Either it runs once (at start, or when something is registered or initialised), or it needs the call\'s own values; then the reason names what it depends on and how often it runs.'

describe('zod schemas built inside functions', () => {
  it('builds them only where the committed list says why', () => {
    const now = census(folders.flatMap(files).sort().map(path => parse(path, readFileSync(join(root, path), 'utf8'))))
    if (process.env.SOTTO_SCHEMA_SITES_PRINT === '1') {
      for (const [path, byFunction] of now) for (const [fn, sites] of byFunction) for (const site of sites) console.log(`${path}:${site.line} ${fn}  ${site.text}`)
    }
    let listed = JSON.parse(readFileSync(listFile, 'utf8')) as Listed
    if (process.env.SOTTO_UPDATE_SCHEMA_SITES === '1') {
      const next: Listed = {}
      for (const [path, byFunction] of [...now].sort(([a], [b]) => a.localeCompare(b))) {
        for (const [fn, sites] of [...byFunction].sort(([a], [b]) => a.localeCompare(b))) (next[path] ??= {})[fn] = { count: sites.length, reason: listed[path]?.[fn]?.reason ?? '' }
      }
      writeFileSync(listFile, `${JSON.stringify(next, null, 2)}\n`)
      listed = next
    }
    const problems: string[] = []
    for (const path of [...new Set([...now.keys(), ...Object.keys(listed)])].sort()) {
      for (const fn of [...new Set([...now.get(path)?.keys() ?? [], ...Object.keys(listed[path] ?? {})])].sort()) {
        const sites = now.get(path)?.get(fn) ?? [], entry = listed[path]?.[fn]
        const where = sites.map(site => `${path}:${site.line} ${site.text}`).join('\n    ')
        if (!entry) problems.push(`${path} ${fn} builds ${sites.length} zod schema(s) every time it runs, which the list does not allow:\n    ${where}\n  Build the schema once at module scope. Otherwise add the function to the list with its reason and say why in the PR. ${exception}`)
        else if (sites.length > entry.count) problems.push(`${path} ${fn} now builds ${sites.length} zod schema(s) where the list allows ${entry.count}:\n    ${where}\n  Build the new one once at module scope, or raise the count and say why in the PR. ${exception}`)
        else if (sites.length < entry.count) problems.push(`${path} ${fn} now builds ${sites.length} zod schema(s) where the list has ${entry.count}. Good: ${sites.length ? 'lower the count' : 'remove the entry'} so it holds.`)
        else if (!entry.reason.trim()) problems.push(`${path} ${fn} is on the list without a reason. ${exception}`)
      }
    }
    expect(problems, `${problems.join('\n')}\n\nRewrite the counts with: SOTTO_UPDATE_SCHEMA_SITES=1 npx vitest run tests/unit/main/zodSchemaSites.test.ts`).toEqual([])
  }, SCAN_DEADLINE_MS)

  const sitesOf = (files: Record<string, string>): string[] =>
    [...census(Object.entries(files).map(([path, text]) => parse(path, text)))].flatMap(([path, byFunction]) =>
      [...byFunction].flatMap(([fn, sites]) => sites.map(site => `${path} ${fn}: ${site.text}`)))

  it('finds a schema built per call and leaves module scope and z.lazy alone', () => {
    expect(sitesOf({ 'a.ts': `import { z } from 'zod'
const item = z.object({ id: z.string() })
const tree = z.lazy(() => z.array(z.object({ id: z.string() })))
const values = Object.fromEntries(['a'].map(key => [key, z.string()]))
export function read(value: unknown) {
  item.parse(value); item.safeParse(value).success; z.prettifyError
  return z.object({ id: z.string(), item }).extend({ more: z.number() }).safeParse(value)
}
class Reader { handle(value: unknown) { return item.optional().parse(value) } }
` })).toEqual([
      'a.ts values.(anonymous): z.string()',
      'a.ts read: z.object({ id: z.string(), item }).extend({ more: z.number() })',
      'a.ts Reader.handle: item.optional()',
    ])
  })

  it('does not take a string method or a parse result for a schema', () => {
    expect(sitesOf({ 'a.ts': `import { z } from 'zod'
const name = z.string()
export function read(value: unknown, text: string) { return [name.parse(value).trim(), text.trim(), text.includes('x'), name.safeParse(value).data?.startsWith('a')] }
` })).toEqual([])
  })

  it('follows schemas and factories across files, and schema-typed parameters', () => {
    expect(sitesOf({
      'shared.ts': `import { z } from 'zod'
export const thing = z.object({ id: z.string() })
export function resultSchema<T extends z.ZodType>(value: T) { return z.object({ ok: z.literal(true), value }) }
export function wrap<S extends z.ZodType>(schema: S) { return schema.optional() }
export const parseThing = (value: unknown) => z.object({ id: z.string() }).parse(value)
`,
      'main.ts': `import { thing, resultSchema, parseThing } from './shared'
const answer = resultSchema(thing)
export function call(value: unknown) { parseThing(value); answer.parse(value); return resultSchema(thing.array()).parse(value) }
`,
    })).toEqual([
      'shared.ts resultSchema: z.object({ ok: z.literal(true), value })',
      'shared.ts wrap: schema.optional()',
      'shared.ts parseThing: z.object({ id: z.string() })',
      'main.ts call: resultSchema(thing.array())',
    ])
  })

  it('finds factories imported from zod by name and schemas reached through a module namespace', () => {
    expect(sitesOf({
      'shared.ts': `import { z } from 'zod'
export const thing = z.object({ id: z.string() })
export const make = () => z.string()
`,
      'main.ts': `import { object, string as text, ZodError, prettifyError } from 'zod'
import * as shared from './shared'
const once = object({ id: text() })
export function read(value: unknown) {
  prettifyError(new ZodError([])); once.parse(value); shared.thing.parse(value)
  return [object({ id: text() }).parse(value), shared.thing.optional(), shared.make()]
}
`,
    })).toEqual([
      'shared.ts make: z.string()',
      'main.ts read: object({ id: text() })',
      'main.ts read: shared.thing.optional()',
      'main.ts read: shared.make()',
    ])
  })

  it('does not take a shadowing name, a non-schema member or another module\'s same name for a schema', () => {
    expect(sitesOf({
      'labels.ts': `export const thing = 'label'
`,
      // Another module exports a schema by the same name: matched by name alone, \`thing.trim()\` would read as a schema built.
      'schemas.ts': `import { z } from 'zod'
export const thing = z.string()
`,
      'main.ts': `import { z } from 'zod'
import { thing } from './labels'
const name = z.string()
const choice = z.enum(['a', 'b'])
export function read(name: string) { return name.trim() }
export function inner() { const name = 'x'; return name.trim() }
export function loop(names: string[]) { for (const name of names) name.trim() }
export function has(value: string) { return choice.options.includes(value as 'a') }
export function label() { return thing.trim() }
export function shape() { return name.shape }
`,
    })).toEqual([])
  })

  it('takes a function that returns a schema from a conditional or logical expression for a factory', () => {
    expect(sitesOf({ 'a.ts': `import { z } from 'zod'
function make(flag: boolean) { return flag ? z.string() : z.number() }
const either = (flag: boolean) => flag && z.boolean()
const fallback = (cached?: z.ZodType) => cached ?? z.unknown()
export function use() { return [make(true), either(false), fallback()] }
` })).toEqual([
      'a.ts make: z.string()',
      'a.ts make: z.number()',
      'a.ts either: z.boolean()',
      'a.ts fallback: z.unknown()',
      'a.ts use: make(true)',
      'a.ts use: either(false)',
      'a.ts use: fallback()',
    ])
  })
})
