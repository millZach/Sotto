// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PINNED_NODE } from '../../fixtures/pinnedNode'

// `.node-version` is the one place the suite's Node version is written for a person or a version manager to read.
// Each workflow names its own, since a job may install Node before it checks the repository out; this holds every one
// of them to the file, so the counts a local run takes are the counts CI takes (#2339).
describe('the pinned Node version', () => {
  const workflows = readdirSync('.github/workflows').filter(name => name.endsWith('.yml'))

  it('is a full version', () => { expect(PINNED_NODE).toMatch(/^\d+\.\d+\.\d+$/u) })

  it.each(workflows)('is the one %s installs', name => {
    const versions = [...readFileSync(join('.github/workflows', name), 'utf8').matchAll(/^\s*node-version:\s*['"]?([^'"\s]+)['"]?\s*$/gmu)].map(match => match[1])
    expect(versions.filter(version => version !== PINNED_NODE), `${name} installs another Node than .node-version`).toEqual([])
  })
})
