import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { evidenceDirectory } from '../fixtures/evidence'
import { PRODUCT_EVENTS_INSTALL_FILE } from '../../src/main/productEvents/identity'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'

/**
 * The notice, the switch and the sender together (ADR-0179), in the built app with its environment naming an endpoint: nothing
 * goes before a press, what goes after it is on the lists, and off stops it. `SOTTO_PROOF_ENDPOINT` points the journey at a real
 * Worker in place of this file's own server, with made-up accounts, and reads what the Worker stored back from D1 with the
 * Cloudflare token in the environment, for the run docs/verification cites. Captures go to
 * artifacts/product-events for that note.
 */
const evidence = evidenceDirectory('artifacts/product-events')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const PROOF = process.env.SOTTO_PROOF_ENDPOINT
const FORBIDDEN = /prompt|message|path|branch|repo|title|thread_?id|session|email/i

interface SentEvent { readonly uuid: string; readonly event: string; readonly distinct_id: string; readonly properties: Record<string, unknown> }

const claudeId = '11111111-2222-4333-8444-555555555555'
const fakeJwt = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { user_id: 'user-made-up-for-this-proof' } })).toString('base64url')}.y`

async function fixtureHomes(): Promise<{ readonly home: string; readonly environment: Record<string, string> }> {
  const home = await mkdtemp(join(tmpdir(), 'sotto-e2e-product-events-homes-'))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: claudeId } }), 'utf8')
  await mkdir(join(home, 'codex'))
  await writeFile(join(home, 'codex', 'auth.json'), JSON.stringify({ tokens: { id_token: fakeJwt } }), 'utf8')
  return { home, environment: { CLAUDE_CONFIG_DIR: home, CODEX_HOME: join(home, 'codex') } }
}

async function eventServer(): Promise<{ readonly server: Server; readonly endpoint: string; readonly sent: SentEvent[] }> {
  const sent: SentEvent[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => { sent.push(...(JSON.parse(body) as { batch: SentEvent[] }).batch); response.writeHead(204).end() })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return { server, endpoint: `http://127.0.0.1:${port}`, sent }
}

async function withEnvironment<T>(environment: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  Object.assign(process.env, environment)
  try { return await run() } finally {
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  }
}

async function profileWith(settings: Record<string, unknown>): Promise<string> {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-product-events-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, reducedMotion: 'on', ...settings }), 'utf8')
  return profile
}

/** The events the real Worker stored since a moment, read back from D1. */
function storedOnWorker(since: string): string[] {
  const output = execFileSync('npx', ['--yes', 'wrangler@4.156.2', 'd1', 'execute', 'sotto-product-events', '--remote', '--json', '--command', `SELECT event FROM product_events WHERE received_at >= '${since}'`],
    { cwd: 'workers/product-events', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  return (JSON.parse(output) as [{ results: { event: string }[] }])[0].results.map(row => row.event)
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
const notice = (page: Page) => page.getByRole('status', { name: 'Sotto now sends product events' })

async function shot(launched: LaunchedSotto, name: string): Promise<void> {
  await launched.page.mouse.move(1, 1)
  await launched.page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** The card and everything in it stay inside the window, and the card's text does not run past its edge. */
async function fits(page: Page, selector: string): Promise<void> {
  const problems = await page.evaluate(picked => {
    const found: string[] = []
    const box = document.querySelector<HTMLElement>(picked)
    if (!box) return [`${picked} is not on the page`]
    const rect = box.getBoundingClientRect()
    if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) found.push(`${picked} leaves the window`)
    if (box.scrollWidth > box.clientWidth + 1) found.push(`${picked} scrolls sideways`)
    return found
  }, selector)
  expect(problems).toEqual([])
}

test.describe.configure({ mode: 'serial' })

test('nothing goes before a press, what goes after it is on the lists, and off stops it', async () => {
  test.setTimeout(240_000)
  await mkdir(evidence, { recursive: true })
  const { home, environment } = await fixtureHomes()
  const local = PROOF ? null : await eventServer()
  const profile = await profileWith({})
  const installFile = join(profile, PRODUCT_EVENTS_INSTALL_FILE)
  const startedAt = new Date().toISOString()
  let launched: LaunchedSotto | undefined
  try {
    await withEnvironment({ ...environment, SOTTO_PRODUCT_EVENTS_ENDPOINT: PROOF ?? local!.endpoint }, async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      await expect(notice(page)).toBeVisible()
      await expect(notice(page)).toContainText('Hashed is not anonymous: those IDs link your computers to one person.')

      // The window is up and its features can run: a press on one before the answer keeps nothing and makes no ID.
      await openPage(page, 'Settings')
      await page.getByRole('tab', { name: 'Application', exact: true }).click()
      await expect(page.getByRole('switch', { name: 'Send product events' })).toBeChecked()
      expect(await exists(installFile)).toBe(false)
      expect(local?.sent ?? []).toEqual([])

      await notice(page).getByRole('button', { name: 'See every event' }).click()
      await expect(page.getByRole('dialog', { name: 'Every product event' })).toContainText('feature.used')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(notice(page)).toBeVisible()

      await notice(page).getByRole('button', { name: 'Got it' }).click()
      await expect(notice(page)).toHaveCount(0)
      await expect.poll(() => exists(installFile), { timeout: 45_000 }).toBe(true)
      if (local) {
        await expect.poll(() => local.sent.map(event => event.event), { timeout: 45_000 }).toEqual(expect.arrayContaining(['app.started', 'install.owner_observed']))
        const owners = local.sent.filter(event => event.event === 'install.owner_observed').map(event => event.properties.ownerSource)
        expect(owners.sort()).toEqual(['claude', 'openai'])
        const whole = JSON.stringify(local.sent)
        expect(whole).not.toContain(claudeId)
        expect(whole).not.toContain('user-made-up-for-this-proof')
        for (const event of local.sent) {
          expect(Object.keys(event.properties).filter(name => FORBIDDEN.test(name))).toEqual([])
          expect(event.distinct_id).toMatch(/^[0-9a-f]{64}$/)
          expect(event.properties).toMatchObject({ surface: 'desktop', $process_person_profile: false, $geoip_disable: true })
        }
      }

      // A feature from the list, in the next batch.
      await page.getByRole('link', { name: 'Usage', exact: true }).click()
      if (PROOF) {
        await expect.poll(() => storedOnWorker(startedAt), { timeout: 90_000, intervals: [5_000] }).toEqual(expect.arrayContaining(['app.started', 'install.owner_observed', 'feature.used']))
      } else {
        await expect.poll(() => local!.sent.map(event => event.event), { timeout: 45_000 }).toContain('feature.used')
        await openPage(page, 'Settings')
        await page.getByRole('tab', { name: 'Application', exact: true }).click()
        const count = local!.sent.length
        await page.getByRole('switch', { name: 'Send product events' }).click()
        await expect(page.getByRole('switch', { name: 'Send product events' })).not.toBeChecked()
        await expect.poll(() => exists(installFile)).toBe(false)
        expect(local!.sent.length).toBe(count)
      }
    })
    await closeSotto(launched!)
    launched = undefined
  } finally {
    if (launched) await closeSotto(launched).catch(() => undefined)
    await new Promise<void>(done => local ? local.server.close(() => done()) : done())
    await removeOwnedE2EProfile(profile)
    await rm(home, { recursive: true, force: true })
  }
})

test('Escape puts it off until the next start, and Turn off is kept', async () => {
  test.setTimeout(180_000)
  const { home, environment } = await fixtureHomes()
  const local = await eventServer()
  const profile = await profileWith({})
  let launched: LaunchedSotto | undefined
  try {
    await withEnvironment({ ...environment, SOTTO_PRODUCT_EVENTS_ENDPOINT: local.endpoint }, async () => {
      launched = await launchSotto('success', profile)
      await expect(notice(launched.page)).toBeVisible()
      await launched.page.keyboard.press('Escape')
      await expect(notice(launched.page)).toHaveCount(0)
      await closeSotto(launched)

      launched = await launchSotto('success', profile)
      await expect(notice(launched.page)).toBeVisible()
      await notice(launched.page).getByRole('button', { name: 'Turn off' }).click()
      await expect(notice(launched.page)).toHaveCount(0)
      await expect(launched.page.getByText('Product events are off. Sotto sends nothing.')).toBeVisible()
      await closeSotto(launched)

      launched = await launchSotto('success', profile)
      await openPage(launched.page, 'Settings')
      await launched.page.getByRole('tab', { name: 'Application', exact: true }).click()
      await expect(launched.page.getByRole('switch', { name: 'Send product events' })).not.toBeChecked()
      await expect(notice(launched.page)).toHaveCount(0)
    })
    expect(local.sent).toEqual([])
    expect(await exists(join(profile, PRODUCT_EVENTS_INSTALL_FILE))).toBe(false)
  } finally {
    if (launched) await closeSotto(launched).catch(() => undefined)
    await new Promise<void>(done => local.server.close(() => done()))
    await removeOwnedE2EProfile(profile)
    await rm(home, { recursive: true, force: true })
  }
})

test('the environment outranks the switch: no notice, and the row shows off and says why', async () => {
  test.setTimeout(120_000)
  const profile = await profileWith({})
  let launched: LaunchedSotto | undefined
  try {
    await withEnvironment({ DO_NOT_TRACK: '1', SOTTO_PRODUCT_EVENTS_ENDPOINT: 'http://127.0.0.1:9' }, async () => {
      launched = await launchSotto('success', profile)
      await openPage(launched.page, 'Settings')
      await launched.page.getByRole('tab', { name: 'Application', exact: true }).click()
      const row = launched.page.getByRole('switch', { name: 'Send product events' })
      await expect(row).not.toBeChecked()
      await expect(row).toBeDisabled()
      await expect(launched.page.getByText('Off on this computer because DO_NOT_TRACK is set.')).toBeVisible()
      await expect(notice(launched.page)).toHaveCount(0)
      await row.scrollIntoViewIfNeeded()
      await shot(launched, 'settings-locked-dark-1280x800')
    })
  } finally {
    if (launched) await closeSotto(launched).catch(() => undefined)
    await removeOwnedE2EProfile(profile)
  }
})

test('the notice, the list and the row fit at every size in both modes', async () => {
  test.setTimeout(240_000)
  const profile = await profileWith({})
  let launched: LaunchedSotto | undefined
  try {
    await withEnvironment({ SOTTO_PRODUCT_EVENTS_ENDPOINT: 'http://127.0.0.1:9' }, async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      await expect(notice(page)).toBeVisible()
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await fits(page, '.product-events-notice')
          await shot(launched, `notice-${mode}-${width}x${height}`)
          await notice(page).getByRole('button', { name: 'See every event' }).click()
          const list = page.getByRole('dialog', { name: 'Every product event' })
          await expect(list).toBeVisible()
          await fits(page, '.tt-dialog')
          await shot(launched, `list-${mode}-${width}x${height}`)
          await list.getByRole('button', { name: 'Close' }).click()

          await openPage(page, 'Settings')
          await page.getByRole('tab', { name: 'Application', exact: true }).click()
          const row = page.getByRole('switch', { name: 'Send product events' })
          await row.scrollIntoViewIfNeeded()
          await shot(launched, `settings-${mode}-${width}x${height}`)
        }
      }
      // Colour comes from the theme: one more of each mode, at the size with least room.
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light', lightTheme: 'citrine' }) })
      await shot(launched, 'notice-citrine-light-820x560')
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark', darkTheme: 'graphite' }) })
      await shot(launched, 'notice-graphite-dark-820x560')
      // Tab reaches the card's buttons in the order the eye does.
      await notice(page).getByRole('button', { name: 'Got it' }).focus()
      await page.keyboard.press('Tab')
      await expect(notice(page).getByRole('button', { name: 'Turn off' })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(notice(page).getByRole('button', { name: 'See every event' })).toBeFocused()
    })
  } finally {
    if (launched) await closeSotto(launched).catch(() => undefined)
    await removeOwnedE2EProfile(profile)
  }
})
