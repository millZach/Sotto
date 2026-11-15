import { createServer } from 'node:http'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { withShownPictureThread } from './support/shownPictureThread'
import { openPage, openThreads } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * A Meshy account on Settings › Plugins (ADR-0141, ADR-0205; slice 11, part 1), on Owl, against a made-up Meshy API on
 * this computer that answers only its balance. A key Meshy refuses saves nothing and says so; a good one is checked for
 * free and never shown again. Ask before each 3D model and the monthly credit limit live on the account (Zach's pick
 * on November 15, 2026). Nothing reaches Meshy, and every key is made up. Captures go to artifacts/plugins-meshy.
 */
const evidence = evidenceDirectory('artifacts/plugins-meshy')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const GOOD = 'msy_made_up_good_key_0123456789', BAD = 'msy_made_up_bad_key_9876543210'

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
async function filesUnder(folder: string): Promise<{ path: string; text: string }[]> {
  const found: { path: string; text: string }[] = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) { if (!/Cache|GPUCache|blob_storage|Code Cache|DawnCache|Network|native-fixture/u.test(entry.name)) found.push(...await filesUnder(path)); continue }
    if (/\.(json|log|txt|jsonl)$/u.test(entry.name)) found.push({ path, text: await readFile(path, 'utf8').catch(() => '') })
  }
  return found
}

test('A Meshy account is added on Plugins with its key checked for free, and keeps Ask before each 3D model and its limit', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(240_000)
  await mkdir(evidence, { recursive: true })
  // A made-up Meshy: the balance, for the good key only, and nothing else.
  const asked: string[] = []
  const meshy = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`)
    const good = request.headers.authorization === `Bearer ${GOOD}`
    if (request.method === 'GET' && request.url === '/openapi/v1/balance' && good) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ balance: 1000, monthly_credits: 1000, permanent_credits: 0, monthly_resets_at: null }))
    } else response.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"Invalid API key"}')
  })
  await new Promise<void>(resolve => meshy.listen(0, '127.0.0.1', resolve))
  const previous = process.env.SOTTO_E2E_MESHY_API_URL
  process.env.SOTTO_E2E_MESHY_API_URL = `http://127.0.0.1:${(meshy.address() as AddressInfo).port}`
  try {
    await withShownPictureThread('sotto-e2e-plugins-meshy-', async ({ launched, page, root }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Plugins', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      await expect(panel.getByText('3D, sound and video', { exact: true })).toBeVisible()
      const row = panel.getByRole('button', { name: /^Meshy/u })
      await expect(row).toHaveAccessibleName('Meshy Not added')
      await row.click()
      await panel.getByRole('button', { name: 'Add a Meshy account' }).click()
      const form = panel.getByRole('form', { name: 'Add a Meshy account' })
      await form.getByLabel('Name').fill('Studio')

      // A key Meshy refuses: nothing is saved, and the page says what to do.
      await form.getByLabel('API key').fill(BAD)
      await form.getByRole('button', { name: 'Add account' }).click()
      await expect(form.getByRole('alert')).toHaveText('Meshy did not accept this key. Nothing was saved. Make a key at meshy.ai/developers/keys: Meshy’s API needs a paid plan.')

      // A good one is kept, checked by reading the balance and nothing else.
      await form.getByLabel('API key').fill(GOOD)
      await form.getByRole('button', { name: 'Add account' }).click()
      const card = panel.getByRole('region', { name: 'Meshy account Studio' })
      await expect(card).toContainText('API key saved')
      await expect(row).toHaveAccessibleName('Meshy Studio')
      expect(asked).toEqual(['GET /openapi/v1/balance', 'GET /openapi/v1/balance'])
      expect(await page.content()).not.toContain(GOOD)

      // What it spends: asking is on, and the limit is 1,000 credits, each saved as it changes.
      const spends = card.getByRole('region', { name: 'What it spends' })
      const ask = spends.getByRole('switch', { name: 'Ask before each 3D model' })
      await expect(ask).toBeChecked()
      await expect(spends.getByLabel('Monthly credit limit')).toHaveValue('1000')
      // And what this month's 3D models took against it: none yet.
      await expect(spends).toContainText('Credits this month: 0 of 1,000.')
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          expect(await overflow(page), `Meshy ${width}x${height} ${mode}`).toEqual([])
          if (mode === 'dark' || width === 1280) {
            await spends.scrollIntoViewIfNeeded()
            await shot(page, `meshy-account-${mode}-${width}x${height}`)
          }
        }
      }
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await ask.click()
      await expect(ask).not.toBeChecked()
      await spends.getByLabel('Monthly credit limit').fill('300')
      await spends.getByLabel('Monthly credit limit').press('Enter')
      const accounts = await page.evaluate(async () => window.sotto!.plugins!.accounts())
      expect(accounts.find(account => account.plugin === 'meshy')?.spending).toEqual({ askBefore: false, monthlyLimit: 300 })
      await shot(page, 'meshy-spending-changed-dark-1280x800')

      // Neither key is written in the clear anywhere in Sotto's data folder.
      for (const file of await filesUnder(dirname(root))) {
        expect(file.text.includes(GOOD), file.path).toBe(false)
        expect(file.text.includes(BAD), file.path).toBe(false)
      }
      await openThreads(page)
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    if (previous === undefined) delete process.env.SOTTO_E2E_MESHY_API_URL
    else process.env.SOTTO_E2E_MESHY_API_URL = previous
    await new Promise<void>(resolve => meshy.close(() => resolve()))
  }
})
