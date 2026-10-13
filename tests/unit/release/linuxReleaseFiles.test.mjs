// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearLinuxFinishOutputs, readLinuxPackageInputs, readLinuxPromotion } from '../../../scripts/linux-release-files.mjs'
import { cleanStableCheckout as checkout, stableReleaseRecord as promotion } from '../../fixtures/stableReleaseFixture.mjs'
import { withStableManifestGuard } from '../../../scripts/stable-package.mjs'

const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-release-files-'))
  roots.push(root)
  return root
}

describe('Linux finish output lifecycle', () => {
  it('removes old and partially written finish outputs while keeping inputs and other platforms', async () => {
    const root = await fixture()
    const removed = ['PKGBUILD', '.SRCINFO', 'SHA256SUMS.txt', 'linux-release-verification.json',
      'sotto-bin-0.1.37-2-x86_64.pkg.tar.zst', 'sotto-bin-0.1.38-1-x86_64.pkg.tar.zst']
    const kept = ['linux-desktop-package.json', 'stable-promotion.json', 'Sotto-0.1.38-linux-x64.tar.gz',
      'Sotto Setup 0.1.38.exe', 'latest.yml', 'Sotto-host-0.1.38-linux-x64.tar.gz']
    for (const name of [...removed, ...kept]) await writeFile(join(root, name), name)
    await mkdir(join(root, 'archive'))
    await writeFile(join(root, 'archive', removed[4]), 'archived')
    await clearLinuxFinishOutputs(root)
    expect((await readdir(root)).sort()).toEqual([...kept, 'archive'].sort())
    expect(await readFile(join(root, 'archive', removed[4]), 'utf8')).toBe('archived')
    // A failed move of a new bundle must also invalidate its partially present metadata.
    await writeFile(join(root, 'PKGBUILD'), 'new partial recipe')
    await clearLinuxFinishOutputs(root)
    expect((await readdir(root)).sort()).toEqual([...kept, 'archive'].sort())
  })
  it('works before a release directory exists and on a second cleanup', async () => {
    const root = await fixture()
    await clearLinuxFinishOutputs(join(root, 'absent'))
    await clearLinuxFinishOutputs(root)
    await clearLinuxFinishOutputs(root)
  })
  it('guides a missing receipt, malformed JSON and missing tarball to packaging again', async () => {
    const root = await fixture()
    await expect(readLinuxPackageInputs(root, '0.1.38')).rejects.toThrow('Run the matching Linux packaging command again')
    await writeFile(join(root, 'linux-desktop-package.json'), '{')
    await expect(readLinuxPackageInputs(root, '0.1.38')).rejects.toThrow('Run the matching Linux packaging command again')
    await writeFile(join(root, 'linux-desktop-package.json'), JSON.stringify({ version: '0.1.38' }))
    await expect(readLinuxPackageInputs(root, '0.1.38')).rejects.toThrow('Run the matching Linux packaging command again')
    await writeFile(join(root, 'Sotto-0.1.38-linux-x64.tar.gz'), 'test archive')
    const inputs = await readLinuxPackageInputs(root, '0.1.38')
    expect(inputs.receipt.version).toBe('0.1.38')
    expect(inputs.archiveHash).toMatchObject({ bytes: 12, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
  })
  it('rereads the checked promotion and refuses a changed release check even at the same clean source', async () => {
    const root = await fixture()
    await expect(readLinuxPromotion(root, checkout)).rejects.toThrow('Run npm run package:linux:stable')
    await writeFile(join(root, 'stable-promotion.json'), JSON.stringify(promotion))
    expect(await readLinuxPromotion(root, checkout, promotion)).toEqual(promotion)
    await writeFile(join(root, 'stable-promotion.json'), JSON.stringify({ ...promotion, checkedAt: '2026-10-13T12:00:00Z' }))
    await expect(readLinuxPromotion(root, checkout, promotion)).rejects.toThrow('release check changed')
    await expect(readLinuxPromotion(root, { ...checkout, clean: false })).rejects.toThrow('uncommitted changes')
  })
  it('refuses branch-only sources, missing or red CI and a stable version already published', async () => {
    const root = await fixture()
    await writeFile(join(root, 'stable-promotion.json'), JSON.stringify(promotion))
    await expect(readLinuxPromotion(root, { ...checkout, onMain: false })).rejects.toThrow('not on origin/main')
    for (const checks of [[], [{ ...promotion.checks[0], conclusion: 'failure' }, promotion.checks[1]]]) {
      await writeFile(join(root, 'stable-promotion.json'), JSON.stringify({ ...promotion, checks }))
      await expect(readLinuxPromotion(root, checkout)).rejects.toThrow('CI check')
    }
    await writeFile(join(root, 'stable-promotion.json'), JSON.stringify({ ...promotion, explicitVersion: true, stableVersion: promotion.latestStableVersion }))
    await expect(readLinuxPromotion(root, checkout)).rejects.toThrow('not newer')
  })
})

describe('stable manifest guard failures', () => {
  it('retains the original packaging error when the manifests are unchanged', async () => {
    const original = new Error('native rebuild failed')
    await expect(withStableManifestGuard(async () => { throw original }, async () => {})).rejects.toBe(original)
  })
  it('reports both failures when a failed package attempt changes a real manifest', async () => {
    const root = await fixture()
    const path = join(root, 'package.json')
    await writeFile(path, 'original')
    const original = new Error('native rebuild failed'), changed = new Error('source manifest changed')
    const result = await withStableManifestGuard(async () => {
      await writeFile(path, 'changed')
      throw original
    }, async () => { if (await readFile(path, 'utf8') !== 'original') throw changed }).catch(error => error)
    expect(result).toBeInstanceOf(AggregateError)
    expect(result.errors).toEqual([original, changed])
  })
  it('still refuses manifest changes after an otherwise successful package attempt', async () => {
    const changed = new Error('source manifest changed')
    await expect(withStableManifestGuard(async () => 'packaged', async () => { throw changed })).rejects.toBe(changed)
    await expect(withStableManifestGuard(async () => 'packaged', async () => {})).resolves.toBe('packaged')
  })
})
