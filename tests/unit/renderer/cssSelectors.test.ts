// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// A :has() inside another :has() is not valid CSS, and the browser drops the whole rule without a word. #1391's
// floating composer shipped that way and never floated, while every layout test still passed.

const root = join(process.cwd(), 'src')

function stylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? stylesheets(path) : entry.name.endsWith('.css') ? [path] : []
  })
}

/** Each :has() whose argument holds another, as the text of the outer one. Comments and quoted strings are left out. */
function nestedHas(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""')
  const found: string[] = []
  for (let start = text.indexOf(':has('); start !== -1; start = text.indexOf(':has(', start + 1)) {
    let depth = 0
    let end = start + 4
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++
      else if (text[end] === ')' && --depth === 0) break
    }
    const argument = text.slice(start + 5, end)
    if (argument.includes(':has(')) found.push(text.slice(start, end + 1))
  }
  return found
}

describe('stylesheet selectors', () => {
  it('finds a :has() nested in another, however deep, and passes ones side by side', () => {
    expect(nestedHas('.a:has(> .b:not(:has(> .c))) { color: red }')).toHaveLength(1)
    expect(nestedHas('.a:has(> .b):not(:has(> .b > .c)) { color: red }')).toEqual([])
    expect(nestedHas('/* .a:has(.b:has(.c)) */ .a { color: red }')).toEqual([])
    // Brackets and :has( inside a quoted attribute value are text, not selectors.
    expect(nestedHas('.a:has([data-label=":has(.b)"]) { color: red }')).toEqual([])
    expect(nestedHas('.a:has([data-label=")"] :has(.b)) { color: red }')).toHaveLength(1)
    expect(nestedHas(".a:has([data-label='(']) .b:has(.c) { color: red }")).toEqual([])
  })

  it('never nests :has() in any stylesheet', () => {
    const offenders = stylesheets(root).flatMap(path => nestedHas(readFileSync(path, 'utf8')).map(rule => `${relative(root, path)}: ${rule}`))
    expect(offenders).toEqual([])
  })
})
