// Stable host command checks main, CI and version; package:host remains the offline CI build.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { checkRelease, stableReleaseArguments } from './check-release.mjs'
import { packageHost } from './package-host.mjs'
import { checkedPromotion, withStableManifestGuard } from './stable-package.mjs'
import { releaseCheckout } from './stable-promotion.mjs'

const root = resolve(import.meta.dirname, '..')

async function savedPromotion() {
  try { return JSON.parse(await readFile(resolve(root, 'release/stable-promotion.json'), 'utf8')) }
  catch { throw new Error('The stable release check could not be read. Run release:check before packaging the release host.') }
}

/** Package the same checked main source and stable version as the desktop. */
export async function packageStableHost({ readPromotion = savedPromotion, checkout = () => releaseCheckout(root), packageArchive = packageHost } = {}) {
  const promotion = checkedPromotion(await readPromotion(), checkout())
  const manifest = await readFile(resolve(root, 'package.json'))
  const lock = await readFile(resolve(root, 'package-lock.json'))
  const archive = await withStableManifestGuard(async () => {
    const result = await packageArchive({ version: promotion.stableVersion })
    checkedPromotion(promotion, checkout())
    return result
  }, async () => {
    if (!(await readFile(resolve(root, 'package.json'))).equals(manifest) || !(await readFile(resolve(root, 'package-lock.json'))).equals(lock)) {
      throw new Error('The source package manifests changed during host packaging.')
    }
  })
  return { archive, promotion }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await checkRelease(stableReleaseArguments(process.argv.slice(2)))
    const { archive, promotion } = await packageStableHost()
    process.stdout.write(`Packaged Sotto host ${promotion.stableVersion} from checked main commit ${promotion.sourceCommit}.\n${archive}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
