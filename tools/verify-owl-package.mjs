// Launch the Owl app with an isolated profile and check that it opens its window with its real preload status.
// node tools/verify-owl-package.mjs 0.1.37-owl.20261011.1 [--app <folder>] [--out <folder>]
// Reads this platform's unpacked app by default: release/win-unpacked on Windows, release/mac-arm64 on a Mac,
// release/linux-unpacked on Linux. --app names another folder laid out the same way, such as where the nightly's
// launch check installed the Windows Owl, copied Sotto.app from the disk image or extracted the Linux tarball.
// The status and screenshot go to release/, or to --out.
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { _electron as electron } from '@playwright/test'
import { releasePlatformProfile } from '../scripts/release-platform-profile.mjs'

const root = resolve(import.meta.dirname, '..')
const [expectedVersion, ...options] = process.argv.slice(2)
if (!expectedVersion || expectedVersion.startsWith('--')) throw new Error('Supply the packaged Owl version.')
const chosen = new Map()
for (let index = 0; index < options.length; index += 2) {
  const [key, value] = [options[index], options[index + 1]]
  if (!['--app', '--out'].includes(key) || chosen.has(key) || !value || value.startsWith('--')) throw new Error('Usage: node tools/verify-owl-package.mjs <version> [--app <folder>] [--out <folder>]')
  chosen.set(key, resolve(value))
}
const profile = releasePlatformProfile()
const appFolder = chosen.get('--app') ?? resolve(root, 'release', profile.packagedDirName)
const output = chosen.get('--out') ?? resolve(root, 'release')
const temporary = await mkdtemp(join(tmpdir(), 'sotto-owl-package-'))
let application
// The app closes first and the profile goes even when the close fails.
const cleanUp = async () => {
  try { await application?.close() }
  finally { await rm(temporary, { recursive: true, force: true }) }
}
try {
  if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('sotto-owl-package-')) throw new Error('Unexpected probe directory.')
  const userData = join(temporary, 'Chromium')
  await mkdir(userData)
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ autoUpdateCheck: false }))
  const environment = { ...process.env, ...await profile.smokeEnvironment(temporary) }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('SOTTO_') || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)) delete environment[key]
  }
  application = await electron.launch({ executablePath: profile.executablePath(appFolder),
    args: [`--user-data-dir=${userData}`, ...profile.smokeArgs], env: environment, timeout: 45_000 })
  const identity = await application.evaluate(({ app }) => ({ version: app.getVersion(), name: app.getName(), userData: app.getPath('userData') }))
  const first = await application.firstWindow()
  const page = application.windows().find(candidate => candidate.url().endsWith('/index.html')) ?? first
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'Get started', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  const status = await page.evaluate(() => globalThis.sotto.getUpdateStatus())
  // On macOS the temporary folder is under /var, a link to /private/var, and the app reports the resolved form.
  const ownProfile = await realpath(identity.userData).catch(() => identity.userData) === await realpath(userData)
  if (identity.version !== expectedVersion || identity.name.toLowerCase() !== 'sotto' || !ownProfile ||
    status.currentVersion !== expectedVersion || status.releaseTrack !== 'owl') {
    throw new Error(`Packaged Owl identity/status mismatch: ${JSON.stringify({ identity, status })}`)
  }
  await mkdir(output, { recursive: true })
  await page.screenshot({ path: resolve(output, 'owl-package.png') })
  const result = { identity: { version: identity.version, name: identity.name, isolatedProfile: true }, status }
  await writeFile(resolve(output, 'owl-package-status.json'), JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  // What failed in the probe is the error to report, not a close that failed after it.
  await cleanUp().catch(() => {})
  throw error
}
await cleanUp()
