// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { releasePlatformProfile } from '../../../scripts/release-platform-profile.mjs'
import { verifyLinuxArchiveContents } from '../../../scripts/verify-linux-tarball.mjs'

const roots = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-tar-test-'))
  roots.push(root)
  const name = 'Sotto-0.1.34-linux-x64'
  const packaged = join(root, name)
  await mkdir(join(packaged, 'resources/runtime'), { recursive: true })
  await writeFile(join(packaged, 'sotto'), 'executable')
  await chmod(join(packaged, 'sotto'), 0o755)
  await writeFile(join(packaged, 'resources/app.asar'), 'asar')
  await writeFile(join(packaged, 'resources/runtime/ort-wasm-simd-threaded.wasm'), 'wasm')
  const archive = join(root, `${name}.tar.gz`)
  const pack = () => execFileSync('tar', ['-czf', `./${name}.tar.gz`, name], { cwd: root })
  return { root, packaged, archive, pack }
}

describe('Linux tarball verification', () => {
  it('extracts the builder layout and verifies every file, including external runtime resources', async () => {
    const { packaged, archive, pack } = await fixture()
    pack()
    await expect(releasePlatformProfile('linux').openDistributable(archive, async (asar, extracted) => {
      expect(asar).toBe(join(extracted, 'resources/app.asar'))
      return verifyLinuxArchiveContents(packaged, extracted)
    })).resolves.toEqual({ filesChecked: 3 })
  })

  it('rejects a tarball missing a required resource even when its ASAR is unchanged', async () => {
    const { packaged, archive, pack } = await fixture()
    await rm(join(packaged, 'resources/runtime/ort-wasm-simd-threaded.wasm'))
    pack()
    await writeFile(join(packaged, 'resources/runtime/ort-wasm-simd-threaded.wasm'), 'wasm')
    await expect(releasePlatformProfile('linux').openDistributable(archive, (_asar, extracted) =>
      verifyLinuxArchiveContents(packaged, extracted))).rejects.toThrow('tarball is missing resources/runtime/ort-wasm-simd-threaded.wasm')
  })

  it('rejects changed executable contents', async () => {
    const { packaged, archive, pack } = await fixture()
    pack()
    await writeFile(join(packaged, 'sotto'), 'changed')
    await expect(releasePlatformProfile('linux').openDistributable(archive, (_asar, extracted) =>
      verifyLinuxArchiveContents(packaged, extracted))).rejects.toThrow('tarball differs at sotto')
  })

  it.skipIf(process.platform === 'win32').each([
    ['file execute', 'sotto', 0o755, 0o750],
    ['file read', 'resources/app.asar', 0o644, 0o640],
    ['file write', 'resources/app.asar', 0o644, 0o664],
    ['directory read', 'resources/runtime', 0o755, 0o751],
    ['directory write', 'resources/runtime', 0o755, 0o775],
    ['directory traverse', 'resources/runtime', 0o755, 0o754],
    ['root directory traverse', '.', 0o755, 0o754],
  ])('rejects changed %s permissions even when contents match', async (_kind, path, expectedMode, archivedMode) => {
    const { packaged, archive, pack } = await fixture()
    const entry = join(packaged, path)
    await chmod(entry, archivedMode)
    try { pack() } finally { await chmod(entry, expectedMode) }
    await expect(releasePlatformProfile('linux').openDistributable(archive, (_asar, extracted) =>
      verifyLinuxArchiveContents(packaged, extracted))).rejects.toThrow(`tarball differs at ${path}`)
  })
})
