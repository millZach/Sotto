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
 * A Higgsfield account on Settings › Plugins (ADR-0205; slice 13, part 1), on Owl, against a made-up Higgsfield API on
 * this computer that answers only the usage report, for one made-up key ID and key secret. A key Higgsfield refuses
 * saves nothing and says so; a good one is checked without making anything and its secret is never shown again. Ask
 * before each video and a monthly limit in US dollars live on the account (Zach's picks on #2499). Nothing reaches
 * Higgsfield, and every key is made up. Captures go to artifacts/plugins-higgsfield.
 */
const evidence = evidenceDirectory('artifacts/plugins-higgsfield')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const GOOD_ID = 'made-up-good-key-id-0123', GOOD_SECRET = 'made_up_good_key_secret_456789'
const BAD_ID = 'made-up-bad-key-id-9876', BAD_SECRET = 'made_up_bad_key_secret_543210'

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

test('A Higgsfield account is added on Plugins with its key ID and secret checked without making anything, and keeps Ask before each video and its limit in dollars', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(240_000)
  await mkdir(evidence, { recursive: true })
  // A made-up Higgsfield: the usage report, for the good key only, and nothing else.
  const asked: string[] = []
  const higgsfield = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`)
    const good = request.headers.authorization === `Key ${GOOD_ID}:${GOOD_SECRET}`
    if (request.method === 'GET' && request.url === '/models/usage' && good) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: [] }))
    } else response.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"Invalid credentials"}')
  })
  await new Promise<void>(resolve => higgsfield.listen(0, '127.0.0.1', resolve))
  const previous = process.env.SOTTO_E2E_HIGGSFIELD_API_URL
  process.env.SOTTO_E2E_HIGGSFIELD_API_URL = `http://127.0.0.1:${(higgsfield.address() as AddressInfo).port}`
  try {
    await withShownPictureThread('sotto-e2e-plugins-higgsfield-', async ({ launched, page, root }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Plugins', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      await expect(panel.getByText('3D, sound and video', { exact: true })).toBeVisible()
      const row = panel.getByRole('button', { name: /^Higgsfield/u })
      await expect(row).toHaveAccessibleName('Higgsfield Not added')
      await row.click()
      await panel.getByRole('button', { name: 'Add a Higgsfield account' }).click()
      const form = panel.getByRole('form', { name: 'Add a Higgsfield account' })
      await form.getByLabel('Name').fill('Videos')

      // A key ID with a colon in it is not one Higgsfield issued: the form says so, and nothing is sent.
      await form.getByLabel('Key ID').fill(`${GOOD_ID}:${GOOD_SECRET}`)
      await form.getByLabel('Key secret').fill(GOOD_SECRET)
      await expect(form).toContainText('A key ID is one line with no spaces or colons. Copy it again from Higgsfield’s console.')
      await expect(form.getByRole('button', { name: 'Add account' })).toHaveAttribute('aria-disabled', 'true')
      await resizeContentWindow(launched, 1280, 800, [800, 540])
      await form.scrollIntoViewIfNeeded()
      await shot(page, 'higgsfield-key-id-malformed-dark-1280x800')
      expect(asked).toEqual([])

      // A key Higgsfield refuses: nothing is saved, and the page says what to do.
      await form.getByLabel('Key ID').fill(BAD_ID)
      await form.getByLabel('Key secret').fill(BAD_SECRET)
      await form.getByRole('button', { name: 'Add account' }).click()
      await expect(form.getByRole('alert')).toHaveText('Higgsfield did not accept this key ID and secret. Nothing was saved. Check both in Higgsfield’s console at open.higgsfield.ai.')

      // A good one is kept, checked by reading the usage report and nothing else.
      await form.getByLabel('Key ID').fill(GOOD_ID)
      await form.getByLabel('Key secret').fill(GOOD_SECRET)
      await form.getByRole('button', { name: 'Add account' }).click()
      const card = panel.getByRole('region', { name: 'Higgsfield account Videos' })
      await expect(card).toContainText('Key saved')
      await expect(row).toHaveAccessibleName('Higgsfield Videos')
      expect(asked).toEqual(['GET /models/usage', 'GET /models/usage'])
      expect(await page.content()).not.toContain(GOOD_SECRET)

      // What it spends: asking is on, and the limit is $10, each saved as it changes.
      const spends = card.getByRole('region', { name: 'What it spends' })
      const ask = spends.getByRole('switch', { name: 'Ask before each video' })
      await expect(ask).toBeChecked()
      await expect(spends.getByLabel('Monthly limit in US dollars')).toHaveValue('10')
      // Nothing is counted for it until threads can make videos.
      await expect(spends).not.toContainText('Spent this month')
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          expect(await overflow(page), `Higgsfield ${width}x${height} ${mode}`).toEqual([])
          if (mode === 'dark' || width === 1280) {
            await spends.scrollIntoViewIfNeeded()
            await shot(page, `higgsfield-account-${mode}-${width}x${height}`)
          }
        }
      }
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await ask.click()
      await expect(ask).not.toBeChecked()
      await spends.getByLabel('Monthly limit in US dollars').fill('25')
      await spends.getByLabel('Monthly limit in US dollars').press('Enter')
      const accounts = await page.evaluate(async () => window.sotto!.plugins!.accounts())
      expect(accounts.find(account => account.plugin === 'higgsfield')?.spending).toEqual({ askBefore: false, monthlyLimit: 25 })
      await shot(page, 'higgsfield-spending-changed-dark-1280x800')

      // Neither key secret is written in the clear anywhere in Sotto's data folder.
      for (const file of await filesUnder(dirname(root))) {
        expect(file.text.includes(GOOD_SECRET), file.path).toBe(false)
        expect(file.text.includes(BAD_SECRET), file.path).toBe(false)
      }
      await openThreads(page)
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    if (previous === undefined) delete process.env.SOTTO_E2E_HIGGSFIELD_API_URL
    else process.env.SOTTO_E2E_HIGGSFIELD_API_URL = previous
    await new Promise<void>(resolve => higgsfield.close(() => resolve()))
  }
})
