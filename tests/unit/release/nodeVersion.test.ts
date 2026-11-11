// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
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
// The manual launch benchmark is separate from those counts: it measures each revision with that revision's pin.
describe('the pinned Node version', () => {
  const workflows = readdirSync('.github/workflows').filter(name => /\.ya?ml$/u.test(name))

  it('is a full version', () => { expect(PINNED_NODE).toMatch(/^\d+\.\d+\.\d+$/u) })

  it('reads a version however a workflow writes it', () => {
    expect(namedNodeVersions(["  node-version: '24.22.1'", '  node-version: 26.8.1 # newer', '  node-version: "${{ matrix.node }}"', '  node-version-file: .nvmrc'].join('\n')))
      .toEqual(['24.22.1', '26.8.1', '${{ matrix.node }}', 'file:.nvmrc'])
  })

  it('is installed by some workflow', () => {
    expect(workflows.flatMap(name => namedNodeVersions(readFileSync(join('.github/workflows', name), 'utf8')))).toContain(PINNED_NODE)
  })

  it('reads each launch benchmark revision’s pin, falling back to the suite pin only when absent', () => {
    const workflow = parse(readFileSync('.github/workflows/launch-time.yml', 'utf8')) as {
      jobs: { launch: { steps: { id?: string; uses?: string; run?: string; with?: { 'node-version'?: string } }[] } }
    }
    const steps = workflow.jobs.launch.steps
    const choose = steps.find(step => step.id === 'node')?.run ?? ''
    expect(choose).toContain('if [ -f "$1/.node-version" ]')
    expect(choose).toContain('tr -d \'[:space:]\' < "$1/.node-version"')
    expect(choose).toContain(`else echo ${PINNED_NODE};`)
    expect(choose).toContain('echo "change=$(pick .)" >> "$GITHUB_OUTPUT"')
    expect(choose).toContain('echo "base=$(pick "$RUNNER_TEMP/base")" >> "$GITHUB_OUTPUT"')
    expect(steps.filter(step => step.uses?.startsWith('actions/setup-node@')).map(step => step.with?.['node-version']))
      .toEqual(['${{ steps.node.outputs.base }}', '${{ steps.node.outputs.change }}'])
  })

  it.each(workflows)('uses a declared Node pin for every install in %s', name => {
    const workflow = readFileSync(join('.github/workflows', name), 'utf8')
    const versions = namedNodeVersions(workflow)
    const revisionPins = name === 'launch-time.yml' ? ['${{ steps.node.outputs.base }}', '${{ steps.node.outputs.change }}'] : []
    expect(versions.filter(version => version !== PINNED_NODE && version !== 'file:.node-version' && !revisionPins.includes(version)), `${name} installs another Node than .node-version`).toEqual([])
    // A setup-node step that names no version installs whatever the runner has.
    expect(versions, `${name} has a setup-node step that names no version`).toHaveLength([...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*actions\/setup-node@/gmu)].length)
  })
})
