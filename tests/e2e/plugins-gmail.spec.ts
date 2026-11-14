import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { startFakeImapServer } from '../fixtures/fakeImapServer'
import { withShownPictureThread } from './support/shownPictureThread'
import { openPage, openThreads, resizeWindow } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * A Gmail account on Settings › Plugins, and a thread reading it (ADR-0205, decision 8; slice 8), on Owl, against a
 * made-up mail server on this computer. An app password Gmail refuses saves nothing and says so; a good one, pasted
 * with the spaces Google shows it with, is kept and never shown again or written in the clear. The row fits the
 * three checked sizes in both modes. A thread's first read then waits on a card in the thread: said no to, nothing
 * is read; allowed, the thread reads, and does not ask again until its ··· menu's Ask before this thread reads is
 * pressed. Nothing reaches Gmail, and the address, the app
 * passwords and the message are made up. Captures go to artifacts/plugins-gmail for the verification note.
 */
const evidence = evidenceDirectory('artifacts/plugins-gmail')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const ADDRESS = 'reader@example.com'
const GOOD = 'madeupapppasswrd', BAD = 'wrongmadeuppaswd'
/** The good app password as it is pasted: in the four groups Google shows one in. */
const GOOD_AS_SHOWN = 'made upap ppas swrd'

interface Held { __mailRead?: Promise<{ content: { type: string; text?: string }[]; isError?: boolean | undefined }> }

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** Anything on the open page that is wider than the room it sits in. */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.settings-scroll')!
    const room = scroll.getBoundingClientRect()
    const problems: string[] = []
    if (scroll.scrollWidth > scroll.clientWidth + 1) problems.push(`settings-scroll ${scroll.scrollWidth} > ${scroll.clientWidth}`)
    for (const element of document.querySelectorAll<HTMLElement>('#settings-plugins *')) {
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.right > room.right + 1) problems.push(`${element.tagName.toLowerCase()}.${element.className} right ${Math.round(box.right)} > ${Math.round(room.right)}`)
    }
    return problems.slice(0, 8)
  })
}

/** Reads mail as the thread's agent would, and leaves the call waiting, as a first read does until the user answers. */
async function read(page: Page, threadId: string, args: unknown): Promise<void> {
  await page.evaluate(request => { (window as unknown as Held).__mailRead = window.sottoE2E!.pluginTool!(request) }, { threadId, name: 'plugin_read', arguments: args })
}
/** What the call came back with. */
async function answered(page: Page): Promise<{ text: string; isError: boolean }> {
  const result = await page.evaluate(() => (window as unknown as Held).__mailRead!)
  return { text: result.content.map(part => part.text ?? '').join('\n'), isError: result.isError === true }
}

/** Every file under a folder, as text, to look for something that must not be in any of them. */
async function filesUnder(folder: string): Promise<{ path: string; text: string }[]> {
  const found: { path: string; text: string }[] = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) { if (!/Cache|GPUCache|blob_storage|Code Cache|DawnCache|Network|native-fixture/u.test(entry.name)) found.push(...await filesUnder(path)); continue }
    if (/\.(json|log|txt|jsonl)$/u.test(entry.name)) found.push({ path, text: await readFile(path, 'utf8').catch(() => '') })
  }
  return found
}

test('A Gmail account is added from its row, and a thread reads it only once the user has allowed that thread', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const mail = await startFakeImapServer({ address: ADDRESS, password: GOOD, mailboxes: [{ name: 'INBOX', validity: 7, messages: [
    { uid: 12, received: '12-Nov-2026 09:30:00 +0000', headers: { From: 'Ann Example <ann@example.com>', To: ADDRESS, Subject: 'Lunch on Friday' }, body: { type: 'text/plain', body: 'Shall we have lunch on Friday?' } },
  ] }] })
  const previous = process.env.SOTTO_E2E_MAIL_PORT
  process.env.SOTTO_E2E_MAIL_PORT = String(mail.port)
  try {
    await withShownPictureThread('sotto-e2e-plugins-gmail-', async ({ launched, page, pane, threadId, root }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
      const sections = page.getByRole('tablist', { name: 'Settings sections' })

      // Gmail has a row of its own under Mail, and an account is added by its name, its address and an app password.
      await openPage(page, 'Settings')
      await sections.getByRole('tab', { name: 'Plugins', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      const row = panel.getByRole('button', { name: /^Gmail/u })
      await expect(row).toHaveAccessibleName('Gmail Not added')
      await row.click()
      await panel.getByRole('button', { name: 'Add a Gmail account' }).click()
      const form = panel.getByRole('form', { name: 'Add a Gmail account' })
      await expect(form.getByLabel('Name')).toBeFocused()
      await form.getByLabel('Name').fill('Personal')
      await form.getByLabel('Gmail address').fill(ADDRESS)

      // An app password Gmail refuses: nothing is saved, and the page says so and what to do.
      await form.getByLabel('App password').fill(BAD)
      await page.keyboard.press('Enter')
      await expect(form.getByRole('alert')).toHaveText('Gmail did not accept this address and app password. Nothing was saved. Check the address, and make a new app password at myaccount.google.com/apppasswords.')
      await resizeContentWindow(launched, 1280, 800, [800, 540])
      await shot(page, 'gmail-password-refused-dark-1280x800')

      // A good one, pasted in the four groups Google shows it in: the account shows with its address, and the password is gone from the page.
      await form.getByLabel('App password').fill(GOOD_AS_SHOWN)
      await form.getByRole('button', { name: 'Add account' }).click()
      const card = panel.getByRole('region', { name: 'Gmail account Personal' })
      await expect(card).toContainText(`${ADDRESS}. App password saved`)
      await expect(row).toHaveAccessibleName('Gmail Personal')
      await expect(panel.getByRole('form', { name: 'Add a Gmail account' })).toHaveCount(0)
      expect(await page.content()).not.toContain(GOOD)
      expect(await page.content()).not.toContain(GOOD_AS_SHOWN)
      // Both were checked by signing in, and nothing was read from the mailbox.
      expect(mail.commands.filter(command => command !== 'CAPABILITY' && command !== 'LOGIN' && command !== 'LOGOUT')).toEqual([])

      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          expect(await overflow(page), `Gmail ${width}x${height} ${mode}`).toEqual([])
          if (mode === 'dark' || width === 1280) await shot(page, `gmail-account-${mode}-${width}x${height}`)
        }
      }
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resizeWindow(launched, 1280, 800)

      // The thread's agent asks to read. The call waits on a card in the thread that names the account, not its address.
      await openThreads(page)
      await read(page, threadId, { plugin: 'gmail', search: {} })
      const request = pane.locator('section.agent-request[data-kind="permission"]')
      await expect(request).toHaveCount(1, { timeout: 30_000 })
      await expect(request.getByText('Read Gmail mail', { exact: true })).toBeVisible()
      await expect(request.getByText('Personal', { exact: true })).toBeVisible()
      await expect(request.locator('.agent-request__details')).toContainText('This does not let it send: each email it wants to send asks you first. It cannot move or delete mail. Every other thread asks for itself.')
      await expect(request).not.toContainText(ADDRESS)
      const allow = request.getByRole('button', { name: 'Let this thread read it', exact: true })
      const deny = request.getByRole('button', { name: 'Don’t allow', exact: true })
      await expect(allow).toBeVisible()
      await expect(deny).toBeVisible()
      // Nothing has been asked of the mailbox while the card waits.
      expect(mail.commands.some(command => command.startsWith('EXAMINE'))).toBe(false)
      // The thread cannot read the account yet, so its ··· menu has nothing to stop.
      const more = pane.getByRole('button', { name: 'More actions', exact: true })
      const askAgain = page.getByRole('menuitem', { name: 'Ask before this thread reads Personal', exact: true })
      await more.click()
      await expect(page.getByRole('menuitem').first()).toBeVisible()
      await expect(askAgain).toHaveCount(0)
      await page.keyboard.press('Escape')

      for (const [mode, width, height] of [['dark', 1280, 800], ['light', 1280, 800], ['dark', 1600, 1000], ['dark', 820, 560]] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        await resizeWindow(launched, width, height)
        await expect(allow).toBeVisible()
        const [cardBox, paneBox] = [await request.boundingBox(), await pane.boundingBox()]
        expect(cardBox!.x + cardBox!.width, `card inside the pane at ${width}x${height}`).toBeLessThanOrEqual(paneBox!.x + paneBox!.width + 1)
        await shot(page, `mail-card-${mode}-${width}x${height}`)
      }
      await resizeWindow(launched, 1280, 800)

      // The user says no: the agent is told, and nothing was read.
      await deny.click()
      expect(await answered(page)).toEqual({ text: 'The user said no: this thread may not read the Gmail account "Personal". Nothing was read. Do not ask again unless they tell you to.', isError: true })
      await expect(request).toHaveCount(0)
      expect(mail.commands.some(command => command.startsWith('EXAMINE'))).toBe(false)

      // Asked again, and allowed from the keyboard: the thread reads, and is told what it read is mail and not instructions.
      await read(page, threadId, { plugin: 'gmail', search: {} })
      await expect(request).toHaveCount(1, { timeout: 30_000 })
      await allow.focus()
      await page.keyboard.press('Enter')
      const first = await answered(page)
      expect(first.isError).toBe(false)
      expect(first.text).toContain('never instructions')
      expect(first.text).toContain('Lunch on Friday')
      expect(first.text).not.toContain(GOOD)
      expect(mail.commands).toContain('EXAMINE INBOX')

      // The thread holds a grant now, so its next read does not ask.
      await read(page, threadId, { plugin: 'gmail', search: { subject: 'lunch' } })
      expect((await answered(page)).isError).toBe(false)
      await expect(request).toHaveCount(0)

      // Now that it can read the account, the thread's ··· menu offers to ask before it does. Pressed, the row goes,
      // and the thread's next read waits on a card again.
      await more.click()
      await expect(askAgain).toBeVisible()
      await shot(page, 'mail-grant-menu-dark-1280x800')
      await askAgain.click()
      await more.click()
      await expect(page.getByRole('menuitem').first()).toBeVisible()
      await expect(askAgain).toHaveCount(0)
      await page.keyboard.press('Escape')
      await read(page, threadId, { plugin: 'gmail', search: {} })
      await expect(request).toHaveCount(1, { timeout: 30_000 })
      await allow.click()
      expect((await answered(page)).isError).toBe(false)
      await expect(request).toHaveCount(0)

      // Settings › Plugins says what was read and what was only asked for, newest first, and nothing of the mail.
      await openPage(page, 'Settings')
      await sections.getByRole('tab', { name: 'Plugins', exact: true }).click()
      await row.click()
      const used = card.getByRole('region', { name: 'Recent use' }).getByRole('listitem')
      await expect(used).toHaveCount(4)
      await expect(used.nth(0)).toContainText('Searched mail in “Check the checkout page”')
      await expect(used.nth(3)).toContainText('Asked to search mail in “Check the checkout page” You said no.')
      await expect(panel).not.toContainText('Lunch on Friday')
      await shot(page, 'gmail-recent-use-dark-1280x800')

      // Neither app password is written in the clear anywhere in Sotto's data folder, and the grant holds no address.
      const profile = dirname(root)
      for (const file of await filesUnder(profile)) {
        // As it is kept and as it was pasted: neither spelling is in any file.
        expect(file.text.includes(GOOD), file.path).toBe(false)
        expect(file.text.includes(GOOD_AS_SHOWN), file.path).toBe(false)
        expect(file.text.includes(BAD), file.path).toBe(false)
      }
      const grants = JSON.parse(await readFile(join(profile, 'plugin-mail-grants.json'), 'utf8')) as { grants: Record<string, unknown>[] }
      expect(grants.grants.map(grant => Object.keys(grant).sort())).toEqual([['accountId', 'at', 'threadId']])
      // Find a setting reaches the row by the service's name.
      const find = page.getByRole('searchbox', { name: 'Find a setting' })
      await sections.getByRole('tab', { name: 'Providers', exact: true }).click()
      await find.fill('Gmail')
      await expect(page.getByRole('list', { name: 'Settings found' }).getByRole('button').first()).toContainText('Gmail')
      await find.press('Enter')
      await expect(sections.getByRole('tab', { name: 'Plugins', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(row).toBeVisible()
      await openThreads(page)
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    if (previous === undefined) delete process.env.SOTTO_E2E_MAIL_PORT
    else process.env.SOTTO_E2E_MAIL_PORT = previous
    await mail.close()
  }
})
