// @vitest-environment node
/*
 * The iPhone app speaks the iPhone's language from String Catalogs (ADR-0123). Only the macOS job compiles the
 * app, so the catalogs are checked here, on every pull request: every key the Swift code localizes is in its
 * catalog, nothing stale stays, every language has every key, and each translation carries English's placeholders
 * and its language's plural forms. Run the same check by hand with `node apps/ios/Scripts/check-strings.mjs`.
 */
import { describe, expect, it } from 'vitest'
import { check, lexSwift, samePlaceholders, scanFile, specifierFor } from '../../../apps/ios/Scripts/check-strings.mjs'

describe('the iPhone string catalogs', () => {
  it('hold every key the Swift code localizes, in every language', () => {
    const { problems } = check()
    expect(problems).toEqual([])
  })
})

describe('reading Swift', () => {
  it('turns interpolations into the specifiers Swift writes', () => {
    const source = 'let count = items.count\nlet name = host.name\nlet s = String(localized: "\\(name) has \\(count) threads")\n'
    expect(scanFile('Sotto/X.swift', source).keys.map(k => k.key)).toEqual(['%@ has %lld threads'])
  })

  it('reads a key inside SwiftUI initializers and its comment', () => {
    const { keys } = scanFile('Sotto/X.swift', 'Text("Open", comment: "Opens the thread")\nButton("Try again") {}\n')
    expect(keys.map(k => [k.key, k.comment])).toEqual([['Open', 'Opens the thread'], ['Try again', undefined]])
  })

  it('flags a literal that a ternary makes a String', () => {
    const { problems } = scanFile('Sotto/X.swift', 'Text(flag ? "Working" : "Idle")\n')
    expect(problems).toHaveLength(2)
  })

  it('leaves Text(verbatim:) and comments alone', () => {
    const { keys, problems } = scanFile('Sotto/X.swift', '// Text("Not this")\nText(verbatim: title ?? "Untitled")\n')
    expect(keys).toEqual([])
    expect(problems).toEqual([])
  })

  it('reads a key of its own with the English as its default value', () => {
    const { keys, problems } = scanFile('Sotto/X.swift', 'let s = String(localized: "agent-row.open", defaultValue: "Open", comment: "Expanded")\n')
    expect(keys.map(k => [k.key, k.english, k.comment])).toEqual([['agent-row.open', 'Open', 'Expanded']])
    expect(problems).toEqual([])
  })

  it('wants a default value to carry its key\'s placeholders', () => {
    const { problems } = scanFile('Sotto/X.swift', 'let s = String(localized: "row.count", defaultValue: "\\(n) rows")\n')
    expect(problems[0]).toContain('same placeholders')
  })

  it('asks SottoCore for its own bundle', () => {
    const { problems } = scanFile('Sources/SottoCore/X.swift', 'let s = String(localized: "Online")\n')
    expect(problems[0]).toContain('bundle: .module')
  })

  it('reads nested strings inside an interpolation', () => {
    const { literals } = lexSwift('let s = "a \\(x ?? "b") c"\n')
    expect(literals.map(l => l.segments.map(s => s.text ?? `{${s.expr}}`).join(''))).toEqual(['a {x ?? "b"} c', 'b'])
  })

  it('reads counts as numbers and everything else as text', () => {
    expect(specifierFor('threads.count')).toBe('%lld')
    expect(specifierFor('n - 1')).toBe('%lld')
    expect(specifierFor('model.name(hostID)')).toBe('%@')
  })
})

describe('placeholders', () => {
  it('match in order, or by position when a language reorders them', () => {
    expect(samePlaceholders('%@ on %@ has %lld', '%@ sur %@ a %lld')).toBe(true)
    expect(samePlaceholders('%@ on %@ has %lld', '%3$lld: %2$@, %1$@')).toBe(true)
    expect(samePlaceholders('%@ has %lld', '%lld has %@')).toBe(false)
    expect(samePlaceholders('%@ has %lld', '%@ has')).toBe(false)
    expect(samePlaceholders('%lld threads', 'محادثتان', { mayOmit: true })).toBe(true)
  })
})
