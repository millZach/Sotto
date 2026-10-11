// Called after release:check; package:host remains the offline source-version build used by CI.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { packageHost } from './package-host.mjs'
import { checkedPromotion } from './stable-package.mjs'
import { releaseCheckout } from './stable-promotion.mjs'

const root = resolve(import.meta.dirname, '..')

async function savedPromotion() {
  try { return JSON.parse(await readFile(resolve(root, 'release/stable-promotion.json'), 'utf8')) }
  catch { throw new Error('The checked stable promotion could not be read. Run release:check before packaging the release host.') }
}

/** Package the same clean source and base version as the promoted desktop, without reading a release feed. */
export async function packageStableHost({ readPromotion = savedPromotion, checkout = () => releaseCheckout(root), packageArchive = packageHost } = {}) {
  const promotion = checkedPromotion(await readPromotion(), checkout())
  const archive = await packageArchive({ version: promotion.stableVersion })
  checkedPromotion(promotion, checkout())
  return { archive, promotion }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { archive, promotion } = await packageStableHost()
    process.stdout.write(`Packaged Sotto host ${promotion.stableVersion} from ${promotion.sourceCommit}, carried by Sotto Owl ${promotion.owlVersion}.\n${archive}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
