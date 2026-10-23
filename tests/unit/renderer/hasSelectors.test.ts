// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(process.cwd(), 'src/renderer')

function stylesheets(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name)
    return entry.isDirectory() ? stylesheets(path) : entry.name.endsWith('.css') ? [path] : []
  })
}

/** `text` split at `separator` wherever it is outside brackets, parentheses and quotes. */
function splitTopLevel(text: string, separator: (char: string) => boolean): string[] {
  const parts: string[] = []
  let depth = 0, quote = '', start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (depth === 0 && separator(char)) { parts.push(text.slice(start, index)); start = index + 1 }
  }
  parts.push(text.slice(start))
  return parts
}

/** Every selector of every style rule, also inside `@media` and `@container`. Keyframe steps come along, harmlessly. */
function selectors(css: string): string[] {
  const found: string[] = []
  let prelude = ''
  for (const char of css.replace(/\/\*[\s\S]*?\*\//gu, '')) {
    if (char === '{') {
      const text = prelude.trim()
      if (text && !text.startsWith('@')) found.push(...splitTopLevel(text, char => char === ',').map(part => part.trim()))
      prelude = ''
    } else if (char === '}' || char === ';') prelude = ''
    else prelude += char
  }
  return found
}

/** The last compound of a complex selector, the part a rule styles. */
function subjectCompound(selector: string): string {
  const compounds = splitTopLevel(selector.replace(/\s*([>+~])\s*/gu, ' '), char => /\s/u.test(char)).filter(Boolean)
  return compounds.at(-1) ?? ''
}

/**
 * Chromium answers a change to the page by restyling every element the last part of a `:has()` rule could style. When
 * that part names no element, class, id or attribute (`:has(...) > *`, `:has(...) > :not(.x)`), that is every element in
 * the window, after any change anywhere (#1423). A `:has()` in the last part itself restyles only what that part names.
 */
function restylesEverything(selector: string): boolean {
  const subject = subjectCompound(selector)
  if (!selector.includes(':has(') || subject.includes(':has(')) return false
  const named = subject.replace(/::?[\w-]+\((?:[^()]|\([^()]*\))*\)/gu, match => match.startsWith(':not(') ? '' : match)
  return !/^[a-z]|[.#[]/iu.test(named)
}

describe(':has() selectors', () => {
  it('finds the selector shape that slowed the whole window', () => {
    expect(restylesEverything(".pill:has(.update-control:not([data-state='idle'])) > :not(.tab)")).toBe(true)
    expect(restylesEverything('.pill:has(.update-control) > *')).toBe(true)
    expect(restylesEverything('.pill:has(.update-control) :not(.tab)')).toBe(true)
    expect(restylesEverything('.pill:has(.update-control) span')).toBe(false)
    expect(restylesEverything('.pill:has(.update-control) > .tab')).toBe(false)
    expect(restylesEverything('.pill:has(.update-control) > :is(.pages, .switch)')).toBe(false)
    expect(restylesEverything(".pill:has(.update-control:not([data-state='idle']))::before")).toBe(false)
    expect(restylesEverything('.view .pane:has(> .questions) > [data-part]')).toBe(false)
    expect(restylesEverything('.pill > :not(.tab)')).toBe(false)
  })

  it('never leaves the part a :has() rule styles naming nothing', () => {
    const offenders = stylesheets(RENDERER).flatMap(path =>
      selectors(readFileSync(path, 'utf8')).filter(restylesEverything).map(selector => `${relative(process.cwd(), path)}: ${selector}`))
    expect(offenders).toEqual([])
  })
})
