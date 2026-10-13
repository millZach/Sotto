// npm run release:check [-- --version X.Y.Z]; record clean-main, CI and version evidence for packaging.
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { decideStablePromotion, publishedCheckRuns, publishedReleases, releaseCheckout, requireStableCheckout, stableVersionParts } from './stable-promotion.mjs'

export function stableReleaseArguments(args) {
  if (args.length === 0) return {}
  if (args.length !== 2 || args[0] !== '--version') throw new Error('Usage: npm run release:check -- --version X.Y.Z')
  stableVersionParts(args[1])
  return { version: args[1] }
}

export async function checkRelease({ root = resolve(import.meta.dirname, '..'), version } = {}) {
  const recordPath = resolve(root, 'release/stable-promotion.json')
  await rm(recordPath, { force: true })
  const initial = releaseCheckout(root)
  if (!initial.clean) requireStableCheckout(initial)
  try { execFileSync('git', ['fetch', 'origin', 'main'], { cwd: root, stdio: 'pipe', windowsHide: true }) }
  catch { throw new Error('Could not fetch origin/main. Check your connection and run release:check again.') }
  const checkout = releaseCheckout(root)
  requireStableCheckout(checkout)
  const [releases, checks] = await Promise.all([publishedReleases(), publishedCheckRuns(checkout.sourceCommit)])
  const promotion = { ...decideStablePromotion(releases, checkout, checks, version), checkedAt: new Date().toISOString() }
  const final = releaseCheckout(root)
  requireStableCheckout(final)
  if (final.sourceCommit !== checkout.sourceCommit || final.sourceVersion !== checkout.sourceVersion) throw new Error('The checkout changed during release:check. Run release:check again.')
  await mkdir(resolve(root, 'release'), { recursive: true })
  await writeFile(recordPath, JSON.stringify(promotion, null, 2) + '\n')
  process.stdout.write(`Sotto ${promotion.stableVersion} will ship source commit ${promotion.sourceCommit} from origin/main. The checkout is clean. Gates (Windows) and Package result succeeded. Newest published stable: ${promotion.latestStableVersion ?? 'none'}.\n`)
  return promotion
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await checkRelease(stableReleaseArguments(process.argv.slice(2))) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
