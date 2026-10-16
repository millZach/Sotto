// @vitest-environment node
/**
 * Where main and the headless host copy state. In October 2026 main came to spend most of its time copying: a record
 * copied for every thread on every update, a whole shell rebuilt for a question asked on every change. Each copy looked
 * harmless where it was written. This keeps a committed count of every copy call site per file, so a new one shows up in
 * review: it fails until `tests/fixtures/copySites.json` is rewritten on purpose, and the PR says why the copy is needed
 * and that it does not run on every update. `tests/perf/streamingCopyBudget.perf.test.ts` counts what one update actually
 * copies.
 *
 *   SOTTO_UPDATE_COPY_SITES=1 npx vitest run tests/unit/main/copySites.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(__dirname, '../../..')
const listFile = join(root, 'tests/fixtures/copySites.json')
const folders = ['src/main', 'src/host']
// End-to-end test hooks run only in test builds.
const skipped = ['src/main/e2e/']
const patterns: Record<string, RegExp> = {
  'structuredClone(': /\bstructuredClone\(/g,
  'shell()': /\.shell\(\)/g,
  'watcherRecord()': /\bwatcherRecord\(\)/g,
  'cloneHostSnapshot(': /\bcloneHostSnapshot\(/g,
  'cloneActivitySnapshot(': /\bcloneActivitySnapshot\(/g,
  'JSON round trip': /JSON\.parse\(\s*JSON\.stringify\(/g,
}

function files(folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry => {
    const path = `${folder}/${entry.name}`
    if (entry.isDirectory()) return files(path)
    return entry.name.endsWith('.ts') && !skipped.some(prefix => path.startsWith(prefix)) ? [path] : []
  })
}

/** Comments name these calls too; only code counts. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

function census(): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {}
  for (const path of folders.flatMap(files).sort()) {
    const text = code(readFileSync(join(root, path), 'utf8'))
    for (const [name, pattern] of Object.entries(patterns)) {
      const found = text.match(pattern)?.length ?? 0
      if (found) (counts[relative(root, join(root, path)).split('\\').join('/')] ??= {})[name] = found
    }
  }
  return counts
}

it('copies state only where the committed list says it does', () => {
  const now = census()
  if (process.env.SOTTO_UPDATE_COPY_SITES === '1') writeFileSync(listFile, `${JSON.stringify(now, null, 2)}\n`)
  const listed = JSON.parse(readFileSync(listFile, 'utf8')) as Record<string, Record<string, number>>
  const changes: string[] = []
  for (const path of [...new Set([...Object.keys(now), ...Object.keys(listed)])].sort()) {
    for (const name of Object.keys(patterns)) {
      const was = listed[path]?.[name] ?? 0, is = now[path]?.[name] ?? 0
      if (is > was) changes.push(`${path} now has ${is} ${name} where the list allows ${was}. Copying on a path that runs on every update is what made main lag; if this copy runs only for a command or a read, rewrite the list and say why in the PR.`)
      else if (is < was) changes.push(`${path} now has ${is} ${name} where the list has ${was}. Good: rewrite the list so the lower count holds.`)
    }
  }
  expect(changes, `${changes.join('\n')}\n\nRewrite the list with: SOTTO_UPDATE_COPY_SITES=1 npx vitest run tests/unit/main/copySites.test.ts`).toEqual([])
})
