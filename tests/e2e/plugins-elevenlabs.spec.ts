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
 * An ElevenLabs account on Settings › Plugins (ADR-0205; slice 12, part 1), on Owl, against a made-up ElevenLabs API on
 * this computer that answers only the account's subscription. A key ElevenLabs refuses saves nothing and says so; a good
 * one is checked without making anything and never shown again. Ask before each sound and a monthly limit in US
 * dollars live on the account (Zach's picks on #2498, the tag prototype/elevenlabs). Nothing reaches ElevenLabs, and
 * every key is made up. Captures go to artifacts/plugins-elevenlabs.
 */
const evidence = evidenceDirectory('artifacts/plugins-elevenlabs')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const GOOD = 'sk_made_up_good_elevenlabs_key_0123456789', BAD = 'sk_made_up_bad_elevenlabs_key_9876543210'

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

test('An ElevenLabs account is added on Plugins with its key checked without making anything, and keeps Ask before each sound and its limit in dollars', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(240_000)
  await mkdir(evidence, { recursive: true })
  // A made-up ElevenLabs: the account's subscription, for the good key only, and nothing else.
  const asked: string[] = []
  const elevenLabs = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`)
    const good = request.headers['xi-api-key'] === GOOD
    if (request.method === 'GET' && request.url === '/v1/user/subscription' && good) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tier: 'creator', character_count: 0, character_limit: 100000, status: 'active' }))
    } else response.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":{"status":"invalid_api_key"}}')
  })
  await new Promise<void>(resolve => elevenLabs.listen(0, '127.0.0.1', resolve))
  const previous = process.env.SOTTO_E2E_ELEVENLABS_API_URL
  process.env.SOTTO_E2E_ELEVENLABS_API_URL = `http://127.0.0.1:${(elevenLabs.address() as AddressInfo).port}`
  try {
    await withShownPictureThread('sotto-e2e-plugins-elevenlabs-', async ({ launched, page, root }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Plugins', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      await expect(panel.getByText('3D, sound and video', { exact: true })).toBeVisible()
      const row = panel.getByRole('button', { name: /^ElevenLabs/u })
      await expect(row).toHaveAccessibleName('ElevenLabs Not added')
      await row.click()
      await panel.getByRole('button', { name: 'Add an ElevenLabs account' }).click()
      const form = panel.getByRole('form', { name: 'Add an ElevenLabs account' })
      await form.getByLabel('Name').fill('Voices')

      // A key ElevenLabs refuses: nothing is saved, and the page says what to do.
      await form.getByLabel('API key').fill(BAD)
      await form.getByRole('button', { name: 'Add account' }).click()
      await expect(form.getByRole('alert')).toHaveText('ElevenLabs did not accept this key. Nothing was saved. Check the key at elevenlabs.io/app/settings/api-keys. A restricted key must be allowed to read your account.')

      // A good one is kept, checked by reading the subscription and nothing else.
      await form.getByLabel('API key').fill(GOOD)
      await form.getByRole('button', { name: 'Add account' }).click()
      const card = panel.getByRole('region', { name: 'ElevenLabs account Voices' })
      await expect(card).toContainText('API key saved')
      await expect(row).toHaveAccessibleName('ElevenLabs Voices')
      expect(asked).toEqual(['GET /v1/user/subscription', 'GET /v1/user/subscription'])
      expect(await page.content()).not.toContain(GOOD)

      // What it spends: asking is on, and the limit is $10, each saved as it changes.
      const spends = card.getByRole('region', { name: 'What it spends' })
      const ask = spends.getByRole('switch', { name: 'Ask before each sound' })
      await expect(ask).toBeChecked()
      await expect(spends.getByLabel('Monthly limit in US dollars')).toHaveValue('10')
      // Nothing is counted against it until threads make sounds.
      await expect(spends).not.toContainText('Credits this month')
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          expect(await overflow(page), `ElevenLabs ${width}x${height} ${mode}`).toEqual([])
          if (mode === 'dark' || width === 1280) {
            await spends.scrollIntoViewIfNeeded()
            await shot(page, `elevenlabs-account-${mode}-${width}x${height}`)
          }
        }
      }
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await ask.click()
      await expect(ask).not.toBeChecked()
      await spends.getByLabel('Monthly limit in US dollars').fill('25')
      await spends.getByLabel('Monthly limit in US dollars').press('Enter')
      const accounts = await page.evaluate(async () => window.sotto!.plugins!.accounts())
      expect(accounts.find(account => account.plugin === 'elevenlabs')?.spending).toEqual({ askBefore: false, monthlyLimit: 25 })
      await shot(page, 'elevenlabs-spending-changed-dark-1280x800')

      // Neither key is written in the clear anywhere in Sotto's data folder.
      for (const file of await filesUnder(dirname(root))) {
        expect(file.text.includes(GOOD), file.path).toBe(false)
        expect(file.text.includes(BAD), file.path).toBe(false)
      }
      await openThreads(page)
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    if (previous === undefined) delete process.env.SOTTO_E2E_ELEVENLABS_API_URL
    else process.env.SOTTO_E2E_ELEVENLABS_API_URL = previous
    await new Promise<void>(resolve => elevenLabs.close(() => resolve()))
  }
})
