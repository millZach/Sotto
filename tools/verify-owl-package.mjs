// Launch the unpacked Owl app with an isolated profile and check its real preload status.
// node tools/verify-owl-package.mjs 0.1.37-owl.20261011.1
// Reads this platform's unpacked app: release/win-unpacked on Windows, release/mac-arm64 on a Mac.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { _electron as electron } from '@playwright/test'
import { releasePlatformProfile } from '../scripts/release-platform-profile.mjs'

const root = resolve(import.meta.dirname, '..')
const expectedVersion = process.argv[2]
if (!expectedVersion) throw new Error('Supply the packaged Owl version.')
const profile = releasePlatformProfile()
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
  application = await electron.launch({ executablePath: profile.executablePath(resolve(root, 'release', profile.packagedDirName)),
    args: [`--user-data-dir=${userData}`, ...profile.smokeArgs], env: environment, timeout: 45_000 })
  const identity = await application.evaluate(({ app }) => ({ version: app.getVersion(), name: app.getName(), userData: app.getPath('userData') }))
  const first = await application.firstWindow()
  const page = application.windows().find(candidate => candidate.url().endsWith('/index.html')) ?? first
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'Get started', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  const status = await page.evaluate(() => globalThis.sotto.getUpdateStatus())
  if (identity.version !== expectedVersion || identity.name.toLowerCase() !== 'sotto' || identity.userData !== userData ||
    status.currentVersion !== expectedVersion || status.releaseTrack !== 'owl') {
    throw new Error(`Packaged Owl identity/status mismatch: ${JSON.stringify({ identity, status })}`)
  }
  await page.screenshot({ path: resolve(root, 'release/owl-package.png') })
  const result = { identity: { version: identity.version, name: identity.name, isolatedProfile: true }, status }
  await writeFile(resolve(root, 'release/owl-package-status.json'), JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  // What failed in the probe is the error to report, not a close that failed after it.
  await cleanUp().catch(() => {})
  throw error
}
await cleanUp()
