import { readdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileSha256 } from './release-provenance.mjs'
import { checkedPromotion, stablePackagePlan } from './stable-package.mjs'

const metadata = ['linux-release-verification.json', 'PKGBUILD', '.SRCINFO', 'SHA256SUMS.txt']

/** Invalidate the completion marker first; preserve tarballs, archives and other platforms. */
export async function clearLinuxFinishOutputs(release) {
  await rm(join(release, metadata[0]), { force: true })
  let names
  try { names = await readdir(release) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const name of names) {
    if (metadata.includes(name) || /^sotto-bin-\d+\.\d+\.\d+-\d+-x86_64\.pkg\.tar\.zst$/u.test(name)) {
      await rm(join(release, name), { force: true })
    }
  }
}

export async function readLinuxPackageInputs(release, version) {
  const tarball = join(release, basename(stablePackagePlan('linux', version).installer))
  try {
    const receipt = JSON.parse(await readFile(join(release, 'linux-desktop-package.json'), 'utf8'))
    return { receipt, tarball, archiveHash: await fileSha256(tarball) }
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      throw new Error('The checked Linux tarball or packaging record is missing or unreadable. Run the matching Linux packaging command again.', { cause: error })
    }
    throw error
  }
}

export async function readLinuxPromotion(release, checkout, expected) {
  let saved
  try { saved = JSON.parse(await readFile(join(release, 'stable-promotion.json'), 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) throw new Error('The stable release check is missing or unreadable. Run npm run package:linux:stable before finishing the Linux release.', { cause: error })
    throw error
  }
  const promotion = checkedPromotion(saved, checkout)
  if (expected && JSON.stringify(promotion) !== JSON.stringify(expected)) {
    throw new Error('The stable release check changed during the Linux release. Run npm run package:linux:stable again.')
  }
  return promotion
}
