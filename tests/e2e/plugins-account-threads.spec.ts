import { createServer, type Server } from 'node:http'
import { mkdir } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { withShownPictureThread } from './support/shownPictureThread'
import { openPage, resizeWindow } from './support/sottoLaunch'

/**
 * Which threads may use a plugin account (ADR-0205, decision 9), on Owl: an account's switch and the projects it is
 * kept to, on Settings › Plugins, and what a real thread's agent is told at its next call. Switched off, or kept to
 * another project, the account is not there for the thread; switched back on, or given back to every project, it is.
 * Vercel is a stand-in on this computer that knows one made-up token. Captures go to artifacts/plugins-account-threads.
 */
const evidence = evidenceDirectory('artifacts/plugins-account-threads')
const OWNED = ['SOTTO_E2E_VERCEL_API_URL'] as const
/** A made-up token: nothing here is a real credential. */
const TOKEN = 'made-up-token-vercel-accepts'
const WITHHELD = 'no account is available to this thread: the user has switched it off or kept it to other projects'

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** Vercel, as far as checking a token goes. Everything asked of it is kept. */
async function standInVercel(): Promise<{ server: Server; url: string; asked: string[] }> {
  const asked: string[] = []
  const server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`)
    const good = request.headers.authorization === `Bearer ${TOKEN}`
    response.writeHead(good ? 200 : 403, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(good ? (request.url === '/v2/user' ? { user: { username: 'example-user' } } : { deployments: [] }) : { error: { code: 'forbidden', invalidToken: true } }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked }
}

/** What the thread's agent is told when it calls a plugin tool, as text. */
async function told(page: Page, threadId: string, name: string, args: unknown): Promise<string> {
  const result = await page.evaluate(request => window.sottoE2E!.pluginTool!(request), { threadId, name, arguments: args })
  return result.content.map(part => part.type === 'text' ? part.text : '').join('\n')
}

/** Anything in the open Plugins page that is wider than the room it sits in. */
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

test('An account switched off, or kept to another project, is not there for a thread at its next call', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const vercel = await standInVercel()
  const previous = Object.fromEntries(OWNED.map(key => [key, process.env[key]]))
  process.env.SOTTO_E2E_VERCEL_API_URL = vercel.url
  try {
    await withShownPictureThread('sotto-e2e-plugins-account-threads-', async ({ launched, page, threadId, root }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      // A second project, which the thread is not in: the thread is in Lumen shop.
      const other = join(root, 'other-site')
      await mkdir(other, { recursive: true })
      await page.evaluate(async path => {
        await window.sotto!.updateSettings({ reducedMotion: 'on' })
        const made = await window.sotto!.agents!.command({ type: 'create-project', provider: 'codex', title: 'Other site', path, useExisting: true })
        if (made.error) throw new Error(made.error)
      }, other)
      const added = await page.evaluate(async secret => window.sotto!.plugins!.addAccount({ plugin: 'vercel', name: 'Work', secret }), TOKEN)
      expect(added.ok).toBe(true)

      // A new account is for every thread: the thread's agent is told of it and reads through it.
      expect(await told(page, threadId, 'plugin_accounts', {})).toContain('Vercel: account "Work".')
      expect(await told(page, threadId, 'plugin_read', { plugin: 'vercel', path: 'v6/deployments' })).toContain('deployments')

      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Plugins', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      const row = panel.getByRole('button', { name: /^Vercel/u })
      await row.click()
      const card = panel.getByRole('region', { name: 'Vercel account Work' })
      const toggle = card.getByRole('switch', { name: 'Threads may use Work' })
      const chips = card.getByRole('group', { name: 'Projects whose threads may use Work' })
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await expect(chips.getByRole('button')).toHaveText(['Every project', 'Lumen shop', 'Other site'])
      await expect(chips.getByRole('button', { name: 'Every project' })).toHaveAttribute('aria-pressed', 'true')
      await expect(card).toContainText('Threads in every project may use it, and so may Watcher.')

      // Kept to the other project, from the keyboard: the thread, which is in Lumen shop, loses it at its next call.
      await chips.getByRole('button', { name: 'Other site' }).focus()
      await page.keyboard.press('Enter')
      await expect(chips.getByRole('button', { name: 'Other site' })).toHaveAttribute('aria-pressed', 'true')
      await expect(chips.getByRole('button', { name: 'Every project' })).toHaveAttribute('aria-pressed', 'false')
      await expect(card).toContainText('Only threads in Other site may use it. Watcher belongs to no project, so it cannot.')
      expect(await told(page, threadId, 'plugin_accounts', {})).toContain(WITHHELD)
      const refused = await told(page, threadId, 'plugin_read', { plugin: 'vercel', account: 'Work', path: 'v6/deployments' })
      expect(refused).toContain('No Vercel account is available to this thread')
      const before = vercel.asked.length

      for (const [mode, width, height] of [['dark', 1600, 1000], ['dark', 1280, 800], ['light', 1280, 800], ['dark', 820, 560]] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        await resizeWindow(launched, width, height)
        expect(await overflow(page), `Plugins ${width}x${height} ${mode}`).toEqual([])
        // At the smallest window the account sits below the fold: it is brought into view, as a user scrolls to it.
        await chips.scrollIntoViewIfNeeded()
        if (width !== 1600) await shot(page, `account-kept-to-a-project-${mode}-${width}x${height}`)
      }
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })

      // Its own project pressed as well: the thread has the account again.
      await chips.getByRole('button', { name: 'Lumen shop' }).click()
      await expect(card).toContainText('Only threads in Other site, Lumen shop may use it.')
      expect(await told(page, threadId, 'plugin_accounts', {})).toContain('Vercel: account "Work".')

      // Switched off: no thread has it, the folded row says so, and nothing was asked of Vercel for the refused calls.
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect(card).toContainText('Off. No thread can see or use this account until you turn it back on. Its token stays saved.')
      await expect(chips).toHaveCount(0)
      await expect(row).toHaveAccessibleName('Vercel Work (off)')
      expect(await told(page, threadId, 'plugin_accounts', {})).toContain(WITHHELD)
      await shot(page, 'account-off-dark-1280x800')
      expect(vercel.asked.length).toBe(before)

      // Back on, and back to every project: the last project let go gives it to all of them.
      await toggle.click()
      await chips.getByRole('button', { name: 'Every project' }).click()
      await expect(chips.getByRole('button', { name: 'Every project' })).toHaveAttribute('aria-pressed', 'true')
      await expect(chips.getByRole('button', { name: 'Other site' })).toHaveAttribute('aria-pressed', 'false')
      expect(await told(page, threadId, 'plugin_accounts', {})).toContain('Vercel: account "Work".')
      await expect(page.locator('body')).not.toContainText(TOKEN)
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    for (const key of OWNED) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    await new Promise<void>(done => vercel.server.close(() => done()))
  }
})
