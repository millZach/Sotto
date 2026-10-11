// node scripts/verify-watcher-package.mjs: packaged stable ignores the development override on a fresh owned profile.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { _electron as electron } from '@playwright/test'
import { releasePlatformProfile } from './release-platform-profile.mjs'

const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'sotto-watcher-package-'))
if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('sotto-watcher-package-')) throw new Error('Unexpected package probe directory.')
let application
try {
  const userData = join(temporary, 'Chromium')
  await mkdir(userData)
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ autoUpdateCheck: false, localHostEnabled: false }))
  const environment = { ...process.env, ...await releasePlatformProfile().smokeEnvironment(temporary) }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('SOTTO_') || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)) delete environment[key]
  }
  environment.SOTTO_WATCHER_ENABLED = '1'
  application = await electron.launch({ executablePath: resolve(root, 'release/win-unpacked/Sotto.exe'),
    args: [`--user-data-dir=${userData}`], env: environment, timeout: 45_000 })
  const identity = await application.evaluate(({ app }) => ({ version: app.getVersion(), name: app.getName(), packaged: app.isPackaged, userData: app.getPath('userData') }))
  const page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'Get started', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  const status = await page.evaluate(() => globalThis.sotto.getUpdateStatus())
  if (!identity.packaged || identity.userData !== userData || identity.name.toLowerCase() !== 'sotto' ||
    status.currentVersion !== identity.version || status.releaseTrack !== 'stable' || status.watcherEnabled !== false) {
    throw new Error('Packaged stable did not keep the Watcher gate off with the development override set.')
  }
  await mkdir(resolve(root, 'artifacts/watcher-gate'), { recursive: true })
  await page.screenshot({ path: resolve(root, 'artifacts/watcher-gate/packaged-stable.png') })
  const result = { version: identity.version, name: identity.name, packaged: true, isolatedProfile: true, override: '1', status }
  await writeFile(resolve(root, 'release/watcher-package-status.json'), JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally {
  await application?.close()
  await rm(temporary, { recursive: true, force: true })
}
