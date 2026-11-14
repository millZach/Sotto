import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { startFakeImapServer } from '../fixtures/fakeImapServer'
import { readFakeSmtpMessage, startFakeSmtpServer } from '../fixtures/fakeSmtpServer'
import { withShownPictureThread } from './support/shownPictureThread'
import { openPage, openThreads, resizeWindow } from './support/sottoLaunch'

/**
 * A thread sending an email from a Gmail account (ADR-0205, slice 9), on Owl, against made-up mail servers on this
 * computer. Every email waits on a card in the thread that shows who it goes to, the Bcc too, the subject and the
 * whole text, and names the account as the user named it. Said no to, nothing reaches the server; allowed, the email
 * is sent once, as the account, with the Bcc in no line of it. Settings › Plugins then says an email was sent and one
 * was only asked for, and nothing of what it said. Nothing reaches Gmail, and every address and word is made up.
 * Captures go to artifacts/plugins-gmail-send for the verification note.
 */
const evidence = evidenceDirectory('artifacts/plugins-gmail-send')
const ADDRESS = 'reader@example.com'
const PASSWORD = 'madeupapppasswrd'
const EMAIL = {
  plugin: 'gmail', to: ['ann@example.com', 'ben@example.org'], cc: ['cara@example.com'], bcc: ['dan@example.net'], subject: 'October numbers by Friday',
  text: 'Hello Ann,\n\nThe filing date is the 30th, so the numbers for October need to reach us by Friday.\nI can call on Thursday if that is easier.\n\nThanks,\nZ.',
}

interface Held { __mailSend?: Promise<{ content: { type: string; text?: string }[]; isError?: boolean | undefined }> }

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}
/** Asks to send as the thread's agent would, and leaves the call waiting, as every send does until the user answers. */
async function send(page: Page, threadId: string): Promise<void> {
  await page.evaluate(request => { (window as unknown as Held).__mailSend = window.sottoE2E!.pluginTool!(request) }, { threadId, name: 'mail_send', arguments: EMAIL })
}
async function answered(page: Page): Promise<{ text: string; isError: boolean }> {
  const result = await page.evaluate(() => (window as unknown as Held).__mailSend!)
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

test('A thread sends an email from a Gmail account only once the user has allowed that email', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const imap = await startFakeImapServer({ address: ADDRESS, password: PASSWORD, mailboxes: [{ name: 'INBOX', validity: 7, messages: [] }] })
  const smtp = await startFakeSmtpServer({ address: ADDRESS, password: PASSWORD })
  const kept = ['SOTTO_E2E_MAIL_PORT', 'SOTTO_E2E_SMTP_PORT'] as const
  const previous = kept.map(name => process.env[name])
  process.env.SOTTO_E2E_MAIL_PORT = String(imap.port)
  process.env.SOTTO_E2E_SMTP_PORT = String(smtp.port)
  try {
    await withShownPictureThread('sotto-e2e-plugins-gmail-send-', async ({ launched, page, pane, threadId, root }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
      const sections = page.getByRole('tablist', { name: 'Settings sections' })

      // A Gmail account, added from its row. The row says a thread asks before each email it sends.
      await openPage(page, 'Settings')
      await sections.getByRole('tab', { name: 'Plugins', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      const row = panel.getByRole('button', { name: /^Gmail/u })
      await row.click()
      await expect(panel).toContainText('A thread asks you before each email it sends, and shows you the whole email first. It cannot move or delete mail, and a message it reads stays unread for you.')
      await panel.getByRole('button', { name: 'Add a Gmail account' }).click()
      const form = panel.getByRole('form', { name: 'Add a Gmail account' })
      await form.getByLabel('Name').fill('Personal')
      await form.getByLabel('Gmail address').fill(ADDRESS)
      await form.getByLabel('App password').fill(PASSWORD)
      await form.getByRole('button', { name: 'Add account' }).click()
      const card = panel.getByRole('region', { name: 'Gmail account Personal' })
      await expect(card).toContainText(`${ADDRESS}. App password saved`)
      // Adding it signed in to read; nothing was sent.
      expect(smtp.commands).toEqual([])

      // The thread's agent asks to send. The call waits on a card that shows the whole email and names the account by its name.
      await openThreads(page)
      await resizeWindow(launched, 1280, 800)
      await send(page, threadId)
      const request = pane.locator('section.agent-request[data-kind="permission"]')
      await expect(request).toHaveCount(1, { timeout: 30_000 })
      await expect(request.getByText('Send an email as Personal', { exact: true })).toBeVisible()
      await expect(request.getByText('ann@example.com, ben@example.org and 2 more', { exact: true })).toBeVisible()
      await expect(request.locator('.agent-request__details')).toHaveText(['To: ann@example.com, ben@example.org', 'Cc: cara@example.com', 'Bcc: dan@example.net', 'Subject: October numbers by Friday', '', EMAIL.text].join('\n'))
      await expect(request).not.toContainText(ADDRESS)
      const allow = request.getByRole('button', { name: 'Send the email', exact: true })
      const deny = request.getByRole('button', { name: 'Don’t send it', exact: true })
      await expect(allow).toBeVisible()
      await expect(deny).toBeVisible()
      // Nothing has reached the sending server while the card waits.
      expect(smtp.commands).toEqual([])

      for (const [mode, width, height] of [['dark', 1280, 800], ['light', 1280, 800], ['dark', 1600, 1000], ['dark', 820, 560]] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        await resizeWindow(launched, width, height)
        await expect(allow).toBeVisible()
        const [cardBox, paneBox] = [await request.boundingBox(), await pane.boundingBox()]
        expect(cardBox!.x + cardBox!.width, `card inside the pane at ${width}x${height}`).toBeLessThanOrEqual(paneBox!.x + paneBox!.width + 1)
        await shot(page, `send-card-${mode}-${width}x${height}`)
      }
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resizeWindow(launched, 1280, 800)

      // The user says no: the agent is told, and nothing reached the server.
      await deny.click()
      expect(await answered(page)).toEqual({ text: 'The user said no. Nothing was sent. Do not ask again unless they tell you to.', isError: true })
      await expect(request).toHaveCount(0)
      expect(smtp.commands).toEqual([])

      // Asked again, and allowed from the keyboard: it is sent once, as the account, to everyone, and the Bcc is in no line of it.
      await send(page, threadId)
      await expect(request).toHaveCount(1, { timeout: 30_000 })
      await allow.focus()
      await page.keyboard.press('Enter')
      expect(await answered(page)).toEqual({ text: 'The user allowed it. Sent from the Gmail account "Personal" to 4 addresses.', isError: false })
      await expect(request).toHaveCount(0)
      expect(smtp.messages).toHaveLength(1)
      const [message] = smtp.messages
      expect(message!.from).toBe(ADDRESS)
      expect(message!.to).toEqual(['ann@example.com', 'ben@example.org', 'cara@example.com', 'dan@example.net'])
      const read = readFakeSmtpMessage(message!.data)
      expect(read.headers['From']).toBe(ADDRESS)
      expect(read.headers['To']).toBe('ann@example.com, ben@example.org')
      expect(read.text.replace(/\r\n/gu, '\n')).toBe(EMAIL.text)
      expect(message!.data).not.toContain('dan@example.net')

      // Settings › Plugins says an email was sent and one was only asked for, newest first, and nothing of either.
      await openPage(page, 'Settings')
      await sections.getByRole('tab', { name: 'Plugins', exact: true }).click()
      await row.click()
      const used = card.getByRole('region', { name: 'Recent use' }).getByRole('listitem')
      await expect(used).toHaveCount(2)
      await expect(used.nth(0)).toContainText('Sent an email in “Check the checkout page” You allowed it.')
      await expect(used.nth(1)).toContainText('Asked to send an email in “Check the checkout page” You said no.')
      await expect(panel).not.toContainText('October numbers')
      await expect(panel).not.toContainText('ann@example.com')
      await card.getByRole('region', { name: 'Recent use' }).scrollIntoViewIfNeeded()
      await shot(page, 'gmail-send-recent-use-dark-1280x800')

      // The app password is written in the clear nowhere in Sotto's data folder, and the record of use names nobody.
      for (const file of await filesUnder(dirname(root))) expect(file.text.includes(PASSWORD), file.path).toBe(false)
      const record = await readFile(join(dirname(root), 'plugin-use.json'), 'utf8')
      expect(record).not.toMatch(/example\.(?:com|org|net)|October/u)
      await openThreads(page)
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    kept.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index] })
    await Promise.all([imap.close(), smtp.close()])
  }
})
