import { createServer } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { withShownPictureThread } from './support/shownPictureThread'
import { openPage, openThreads, resizeWindow } from './support/sottoLaunch'

/**
 * A sound a thread makes with ElevenLabs (ADR-0205; slice 12, part 2), on Owl, against a made-up ElevenLabs on this
 * computer that answers the subscription, the voices and the three ways to make a sound with a small MP3. The thread
 * asks with make_sound; the card says what goes to ElevenLabs, the voice, what it costs and the month so far; the MP3
 * lands in sounds/ in the thread's folder, and nothing plays. The account then says what the month spent. Nothing
 * reaches ElevenLabs, and the key is made up. Captures go to artifacts/plugins-elevenlabs.
 */
const evidence = evidenceDirectory('artifacts/plugins-elevenlabs')
const KEY = 'sk_made_up_elevenlabs_key_0123456789'
/**
 * A real MP3 the window can play: two seconds of silence as 77 MPEG-1 Layer III frames at 128 kbps and 44.1 kHz, each
 * a 4-byte header and 413 zero bytes, which decoders read as silence.
 */
const FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)])
const MP3 = Buffer.concat(Array.from({ length: 77 }, () => FRAME))
const SPEECH = { kind: 'speech', name: 'Opening narration', voice: 'Rachel', words: 'Welcome to Lumen. In the next two minutes you will set up your shop, add your first product and take your first order.' }
const MUSIC = { kind: 'music', name: 'Calm intro loop', words: 'Calm, warm acoustic guitar and soft piano, loops cleanly', seconds: 30, instrumental: true }

type Called = { content: { type: string; text?: string }[]; isError?: boolean | undefined }
interface Held { __made?: Record<string, Promise<Called>> }

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: join(evidence, `${name}.png`), caret: 'hide' })
}
async function make(page: Page, threadId: string, sound: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ request, key }) => {
    const held = window as unknown as Held
    held.__made = { ...held.__made, [key]: window.sottoE2E!.pluginTool!(request) }
  }, { request: { threadId, name: 'make_sound', arguments: sound }, key: String(sound['name']) })
}
async function answered(page: Page, name: string): Promise<{ text: string; isError: boolean }> {
  const result = await page.evaluate(key => (window as unknown as Held).__made![key]!, name)
  return { text: result.content.map(part => part.text ?? '').join('\n'), isError: result.isError === true }
}
async function card(pane: Locator): Promise<Locator> {
  const found = pane.locator('section.agent-request[data-kind="permission"]')
  await expect(found).toHaveCount(1, { timeout: 30_000 })
  return found
}

test('A thread makes speech and music with ElevenLabs after the card is answered, and nothing plays', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const asked: string[] = []
  const elevenLabs = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`)
    if (request.headers['xi-api-key'] !== KEY) { response.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":{"status":"invalid_api_key"}}'); return }
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/v1/user/subscription') { response.writeHead(200, { 'content-type': 'application/json' }).end('{"tier":"creator"}'); return }
    if (request.method === 'GET' && url.startsWith('/v2/voices')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ voices: [{ voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' }, { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' }], has_more: false }))
      return
    }
    if (request.method === 'POST' && /^\/v1\/(?:text-to-speech\/21m00Tcm4TlvDq8ikWAM|sound-generation|music)\?output_format=mp3_44100_128$/u.test(url)) {
      request.resume()
      request.on('end', () => { response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(MP3.byteLength) }).end(MP3) })
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>(resolve => elevenLabs.listen(0, '127.0.0.1', resolve))
  const previous = process.env.SOTTO_E2E_ELEVENLABS_API_URL
  process.env.SOTTO_E2E_ELEVENLABS_API_URL = `http://127.0.0.1:${(elevenLabs.address() as AddressInfo).port}`
  try {
    await withShownPictureThread('sotto-e2e-elevenlabs-sound-', async ({ launched, page, pane, threadId, project }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on', appearance: 'dark' }) })

      // An ElevenLabs account named Studio.
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Plugins', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      await panel.getByRole('button', { name: /^ElevenLabs/u }).click()
      await panel.getByRole('button', { name: 'Add an ElevenLabs account' }).click()
      const form = panel.getByRole('form', { name: 'Add an ElevenLabs account' })
      await form.getByLabel('Name').fill('Studio')
      await form.getByLabel('API key').fill(KEY)
      await form.getByRole('button', { name: 'Add account' }).click()
      await expect(panel.getByRole('region', { name: 'ElevenLabs account Studio' })).toContainText('API key saved')

      // Speech: the card says the words, the voice, under a cent and the month so far, and nothing goes before the yes.
      await openThreads(page)
      await resizeWindow(launched, 1280, 800)
      await make(page, threadId, SPEECH)
      const speechCard = await card(pane)
      await expect(speechCard).toContainText('Make a sound with ElevenLabs')
      await expect(speechCard).toContainText('Speech · Opening narration')
      await expect(speechCard).toContainText(`Speaks these words in the voice Rachel (${SPEECH.words.length} characters):`)
      await expect(speechCard).toContainText('Under $0.01 on the ElevenLabs account Studio; $0.00 of its $10 used this month.')
      await expect(speechCard).toContainText('Nothing plays on its own.')
      expect(asked.filter(line => line.startsWith('POST'))).toEqual([])
      await speechCard.scrollIntoViewIfNeeded()
      await shot(page, 'sound-card-dark-1280x800')
      await speechCard.getByRole('button', { name: 'Make the sound', exact: true }).click()
      const spoken = await answered(page, SPEECH.name)
      expect(spoken.isError).toBe(false)
      expect(spoken.text).toContain('sounds/Opening narration.mp3')
      expect(new Uint8Array(await readFile(join(project, 'sounds', 'Opening narration.mp3')))).toEqual(new Uint8Array(MP3))

      // Part 3: the sound is a quiet line under the reply, with Play, and nothing plays until it is pressed.
      const line = pane.getByRole('group', { name: 'Sound: Opening narration' })
      await expect(line).toBeVisible({ timeout: 30_000 })
      const play = line.getByRole('button', { name: 'Play Opening narration' })
      await expect(play).toBeEnabled({ timeout: 30_000 })
      await expect(line).toContainText('Speech')
      expect(await page.evaluate(() => [...document.querySelectorAll('audio, video')].some(element => !(element as HTMLMediaElement).paused))).toBe(false)
      await line.scrollIntoViewIfNeeded()
      await shot(page, 'sound-line-dark-1280x800')
      await line.getByRole('button', { name: 'Show the details' }).click()
      await expect(line).toContainText(SPEECH.words)
      await expect(line).toContainText('Spoken in the voice Rachel')
      await expect(line.getByRole('button', { name: /^Show in (?:File Explorer|Finder|the file manager)$/u })).toBeVisible()
      await shot(page, 'sound-line-open-dark-1280x800')
      await page.keyboard.press('Escape')
      await expect(line.getByRole('button', { name: 'Show the details' })).toBeFocused()
      // Play fetches the MP3 and plays it; Pause stops it.
      await play.click()
      await expect(line.getByRole('button', { name: 'Pause Opening narration' })).toBeVisible({ timeout: 15_000 })
      await expect(line.getByRole('slider', { name: 'Place in Opening narration' })).toHaveAttribute('aria-valuetext', /of 0:02$/u, { timeout: 15_000 })
      await shot(page, 'sound-line-playing-dark-1280x800')
      await line.getByRole('button', { name: 'Pause Opening narration' }).click()
      await expect(line.getByRole('button', { name: 'Play Opening narration' })).toBeVisible()
      for (const [mode, width, height] of [['light', 1280, 800], ['dark', 820, 560]] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        await resizeWindow(launched, width, height)
        await line.scrollIntoViewIfNeeded()
        const outside = await line.evaluate((element, paneElement) => {
          const room = paneElement!.getBoundingClientRect()
          return [element, ...element.querySelectorAll<HTMLElement>('*')].filter(part => { const box = part.getBoundingClientRect(); return box.width > 0 && (box.right > room.right + 1 || box.left < room.left - 1) }).length
        }, await pane.elementHandle())
        expect(outside, `line ${width}x${height} ${mode}`).toBe(0)
        await shot(page, `sound-line-${mode}-${width}x${height}`)
      }
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resizeWindow(launched, 1280, 800)

      // Music, in light: thirty seconds with no singing, and the month now counts the speech.
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
      await make(page, threadId, MUSIC)
      const musicCard = await card(pane)
      await expect(musicCard).toContainText('Makes music, 30 seconds long, with no singing, from these words:')
      await expect(musicCard).toContainText(/About \$0\.0[78] on the ElevenLabs account Studio; under \$0\.01 of its \$10 used this month\./u)
      await musicCard.scrollIntoViewIfNeeded()
      await shot(page, 'sound-card-light-1280x800')
      await musicCard.getByRole('button', { name: 'Make the sound', exact: true }).click()
      expect((await answered(page, MUSIC.name)).isError).toBe(false)
      await readFile(join(project, 'sounds', 'Calm intro loop.mp3'))
      await expect(pane.getByRole('group', { name: 'Sound: Calm intro loop' })).toBeVisible({ timeout: 30_000 })
      // Nothing in the window is playing a sound now.
      expect(await page.evaluate(() => [...document.querySelectorAll('audio, video')].some(element => !(element as HTMLMediaElement).paused))).toBe(false)

      // The account says what the month spent, and Recent use says what was made.
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Plugins', exact: true }).click()
      const studio = panel.getByRole('region', { name: 'ElevenLabs account Studio' })
      if (await studio.count() === 0) await panel.getByRole('button', { name: /^ElevenLabs/u }).click()
      await expect(studio).toContainText(/Spent this month: \$0\.0[78] of \$10\./u, { timeout: 30_000 })
      await expect(studio).toContainText('Made speech')
      await expect(studio).toContainText('Made music')
      await studio.getByRole('region', { name: 'What it spends' }).scrollIntoViewIfNeeded()
      await shot(page, 'sound-spent-dark-1280x800')

      // Only the made-up ElevenLabs was asked, and only what the sounds needed.
      expect(asked.filter(line => line.startsWith('POST'))).toEqual(['POST /v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128', 'POST /v1/music?output_format=mp3_44100_128'])
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    if (previous === undefined) delete process.env.SOTTO_E2E_ELEVENLABS_API_URL
    else process.env.SOTTO_E2E_ELEVENLABS_API_URL = previous
    await new Promise<void>(resolve => elevenLabs.close(() => resolve()))
  }
})
