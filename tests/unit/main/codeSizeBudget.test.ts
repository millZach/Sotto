// @vitest-environment node
/**
 * How much code the coordinator may hold (ADR-0190). `AgentControl` reached about 7,100 lines, and most new behaviour
 * landed in it because it was already there. Each file on `tests/fixtures/codeSizeBudget.json` has a cap in KB, which a
 * pull request that moves code out lowers to the new size plus some room. A raise needs its reason in the PR.
 *
 * The size is characters of code. Counting lines would reward cramming them, and counting comments would reward deleting
 * the ones that say why.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = resolve(__dirname, '../../..')
const caps = JSON.parse(readFileSync(join(root, 'tests/fixtures/codeSizeBudget.json'), 'utf8')) as Record<string, number>

/** Comments are found from the parse, so one written inside a string or a template stays code. */
function codeCharacters(text: string): number {
  const file = ts.createSourceFile('budgeted.ts', text, ts.ScriptTarget.Latest)
  let code = ''
  const visit = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return
    const children = node.getChildren(file)
    if (children.length) { children.forEach(visit); return }
    if (node.pos === node.end) return
    // What comes ahead of a token is only whitespace and comments.
    const start = node.getStart(file)
    code += text.slice(node.pos, start).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '') + text.slice(start, node.end)
  }
  visit(file)
  return code.split('\n').reduce((total, line) => total + line.trim().length, 0)
}

it('counts code, leaving out comments and indentation', () => {
  expect(codeCharacters('/** Why. */\n// Why again.\n    const x = 1 // And again.\n')).toBe('const x = 1'.length)
})

it('counts what looks like a comment inside a string or a template', () => {
  for (const line of ['const a = "x // kept"', 'const b = `x /* kept */ ${a}`', 'const c = ["/*", a, "*/"]']) {
    expect(codeCharacters(`${line}\n`)).toBe(line.length)
  }
})

it('keeps every listed file within its cap', () => {
  const over: string[] = []
  for (const [path, cap] of Object.entries(caps)) {
    const file = join(root, path)
    if (!existsSync(file)) { over.push(`${path} is on the list but is gone. Give what replaced it a cap.`); continue }
    const kb = codeCharacters(readFileSync(file, 'utf8')) / 1024
    if (kb > cap) over.push(`${path} holds ${kb.toFixed(1)} KB of code, over its cap of ${cap} KB. Move code out along a seam (docs/plans/2026-11-04-split-agent-control.md).`)
  }
  expect(over).toEqual([])
})
