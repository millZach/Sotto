// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const source = await readFile(resolve(import.meta.dirname, '../../../.github/workflows/owl-linux.yml'), 'utf8')
const workflow = parse(source)
const { package: packageJob, pacman, attest } = workflow.jobs
const indexIn = steps => name => {
  const found = steps.findIndex(step => step.name === name)
  if (found < 0) throw new Error(`No step named ${name}`)
  return found
}
const inPackage = indexIn(packageJob.steps), inPacman = indexIn(pacman.steps)

describe('Sotto Owl for Linux workflow (ADR-0099)', () => {
  it('runs only by hand or from the nightly, one build per version, and is named for what it builds', () => {
    expect(workflow.name).toBe('Sotto Owl for Linux')
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'workflow_call'])
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual(['source', 'version'])
    expect(Object.keys(workflow.on.workflow_call.inputs).sort()).toEqual(['source', 'version'])
    expect(workflow.on.workflow_call.secrets).toBeUndefined()
    expect(workflow.concurrency).toEqual({ group: 'owl-linux-${{ inputs.version }}', 'cancel-in-progress': false })
    expect(Object.keys(workflow.jobs)).toEqual(['package', 'pacman', 'attest'])
  })
  it('reads no secrets, uses no environment, and gives write scopes only to the attesting job', () => {
    expect(source).not.toMatch(/secrets\./u)
    expect(workflow.permissions).toEqual({ 'contents': 'read' })
    for (const job of Object.values(workflow.jobs)) expect(job.environment).toBeUndefined()
    expect(packageJob.permissions).toEqual({ contents: 'read' })
    expect(pacman.permissions).toEqual({ contents: 'read' })
    expect(attest.permissions).toEqual({ 'contents': 'read', 'id-token': 'write', 'attestations': 'write' })
    // Inputs reach scripts only through the environment.
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps) expect(step.run ?? '').not.toMatch(/\$\{\{/u)
  })
  it('builds only a source in the history of the branch it was started from, checked before npm ci in both building jobs', () => {
    for (const [job, index] of [[packageJob, inPackage], [pacman, inPacman]]) {
      const history = job.steps[index("Check out this branch's history")]
      const check = index("Check out the source commit, if this branch's history holds it")
      expect(history.with).toMatchObject({ ref: '${{ github.sha }}', 'fetch-depth': 0, 'persist-credentials': false })
      expect(job.steps.filter(step => step.uses?.startsWith('actions/checkout@'))).toEqual([history])
      expect(job.steps[check].run).toContain('git merge-base --is-ancestor "$SOURCE" "$GITHUB_SHA"')
      expect(job.steps[check].run).toContain('Nothing was built.')
      expect(job.steps[check].run.indexOf('--is-ancestor')).toBeLessThan(job.steps[check].run.indexOf('git checkout'))
      expect(index("Check out this branch's history")).toBe(check - 1)
      expect(check).toBeLessThan(index('Set up Node.js'))
      expect(check).toBeLessThan(index('Install dependencies'))
      expect(index('Check the version and source commit')).toBeLessThan(check)
    }
  })
  it('packages on Ubuntu under a virtual display, with Chromium\'s sandbox on rather than turned off', () => {
    expect(packageJob['runs-on']).toBe('ubuntu-24.04')
    const display = packageJob.steps[inPackage('Install a virtual display and Electron\'s libraries')].run
    expect(display).toContain('xvfb')
    expect(packageJob.steps[inPackage('Let Chromium\'s sandbox start')].run).toBe('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0')
    const pack = packageJob.steps[inPackage('Package and verify the Linux Owl')]
    expect(pack.run).toBe('xvfb-run -a npm run package:owl -- --version "$VERSION" --source "$SOURCE"')
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        expect(step.run ?? '').not.toContain('--no-sandbox')
        expect(step.run ?? '').not.toContain('with-nested-hyprland')
      }
    }
    expect(inPackage('Download Electron')).toBeLessThan(inPackage('Package and verify the Linux Owl'))
    expect(inPackage('Let Chromium\'s sandbox start')).toBeLessThan(inPackage('Package and verify the Linux Owl'))
  })
  it('builds the pacman package in a pinned Arch container, as a user other than root', () => {
    expect(pacman.needs).toBe('package')
    expect(pacman.container.image).toMatch(/^archlinux:base-devel@sha256:[a-f0-9]{64}$/u)
    const build = pacman.steps[inPacman('Build and check the pacman package')].run
    expect(build).toMatch(/^sudo -u builder /u)
    expect(build).toContain('node scripts/package-owl-linux-pacman.mjs --version "$VERSION" --source "$SOURCE" --tarball owl-linux-tarball --out owl-linux')
    expect(pacman.steps[inPacman('Make the builder user')].run).toContain('useradd')
    expect(inPacman('Make the builder user')).toBeLessThan(inPacman('Build and check the pacman package'))
    expect(inPacman('Install the recipe\'s dependencies')).toBeLessThan(inPacman('Build and check the pacman package'))
    expect(pacman.steps[inPacman('Install dependencies')].run).toBe('npm ci --ignore-scripts')
  })
  it('keeps every Linux Owl file, the hidden .SRCINFO included, for two weeks', () => {
    const keep = pacman.steps[inPacman('Retain the Linux Owl files')]
    expect(keep.uses).toMatch(/^actions\/upload-artifact@/u)
    expect(keep.with).toMatchObject({ name: 'sotto-owl-linux-${{ inputs.version }}', path: 'owl-linux/', 'include-hidden-files': true, 'if-no-files-found': 'error', 'retention-days': 14 })
  })
  it('attests the tarball and pacman package in a job that runs nothing from the checkout', () => {
    expect(attest.needs).toBe('pacman')
    expect(attest.steps.some(step => step.uses?.startsWith('actions/checkout@'))).toBe(false)
    const name = attest.steps.find(step => step.name === 'Name the files to attest').run
    expect(name).toContain('tarball.files?.tarball?.filename'); expect(name).toContain('pacman.files?.pacman?.filename')
    const attestation = attest.steps.find(step => step.uses?.startsWith('actions/attest-build-provenance@'))
    expect(attestation.with['subject-path']).toBe('${{ steps.files.outputs.attest }}')
  })
})
