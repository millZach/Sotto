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
})
