// node scripts/verify-owl-features-package.mjs release/win-unpacked stable (or release/mac-arm64 stable).
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'
import { releasePlatformProfile } from './release-platform-profile.mjs'

const root = resolve(import.meta.dirname, '..')
// Load the same list and rule as the app. Its only import is a type; no second release list is maintained.
const source = stripTypeScriptTypes(await readFile(resolve(root, 'src/shared/owlFeatures.ts'), 'utf8'))
const { OWL_FEATURES, isOwlFeatureEnabled } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

export function assertPackagedFeatureStatus(status, track, features = OWL_FEATURES) {
  if (track !== 'stable' && track !== 'owl') throw new Error('Supply the expected release track: stable or owl.')
  if (status.releaseTrack !== track) throw new Error(`The packaged app did not report the ${track} track.`)
  for (const feature of features) {
    const expected = isOwlFeatureEnabled(feature.id, track, features)
    if (status.owlFeatures?.[feature.id] !== expected) {
      throw new Error(`${feature.name} must be ${expected ? 'on' : 'off'} in the packaged ${track} build.`)
    }
  }
  if (status.watcherEnabled !== status.owlFeatures?.watcher) throw new Error('The Watcher compatibility answer differs from the Owl feature list.')
}

// Paths are compared after resolving links: on macOS the temporary folder sits under /var, a link to /private/var,
// and the app may report either form of the same profile.
export async function assertOwnedProfile(identity, status, userData) {
  const problems = []
  if (!identity.packaged) problems.push('the app is not packaged')
  if (identity.name.toLowerCase() !== 'sotto') problems.push(`the app is named ${identity.name}`)
  if (await realpath(identity.userData).catch(() => identity.userData) !== await realpath(userData)) problems.push(`it used the profile ${identity.userData}, not ${userData}`)
  if (status.currentVersion !== identity.version) problems.push(`it reported version ${status.currentVersion} for app version ${identity.version}`)
  if (problems.length) throw new Error(`The package probe did not read the packaged app on its owned profile: ${problems.join('; ')}.`)
}

export async function verifyOwlFeaturesPackage(target, track) {
  if (track !== 'stable' && track !== 'owl') throw new Error('Supply the expected release track: stable or owl.')
  const temporary = await mkdtemp(join(tmpdir(), 'sotto-owl-features-package-'))
  if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('sotto-owl-features-package-')) throw new Error('Unexpected package probe directory.')
  const profile = releasePlatformProfile()
  let application
  try {
    const userData = join(temporary, 'Chromium')
    await mkdir(userData)
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ autoUpdateCheck: false, localHostEnabled: false }))
    const environment = { ...process.env, ...await profile.smokeEnvironment(temporary) }
    for (const key of Object.keys(environment)) {
      if (key.startsWith('SOTTO_') || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)) delete environment[key]
    }
    environment.SOTTO_OWL_FEATURES = OWL_FEATURES.map(feature => `${feature.id}=1`).join(',')
    environment.SOTTO_WATCHER_ENABLED = '1'
    application = await electron.launch({ executablePath: profile.executablePath(resolve(target)),
      args: [`--user-data-dir=${userData}`, ...profile.smokeArgs], env: environment, timeout: 45_000 })
    const identity = await application.evaluate(({ app }) => ({ version: app.getVersion(), name: app.getName(), packaged: app.isPackaged, userData: app.getPath('userData') }))
    const first = await application.firstWindow()
    const page = application.windows().find(candidate => candidate.url().endsWith('/index.html')) ?? first
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('button', { name: 'Get started', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    const status = await page.evaluate(() => globalThis.sotto.getUpdateStatus())
    await assertOwnedProfile(identity, status, userData)
    assertPackagedFeatureStatus(status, track)
    const output = resolve(root, 'release')
    await mkdir(output, { recursive: true })
    await page.bringToFront()
    await page.evaluate(async () => {
      await globalThis.document.fonts.ready
      await new Promise(done => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(done)))
    })
    // An early Electron compositor frame can be empty despite a ready DOM; prime it before saving the evidence.
    await page.screenshot()
    await page.screenshot({ path: join(output, `owl-features-${track}-package.png`) })
    const result = { version: identity.version, name: identity.name, packaged: true, isolatedProfile: true,
      overrides: { SOTTO_OWL_FEATURES: environment.SOTTO_OWL_FEATURES, SOTTO_WATCHER_ENABLED: '1' }, status }
    await writeFile(join(output, `owl-features-${track}-package-status.json`), JSON.stringify(result, null, 2) + '\n')
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result
  } finally {
    try { await application?.close() }
    finally { await rm(temporary, { recursive: true, force: true }) }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyOwlFeaturesPackage(process.argv[2] ?? resolve(root, 'release', releasePlatformProfile().packagedDirName), process.argv[3] ?? 'stable')
}
