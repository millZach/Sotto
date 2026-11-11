// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PINNED_NODE } from '../../fixtures/pinnedNode'

/**
 * Every Node version a workflow file names, read from each `node-version` line whatever follows it: a quoted or bare
 * version, a comment after it, or an expression. A `node-version-file` line is read as the file it names.
 */
export function namedNodeVersions(workflow: string): string[] {
  return [...workflow.matchAll(/^\s*(?:-\s*)?(node-version(?:-file)?)\s*:\s*(.*)$/gmu)].map(([, key, rest]) => {
    const value = rest!.replace(/\s+#.*$/u, '').trim().replace(/^(['"])(.*)\1$/u, '$2')
    return key === 'node-version-file' ? `file:${value}` : value
  })
}

// `.node-version` is the one place the suite's Node version is written for a person or a version manager to read.
// Each workflow names its own, since a job may install Node before it checks the repository out; this holds every one
// of them to the file, so the counts a local run takes are the counts CI takes (#2339). Anything it cannot read as that
// exact version fails: a matrix, an expression or another file would let CI move to a Node the budgets skip on.
/**
 * The workflows that measure two refs side by side, each on the Node its own `.node-version` names, so a base from
 * before a change of version is measured as it shipped. Their setup-node steps name the output of a step that reads the
 * file from each checkout; the test below holds that step to the file and to the pinned version where a ref has none.
 */
const READ_FROM_EACH_CHECKOUT: Record<string, readonly string[]> = {
  'launch-time.yml': ['${{ steps.node.outputs.base }}', '${{ steps.node.outputs.change }}'],
}

describe('the pinned Node version', () => {
  const workflows = readdirSync('.github/workflows').filter(name => /\.ya?ml$/u.test(name))

  it('is a full version', () => { expect(PINNED_NODE).toMatch(/^\d+\.\d+\.\d+$/u) })

  it('reads a version however a workflow writes it', () => {
    expect(namedNodeVersions(["  node-version: '24.22.1'", '  node-version: 26.8.1 # newer', '  node-version: "${{ matrix.node }}"', '  node-version-file: .nvmrc'].join('\n')))
      .toEqual(['24.22.1', '26.8.1', '${{ matrix.node }}', 'file:.nvmrc'])
  })

  it.each(Object.keys(READ_FROM_EACH_CHECKOUT))('is what %s falls back to, and it reads each checkout\'s own file', name => {
    const workflow = readFileSync(join('.github/workflows', name), 'utf8')
    const pick = /pick\(\) \{ if \[ -f "\$1\/\.node-version" \]; then tr -d '\[:space:\]' < "\$1\/\.node-version"; else echo (\S+); fi; \}/u.exec(workflow)
    expect(pick?.[1], `${name} no longer reads .node-version from each checkout the way this test knows`).toBe(PINNED_NODE)
  })

  it('is installed by some workflow', () => {
    expect(workflows.flatMap(name => namedNodeVersions(readFileSync(join('.github/workflows', name), 'utf8')))).toContain(PINNED_NODE)
  })

  it.each(workflows)('is the only one %s installs, at every step that installs Node', name => {
    const workflow = readFileSync(join('.github/workflows', name), 'utf8')
    const versions = namedNodeVersions(workflow)
    const read = READ_FROM_EACH_CHECKOUT[name] ?? []
    expect(versions.filter(version => version !== PINNED_NODE && version !== 'file:.node-version' && !read.includes(version)), `${name} installs another Node than .node-version`).toEqual([])
    // A setup-node step that names no version installs whatever the runner has.
    expect(versions, `${name} has a setup-node step that names no version`).toHaveLength([...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*actions\/setup-node@/gmu)].length)
  })
})
