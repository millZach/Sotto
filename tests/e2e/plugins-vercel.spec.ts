import { resizeContentWindow } from './support/sottoWindow'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'

/**
 * A Vercel account on Settings › Plugins (ADR-0205, slice 3), on Owl, against a stand-in for Vercel's API on this
 * computer: a token Vercel refuses saves nothing and says so, a good one is kept and never shown again or written in
 * the clear, the row fits the three checked sizes in both modes, Escape cancels Replace, and Remove asks first. Nothing
 * reaches Vercel, and the tokens are made up. Captures go to artifacts/plugins-vercel for the verification note.
 */
const evidence = evidenceDirectory('artifacts/plugins-vercel')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const OWNED = ['SOTTO_OWL_FEATURES', 'SOTTO_E2E_VERCEL_API_URL'] as const
const GOOD = 'made-up-token-vercel-accepts', BAD = 'made-up-token-vercel-refuses'

const sections = (page: Page) => page.getByRole('tablist', { name: 'Settings sections' })

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

/** Vercel, as far as checking a token goes: it says who a good token belongs to and refuses any other. */
async function standInVercel(): Promise<{ server: Server; url: string; asked: string[] }> {
  const asked: string[] = []
  const server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`)
    const good = request.headers.authorization === `Bearer ${GOOD}`
    response.writeHead(good ? 200 : 403, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(good ? { user: { username: 'example-user', email: 'someone@example.com' } } : { error: { code: 'forbidden', message: 'Not authorized', invalidToken: true } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked }
}

/** Every file under a folder, as text, to look for something that must not be in any of them. */
async function filesUnder(folder: string): Promise<{ path: string; text: string }[]> {
  const found: { path: string; text: string }[] = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) { if (!/Cache|GPUCache|blob_storage|Code Cache|DawnCache|Network/u.test(entry.name)) found.push(...await filesUnder(path)); continue }
    if (/\.(json|log|txt|jsonl)$/u.test(entry.name)) found.push({ path, text: await readFile(path, 'utf8').catch(() => '') })
  }
  return found
}

test('A Vercel account is checked, kept without its token showing anywhere, replaced and removed from its row', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-plugins-vercel-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, reducedMotion: 'on' }), 'utf8')
  const vercel = await standInVercel()
  const previous = Object.fromEntries(OWNED.map(key => [key, process.env[key]]))
  process.env.SOTTO_OWL_FEATURES = 'plugins=1'
  process.env.SOTTO_E2E_VERCEL_API_URL = vercel.url
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await openPage(page, 'Settings')
    await sections(page).getByRole('tab', { name: 'Plugins', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
    const row = panel.getByRole('button', { name: /^Vercel/u })
    await expect(row).toHaveAccessibleName('Vercel Not added')
    await row.click()
    await panel.getByRole('button', { name: 'Add a Vercel account' }).click()
    const form = panel.getByRole('form', { name: 'Add a Vercel account' })
    await expect(form.getByLabel('Name')).toBeFocused()

    // A token Vercel refuses: nothing is saved, and the page says so and what to do.
    await form.getByLabel('Name').fill('Work')
    await form.getByLabel('Token').fill(BAD)
    await page.keyboard.press('Enter')
    await expect(form.getByRole('alert')).toHaveText('Vercel did not accept this token. Nothing was saved. Make a new token at vercel.com/account/tokens and paste it here.')
    await resizeContentWindow(launched, 1280, 800, [800, 540])
    await shot(page, 'vercel-token-refused-dark-1280x800')

    // A token it accepts: the account shows, with who Vercel says it is, and the token is gone from the page.
    await form.getByLabel('Token').fill(GOOD)
    await form.getByRole('button', { name: 'Add account' }).click()
    const card = panel.getByRole('region', { name: 'Vercel account Work' })
    await expect(card).toContainText('Signed in to Vercel as example-user. Token saved')
    await expect(row).toHaveAccessibleName('Vercel Work')
    await expect(panel.getByRole('form', { name: 'Add a Vercel account' })).toHaveCount(0)
    expect(await page.content()).not.toContain(GOOD)
    expect(vercel.asked).toEqual(['GET /v2/user', 'GET /v2/user'])

    for (const mode of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
      for (const [width, height] of SIZES) {
        await resizeContentWindow(launched, width, height, [800, 540])
        expect(await overflow(page), `Vercel ${width}x${height} ${mode}`).toEqual([])
        if (mode === 'dark' || width === 1280) await shot(page, `vercel-account-${mode}-${width}x${height}`)
      }
    }
    await resizeContentWindow(launched, 1280, 800)
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })

    // Replace opens a field of its own; Escape cancels it, keeps the row open and gives focus back to Replace.
    const replace = card.getByRole('button', { name: 'Replace the token for Work' })
    await replace.click()
    await expect(card.getByLabel('New token')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(card.getByLabel('New token')).toHaveCount(0)
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    await expect(replace).toBeFocused()

    // Neither token is written in the clear anywhere in Sotto's data folder: not in the record of accounts, not in a log.
    for (const file of await filesUnder(profile)) {
      expect(file.text.includes(GOOD), file.path).toBe(false)
      expect(file.text.includes(BAD), file.path).toBe(false)
    }
    const kept = JSON.parse(await readFile(join(profile, 'plugin-accounts.json'), 'utf8')) as { accounts: Record<string, unknown>[] }
    expect(kept.accounts.map(account => Object.keys(account).sort())).toEqual([['id', 'name', 'on', 'plugin', 'projects', 'savedAt', 'signedInAs']])

    // Remove asks first, and says what is deleted.
    await card.getByRole('button', { name: 'Remove the Vercel account Work' }).click()
    await expect(card.getByRole('group', { name: 'Remove the Vercel account Work' })).toContainText('Its token is deleted from this computer, and threads lose the account at once. Nothing changes at Vercel.')
    await shot(page, 'vercel-remove-asks-dark-1280x800')
    await card.getByRole('button', { name: 'Remove account' }).click()
    await expect(row).toHaveAccessibleName('Vercel Not added')
    expect((JSON.parse(await readFile(join(profile, 'plugin-accounts.json'), 'utf8')) as { accounts: unknown[] }).accounts).toEqual([])
    expect(errors).toEqual([])
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    await new Promise(resolve => vercel.server.close(resolve))
    for (const key of OWNED) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    await removeOwnedE2EProfile(profile)
  }
})
