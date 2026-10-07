import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import type { AgentMessage } from '../../src/shared/agents'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

// A visual an agent draws in its thread (ADR-0055, #792), in the running app: the visualize tool is called as the
// thread's agent would call it, and the card lands in the open thread between the words before and after the call.
const SHOTS = resolve('artifacts/visual-in-thread')
// A minute ago, so the folded turn's "Worked for" line reads as the short turn it was.
const START = Date.now() - 60_000
const at = (second: number): string => new Date(START + second * 1000).toISOString()
const HISTORY: AgentMessage[] = [
  { id: 'visual-prompt', role: 'user', text: 'How does a send move through Sotto?', createdAt: at(0) },
  { id: 'visual-before', role: 'assistant', text: 'Here is the path a send takes.', createdAt: at(5) },
]
const AFTER = 'The part worth knowing is step 3: an uncertain send is reconciled, never sent twice.'
const SEND = {
  title: 'How a send moves through Sotto', kind: 'diagram',
  source: ['sequenceDiagram', '  participant You', '  participant Sotto', '  participant Codex', '  You->>Sotto: Send prompt', '  Sotto-->>You: Shows it as sending',
    '  Sotto->>Codex: turn/start', '  Codex-->>Sotto: Accepted', '  Codex-->>You: Streams the answer'].join('\n'),
  intro: 'Sotto shows your message before Codex has it, and never sends it twice.',
  steps: [
    { text: 'You press Send. Sotto draws the message at once, marked as sending.', highlight: ['You', '1', '2'] },
    { text: 'Sotto starts the turn on Codex and waits for it to accept.', highlight: ['3', '4'] },
    { text: 'If no answer comes, Sotto checks the thread rather than sending again.', highlight: ['Sotto'] },
    { text: 'Codex streams its answer into the thread.', highlight: ['5'] },
  ],
}
const BROKEN = { title: 'A flow that will not draw', kind: 'diagram', source: 'flowchart TD\n  A[Start --> B\n  B -->> C((', steps: [{ text: 'This step stays readable.' }] }

type ToolReply = { content: { type: string; text?: string }[]; isError?: boolean }
const visualize = (page: Page, args: unknown): Promise<ToolReply> => page.evaluate(request => window.sottoE2E!.visualTool!(request), { threadId: 'workshop', arguments: args }) as Promise<ToolReply>
const replyText = (reply: ToolReply): string => reply.content.map(item => item.text ?? '').join('')
const history = (page: Page, messages: AgentMessage[]): Promise<void> => page.evaluate(value => window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'workshop', text: '', messages: value }), messages)

async function openWorkshop(launched: LaunchedSotto, first: boolean): Promise<Locator> {
  const { page } = launched
  if (first) {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
  } else await page.evaluate(() => window.sotto!.agents!.command({ type: 'connect' }))
  await resizeWindow(launched, 1280, 800)
  await openThreads(page)
  // The first exchange may have named the thread by the time Sotto restarts, so the restart selects it by its ID.
  if (first) await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
  else await page.evaluate(() => window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' }))
  const log = page.getByRole('log', { name: 'Thread transcript' })
  await expect(log).toBeVisible()
  return log
}

/** Scrolls the transcript so the element sits a little below its top, with the words before it in view. */
async function scrollTo(locator: Locator, offset = 80): Promise<void> {
  await locator.evaluate((element, gap) => {
    const transcript = element.closest('.thread-workspace__transcript')!
    transcript.scrollTop += element.getBoundingClientRect().top - transcript.getBoundingClientRect().top - gap
  }, offset)
}
/** A screenshot with nothing focused, so a focus ring left by the keyboard checks does not stand in the picture. */
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.screenshot({ path: join(SHOTS, name), animations: 'disabled' })
}

/** The contrast of each element's text against the card it sits on, composited over the room. */
async function contrasts(card: Locator, selectors: readonly string[]): Promise<number[]> {
  return card.evaluate((element, list) => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d')!
    const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--tt-canvas)'; document.body.append(probe)
    const room = getComputedStyle(probe).backgroundColor; probe.remove()
    const luminance = (data: Uint8ClampedArray): number => [...data].slice(0, 3).map(value => value / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
    const paint = (...colours: string[]): number => {
      for (const colour of colours) { context.fillStyle = colour; context.fillRect(0, 0, 1, 1) }
      return luminance(context.getImageData(0, 0, 1, 1).data)
    }
    return list.map(selector => {
      const target = element.querySelector(selector)!
      const surface = target.closest('.visual-card__bar') ?? element
      const background = paint(room, getComputedStyle(element).backgroundColor, getComputedStyle(surface).backgroundColor)
      const foreground = paint(room, getComputedStyle(element).backgroundColor, getComputedStyle(surface).backgroundColor, getComputedStyle(target).color)
      return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05)
    })
  }, selectors)
}

test('an agent draws a visual in its thread, live, and it stays with the thread', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-visuals-'))
  try {
    let launched = await launchSotto('success', profile)
    try {
      const { page } = launched
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const log = await openWorkshop(launched, true)
      await history(page, HISTORY)
      await expect(log).toContainText('Here is the path a send takes.')

      // The agent calls visualize mid-reply: the card arrives in the open thread without reopening it.
      const shown = await visualize(page, SEND)
      expect(shown.isError).not.toBe(true)
      expect(replyText(shown)).toBe('Shown in the thread as "How a send moves through Sotto": a sequence diagram with 4 steps, under your last message. Do not repeat the steps in your reply.')
      const card = log.getByRole('region', { name: 'Visual: How a send moves through Sotto' })
      await expect(card).toBeVisible()
      const image = card.getByRole('img', { name: 'Sequence diagram: How a send moves through Sotto' })
      await expect(image).toBeVisible({ timeout: 15_000 })
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      await expect(card.getByRole('listitem')).toHaveCount(4)
      await expect(card).toContainText(SEND.intro)

      // The words the agent writes after the call come after the card, while the turn runs.
      await page.evaluate(text => window.sottoE2E!.agentEvent!({ type: 'stream', threadId: 'workshop', messageId: 'visual-after', text, status: 'running' }), AFTER)
      await expect(log).toContainText(AFTER)
      const order = (): Promise<number[]> => log.evaluate((element, words) => {
        const text = element.textContent ?? ''
        return words.map(word => text.indexOf(word))
      }, ['Here is the path a send takes.', 'How a send moves through Sotto', AFTER])
      const live = await order()
      expect(live.every(index => index >= 0)).toBe(true)
      expect(live).toEqual([...live].sort((a, b) => a - b))
      // Once the turn ends its work folds under one line; the visual stays in view, before the final reply.
      await page.evaluate(text => window.sottoE2E!.agentEvent!({ type: 'stream', threadId: 'workshop', messageId: 'visual-after', text, status: 'idle' }), AFTER)
      const fold = log.getByRole('region', { name: /^Worked for/u })
      await expect(fold).toBeVisible()
      await expect(fold.getByRole('region', { name: /^Visual:/u })).toHaveCount(0)
      await expect(card).toBeVisible()
      const folded = await log.evaluate((element, words) => {
        const text = element.textContent ?? ''
        return words.map(word => text.indexOf(word))
      }, ['Worked for', 'How a send moves through Sotto', AFTER])
      expect(folded.every(index => index >= 0)).toBe(true)
      expect(folded).toEqual([...folded].sort((a, b) => a - b))

      // The keyboard path: Show source, Copy source and Expand in reading order; Expand opens the viewer and Escape
      // closes it, back on Expand.
      const showSource = card.getByRole('button', { name: 'Show source' })
      const copySource = card.getByRole('button', { name: 'Copy source' })
      const expand = card.getByRole('button', { name: 'Expand How a send moves through Sotto' })
      await showSource.focus()
      // Arriving by the keyboard shows the focus ring.
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
      await expect(showSource).toBeFocused()
      await expect(showSource).toHaveCSS('outline-style', 'solid')
      await page.keyboard.press('Tab'); await expect(copySource).toBeFocused()
      await page.keyboard.press('Tab'); await expect(expand).toBeFocused()
      await page.keyboard.press('Enter')
      const viewer = page.getByRole('dialog')
      await expect(viewer).toBeVisible()
      await page.screenshot({ path: join(SHOTS, 'expanded-1280x800-dark.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await expect(viewer).toBeHidden()
      await expect(expand).toBeFocused()
      await showSource.press('Enter')
      await expect(showSource).toHaveAttribute('aria-pressed', 'true')
      await expect(card.getByLabel('How a send moves through Sotto source')).toContainText('sequenceDiagram')
      await showSource.press('Enter')
      await expect(image).toBeVisible()

      // Reduced motion: the card draws the same and nothing in it, or in the viewer, takes longer than an instant to move.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
      const moving = (locator: Locator): Promise<string[]> => locator.evaluate(element => {
        const seconds = (value: string): number => Math.max(...value.split(',').map(part => part.trim().endsWith('ms') ? parseFloat(part) / 1000 : parseFloat(part)))
        const slow: string[] = []
        for (const node of [element, ...element.querySelectorAll('*')]) for (const pseudo of [null, '::before', '::after']) {
          const style = getComputedStyle(node, pseudo)
          if (seconds(style.transitionDuration) > 0.001 || seconds(style.animationDuration) > 0.001) slow.push(`${node.className}${pseudo ?? ''}`)
        }
        return slow
      })
      await expect(image).toBeVisible()
      expect(await moving(card)).toEqual([])
      await expand.press('Enter')
      await expect(viewer).toBeVisible()
      expect(await moving(viewer)).toEqual([])
      expect(await viewer.evaluate(element => getComputedStyle(element, '::backdrop').transitionDuration)).toMatch(/^(?:0s|0\.001s|1ms)$/u)
      await page.keyboard.press('Escape')
      await expect(viewer).toBeHidden()
      await expect(expand).toBeFocused()
      await page.emulateMedia({ reducedMotion: null })

      // Light and dark at every size the window supports, nothing clipped, text at 4.5:1 on the card.
      let appearance: 'dark' | 'light' = 'dark'
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const mode of ['dark', 'light'] as const) {
          const drawing = await image.getAttribute('src')
          await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), mode)
          await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
          // The drawing is made again in the new appearance's colours; the old one stays until the new one is ready.
          if (mode !== appearance) await expect.poll(() => image.getAttribute('src'), { timeout: 15_000 }).not.toBe(drawing)
          appearance = mode
          await scrollTo(card)
          const fits = await card.evaluate(element => {
            const box = element.getBoundingClientRect()
            const title = element.querySelector('.visual-card__title')!
            return { right: box.right <= innerWidth, overflow: element.scrollWidth <= element.clientWidth + 1, page: document.documentElement.scrollWidth <= innerWidth,
              controls: [...element.querySelectorAll('.visual-card__actions button')].every(button => { const rect = button.getBoundingClientRect(); return rect.right <= box.right + 0.5 && rect.width >= 24 }),
              title: title.getBoundingClientRect().width > 40 }
          })
          expect(fits).toEqual({ right: true, overflow: true, page: true, controls: true, title: true })
          for (const ratio of await contrasts(card, ['.visual-card__title', '.visual-card__kind', '.visual-card__intro', '.visual-card__steps li'])) expect(ratio).toBeGreaterThanOrEqual(4.5)
          await shot(page, `card-${width}x${height}-${mode}.png`)
        }
      }
      await resizeWindow(launched, 1280, 800)
      const lightDrawing = await image.getAttribute('src')
      await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
      await expect.poll(() => image.getAttribute('src'), { timeout: 15_000 }).not.toBe(lightDrawing)

      // A diagram Mermaid cannot draw shows its source and the reason, and its steps stay readable.
      expect((await visualize(page, BROKEN)).isError).not.toBe(true)
      const broken = log.getByRole('region', { name: 'Visual: A flow that will not draw' })
      await expect(broken.getByText(/^Couldn't draw this diagram\./u)).toBeVisible({ timeout: 15_000 })
      await expect(broken.getByLabel('A flow that will not draw source')).toContainText('A[Start --> B')
      await expect(broken.getByRole('listitem')).toHaveText(['This step stays readable.'])
      await scrollTo(broken)
      await shot(page, 'error-1280x800-dark.png')

      // With the switch off a call is refused, saying nothing was drawn, and the visuals already here stay.
      await page.evaluate(async () => window.sotto!.updateSettings({ visualsInThreads: false }))
      expect(await page.evaluate(async () => (await window.sotto!.getSettings()).visualsInThreads)).toBe(false)
      const refused = await visualize(page, { ...SEND, title: 'Not drawn' })
      expect(refused.isError).toBe(true)
      expect(replyText(refused)).toBe('Visuals are turned off in Sotto\'s settings. Nothing was drawn. Explain in text instead.')
      await expect(log.getByRole('region', { name: 'Visual: Not drawn' })).toHaveCount(0)
      await expect(card).toBeVisible()
      await page.evaluate(async () => window.sotto!.updateSettings({ visualsInThreads: true }))

      // The window's own copy of the thread keeps the explanation as the visual's text.
      const detail = await page.evaluate(async () => (await window.sotto!.agents!.threadDetail!('workshop'))?.messages.filter(message => message.id.startsWith('visual:')).map(message => message.text))
      expect(detail?.[0]).toContain('The visual is in Sotto on your computer.')
      expect(errors).toEqual([])
    } finally { await closeSotto(launched) }

    // After a restart the provider gives the thread its history again, and the card is back in its place.
    launched = await launchSotto('success', profile)
    try {
      const { page } = launched
      const log = await openWorkshop(launched, false)
      await history(page, [...HISTORY, { id: 'visual-after', role: 'assistant', text: AFTER, createdAt: at(40) }])
      const card = log.getByRole('region', { name: 'Visual: How a send moves through Sotto' })
      await expect(card).toBeVisible()
      await expect(card.getByRole('img')).toBeVisible({ timeout: 15_000 })
      await scrollTo(card)
      await shot(page, 'restarted-1280x800-dark.png')
    } finally { await closeSotto(launched) }
  } finally { await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true }) }
})
