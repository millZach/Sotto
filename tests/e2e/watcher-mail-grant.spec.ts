import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { evidenceDirectory } from '../fixtures/evidence'
import { startFakeImapServer } from '../fixtures/fakeImapServer'
import { pageBoundProblems } from './support/designCapture'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { holdOwlSky } from './support/sottoOwl'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Ask before Watcher reads a mail account, in a ··· menu at the end of Watcher's strip (#2563; ADR-0205, decision 8;
 * Zach's pick A on November 13, 2026, of the tag prototype/watcher-mail-grant), on Sotto Owl against main's own
 * Watcher over the fake Codex app server and a made-up mail server on this computer: nothing is seeded. Watcher's
 * strip has no menu until Watcher can read a mail account. Its first read waits on a card in its room that names
 * Watcher (#2565); allowed, the
 * menu is there, last in the strip, at the three checked sizes in both modes: the tile, the tabs and All threads are
 * where they were, and Stop all has stepped left by the menu's own width and nothing more. The row ends the grant,
 * the menu goes, Stop all steps back, and Watcher's next read waits on a card again. Nothing reaches
 * Gmail, and the address, the app password and the message are made up. Run after `npm run build`. Captures go to
 * disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/watcher-mail-grant.
 */
const evidence = evidenceDirectory('artifacts/watcher-mail-grant')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const ADDRESS = 'reader@example.com'
const PASSWORD = 'madeupapppasswrd'
const WATCHER_REPLY = 'Watcher here.'
const ROW = 'Ask before Watcher reads Personal'

interface Held { __mailRead?: Promise<{ content: { type: string; text?: string }[]; isError?: boolean | undefined }> }

const watcherPane = (page: Page): Locator => page.getByRole('region', { name: 'Watcher', exact: true })
const strip = (page: Page): Locator => watcherPane(page).locator('header.watcher-head')
const more = (page: Page): Locator => strip(page).getByRole('button', { name: 'More actions', exact: true })

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await launched.page.mouse.move(0, 0)
  await launched.page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
  await holdOwlSky(launched.page)
  await captureWindow(launched.app, join(evidence, `${name}.png`))
}

/** Reads mail as Watcher's agent would, and leaves the call waiting, as a first read does until the user answers. */
async function read(page: Page, threadId: string): Promise<void> {
  await page.evaluate(request => { (window as unknown as Held).__mailRead = window.sottoE2E!.pluginTool!(request) }, { threadId, name: 'plugin_read', arguments: { plugin: 'gmail', search: {} } })
}
async function answered(page: Page): Promise<{ text: string; isError: boolean }> {
  const result = await page.evaluate(() => (window as unknown as Held).__mailRead!)
  return { text: result.content.map(part => part.text ?? '').join('\n'), isError: result.isError === true }
}

type Box = { x: number; y: number; width: number; height: number }
/** Where the strip's other controls are: the tile, Watcher's name or its tabs, All threads, and Stop all at its end. */
async function placed(page: Page): Promise<{ strip: Box; tile: Box; title: Box; list: Box; stopAll: Box }> {
  return strip(page).evaluate(head => {
    const box = (element: Element | null) => { const r = element?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : { x: -1, y: -1, width: -1, height: -1 } }
    return { strip: box(head), tile: box(head.firstElementChild), title: box(head.querySelector('.thread-workspace__title')), list: box(head.querySelector('.watcher-head__list')),
      stopAll: box(head.querySelector('.watcher-stop-all__button')) }
  })
}

test('Watcher’s strip has Ask before Watcher reads only while Watcher can read a mail account, and the row ends that grant', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  const mail = await startFakeImapServer({ address: ADDRESS, password: PASSWORD, mailboxes: [{ name: 'INBOX', validity: 7, messages: [
    { uid: 12, received: '12-Nov-2026 09:30:00 +0000', headers: { From: 'Ann Example <ann@example.com>', To: ADDRESS, Subject: 'Lunch on Friday' }, body: { type: 'text/plain', body: 'Shall we have lunch on Friday?' } },
  ] }] })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-watcher-mail-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'worker']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({ reply: WATCHER_REPLY }))
  const kept = ['SOTTO_E2E_NATIVE_FIXTURE_ROOT', 'SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', 'SOTTO_E2E_MAIL_PORT'] as const
  const previous = new Map(kept.map(name => [name, process.env[name]]))
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  process.env.SOTTO_E2E_MAIL_PORT = String(mail.port)
  try {
    await onReleaseTrack('owl', async () => {
      const launched = await launchSotto('success', profile)
      try {
        const { page } = launched
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await page.evaluate(async () => {
          await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
          const agents = window.sotto!.agents!
          await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
          await agents.command({ type: 'connect', provider: 'codex' })
        })
        await page.reload()
        await openThreads(page)
        await resizeContentWindow(launched, 1280, 800, [800, 540])

        // Main's own Watcher, started from its room's first entry.
        await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
        await expect(page.locator('.watcher-foot .thread-nav__seg')).toBeVisible()
        await page.getByRole('textbox', { name: 'Watcher message' }).click()
        await page.keyboard.type('Find what Ann sent me about Friday.')
        await page.getByRole('button', { name: 'Start Watcher and send' }).click()
        await expect(watcherPane(page).locator('[data-role="assistant"]')).toContainText(WATCHER_REPLY, { timeout: 60_000 })
        const watcherId = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.kind === 'watcher')!.id)

        // A Gmail account every project can use, as Settings › Plugins adds one (plugins-gmail.spec.ts covers that page).
        const added = await page.evaluate(async request => window.sotto!.plugins!.addAccount(request), { plugin: 'gmail' as const, name: 'Personal', secret: PASSWORD, address: ADDRESS })
        expect(added.ok).toBe(true)

        // Watcher can read no mail account yet: its strip has no menu, at any size.
        const before = new Map<string, Awaited<ReturnType<typeof placed>>>()
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          await expect(more(page)).toHaveCount(0)
          before.set(`${width}x${height}`, await placed(page))
        }
        await capture(launched, 'strip-no-grant-dark-820x560')
        await resizeContentWindow(launched, 1280, 800, [800, 540])

        // Watcher's first read waits on a card in its room. Nothing is asked of the mailbox, and there is still no menu.
        await read(page, watcherId)
        const request = watcherPane(page).locator('section.agent-request[data-kind="permission"]')
        await expect(request).toHaveCount(1, { timeout: 30_000 })
        await expect(request.getByText('Read Gmail mail', { exact: true })).toBeVisible()
        await expect(request).not.toContainText(ADDRESS)
        // The card names Watcher, which is never settled, and not "this thread" (#2565).
        await expect(request.locator('.agent-request__details')).toHaveText(['Watcher can search this account’s mail and read its messages, until you stop it.',
          'What it reads goes to Codex, as everything Watcher reads does.', 'It cannot send, move or delete mail. Every thread asks for itself.'].join('\n'))
        await expect(request).not.toContainText(/this thread|settled/u)
        expect(mail.commands.some(command => command.startsWith('EXAMINE'))).toBe(false)
        await expect(more(page)).toHaveCount(0)
        await capture(launched, 'card-first-read-dark-1280x800')
        await request.getByRole('button', { name: 'Let Watcher read it', exact: true }).click()
        const first = await answered(page)
        expect(first.isError).toBe(false)
        expect(first.text).toContain('Lunch on Friday')
        await expect(request).toHaveCount(0)

        // Now Watcher can read the account, so its strip ends in a ··· menu, and nothing else in the strip has moved.
        await expect(more(page)).toBeVisible()
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(async mode => { await window.sotto!.updateSettings({ appearance: mode }) }, appearance)
          for (const [width, height] of SIZES) {
            await resizeContentWindow(launched, width, height, [800, 540])
            await expect(more(page)).toBeVisible()
            // The tile, the tabs and All threads are where they were. Stop all, which was last, has stepped left by the
            // menu's width and the room before it, and is the size it was.
            const [was, now] = [before.get(`${width}x${height}`)!, await placed(page)]
            expect({ ...now, stopAll: null }, `the strip's other controls at ${width}x${height} in ${appearance}`).toEqual({ ...was, stopAll: null })
            const [button, head] = [await more(page).boundingBox(), await strip(page).boundingBox()]
            expect({ ...now.stopAll, x: 0 }).toEqual({ ...was.stopAll, x: 0 })
            expect(was.stopAll.x - now.stopAll.x, `Stop all steps left by the menu alone at ${width}x${height}`).toBe(Math.round(button!.width) + 6)
            // The menu's button begins where Stop all ends, and ends where Stop all used to.
            expect(Math.round(button!.x)).toBe(now.stopAll.x + now.stopAll.width + 6)
            expect(Math.round(button!.x + button!.width)).toBe(was.stopAll.x + was.stopAll.width)
            expect(await pageBoundProblems(page), `${width}x${height} ${appearance}`).toEqual([])
            // The button is the last thing in the strip and sits inside it.
            expect(button!.x + button!.width).toBeLessThanOrEqual(head!.x + head!.width + 1)
            expect(button!.y).toBeGreaterThanOrEqual(head!.y - 1)
            expect(button!.y + button!.height).toBeLessThanOrEqual(head!.y + head!.height + 1)
            await capture(launched, `strip-menu-${appearance}-${width}x${height}`)
            // Open, the menu's one row is whole inside the window.
            await more(page).click()
            const row = strip(page).getByRole('menuitem', { name: ROW, exact: true })
            await expect(row).toBeVisible()
            const list = await strip(page).getByRole('menu', { name: 'More actions' }).boundingBox()
            expect(list!.x).toBeGreaterThanOrEqual(0)
            expect(list!.x + list!.width).toBeLessThanOrEqual(width)
            const [rowWidth, rowScroll] = await row.evaluate(element => [element.clientWidth, element.scrollWidth])
            expect(rowScroll, 'the row is not cut short').toBeLessThanOrEqual(rowWidth!)
            if (appearance === 'dark' || width === 1280) await capture(launched, `strip-menu-open-${appearance}-${width}x${height}`)
            await page.keyboard.press('Escape')
            await expect(strip(page).getByRole('menu')).toHaveCount(0)
            // Escape hands focus back to the button; the next size is captured at rest.
            await more(page).blur()
          }
        }
        await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
        await resizeContentWindow(launched, 1280, 800, [800, 540])

        // From the keyboard, in the order the eye reads the strip: All threads, Stop all, then the menu. Enter opens it on
        // its row, and Escape gives focus back.
        await strip(page).getByRole('button', { name: /^All threads, \d+\. Show the list$/u }).focus()
        await page.keyboard.press('Tab')
        await expect(strip(page).locator('.watcher-stop-all__button')).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(more(page)).toBeFocused()
        await page.keyboard.press('Enter')
        const row = strip(page).getByRole('menuitem', { name: ROW, exact: true })
        await expect(row).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(more(page)).toBeFocused()
        // The strip is the window's drag strip, and the menu's button does not drag it.
        expect(await more(page).evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag')

        // A second read does not ask. Then the row, pressed from the keyboard: the grant ends and the menu goes.
        await read(page, watcherId)
        expect((await answered(page)).isError).toBe(false)
        await expect(request).toHaveCount(0)
        await page.keyboard.press('Enter')
        await expect(row).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(more(page)).toHaveCount(0)
        await expect(watcherPane(page).getByRole('alert')).toHaveCount(0)
        // The button that held focus is gone with the menu: focus is on All threads, not lost to the page.
        await expect(strip(page).getByRole('button', { name: /^All threads, \d+\. Show the list$/u })).toBeFocused()
        const grants = JSON.parse(await readFile(join(profile, 'plugin-mail-grants.json'), 'utf8')) as { grants: unknown[] }
        expect(grants.grants).toEqual([])
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          expect(await placed(page), `the strip after the grant ended at ${width}x${height}`).toEqual(before.get(`${width}x${height}`))
        }
        await resizeContentWindow(launched, 1280, 800, [800, 540])

        // Watcher's next read waits on a card again, and a no reads nothing.
        const examined = mail.commands.filter(command => command.startsWith('EXAMINE')).length
        await read(page, watcherId)
        await expect(request).toHaveCount(1, { timeout: 30_000 })
        await request.getByRole('button', { name: 'Don’t allow', exact: true }).click()
        expect((await answered(page)).isError).toBe(true)
        expect(mail.commands.filter(command => command.startsWith('EXAMINE')).length).toBe(examined)
        await expect(more(page)).toHaveCount(0)
        expect(errors).toEqual([])
      } finally { await closeSotto(launched) }
    })
  } finally {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await mail.close()
    await removeOwnedE2EProfile(profile)
  }
})
