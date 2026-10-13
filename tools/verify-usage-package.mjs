// Windows: node tools/verify-usage-package.mjs release/win-unpacked owl <full-version> (or stable <version>).
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import process from 'node:process'
import { _electron as electron, expect } from '@playwright/test'

const [target, track, version] = process.argv.slice(2)
if (process.platform !== 'win32' || !target || !version || !['owl', 'stable'].includes(track)) {
  throw new Error('Supply a Windows unpacked app, its track and exact version.')
}
const root = resolve(import.meta.dirname, '..')
const output = join(root, 'release')
const temporary = await mkdtemp(join(tmpdir(), 'sotto-usage-package-'))
if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('sotto-usage-package-')) throw new Error('Unexpected package profile directory.')
let app
try {
  const userData = join(temporary, 'profile'), home = join(temporary, 'home')
  const appData = join(temporary, 'roaming'), localAppData = join(temporary, 'local')
  await Promise.all([userData, home, appData, localAppData, output].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ onboardingComplete: true, historyEnabled: false,
    autoUpdateCheck: false, localHostEnabled: track === 'owl', appearance: 'dark', reducedMotion: 'on', threadTitles: false }))
  await writeFile(join(userData, 'agents.json'), JSON.stringify({ configuration: { enabled: false, enabledProviders: [],
    disconnectedProviders: ['codex', 'claude', 'grok', 'devin'], reasoning: 'none', checkClientUpdates: false },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false, outbox: [] }))
  const databasePath = join(userData, 'usage.sqlite')
  const digest = async () => createHash('sha256').update(await readFile(databasePath)).digest('hex')
  let dormantBefore
  if (track === 'stable') {
    const database = new DatabaseSync(databasePath)
    try { database.exec('CREATE TABLE dormant_numeric_probe(tokens INTEGER); INSERT INTO dormant_numeric_probe VALUES (123);') }
    finally { database.close() }
    dormantBefore = await digest()
  }
  const inherited = new Set(['systemroot', 'systemdrive', 'windir', 'comspec', 'temp', 'tmp', 'lang', 'lc_all'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && inherited.has(key.toLowerCase())))
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
    PATH: [join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';') })
  app = await electron.launch({ executablePath: join(resolve(target), 'Sotto.exe'), args: [`--user-data-dir=${userData}`], env, timeout: 45_000 })
  const identity = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, userData: app.getPath('userData') }))
  expect(identity).toEqual({ version, packaged: true, userData })
  const first = await app.firstWindow()
  const page = app.windows().find(candidate => candidate.url().endsWith('/index.html')) ?? first
  const errors = []
  page.on('pageerror', error => errors.push(error.name))
  await page.waitForFunction(() => !!globalThis.sotto)
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
  expect(await page.evaluate(() => typeof globalThis.sottoE2E)).toBe('undefined')
  const status = await page.evaluate(() => globalThis.sotto.getUpdateStatus())
  expect(status.releaseTrack).toBe(track)
  expect(status.owlFeatures.usage).toBe(track === 'owl')
  let figures
  if (track === 'owl') {
    await page.getByRole('link', { name: 'Usage', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible()
    await expect(page.getByRole('tablist', { name: 'Usage measures', exact: true }).getByRole('tab')).toHaveCount(6)
    const read = await page.evaluate(() => globalThis.sotto.usage.read({ timeZone: 'UTC' }))
    expect(read.hosts).toHaveLength(1)
    expect(read.hosts[0].status).toBe('ready')
    figures = read.hosts[0].activity.totals
    expect(figures.prompts.total).toBe(0)
    expect(figures.tokens.total.value).toBeUndefined()
    await page.getByRole('tab', { name: 'Subscriptions', exact: true }).click()
    await expect(page.locator('.usage-subscription')).toHaveCount(4)
    await page.getByRole('tab', { name: 'Models', exact: true }).click()
    await expect(page.getByText('No models recorded in this range.', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  } else {
    await expect(page.getByRole('link', { name: 'Usage', exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => typeof globalThis.sotto.usage)).toBe('undefined')
  }
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().endsWith('/index.html'))
    window.setContentSize(1280, 800); window.show(); window.focus()
  })
  await page.bringToFront()
  await expect.poll(() => page.evaluate(() => globalThis.document.visibilityState === 'visible' && globalThis.document.hasFocus())).toBe(true)
  await page.screenshot({ path: join(output, `usage-${track}-package.png`), animations: 'disabled' })
  expect(errors).toEqual([])
  await app.close(); app = undefined
  const dormantPreserved = track === 'stable' ? await digest() === dormantBefore : undefined
  if (track === 'stable') expect(dormantPreserved).toBe(true)
  const result = { version, track, packaged: true, isolatedProfile: true, providerClientsExcludedFromPath: true,
    providersExplicitlyDisconnected: true, productTestBridgeAbsent: true, usageFeatureEnabled: status.owlFeatures.usage,
    figures, dormantPreserved, pageErrors: errors.length }
  await writeFile(join(output, `usage-${track}-package.json`), JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally {
  try { await app?.close() }
  finally { await rm(temporary, { recursive: true, force: true }) }
}
