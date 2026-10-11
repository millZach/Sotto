// npm run release:check; reads the public feed and records the checked promotion for packaging.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { decideStablePromotion, publishedReleases, releaseCheckout } from './stable-promotion.mjs'

const root = resolve(import.meta.dirname, '..')
const promotionPath = resolve(root, 'release/stable-promotion.json')
try {
  await rm(promotionPath, { force: true })
  const promotion = decideStablePromotion(await publishedReleases(), releaseCheckout(root))
  await mkdir(resolve(root, 'release'), { recursive: true })
  await writeFile(promotionPath, JSON.stringify(promotion, null, 2) + '\n')
  process.stdout.write(`Sotto ${promotion.stableVersion} will promote Sotto Owl ${promotion.owlVersion}, source commit ${promotion.sourceCommit}. The checkout is clean.\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
