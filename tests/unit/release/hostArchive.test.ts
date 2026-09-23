// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_EXTERNAL_IMPORTS, verifyHostExternalDependencies } from '../../../scripts/release-external-dependencies.mjs'
import { inventoryFiles, sha256, verifyHostArchive } from '../../../scripts/verify-host-archive.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const external = () => ({ version: 1, scope: 'host', imports: [...HOST_EXTERNAL_IMPORTS], dynamicImports: [] as string[] })
async function seal(root: string) {
  const artifacts = (await inventoryFiles(root)).filter(file => file.path !== 'build-provenance.json')
  await writeFile(join(root, 'build-provenance.json'), JSON.stringify({ version: 1, sourceCommit: 'a'.repeat(40), buildInputsRevision: 'b'.repeat(64), artifacts, buildSha256: sha256(JSON.stringify(artifacts)) }))
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-manifest-')); roots.push(root)
  const dependencies = { zod: '4.4.3' }
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ version: '1.0.0', type: 'commonjs', main: 'host/index.js', engines: { node: '>=24 <25' }, dependencies }),
    'runtime-manifest.json': JSON.stringify({ version: 1, kind: 'sotto-host', sottoVersion: '1.0.0', node: '>=24 <25', dependencies }),
    'host/index.js': '/* test artifact */',
    'host/external-dependencies.json': JSON.stringify(external()),
    'host/bundled-dependencies.json': JSON.stringify({ version: 1, packages: [] }),
    'node_modules/zod/package.json': JSON.stringify({ version: '4.4.3' }),
    'node_modules/zod/LICENSE': 'MIT test fixture',
    'LICENSE.md': 'Sotto test fixture',
    'THIRD_PARTY_NOTICES.md': 'zod test fixture',
  }
  for (const [file, value] of Object.entries(files)) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), value) }
  await seal(root)
  return root
}

describe('headless host release boundary', () => {
  it('accepts a complete matching manifest and artifact inventory', async () => {
    expect((await verifyHostArchive(await fixture())).manifest.sottoVersion).toBe('1.0.0')
  })
  it.each(['electron', 'node-pty', 'unexpected-package'])('refuses a new external dependency: %s', name => {
    const inventory = external(); inventory.dynamicImports.push(name)
    expect(() => verifyHostExternalDependencies(inventory, { zod: '4.4.3' })).toThrow('allowlist')
  })
  it('refuses a runtime missing a required Node builtin', () => {
    expect(() => verifyHostExternalDependencies(external(), { zod: '4.4.3' }, ['node:fs'])).toThrow('unavailable')
  })
  it('detects a changed built host', async () => {
    const root = await fixture(); await writeFile(join(root, 'host/index.js'), 'changed')
    await expect(verifyHostArchive(root)).rejects.toThrow('hashes do not match')
  })
  it('detects an unrecorded extra file', async () => {
    const root = await fixture(); await writeFile(join(root, 'private-workspace.json'), 'must never ship')
    await expect(verifyHostArchive(root)).rejects.toThrow('hashes do not match')
  })
  it('refuses an unreviewed transitive dependency', async () => {
    const root = await fixture(); await writeFile(join(root, 'node_modules/zod/package.json'), JSON.stringify({ version: '4.4.3', dependencies: { unseen: '1' } }))
    await seal(root); await expect(verifyHostArchive(root)).rejects.toThrow('closure changed')
  })
  it('refuses native code even when its digest is recorded', async () => {
    const root = await fixture(); await writeFile(join(root, 'node_modules/zod/foreign.node'), 'native binary')
    await seal(root); await expect(verifyHostArchive(root)).rejects.toThrow('native binary')
  })
  it('refuses a changed Node version requirement', async () => {
    const root = await fixture(); const path = join(root, 'runtime-manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.node = '>=18'
    await writeFile(path, JSON.stringify(manifest)); await seal(root)
    await expect(verifyHostArchive(root)).rejects.toThrow('runtime manifest')
  })
})
