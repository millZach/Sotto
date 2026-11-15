import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { BRIDGE_CERTIFICATE } from '../fixtures/bridgeCertificates'
import { evidenceDirectory } from '../fixtures/evidence'
import { startFakeImapServer } from '../fixtures/fakeImapServer'
import { startFakeSmtpServer } from '../fixtures/fakeSmtpServer'
import { withShownPictureThread } from './support/shownPictureThread'
import { openPage, openThreads, resizeWindow } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * A Proton Mail account on Settings › Plugins, reached through Proton Mail Bridge on this computer (ADR-0205, slice 10),
 * on Owl, against a made-up Bridge: IMAP and SMTP servers on 127.0.0.1 that begin in the clear, offer STARTTLS and show
 * a certificate of their own, as Bridge does. The account is added with Bridge's ports, read and sent from as Gmail is,
 * and the row says when Bridge is closed. Nothing reaches Proton, and every address, password and word is made up.
 * Captures go to artifacts/plugins-proton-mail for the verification note.
 */
const evidence = evidenceDirectory('artifacts/plugins-proton-mail')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const ADDRESS = 'reader@proton.example'
const PASSWORD = 'made-up-bridge-password'

interface Held { __proton?: Promise<{ content: { type: string; text?: string }[]; isError?: boolean | undefined }> }

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
/** Calls a plugin tool as the thread's agent would, and leaves the call waiting on its card. */
async function call(page: Page, threadId: string, name: string, args: unknown): Promise<void> {
  await page.evaluate(request => { (window as unknown as Held).__proton = window.sottoE2E!.pluginTool!(request) }, { threadId, name, arguments: args })
}
async function answered(page: Page): Promise<{ text: string; isError: boolean }> {
  const result = await page.evaluate(() => (window as unknown as Held).__proton!)
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

test('A Proton Mail account is added with Bridge’s ports, read and sent from through Bridge, and the row says when Bridge is closed', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const imap = await startFakeImapServer({ address: ADDRESS, password: PASSWORD, startTls: BRIDGE_CERTIFICATE, capabilities: ['UIDPLUS'], mailboxes: [{ name: 'INBOX', validity: 3, messages: [
    { uid: 7, received: '14-Nov-2026 09:30:00 +0000', headers: { From: 'Ann Example <ann@example.com>', To: ADDRESS, Subject: 'Tea on Saturday' }, body: { type: 'text/plain', body: 'Shall we have tea on Saturday?' } },
  ] }, { name: 'Sent', validity: 4, messages: [] }] })
  const smtp = await startFakeSmtpServer({ address: ADDRESS, password: PASSWORD, startTls: BRIDGE_CERTIFICATE })
  let imapOpen = true
  // A run reaches only stand-ins it names. Bridge is on this computer, so the ports given in the form are the stand-ins' own.
  const previous = process.env.SOTTO_E2E_MAIL_PORT
  process.env.SOTTO_E2E_MAIL_PORT = String(imap.port)
  try {
    await withShownPictureThread('sotto-e2e-plugins-proton-', async ({ launched, page, pane, threadId, root }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
      const sections = page.getByRole('tablist', { name: 'Settings sections' })

      // Proton Mail has its row under Mail, beside Gmail. Its form asks for Bridge's ports, filled in with Bridge's own.
      await openPage(page, 'Settings')
      await sections.getByRole('tab', { name: 'Plugins', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      const row = panel.getByRole('button', { name: /^Proton Mail/u })
      await expect(row).toHaveAccessibleName('Proton Mail Not added')
      await row.click()
      await panel.getByRole('button', { name: 'Add a Proton Mail account' }).click()
      const form = panel.getByRole('form', { name: 'Add a Proton Mail account' })
      await expect(form.getByLabel('IMAP port')).toHaveValue('1143')
      await expect(form.getByLabel('SMTP port')).toHaveValue('1025')
      await form.getByLabel('Name').fill('Private')
      await form.getByLabel('Proton address').fill(ADDRESS)
      await form.getByLabel('Bridge password').fill(PASSWORD)
      await resizeContentWindow(launched, 1280, 800, [800, 540])
      await form.getByRole('button', { name: 'Add account' }).scrollIntoViewIfNeeded()
      await shot(page, 'proton-add-form-dark-1280x800')
      await form.getByLabel('IMAP port').fill(String(imap.port))
      await form.getByLabel('SMTP port').fill(String(smtp.port))
      await form.getByRole('button', { name: 'Add account' }).click()
      const card = panel.getByRole('region', { name: 'Proton Mail account Private' })
      await expect(card).toContainText(`${ADDRESS}. Bridge password saved`)
      await expect(row).toHaveAccessibleName('Proton Mail Private')
      expect(await page.content()).not.toContain(PASSWORD)
      // Adding signed in to Bridge over TLS, and only after the connection was made TLS.
      expect(imap.commands.slice(0, 4)).toEqual(['CAPABILITY', 'STARTTLS', 'CAPABILITY', 'LOGIN'])
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          expect(await overflow(page), `Proton Mail ${width}x${height} ${mode}`).toEqual([])
          if (mode === 'dark' || width === 1280) await shot(page, `proton-account-${mode}-${width}x${height}`)
        }
      }
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resizeWindow(launched, 1280, 800)

      // A thread reads the account once the user allows it, through Bridge.
      await openThreads(page)
      const request = pane.locator('section.agent-request[data-kind="permission"]')
      await call(page, threadId, 'plugin_read', { plugin: 'proton-mail', search: {} })
      await expect(request).toHaveCount(1, { timeout: 30_000 })
      await expect(request.getByText('Read Proton Mail mail', { exact: true })).toBeVisible()
      await request.getByRole('button', { name: 'Let this thread read it', exact: true }).click()
      const read = await answered(page)
      expect(read.isError).toBe(false)
      expect(read.text).toContain('Tea on Saturday')
      await expect(request).toHaveCount(0)

      // And sends from it once the user allows that email: as the account, through Bridge.
      await call(page, threadId, 'mail_send', { plugin: 'proton-mail', to: ['ann@example.com'], subject: 'Re: Tea on Saturday', text: 'Yes, Saturday suits me.' })
      await expect(request).toHaveCount(1, { timeout: 30_000 })
      await expect(request.getByText('Send an email as Private', { exact: true })).toBeVisible()
      await shot(page, 'proton-send-card-dark-1280x800')
      await request.getByRole('button', { name: 'Send the email', exact: true }).click()
      expect(await answered(page)).toEqual({ text: 'The user allowed it. Sent from the Proton Mail account "Private" to 1 address.', isError: false })
      expect(smtp.messages).toHaveLength(1)
      expect(smtp.messages[0]!.from).toBe(ADDRESS)
      expect(smtp.commands.slice(0, 4)).toEqual(['EHLO [127.0.0.1]', 'STARTTLS', 'EHLO [127.0.0.1]', 'AUTH PLAIN'])

      // Bridge closed: the row and the account say so, and the thread is told rather than left waiting.
      await imap.close()
      imapOpen = false
      await call(page, threadId, 'plugin_read', { plugin: 'proton-mail', search: {} })
      expect(await answered(page)).toEqual({ text: 'Proton Mail Bridge isn\'t running on this computer, or isn\'t answering. Ask the user to open Bridge, then try again. Nothing was read.', isError: true })
      await openPage(page, 'Settings')
      await sections.getByRole('tab', { name: 'Plugins', exact: true }).click()
      await expect(row).toHaveAccessibleName('Proton Mail Bridge isn’t running', { timeout: 30_000 })
      await row.click()
      await expect(card).toContainText('Proton Mail Bridge isn’t running on this computer, so threads can’t read or send this account’s mail. Open Bridge, then look again.')
      await expect(card.getByRole('button', { name: 'Look again', exact: true })).toBeVisible()
      await shot(page, 'proton-bridge-not-running-dark-1280x800')

      // The Bridge password is written in the clear nowhere in Sotto's data folder.
      for (const file of await filesUnder(dirname(root))) expect(file.text.includes(PASSWORD), file.path).toBe(false)
      await openThreads(page)
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    if (previous === undefined) delete process.env.SOTTO_E2E_MAIL_PORT
    else process.env.SOTTO_E2E_MAIL_PORT = previous
    await Promise.all([imapOpen ? imap.close() : Promise.resolve(), smtp.close()])
  }
})
