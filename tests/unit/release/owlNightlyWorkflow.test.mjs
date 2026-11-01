// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const source = await readFile(resolve(import.meta.dirname, '../../../.github/workflows/owl-nightly.yml'), 'utf8')
const workflow = parse(source)
const { jobs } = workflow
const step = (job, name) => {
  const found = jobs[job].steps.findIndex(candidate => candidate.name === name)
  if (found < 0) throw new Error(`No step named ${name} in ${job}`)
  return found
}
const building = ['windows', 'linux-host']

describe('Sotto Owl nightly workflow (ADR-0072, November 1, 2026)', () => {
  it('runs at midnight UTC and by hand, one at a time, as a dry run unless publish is ticked', () => {
    expect(workflow.name).toBe('Sotto Owl nightly')
    expect(workflow.on.schedule).toEqual([{ cron: '0 0 * * *' }])
    expect(workflow.on.workflow_dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    expect(workflow.concurrency).toEqual({ group: 'owl-nightly', 'cancel-in-progress': false })
    expect(jobs.decide.steps[step('decide', 'Apply the skip rules and choose the version')].env.PUBLISH)
      .toBe("${{ github.event_name == 'schedule' || inputs.publish == true }}")
  })
  it('builds nothing unless the decision says so, and publishes only when it says to publish', () => {
    for (const job of ['windows', 'mac', 'linux', 'linux-host']) {
      expect(jobs[job].needs).toBe('decide')
      expect(jobs[job].if).toBe("needs.decide.outputs.build == 'true'")
    }
    expect(jobs.publish.if).toBe("needs.decide.outputs.publish == 'true'")
    expect(jobs.site.needs).toEqual(['decide', 'publish'])
  })
  it('builds the Mac and Linux halves with their own workflows, from the same version and commit', () => {
    expect(jobs.mac.uses).toBe('./.github/workflows/owl-mac.yml')
    expect(jobs.linux.uses).toBe('./.github/workflows/owl-linux.yml')
    for (const job of ['mac', 'linux']) {
      expect(jobs[job].with).toEqual({ version: '${{ needs.decide.outputs.version }}', source: '${{ needs.decide.outputs.source }}' })
      // Only the Mac call inherits: its signing secrets sit in the owl-mac environment, which admits only main.
      expect(jobs[job].secrets).toBe(job === 'mac' ? 'inherit' : undefined)
      expect(jobs[job].permissions).toEqual({ contents: 'read', 'id-token': 'write', attestations: 'write' })
    }
  })
  it('packages the Windows Owl with the same pinned command as by hand, from a source in this branch\'s history', () => {
    expect(jobs.windows['runs-on']).toBe('windows-latest')
    expect(jobs.windows.steps[step('windows', 'Package and verify the Windows Owl')].run).toBe('npm run package:owl -- --version "$VERSION" --source "$SOURCE"')
    for (const job of building) {
      const check = jobs[job].steps[step(job, "Check out the source commit, if this branch's history holds it")].run
      expect(check).toContain('git merge-base --is-ancestor "$SOURCE" "$GITHUB_SHA"')
      expect(step(job, "Check out the source commit, if this branch's history holds it")).toBeLessThan(step(job, 'Install dependencies'))
      expect(step(job, 'Check the version and source commit')).toBeLessThan(step(job, "Check out this branch's history"))
    }
    expect(jobs['linux-host'].steps[step('linux-host', 'Run the socket contract')].run).toBe('npm run test:socket')
    expect(step('linux-host', 'Run the socket contract')).toBeLessThan(step('linux-host', 'Package and verify the Linux host archive'))
  })
  it('opens every platform\'s downloaded installer on a fresh runner before anything is verified for publishing', () => {
    expect(jobs['launch-windows'].needs).toEqual(['decide', 'windows'])
    expect(jobs['launch-mac'].needs).toEqual(['decide', 'mac'])
    expect(jobs['launch-linux'].needs).toEqual(['decide', 'linux'])
    expect(jobs['launch-windows'].steps[step('launch-windows', 'Install the Windows Owl silently')].run).toContain("-ArgumentList '/S'")
    expect(jobs['launch-mac'].steps[step('launch-mac', 'Copy Sotto.app out of the disk image')].run).toContain('spctl --assess')
    expect(jobs['launch-linux'].steps[step('launch-linux', 'Open the Linux Owl and wait for its window')].run).toMatch(/^xvfb-run -a node tools\/verify-owl-package\.mjs "\$VERSION" --app "\$OWL_APP"/u)
    for (const job of ['launch-windows', 'launch-mac', 'launch-linux']) {
      expect(jobs[job].steps.some(candidate => /--no-sandbox/u.test(candidate.run ?? ''))).toBe(false)
      expect(jobs.assemble.needs).toContain(job)
    }
  })
  it('runs release:owl\'s checks on Windows against a clean source checkout before gathering the release', () => {
    expect(jobs.assemble['runs-on']).toBe('windows-latest')
    expect(jobs.assemble.needs).toEqual(['decide', 'windows', 'mac', 'linux', 'linux-host', 'launch-windows', 'launch-mac', 'launch-linux'])
    const gather = jobs.assemble.steps[step('assemble', "Verify every platform's files and gather them")].run
    for (const part of ['assemble --root source', '--mac-artifacts release/owl-mac', '--linux-artifacts release/owl-linux', 'darwin-arm64.tar.gz', 'linux-x64.tar.gz']) expect(gather).toContain(part)
  })
  it('gives write scopes only to attesting, and the release token only to publishing and the site check', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    for (const [name, job] of Object.entries(jobs)) {
      if (['mac', 'linux', 'attest'].includes(name)) continue
      for (const scope of Object.values(job.permissions ?? {})) expect(scope).not.toBe('write')
    }
    expect(jobs.attest.permissions).toEqual({ contents: 'read', 'id-token': 'write', attestations: 'write' })
    const named = new Set([...source.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/gu)].map(match => match[1]))
    expect([...named]).toEqual(['SOTTO_RELEASES_TOKEN'])
    for (const [name, job] of Object.entries(jobs)) {
      const usesSecret = JSON.stringify(job).includes('secrets.')
      expect(usesSecret).toBe(['publish', 'site'].includes(name))
      if (usesSecret) expect(job.environment).toBe('owl-release')
    }
  })
  it('runs nothing from a checkout where it attests or holds the release token', () => {
    for (const job of ['attest', 'publish', 'site']) {
      expect(jobs[job].steps.some(candidate => candidate.uses?.startsWith('actions/checkout@'))).toBe(false)
      expect(jobs[job].steps.some(candidate => /\bnpm\b|\bnode\b/u.test(candidate.run ?? ''))).toBe(false)
    }
  })
  it('passes nothing from an expression straight into a script', () => {
    for (const job of Object.values(jobs)) for (const candidate of job.steps ?? []) expect(candidate.run ?? '').not.toMatch(/\$\{\{/u)
  })
  it('publishes a prerelease that is never Latest, checksums last, after checking every file and the tag is free', () => {
    const publish = jobs.publish.steps[step('publish', 'Publish the prerelease')].run
    expect(publish).toContain('--prerelease --latest=false --notes-file owl-notes.md')
    expect(publish).toContain('git ls-remote --exit-code --tags')
    expect(publish.indexOf('git ls-remote')).toBeLessThan(publish.indexOf('gh release create'))
    expect(publish.indexOf('gh release view "$tag"')).toBeLessThan(publish.indexOf('gh release create'))
    expect(publish.indexOf('gh release create')).toBeLessThan(publish.indexOf('gh release upload "$tag" SHA256SUMS.txt'))
    expect(step('publish', 'Check every file against its checksum and attestation')).toBeLessThan(step('publish', 'Publish the prerelease'))
    expect(step('publish', 'Check the release token')).toBe(0)
    const after = jobs.publish.steps[step('publish', 'Check what was published')].run
    expect(after).toContain('gh release download')
    expect(after).toContain('releases/latest')
  })
  it('checks the site links the new Owl on every platform and deploys it once more if not (#1894)', () => {
    const site = jobs.site.steps[step('site', 'Wait for the site to link the new Owl')].run
    for (const key of ['windows-owl', 'mac-owl', 'linux-owl', 'linux-owl-tar']) expect(site).toContain(key)
    expect(site.match(/gh workflow run deploy-site\.yml/gu)).toHaveLength(1)
    expect(site).toContain('--ref main')
  })
  it('reports every job\'s result, even when one fails', () => {
    expect(jobs.report.if).toBe('always()')
    expect(jobs.report.needs).toEqual(Object.keys(jobs).filter(name => name !== 'report'))
  })
})
