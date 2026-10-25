// Checks the iPhone app's String Catalogs against its Swift sources (ADR-0123).
//
//   node apps/ios/Scripts/check-strings.mjs                 check, exit 1 on any problem
//   node apps/ios/Scripts/check-strings.mjs --keys out.json write every key the code uses, for drafting
//   node apps/ios/Scripts/check-strings.mjs --interpolations list each key's placeholders and the code behind them
//   node apps/ios/Scripts/check-strings.mjs --prose          list string literals that read like prose but aren't localized
//
// It finds every key the code localizes: a literal handed to a SwiftUI initializer that takes a LocalizedStringKey
// (Text, Button, Label, …, .navigationTitle, .accessibilityLabel, …) and every String(localized:). It confirms each
// is in the right catalog (SottoCore's own for Sources/SottoCore, the app's for Sotto/), that the catalog holds
// nothing the code no longer uses, that every language has every key, and that each translation carries the same
// placeholders as English. Plural forms are checked against each language's plural categories.
//
// English is the key, except for a word that means two things in Sotto (Open, Closed, Working): there the code gives
// its own key and the English as `String(localized: "agent-row.open", defaultValue: "Open", comment: …)`, so each
// meaning gets its own translation, and the catalog's English must equal the default value. A key of its own is a
// StaticString, so its values are interpolated into the default value: `String(localized: "computer-row.cant-reach",
// defaultValue: "Can’t reach \(name).")`.
//
// Xcode generates a Swift symbol for each key and fails the build when two in one catalog would share one: keys that
// differ only in case or punctuation, such as "Merged" and "merged" or "Sending" and "Sending…". The in-sentence or
// rarer one gets a key of its own in the same way.
//
// Swift turns an interpolated String into %@ and an Int into %lld. This script cannot type-check, so it reads the
// expression: counts (`.count`, `count`, `n`, arithmetic on a number and the names in INTEGER_NAMES) are %lld and
// everything else is %@. Interpolate only String and Int values in localized text, and when you add an Int under a
// new name, add the name below; `--interpolations` shows what it decided.
import console from 'node:console'
import process from 'node:process'
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const IOS = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The thirty interface languages (ADR-0123) as iOS names them, and `es-419` holding Mexican Spanish for the rest of
 * Latin America, so `es-AR` and `es-US` reach it rather than Spain's. English is the source. */
export const LOCALES = ['es-MX', 'es-419', 'es', 'fr', 'de', 'it', 'pt-BR', 'pt-PT', 'nl', 'pl', 'sv', 'da', 'nb', 'fi',
  'cs', 'ro', 'hu', 'el', 'uk', 'tr', 'ar', 'zh-Hans', 'zh-Hant', 'ja', 'hi', 'bn', 'mr', 'te', 'ta', 'ur']
/** Locales whose every string is another's, kept identical. */
export const MIRRORS = { 'es-419': 'es-MX' }

/** CLDR plural categories: the ones a counted string must give, and the ones it may. */
export const PLURAL_RULES = {
  en: [['one', 'other']], 'es-MX': [['one', 'other'], ['many']], 'es-419': [['one', 'other'], ['many']],
  es: [['one', 'other'], ['many']], fr: [['one', 'other'], ['many']], it: [['one', 'other'], ['many']],
  'pt-BR': [['one', 'other'], ['many']], 'pt-PT': [['one', 'other'], ['many']], de: [['one', 'other']],
  nl: [['one', 'other']], sv: [['one', 'other']], da: [['one', 'other']], nb: [['one', 'other']], fi: [['one', 'other']],
  el: [['one', 'other']], hu: [['one', 'other']], tr: [['one', 'other']], hi: [['one', 'other']], bn: [['one', 'other']],
  mr: [['one', 'other']], te: [['one', 'other']], ta: [['one', 'other']], ur: [['one', 'other']],
  pl: [['one', 'few', 'many', 'other']], cs: [['one', 'few', 'many', 'other']], uk: [['one', 'few', 'many', 'other']],
  ro: [['one', 'few', 'other']], ar: [['zero', 'one', 'two', 'few', 'many', 'other']],
  'zh-Hans': [['other']], 'zh-Hant': [['other']], ja: [['other']],
}

/** SwiftUI calls whose first unlabelled string literal is a LocalizedStringKey. */
const KEY_CALLS = ['Text', 'Button', 'Label', 'Toggle', 'TextField', 'SecureField', 'Picker', 'Section', 'Link', 'Menu',
  'LabeledContent', 'Stepper', 'ContentUnavailableView', 'ProgressView', 'LocalizedStringKey', 'LocalizedStringResource', 'navigationTitle',
  'alert', 'confirmationDialog', 'accessibilityLabel', 'accessibilityHint', 'accessibilityValue', 'help', 'badge']

/** Names that hold an Int wherever they are interpolated into localized text. */
const INTEGER_NAMES = new Set(['count', 'n', 'total', 'needs', 'working', 'hidden', 'others', 'room', 'limit', 'unnamed',
  'inFlight', 'inFlightLimit', 'files', 'attachmentCount', 'number', 'added', 'removed', 'hours', 'minutes', 'rest',
  'value', 'threads', 'index', 'position', 'step', 'connected', 'exitCode', 'code', 'listed', 'shown', 'more', 'turn',
  'unknown', 'photos', 'requests', 'passed', 'failing', 'pending',
  'remaining', 'left', 'running', 'additions', 'deletions', 'insertions', 'changedFiles', 'commits', 'comments', 'skipped'])

// MARK: Reading Swift

/** Reads a Swift source into its string literals, with a copy of the code where comments and the text of every
 * literal are blanked (interpolated code stays), so calls and parentheses can be read around a literal. */
export function lexSwift(source) {
  const masked = source.split('')
  const literals = []
  const blank = (from, to) => { for (let k = from; k < to; k++) if (masked[k] !== '\n') masked[k] = ' ' }

  function readCode(i, untilParen) {
    let depth = 0
    while (i < source.length) {
      const c = source[i]
      if (c === '/' && source[i + 1] === '/') {
        const end = source.indexOf('\n', i); const stop = end < 0 ? source.length : end
        blank(i, stop); i = stop; continue
      }
      if (c === '/' && source[i + 1] === '*') {
        let level = 1, k = i + 2
        while (k < source.length && level > 0) {
          if (source[k] === '/' && source[k + 1] === '*') { level++; k += 2 } else if (source[k] === '*' && source[k + 1] === '/') { level--; k += 2 } else k++
        }
        blank(i, k); i = k; continue
      }
      if (c === '"' || (c === '#' && /^#+"/.test(source.slice(i, i + 8)))) { i = readString(i); continue }
      if (untilParen) {
        if (c === '(') depth++
        else if (c === ')') { if (depth === 0) return i; depth-- }
      }
      i++
    }
    return i
  }

  function readString(start) {
    let i = start, hashes = 0
    while (source[i] === '#') { hashes++; i++ }
    const multiline = source.startsWith('"""', i)
    const quote = multiline ? '"""' : '"'
    i += quote.length
    const close = quote + '#'.repeat(hashes)
    const escape = '\\' + '#'.repeat(hashes)
    const segments = []
    let text = '', textFrom = i
    const literal = { start, multiline, raw: hashes > 0, segments, end: 0 }
    literals.push(literal)
    while (i < source.length) {
      if (source.startsWith(close, i)) {
        if (text) segments.push({ text })
        blank(textFrom, i)
        literal.end = i + close.length
        return literal.end
      }
      if (source.startsWith(escape, i)) {
        const at = i + escape.length
        const next = source[at]
        if (next === '(') {
          if (text) segments.push({ text }); text = ''
          blank(textFrom, i)
          const exprStart = at + 1
          const exprEnd = readCode(exprStart, true)
          segments.push({ expr: source.slice(exprStart, exprEnd).trim(), at: exprStart })
          i = exprEnd + 1; textFrom = i
          continue
        }
        const simple = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', "'": "'" }
        if (next in simple) { text += simple[next]; i = at + 1; continue }
        if (next === 'u') {
          const m = /^u\{([0-9a-fA-F]+)\}/.exec(source.slice(at, at + 12))
          if (m) { text += String.fromCodePoint(parseInt(m[1], 16)); i = at + m[0].length; continue }
        }
        if (multiline && next === '\n') { i = at + 1; continue }
      }
      if (!multiline && source[i] === '\n') { literal.end = i; literal.unterminated = true; return i }
      text += source[i]; i++
    }
    literal.end = i
    return i
  }

  readCode(0, false)
  return { literals, masked: masked.join('') }
}

/** The format specifier Swift writes for an interpolated expression. `declared` reads what a bare name was declared
 * as, nearest first, in the code before it. */
export function specifierFor(expr, declared = () => null) {
  const e = expr.replace(/\s+/g, ' ').trim()
  if (/^\d+$/.test(e)) return '%lld'
  if (/^(Interface\.isolated|String\(|StepRun\.|Words\.|AgentNames\.)/.test(e)) return '%@'
  if (/\.count$/.test(e) || /\.count\s*[-+]\s*\d+$/.test(e)) return '%lld'
  if (/^[\w.]+\s*[-+*/%]\s*\d+$/.test(e) || /^\d+\s*[-+*/%]\s*[\w.]+$/.test(e)) return '%lld'
  if (/^Int\(/.test(e)) return '%lld'
  if (/^[A-Za-z_]\w*$/.test(e)) {
    const declaration = declared(e)
    if (declaration === 'Int') return '%lld'
    if (declaration === 'String') return '%@'
  }
  const last = /([A-Za-z_]\w*)$/.exec(e)
  if (last && INTEGER_NAMES.has(last[1])) return '%lld'
  return '%@'
}

/** What the nearest declaration of `name` before `at` makes it: Int, String, or null when it can't tell. */
function declaredType(masked, at, name) {
  const code = masked.slice(0, at)
  const re = new RegExp(`(?:\\b(?:let|var)\\s+${name}\\s*(?::\\s*(\\w+)\\??)?\\s*=([^\\n]*(?:\\n\\s*[?:][^\\n]*)*))|(?:[(,]\\s*(?:_\\s+)?${name}\\s*:\\s*(\\w+))`, 'g')
  let found = null, m
  while ((m = re.exec(code))) found = m
  if (!found) return null
  const type = found[1] ?? found[3]
  if (type === 'Int') return 'Int'
  if (type === 'String') return 'String'
  const value = found[2]
  if (value === undefined) return null
  if (/String\(\s*localized:|"|->\s*String|\.joined\(|\.title\b|\.name\b/.test(value)) return 'String'
  if (/\.count\b|\bmax\(|\bmin\(|reduce\(0|^\s*\d|[-+*/]\s*\d|\?\?\s*0\b|Int\(/.test(value)) return 'Int'
  return null
}

function keyOf(literal, masked) {
  return literal.segments.map(s => (s.text !== undefined ? s.text : specifierFor(s.expr, name => declaredType(masked, s.at, name)))).join('')
}

/** Reads back from `at` over whitespace and returns the code just before it. */
function before(masked, at, length = 60) { return masked.slice(Math.max(0, at - length), at) }

/** The innermost unclosed opener before `at`, and the name of the call it opens, if any. */
function enclosingCall(masked, at) {
  let depth = 0, comma = false
  for (let k = at - 1; k >= 0; k--) {
    const c = masked[k]
    if (c === ')' || c === ']' || c === '}') depth++
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) {
        if (c !== '(') return null
        const name = /([A-Za-z_]\w*)\s*$/.exec(masked.slice(Math.max(0, k - 60), k))
        const head = masked.slice(k + 1, at)
        return { name: name ? name[1] : '', open: k, firstArgument: !comma, labelled: /^\s*[A-Za-z_]\w*\s*:(?!:)/.test(head) }
      }
      depth--
    } else if (c === ',' && depth === 0) comma = true
  }
  return null
}

/** The matching close of the call whose opener is at `open`. */
function callEnd(masked, open) {
  let depth = 0
  for (let k = open; k < masked.length; k++) {
    const c = masked[k]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return k }
  }
  return masked.length
}

const hasLetters = text => /\p{L}/u.test(text)

/** Every localized key in one Swift file, with where it is and what it says about itself. */
export function scanFile(path, source) {
  const { literals, masked } = lexSwift(source)
  const keys = [], problems = [], prose = []
  const line = at => source.slice(0, at).split('\n').length
  const starts = new Map(literals.map(l => [l.start, l]))
  const core = path.includes('Sources/SottoCore') || path.includes('Sources\\SottoCore')
  for (const literal of literals) {
    const where = `${path}:${line(literal.start)}`
    const lead = before(masked, literal.start)
    const localized = /String\(\s*localized:\s*$/.test(lead)
    const keyCall = new RegExp(`(?:^|[^\\w.])\\.?(${KEY_CALLS.join('|')})\\(\\s*$`).exec(lead)
    const text = literal.segments.filter(s => s.text !== undefined).map(s => s.text).join('')
    if (localized || keyCall) {
      if (literal.multiline || literal.raw) { problems.push(`${where}: a localized key must be one plain "…" literal`); continue }
      const key = keyOf(literal, masked)
      if (!hasLetters(key.replace(/%lld|%@/g, ''))) continue
      if (/%(?!(lld|@))/.test(key.replace(/%lld|%@/g, ''))) problems.push(`${where}: a localized key can't hold a literal %: ${key}`)
      const open = masked.lastIndexOf('(', literal.start)
      const end = callEnd(masked, open)
      let comment
      const call = masked.slice(literal.end, end)
      const m = /comment:\s*(?=")/.exec(call)
      if (m) {
        const commentLiteral = starts.get(literal.end + m.index + m[0].length)
        if (commentLiteral) comment = commentLiteral.segments.map(s => s.text ?? '').join('')
      }
      let english, valueSegments = literal.segments
      const d = /defaultValue:\s*(?=")/.exec(call)
      if (d) {
        if (!localized) problems.push(`${where}: only String(localized:) takes a defaultValue`)
        // With a defaultValue the key is a StaticString, so it can't be interpolated: the values go in the default.
        if (literal.segments.some(s => s.expr !== undefined)) problems.push(`${where}: a key of its own can't be interpolated; put the values in its defaultValue`)
        const defaultLiteral = starts.get(literal.end + d.index + d[0].length)
        if (defaultLiteral) { english = keyOf(defaultLiteral, masked); valueSegments = defaultLiteral.segments }
      }
      if (localized && core && !/bundle:\s*\.module/.test(call)) problems.push(`${where}: SottoCore's String(localized:) needs bundle: .module`)
      if (localized && !core && /bundle:/.test(call)) problems.push(`${where}: the app's strings come from the main bundle; drop bundle:`)
      if (keyCall && core) problems.push(`${where}: SottoCore has no SwiftUI keys`)
      keys.push({ key, comment, english, where, expressions: valueSegments.filter(s => s.expr !== undefined).map(s => `${specifierFor(s.expr, name => declaredType(masked, s.at, name))} ← ${s.expr}`) })
      continue
    }
    if (!hasLetters(text) || /comment:\s*$/.test(lead)) continue
    const call = enclosingCall(masked, literal.start)
    if (call && KEY_CALLS.includes(call.name) && call.firstArgument && !call.labelled && !core) {
      problems.push(`${where}: "${text}" sits in a ternary or ?? inside ${call.name}(…), where Swift makes it a String and never localizes it; use Text("…") in each branch or String(localized:)`)
      continue
    }
    if (/^[A-Z][\p{L}’']*(\s+\S+)+/u.test(text.trim()) || /\s[a-z]+\s/.test(text)) prose.push(`${where}: ${text}`)
  }
  return { keys, problems, prose }
}

function swiftFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return swiftFiles(path)
    return entry.name.endsWith('.swift') ? [path] : []
  })
}

// MARK: Catalogs

export const CATALOGS = {
  app: { path: 'Sotto/Resources/Localizable.xcstrings', sources: ['Sotto'] },
  core: { path: 'Sources/SottoCore/Resources/Localizable.xcstrings', sources: ['Sources/SottoCore'] },
}
export const INFO_PLIST_CATALOG = 'Sotto/Resources/InfoPlist.xcstrings'

/** The placeholders in a format string, in order, as [position or null, type]. */
export function placeholders(text) {
  const found = []
  const re = /%(?:(\d+)\$)?(lld|ld|llu|lu|d|i|u|@|lf|f)|%%/g
  let m
  while ((m = re.exec(text))) if (m[0] !== '%%') found.push([m[1] ? Number(m[1]) : null, m[2]])
  return found
}

/** Whether `translation` carries the same placeholders as `english`: the same types in order, or, with positions,
 * every English argument by its number. */
export function samePlaceholders(english, translation, { mayOmit = false } = {}) {
  const want = placeholders(english).map(p => p[1])
  const got = placeholders(translation)
  if (got.length === 0 && mayOmit) return true
  if (got.some(p => p[0] !== null)) {
    if (got.some(p => p[0] === null)) return false
    const seen = new Set()
    for (const [position, type] of got) {
      if (position < 1 || position > want.length || want[position - 1] !== type) return false
      seen.add(position)
    }
    return mayOmit ? true : seen.size === want.length
  }
  return got.length === want.length && got.every((p, k) => p[1] === want[k])
}

function unitValue(localization) { return localization?.stringUnit?.value }

/** Problems with one catalog entry in one language. */
function checkLocalization(key, locale, english, localization, problems) {
  const label = `${locale} "${key}"`
  if (!localization) { problems.push(`${label}: no translation`); return }
  const plural = localization.variations?.plural
  const englishPlural = english.variations?.plural
  if (englishPlural) {
    if (!plural) { problems.push(`${label}: English varies by plural, so this must too`); return }
    const [required, optional = []] = PLURAL_RULES[locale]
    const forms = Object.keys(plural)
    for (const form of required) if (!plural[form]) problems.push(`${label}: missing plural form ${form}`)
    for (const form of forms) if (!required.includes(form) && !optional.includes(form)) problems.push(`${label}: ${locale} has no plural form ${form}`)
    for (const form of forms) {
      const value = unitValue(plural[form])
      if (typeof value !== 'string' || !value) { problems.push(`${label}: empty plural form ${form}`); continue }
      if (!samePlaceholders(englishPlural.other.stringUnit.value, value, { mayOmit: form !== 'other' })) problems.push(`${label} (${form}): placeholders differ from English: ${value}`)
    }
    return
  }
  if (plural) { problems.push(`${label}: varies by plural where English doesn't`); return }
  const value = unitValue(localization)
  if (typeof value !== 'string' || !value) { problems.push(`${label}: empty translation`); return }
  if (localization.stringUnit.state !== 'translated') problems.push(`${label}: state is ${localization.stringUnit.state}`)
  if (!samePlaceholders(unitValue(english), value)) problems.push(`${label}: placeholders differ from English: ${value}`)
}

/** Problems with a whole catalog: its shape, English, and every language. */
export function checkCatalog(catalog, name, defaults = new Map()) {
  const problems = []
  if (catalog.sourceLanguage !== 'en') problems.push(`${name}: sourceLanguage must be en`)
  if (catalog.version !== '1.0') problems.push(`${name}: version must be 1.0`)
  for (const [key, entry] of Object.entries(catalog.strings ?? {})) {
    if (entry.shouldTranslate === false) continue
    const english = entry.localizations?.en
    if (!english) { problems.push(`${name} "${key}": no English`); continue }
    const englishPlural = english.variations?.plural
    if (englishPlural) {
      if (!englishPlural.one || !englishPlural.other) problems.push(`${name} "${key}": English plural needs one and other`)
      const counts = placeholders(defaults.get(key) ?? key)
      if (counts.length !== 1 || counts[0][1] !== 'lld') problems.push(`${name} "${key}": a counted string has exactly one %lld and nothing else`)
    } else if (unitValue(english) !== (defaults.get(key) ?? key)) {
      problems.push(defaults.has(key) ? `${name} "${key}": English must equal its defaultValue, ${defaults.get(key)}` : `${name} "${key}": English must equal its key`)
    }
    for (const locale of LOCALES) checkLocalization(key, locale, english, entry.localizations[locale], problems)
    for (const [mirror, source] of Object.entries(MIRRORS)) {
      if (JSON.stringify(entry.localizations[mirror]) !== JSON.stringify(entry.localizations[source])) problems.push(`${name} "${key}": ${mirror} must match ${source}`)
    }
    for (const locale of Object.keys(entry.localizations)) if (locale !== 'en' && !LOCALES.includes(locale)) problems.push(`${name} "${key}": ${locale} is not an interface language`)
  }
  return problems
}

const ARGUMENT_TYPES = { lld: 'Int', ld: 'Int', llu: 'Int', lu: 'Int', d: 'Int', i: 'Int', u: 'Int', '@': 'String', lf: 'Double', f: 'Double' }

/** The Swift symbol Xcode makes for a catalog key when it generates String Catalog symbols, as far as two can
 * collide: its letters and digits in any case, without its placeholders, and the types of the arguments they become.
 * A key with no placeholders is a static property, and one with placeholders a function, which may share its name
 * with a property or with a function of other arguments ("Editing" and "Editing %@", "%@ MB" and "%lld MB"). */
export function symbolOf(key) {
  const name = key.replace(/%(?:\d+\$)?(?:lld|ld|llu|lu|d|i|u|@|lf|f)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
  const types = placeholders(key).map(p => ARGUMENT_TYPES[p[1]])
  return { name, signature: types.length ? `${name}(${types.join(', ')})` : name }
}

/** Keys in one catalog that Xcode would give the same symbol, which fails the build: "Merged" and "merged",
 * "Sending" and "Sending…", "Remove %@" and "Remove %@?". Give one of them a key of its own, with its English as
 * the defaultValue. */
export function checkSymbols(catalog, name) {
  const problems = [], seen = new Map()
  for (const key of Object.keys(catalog.strings ?? {})) {
    const { name: symbol, signature } = symbolOf(key)
    if (!symbol) { problems.push(`${name} "${key}": has no letters or digits to name its symbol; give it a key of its own`); continue }
    const other = seen.get(signature)
    if (other === undefined) seen.set(signature, key)
    else problems.push(`${name} "${key}": Xcode would generate the same symbol as "${other}"; give one a key of its own, with its English as defaultValue`)
  }
  return problems
}

/** Everything: the keys in the code, the catalogs that hold them, and the Info.plist strings. */
export function check(root = IOS) {
  const problems = [], prose = [], used = {}
  for (const [name, { path, sources }] of Object.entries(CATALOGS)) {
    used[name] = new Map()
    for (const directory of sources) {
      for (const file of swiftFiles(join(root, directory))) {
        const result = scanFile(relative(root, file).replaceAll('\\', '/'), readFileSync(file, 'utf8'))
        problems.push(...result.problems)
        prose.push(...result.prose)
        for (const key of result.keys) {
          const known = used[name].get(key.key)
          if (known) {
            known.where.push(key.where); known.comment ??= key.comment; known.expressions.push(...key.expressions)
            if (known.english !== key.english) problems.push(`${key.where}: "${key.key}" has another English at ${known.where[0]}`)
          } else used[name].set(key.key, { ...key, where: [key.where] })
        }
      }
    }
    const catalogPath = join(root, path)
    if (!existsSync(catalogPath)) { problems.push(`${path}: missing`); continue }
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
    const defaults = new Map([...used[name]].filter(([, u]) => u.english !== undefined).map(([key, u]) => [key, u.english]))
    problems.push(...checkCatalog(catalog, path, defaults))
    problems.push(...checkSymbols(catalog, path))
    for (const key of used[name].keys()) if (!catalog.strings[key]) problems.push(`${path}: missing "${key}" (${used[name].get(key).where[0]})`)
    for (const key of Object.keys(catalog.strings)) if (!used[name].has(key)) problems.push(`${path}: "${key}" is no longer used; remove it`)
  }
  const infoPath = join(root, INFO_PLIST_CATALOG)
  if (!existsSync(infoPath)) problems.push(`${INFO_PLIST_CATALOG}: missing`)
  else {
    const catalog = JSON.parse(readFileSync(infoPath, 'utf8'))
    problems.push(...checkCatalog({ ...catalog, strings: Object.fromEntries(Object.entries(catalog.strings).map(([key, entry]) => [unitValue(entry.localizations.en) ?? key, { ...entry, localizations: { ...entry.localizations } }])) }, INFO_PLIST_CATALOG)
      .filter(problem => !problem.includes('English must equal its key')))
    const plist = readFileSync(join(root, 'Sotto/Info.plist'), 'utf8')
    for (const key of Object.keys(catalog.strings)) {
      const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)
      if (!m) problems.push(`${INFO_PLIST_CATALOG}: Info.plist has no ${key}`)
      else if (m[1].replace(/&apos;/g, "'") !== unitValue(catalog.strings[key].localizations.en)) problems.push(`${INFO_PLIST_CATALOG}: English ${key} differs from Info.plist`)
    }
  }
  return { problems, prose, used }
}

function main() {
  const args = process.argv.slice(2)
  const { problems, prose, used } = check()
  if (args[0] === '--keys') {
    const out = {}
    for (const [name, keys] of Object.entries(used)) out[name] = [...keys.values()].map(({ key, comment, where }) => ({ key, comment, where }))
    writeFileSync(args[1], JSON.stringify(out, null, 2) + '\n')
    console.log(`Wrote ${Object.values(out).reduce((n, keys) => n + keys.length, 0)} keys to ${args[1]}`)
    return
  }
  if (args[0] === '--interpolations') {
    for (const keys of Object.values(used)) for (const { key, expressions, where } of keys.values()) if (expressions.length) console.log(`${key}\n    ${expressions.join('\n    ')}\n    ${where[0]}`)
    return
  }
  if (args[0] === '--prose') { for (const line of prose) console.log(line); return }
  if (problems.length) {
    for (const problem of problems) console.error(problem)
    console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} in the iPhone app's String Catalogs.`)
    process.exitCode = 1
    return
  }
  const total = Object.values(used).reduce((n, keys) => n + keys.size, 0)
  console.log(`The iPhone app's String Catalogs hold all ${total} keys in ${LOCALES.length} languages besides English.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
