// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { OWL_MAC_SIGNING_ENVIRONMENT } from '../../../scripts/owl-mac-package.mjs'

const source = await readFile(resolve(import.meta.dirname, '../../../.github/workflows/owl-mac.yml'), 'utf8')
const workflow = parse(source)
const job = workflow.jobs.package
const steps = job.steps
const index = name => {
  const found = steps.findIndex(step => step.name === name)
  if (found < 0) throw new Error(`No step named ${name}`)
  return found
}
const secrets = ['MAC_DEVELOPER_ID_P12', 'MAC_DEVELOPER_ID_P12_PASSWORD', 'APPLE_NOTARY_KEY_P8', 'APPLE_NOTARY_KEY_ID', 'APPLE_NOTARY_ISSUER_ID']

describe('Sotto Owl for Mac workflow signing (ADR-0093)', () => {
  it('runs only by hand, in the owl-mac environment', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(job.environment).toBe('owl-mac')
  })
  it('reads exactly the five owl-mac secrets, and only through a step\'s environment', () => {
    const named = new Set([...source.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/gu)].map(match => match[1]))
    expect([...named].sort()).toEqual([...secrets].sort())
    for (const step of steps) {
      expect(step.run ?? '').not.toMatch(/\$\{\{/u)
      for (const value of Object.values(step.with ?? {})) expect(String(value)).not.toContain('secrets.')
    }
    expect(Object.values(job.env ?? {}).join(' ')).not.toContain('secrets.')
  })
  it('fails with a plain message naming any missing secret before it builds anything', () => {
    const check = steps[index('Check the signing credentials')]
    expect(Object.keys(check.env).sort()).toEqual([...secrets].sort())
    expect(check.run).toContain('Nothing was built.')
    expect(check.run).toContain('docs/release/macos-owl-signing.md')
    expect(index('Check the signing credentials')).toBeLessThan(index('Install dependencies'))
  })
  it('builds only a source in the history of the branch the environment admitted, checked before anything runs', () => {
    const history = steps[index("Check out this branch's history")]
    const source = index("Check out the source commit, if this branch's history holds it")
    expect(history.with).toMatchObject({ ref: '${{ github.sha }}', 'fetch-depth': 0, 'persist-credentials': false })
    expect(steps.filter(step => step.uses?.startsWith('actions/checkout@'))).toEqual([history])
    expect(steps[source].run).toContain('git merge-base --is-ancestor "$SOURCE" "$GITHUB_SHA"')
    expect(steps[source].run).toContain('Nothing was built.')
    expect(steps[source].run.indexOf('--is-ancestor')).toBeLessThan(steps[source].run.indexOf('git checkout'))
    expect(index("Check out this branch's history")).toBe(source - 1)
    expect(source).toBeLessThan(index('Set up Node.js'))
    expect(source).toBeLessThan(index('Install dependencies'))
    expect(source).toBeLessThan(index('Prepare the signing keychain and notary key'))
  })
  it('puts the certificate on the runner only after npm ci, and removes it whatever happens', () => {
    const prepare = index('Prepare the signing keychain and notary key')
    const pack = index('Package, sign, notarize and verify the Mac Owl')
    const remove = index('Remove the signing keychain and notary key')
    expect(index('Install dependencies')).toBeLessThan(prepare)
    expect(index('Download Electron')).toBeLessThan(prepare)
    expect(prepare).toBeLessThan(pack)
    expect(remove).toBe(pack + 1)
    expect(steps[remove].if).toBe('always()')
    expect(steps[remove].run).toContain('security delete-keychain "$RUNNER_TEMP/sotto-owl-signing.keychain-db"')
    expect(steps[remove].run).toContain('rm -rf "$RUNNER_TEMP/sotto-owl-signing"')
    expect(steps[prepare].run).toContain('rm -f "$folder/developer-id.p12"')
  })
  it('hands package:owl every name its signing override requires', () => {
    const prepare = steps[index('Prepare the signing keychain and notary key')].run
    const pack = steps[index('Package, sign, notarize and verify the Mac Owl')]
    const handed = new Set([...prepare.matchAll(/echo "([A-Z_]+)=/gu)].map(match => match[1]))
    for (const name of Object.keys(pack.env)) handed.add(name)
    expect([...handed].sort()).toEqual([...OWL_MAC_SIGNING_ENVIRONMENT].sort())
    expect(pack.run).toBe('npm run package:owl -- --version "$VERSION" --source "$SOURCE"')
  })
  it('keeps a Mac Owl only when its receipt says it is signed, notarized and stapled', () => {
    expect(steps[index('Name the files the receipt lists')].run).toContain('signed, notarized and stapled')
  })
  it('builds the matching Mac host archive with every Owl, after the keychain is gone and the app is kept (#1314)', () => {
    const host = index('Package and verify the Mac host archive')
    const keep = index('Retain the Mac host archive')
    expect(steps[host].run).toBe('npm run package:host:owl -- --version "$VERSION" --source "$SOURCE"')
    expect(steps[host].env).toEqual({ COPYFILE_DISABLE: '1' })
    expect(steps[host].if).toBeUndefined()
    expect(index('Remove the signing keychain and notary key')).toBeLessThan(host)
    expect(index('Retain the Mac Owl files')).toBeLessThan(host)
    expect(keep).toBe(host + 1)
    // Its own artifact: the Mac Owl folder must hold only the files its receipt lists.
    expect(steps[keep].with.name).toBe('sotto-owl-mac-host-${{ inputs.version }}')
    expect(steps[keep].with.name).not.toBe(steps[index('Retain the Mac Owl files')].with.name)
    expect(steps[keep].with.path.trim().split('\n')).toEqual([
      'release/Sotto-host-${{ inputs.version }}-darwin-arm64.tar.gz',
      'release/Sotto-host-${{ inputs.version }}-darwin-arm64.tar.gz.sha256',
    ])
    expect(steps[keep].with['if-no-files-found']).toBe('error')
  })
})
