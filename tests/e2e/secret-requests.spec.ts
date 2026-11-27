import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { BrowserTask } from '../../src/shared/browser'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { captureSotto } from './support/sottoCapture'
import { evidenceDirectory } from '../fixtures/evidence'

// A secret request in the built app (ADR-0219, an Owl feature): an agent asks for values it never sees, on a private
// card in its thread. The user types them from the keyboard; the agent gets a file its command reads, or a one-use
// reference Sotto's browser types into a password field. One known value goes through both, and the test asserts it is
// nowhere in the window, the tool results, main's output or Sotto's folder but the secret file. Captures go to
// disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/secret-requests.

const SHOTS = evidenceDirectory('artifacts/secret-requests')
const CANARY = 'canary-E2E-5d1f9b-s3cr3t'
const LOGIN = `<!doctype html><html><head><title>Staging sign in</title><style>body{font:16px system-ui;margin:24px}input,button{display:block;margin:8px 0;padding:8px;font:inherit}</style></head>
<body><h1>Staging</h1><label for="password">Password</label><input id="password" type="password" autofocus>
<button id="go" onclick="document.title = document.querySelector('#password').value === '${CANARY}' ? 'Signed in' : 'Wrong password'">Sign in</button></body></html>`

async function launch(): Promise<LaunchedSotto> {
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = 'secret-requests=1'
  try { return await launchSotto() } finally { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous }
}
type ToolReply = { content: { type: string; text?: string }[]; isError?: boolean }
const json = (reply: ToolReply): Record<string, unknown> => JSON.parse(reply.content.find(item => item.type === 'text')!.text!) as Record<string, unknown>
/** Starts request_secret as the thread's agent would, without waiting: the call returns once the card is answered. */
async function ask(page: Page, args: Record<string, unknown>): Promise<void> {
  await page.evaluate(request => {
    const slot = window as unknown as { pendingSecret?: Promise<unknown> }
    slot.pendingSecret = window.sottoE2E!.secretTool!(request)
  }, { threadId: 'workshop', name: 'request_secret' as const, arguments: args })
}
async function answered(page: Page): Promise<ToolReply> {
  return page.evaluate(async () => await (window as unknown as { pendingSecret: Promise<unknown> }).pendingSecret) as Promise<ToolReply>
}
const card = (page: Page, title: string): Locator => page.locator('section.thread-pane').getByRole('region', { name: title })
async function files(folder: string): Promise<string[]> {
  if (!existsSync(folder)) return []
  return (await Promise.all((await readdir(folder, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)]))).flat()
}

test('an agent asks for a secret on a private card, gets a file or a reference, and never the value', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(LOGIN) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Login server unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launch().catch(error => { server.close(); throw error })
  const { page, app } = launched
  const output: string[] = []
  app.process().stdout?.on('data', chunk => output.push(String(chunk)))
  app.process().stderr?.on('data', chunk => output.push(String(chunk)))
  const replies: ToolReply[] = []
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await resizeContentWindow(launched, 1280, 800, [800, 540]); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()

    // A file for a command: the card takes the value from the keyboard alone.
    await ask(page, { label: 'Sudo password', reason: 'To install the USB driver with sudo -S.', delivery: 'file' })
    const sudo = card(page, 'Sudo password')
    await expect(sudo).toBeVisible()
    await expect(sudo.getByText('Private')).toBeVisible()
    await captureSotto(launched, join(SHOTS, 'card-1280-dark.png'), { mode: 'dom', screenshot: { animations: 'disabled' } })
    await sudo.getByLabel('Value').focus()
    await page.keyboard.type(CANARY)
    await page.keyboard.press('Enter')
    const fileReply = await answered(page); replies.push(fileReply)
    const saved = json(fileReply)
    expect(saved.status).toBe('saved')
    const file = saved.file as string
    expect(await readFile(file, 'utf8')).toBe(CANARY)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    await expect(sudo).toBeHidden()
    const released = await page.evaluate(async path => window.sottoE2E!.secretTool!({ threadId: 'workshop', name: 'release_secret', arguments: { files: [path] } }), file)
    replies.push(released)
    expect(json(released)).toEqual({ released: 1 })
    await expect.poll(() => existsSync(file)).toBe(false)

    // Several values on one card, then declined from the keyboard.
    await ask(page, { label: 'Database login', reason: 'To run the migration.', fields: [{ name: 'user', label: 'User name', secret: false }, { name: 'password', label: 'Password' }], url: 'https://example.com/account' })
    const database = card(page, 'Database login')
    await expect(database.getByLabel('User name')).toHaveAttribute('type', 'text')
    await expect(database.getByLabel('Password')).toHaveAttribute('type', 'password')
    await expect(database.getByRole('button', { name: 'Open sign-in page' })).toBeVisible()
    await captureSotto(launched, join(SHOTS, 'fields-1280-dark.png'), { mode: 'dom', screenshot: { animations: 'disabled' } })
    await database.getByRole('button', { name: 'Decline' }).focus()
    await page.keyboard.press('Enter')
    const declined = await answered(page); replies.push(declined)
    expect(json(declined).status).toBe('declined')

    // A one-use reference, typed by Sotto's browser into a password field.
    await ask(page, { label: 'Staging password', reason: 'To sign in to staging.' })
    const staging = card(page, 'Staging password')
    await staging.getByLabel('Value').fill(CANARY)
    await staging.getByRole('button', { name: 'Save securely' }).click()
    const refReply = await answered(page); replies.push(refReply)
    const secretRef = json(refReply).secretRef as string
    expect(secretRef).toMatch(/^secret-ref:[0-9a-f]{32}$/u)
    const agent = async (name: string, args: unknown): Promise<ToolReply> => {
      const reply = await page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args }) as ToolReply
      replies.push(reply)
      return reply
    }
    expect((await agent('browser_open', { url, description: 'Sign in to staging' })).isError).not.toBe(true)
    const task = (await page.evaluate(async () => { const result = await window.sotto!.browser!.tasks({ threadId: 'workshop' }); return result.ok ? result.value : [] }))[0] as BrowserTask
    const action = (value: unknown) => agent('browser_action', { taskId: task.id, pageId: task.pageId, action: value })
    await expect.poll(async () => JSON.stringify(json(await agent('browser_pages', {})))).toContain('Staging sign in')
    // The browser player draws the page small; a viewport of its own keeps the button inside the page's visible area.
    expect((await action({ type: 'viewport', width: 1024, height: 768 })).isError).not.toBe(true)
    // Focus the password field the way an agent would: inspect, then click its middle.
    const looked = JSON.parse(String(json(await action({ type: 'inspect' })).output)) as { elements: { tag: string; x: number; y: number; width: number; height: number }[] }
    const field = looked.elements.find(element => element.tag === 'input')!
    await action({ type: 'click', x: Math.round(field.x + field.width / 2), y: Math.round(field.y + field.height / 2) })
    expect((await action({ type: 'type', secretRef })).isError).not.toBe(true)
    expect((await action({ type: 'type', secretRef })).isError).toBe(true)
    const button = looked.elements.find(element => element.tag === 'button')!
    await action({ type: 'click', x: Math.round(button.x + button.width / 2), y: Math.round(button.y + button.height / 2) })
    // The page's title, as its accessibility tree's root names it, says whether the typed password was the one saved.
    await expect.poll(async () => String(json(await action({ type: 'inspect' })).output)).toContain('Signed in')
    await action({ type: 'screenshot' })

    // The value is in none of it: the window, the tool results, main's output, Sotto's folder but the secret files.
    expect(await page.content()).not.toContain(CANARY)
    for (const reply of replies) expect(JSON.stringify(reply)).not.toContain(CANARY)
    // Sotto quits first, so its folder is read whole: quitting deletes every secret file and empties their folder.
    await app.close()
    expect(output.join('')).not.toContain(CANARY)
    for (const path of await files(launched.userData)) {
      const size = (await stat(path)).size
      if (size > 64 * 1024 * 1024) continue
      expect((await readFile(path)).includes(Buffer.from(CANARY)), path).toBe(false)
    }
  } finally {
    server.close()
    await closeSotto(launched)
  }
})
