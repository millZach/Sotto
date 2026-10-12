// Called only after npm run release:check by package:win and package:mac.
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { Arch, build, Platform } from 'electron-builder'
import { stablePackagePlan, checkedPromotion } from './stable-package.mjs'
import { releaseCheckout } from './stable-promotion.mjs'

const root = resolve(import.meta.dirname, '..')
const promotion = checkedPromotion(JSON.parse(await readFile(resolve(root, 'release/stable-promotion.json'), 'utf8')), releaseCheckout(root))
const plan = stablePackagePlan(process.argv[2], promotion.stableVersion)
const manifestPath = resolve(root, 'package.json')
const originalManifest = await readFile(manifestPath)
const originalLock = await readFile(resolve(root, 'package-lock.json'))
function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${basename(script)} failed (${result.status ?? result.signal}).`)
}
run(process.env.npm_execpath, ['run', 'assets:verify'])
run(process.env.npm_execpath, ['run', 'build'])
run(resolve(root, 'scripts/write-build-provenance.mjs'))
checkedPromotion(promotion, releaseCheckout(root))
await build({ projectDir: root, targets: (plan.platform === 'win' ? Platform.WINDOWS : Platform.MAC).createTarget([plan.target], plan.platform === 'win' ? Arch.x64 : Arch.arm64),
  publish: 'never', config: plan.config })
run(resolve(root, 'scripts/verify-packaged-resources.mjs'), [resolve(root, plan.unpacked), '--installer', resolve(root, plan.installer)])
run(resolve(root, 'scripts/verify-owl-features-package.mjs'), [resolve(root, plan.unpacked), 'stable'])
if (!(await readFile(manifestPath)).equals(originalManifest) || !(await readFile(resolve(root, 'package-lock.json'))).equals(originalLock)) {
  throw new Error('The source package manifests changed during packaging.')
}
process.stdout.write(`Packaged Sotto ${promotion.stableVersion} from ${promotion.sourceCommit}, carried by Sotto Owl ${promotion.owlVersion}.\n`)
