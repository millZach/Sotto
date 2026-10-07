import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import type { AgentMessage } from '../../src/shared/agents'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

// A visual's walkthrough (#793), in the running app: each kind of diagram the visualize tool draws is stepped through,
// and the parts each step names are lit in the picture the real renderer made, with the rest dimmed.
const SHOTS = resolve('artifacts/visual-walkthrough')
const START = Date.now() - 60_000
const at = (second: number): string => new Date(START + second * 1000).toISOString()
const HISTORY: AgentMessage[] = [
  { id: 'walk-prompt', role: 'user', text: 'Walk me through how a send works.', createdAt: at(0) },
  { id: 'walk-before', role: 'assistant', text: 'Here it is one step at a time.', createdAt: at(5) },
]

const FLOW = {
  title: 'How a draft becomes a turn', kind: 'diagram',
  source: ['flowchart LR', '  A[Draft] --> B{Ready?}', '  B -->|yes| C[Send]', '  B -->|no| A', '  subgraph Provider', '    C --> D[Codex]', '    D --> E[Reply]', '  end', '  E --> A'].join('\n'),
  intro: 'A draft waits until it is ready, then the provider takes it.',
  steps: [
    { text: 'You write a draft in the composer.', highlight: ['A'] },
    { text: 'When it is ready, Sotto sends it.', highlight: ['B->C'] },
    { text: 'The provider runs the turn and replies.', highlight: ['Provider'] },
    { text: 'The reply comes back to you, ready for the next draft.' },
  ],
}
const SEQUENCE = {
  title: 'How a send moves through Sotto', kind: 'diagram',
  source: ['sequenceDiagram', '  participant You', '  participant Sotto', '  participant Codex', '  You->>Sotto: Send prompt', '  Sotto-->>You: Shows it as sending',
    '  loop Until accepted', '    Sotto->>Codex: turn/start', '  end', '  Codex-->>Sotto: Accepted', '  Codex-->>You: Streams the answer'].join('\n'),
  intro: 'Sotto shows your message before Codex has it.',
  steps: [
    { text: 'You press Send.', highlight: ['You', '1'] },
    { text: 'Sotto starts the turn on Codex.', highlight: ['3'] },
    { text: 'Codex streams its answer.', highlight: ['5'] },
  ],
}
const STATE = {
  title: 'A thread\'s states', kind: 'diagram',
  source: ['stateDiagram-v2', '  [*] --> Idle', '  Idle --> Running: send', '  state Running {', '    [*] --> Thinking', '    Thinking --> Writing', '  }', '  Running --> Idle: done'].join('\n'),
  steps: [{ text: 'A thread waits.', highlight: ['Idle'] }, { text: 'Then it works.', highlight: ['Running'] }],
}
const CLASSES = {
  title: 'What a thread holds', kind: 'diagram',
  source: ['classDiagram', '  class Thread', '  class Message', '  class Visual', '  Thread "1" *-- "many" Message : holds', '  Thread --> Visual : draws'].join('\n'),
  steps: [{ text: 'A thread holds its messages.', highlight: ['Thread', 'Message'] }, { text: 'And draws visuals.', highlight: ['Visual'] }],
}
const ENTITIES = {
  title: 'Where a visual is kept', kind: 'diagram',
  source: ['erDiagram', '  THREAD ||--o{ MESSAGE : holds', '  THREAD ||--o{ VISUAL : draws'].join('\n'),
  steps: [{ text: 'A thread has visuals.', highlight: ['THREAD', 'VISUAL'] }, { text: 'And messages.', highlight: ['MESSAGE'] }],
}

type ToolReply = { content: { type: string; text?: string }[]; isError?: boolean }
const visualize = (page: Page, args: unknown): Promise<ToolReply> => page.evaluate(request => window.sottoE2E!.visualTool!(request), { threadId: 'workshop', arguments: args }) as Promise<ToolReply>

async function openWorkshop(launched: LaunchedSotto): Promise<Locator> {
  const { page } = launched
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await resizeWindow(launched, 1280, 800)
  await openThreads(page)
  await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
  const log = page.getByRole('log', { name: 'Thread transcript' })
  await expect(log).toBeVisible()
  return log
}

async function scrollTo(locator: Locator, offset = 60): Promise<void> {
  await locator.evaluate((element, gap) => {
    const transcript = element.closest('.thread-workspace__transcript')!
    transcript.scrollTop += element.getBoundingClientRect().top - transcript.getBoundingClientRect().top - gap
  }, offset)
}
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.screenshot({ path: join(SHOTS, name), animations: 'disabled' })
}

/**
 * The parts a picture lights, read from the SVG the renderer made: an element's own id without the drawing's prefix,
 * or for a sequence diagram's parts their kind and name ("participant:You", "message:i0").
 */
function lit(image: Locator): Promise<string[]> {
  return image.evaluate(element => {
    const data = (element as HTMLImageElement).src.split(',')[1]!
    const svg = new TextDecoder().decode(Uint8Array.from(atob(data), char => char.charCodeAt(0)))
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
    const prefix = `${root.id}-`
    return [...root.querySelectorAll('.sotto-step-lit')].map(part => {
      const kind = part.getAttribute('data-et')
      if (kind && kind !== 'edge') return `${kind}:${part.getAttribute('data-id') ?? part.textContent?.trim()}`
      if (part.id) return part.id.startsWith(prefix) ? part.id.slice(prefix.length) : part.id
      return `${part.getAttribute('class')!.split(' ')[0]}:${part.querySelector('[data-id]')?.getAttribute('data-id') ?? part.textContent?.trim()}`
    }).sort()
  })
}
const dimmed = (image: Locator): Promise<number> => image.evaluate(element => {
  const svg = new TextDecoder().decode(Uint8Array.from(atob((element as HTMLImageElement).src.split(',')[1]!), char => char.charCodeAt(0)))
  return new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('.sotto-step-dim').length
})

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
      const layers = [room, getComputedStyle(element).backgroundColor]
      for (let node = target as Element | null; node && node !== element; node = node.parentElement) {
        const colour = getComputedStyle(node).backgroundColor
        if (colour && colour !== 'rgba(0, 0, 0, 0)') layers.splice(2, 0, colour)
      }
      const background = paint(...layers)
      const foreground = paint(...layers, getComputedStyle(target).color)
      return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05)
    })
  }, selectors)
}

test('a visual walks through its steps, lighting each step\'s part of the diagram', async () => {
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-walkthrough-'))
  const launched = await launchSotto('success', profile)
  try {
    const { page } = launched
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const log = await openWorkshop(launched)
    await page.evaluate(value => window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'workshop', text: '', messages: value }), HISTORY)
    await expect(log).toContainText('Here it is one step at a time.')
    for (const visual of [FLOW, SEQUENCE, STATE, CLASSES, ENTITIES]) expect((await visualize(page, visual)).isError).not.toBe(true)

    const card = (title: string): Locator => log.getByRole('region', { name: `Visual: ${title}` })
    const image = (title: string): Locator => card(title).locator('.visual-card__frames img[data-layer]:not([data-layer="leaving"])')
    const stepper = (title: string): Locator => card(title).getByRole('group', { name: 'Walkthrough' })
    for (const title of [FLOW, SEQUENCE, STATE, CLASSES, ENTITIES].map(visual => visual.title)) await expect(card(title).getByRole('img')).toBeVisible({ timeout: 20_000 })

    // A flowchart: a node, an edge written A->B with its ends and label, a subgraph with what is inside it, and a step
    // that names nothing, which leaves the whole drawing lit.
    const flow = card(FLOW.title)
    await scrollTo(flow)
    await expect(stepper(FLOW.title)).toContainText('Step 1 of 4')
    await expect(stepper(FLOW.title)).toContainText(FLOW.steps[0]!.text)
    await expect(flow.getByRole('listitem')).toHaveCount(0)
    expect(await lit(image(FLOW.title))).toEqual(['flowchart-A-0'])
    expect(await dimmed(image(FLOW.title))).toBeGreaterThan(10)
    await shot(page, 'flowchart-step-1280x800-dark.png')
    const base = await flow.evaluate(element => (element.querySelector('.visual-card__frames img') as HTMLImageElement).naturalWidth)

    // The keyboard path: the first dot, then the arrow keys step while focus stays in the stepper.
    const dot1 = flow.getByRole('button', { name: 'Step 1', exact: true })
    await dot1.focus()
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
    await expect(dot1).toBeFocused()
    await expect(dot1).toHaveCSS('outline-style', 'solid')
    await page.keyboard.press('ArrowRight')
    await expect(stepper(FLOW.title)).toContainText('Step 2 of 4')
    await expect.poll(() => lit(image(FLOW.title))).toEqual(['L_B_C_0', 'edgeLabel:L_B_C_0', 'flowchart-B-1', 'flowchart-C-3'])
    await shot(page, 'flowchart-edge-1280x800-dark.png')
    // The capture took the focus away; it goes back to the second dot.
    await flow.getByRole('button', { name: 'Step 2' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(stepper(FLOW.title)).toContainText('Step 3 of 4')
    await expect.poll(() => lit(image(FLOW.title))).toEqual(['L_C_D_0', 'L_D_E_0', 'Provider', 'edgeLabel:L_C_D_0', 'edgeLabel:L_D_E_0', 'flowchart-C-3', 'flowchart-D-7', 'flowchart-E-9'])
    // Every step's picture is the drawing's size.
    expect(await flow.evaluate(element => (element.querySelector('.visual-card__frames img:last-child') as HTMLImageElement).naturalWidth)).toBe(base)
    // Tab moves on from the dots to Back and Next, in the order they are read.
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
    await expect(flow.getByRole('button', { name: 'Back' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(flow.getByRole('button', { name: 'Next' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(stepper(FLOW.title)).toContainText('Step 4 of 4')
    await expect.poll(() => lit(image(FLOW.title))).toEqual([])
    const startOver = flow.getByRole('button', { name: 'Start over' })
    await expect(startOver).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(stepper(FLOW.title)).toContainText('Step 4 of 4')
    await page.keyboard.press('Enter')
    await expect(stepper(FLOW.title)).toContainText('Step 1 of 4')
    await page.keyboard.press('Shift+Tab')
    await expect(flow.getByRole('button', { name: 'Back' })).toBeFocused()
    await expect(flow.getByRole('button', { name: 'Back' })).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(stepper(FLOW.title)).toContainText('Step 2 of 4')

    // Expand shows the step as it is lit; Escape closes it, back on Expand.
    const expand = flow.getByRole('button', { name: `Expand ${FLOW.title}` })
    await expand.focus()
    await page.keyboard.press('Enter')
    const viewer = page.getByRole('dialog')
    await expect(viewer).toBeVisible()
    expect(await lit(viewer.getByRole('img'))).toEqual(['L_B_C_0', 'edgeLabel:L_B_C_0', 'flowchart-B-1', 'flowchart-C-3'])
    await page.screenshot({ path: join(SHOTS, 'flowchart-expanded-1280x800-dark.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(viewer).toBeHidden()
    await expect(expand).toBeFocused()

    // Read all, from the keyboard: the intro and the numbered steps instead of the walkthrough, nothing dimmed. Its
    // place in the header is before Show source, and while every step shows it reads Step through.
    const readAll = flow.getByRole('button', { name: 'Read all' })
    await readAll.focus()
    await page.keyboard.press('Tab')
    await expect(flow.getByRole('button', { name: 'Show source' })).toBeFocused()
    await readAll.press('Space')
    const stepThrough = flow.getByRole('button', { name: 'Step through' })
    await expect(stepThrough).toBeFocused()
    await expect(stepper(FLOW.title)).toHaveCount(0)
    await expect(flow.getByRole('listitem')).toHaveCount(4)
    await expect(flow).toContainText(FLOW.intro)
    await expect.poll(() => lit(image(FLOW.title))).toEqual([])
    expect(await dimmed(image(FLOW.title))).toBe(0)
    for (const ratio of await contrasts(flow, ['.visual-card__read-all', '.visual-card__intro', '.visual-card__steps li'])) expect(ratio).toBeGreaterThanOrEqual(4.5)
    await scrollTo(flow)
    await shot(page, 'flowchart-read-all-1280x800-dark.png')
    await stepThrough.press('Space')
    await expect(readAll).toBeFocused()
    await expect(stepper(FLOW.title)).toContainText('Step 2 of 4')

    // A sequence diagram: participants by name, and arrows counted from 1 past the loop, each with its two participants.
    const sequence = card(SEQUENCE.title)
    await scrollTo(sequence)
    expect(await lit(image(SEQUENCE.title))).toEqual(['life-line:Sotto', 'life-line:You', 'message:i0', 'messageText:Send prompt', 'participant:Sotto', 'participant:You'])
    await sequence.getByRole('button', { name: 'Next' }).click()
    await expect.poll(() => lit(image(SEQUENCE.title))).toEqual(['life-line:Codex', 'life-line:Sotto', 'message:i3', 'messageText:turn/start', 'participant:Codex', 'participant:Sotto'])
    await shot(page, 'sequence-step-1280x800-dark.png')
    await sequence.getByRole('button', { name: 'Step 3' }).click()
    await expect.poll(() => lit(image(SEQUENCE.title))).toEqual(['life-line:Codex', 'life-line:You', 'message:i6', 'messageText:Streams the answer', 'participant:Codex', 'participant:You'])

    // State, class and entity relationship diagrams.
    expect(await lit(image(STATE.title))).toEqual([expect.stringMatching(/^state-Idle-\d+$/u)])
    await card(STATE.title).getByRole('button', { name: 'Next' }).click()
    await expect.poll(async () => (await lit(image(STATE.title))).map(id => id.replace(/-\d+$/u, ''))).toEqual(['state-Running', 'state-Running_start', 'state-Thinking', 'state-Writing'])
    expect((await lit(image(CLASSES.title))).map(id => id.replace(/-\d+$/u, ''))).toEqual(['classId-Message', 'classId-Thread', 'edgeLabel:id_Thread_Message_1', 'id_Thread_Message_1'])
    await card(CLASSES.title).getByRole('button', { name: 'Next' }).click()
    await expect.poll(async () => (await lit(image(CLASSES.title))).map(id => id.replace(/-\d+$/u, ''))).toEqual(['classId-Visual'])
    expect(await lit(image(ENTITIES.title))).toEqual(['edgeLabel:id_entity-THREAD-0_entity-VISUAL-2_1', 'entity-THREAD-0', 'entity-VISUAL-2', 'id_entity-THREAD-0_entity-VISUAL-2_1'])
    await card(ENTITIES.title).getByRole('button', { name: 'Next' }).click()
    await expect.poll(() => lit(image(ENTITIES.title))).toEqual(['entity-MESSAGE-1'])

    // Reduced motion: the next picture replaces the last at once, and nothing in the card moves for longer than an instant.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await scrollTo(flow)
    const moving = (locator: Locator): Promise<string[]> => locator.evaluate(element => {
      const seconds = (value: string): number => Math.max(...value.split(',').map(part => part.trim().endsWith('ms') ? parseFloat(part) / 1000 : parseFloat(part)))
      const slow: string[] = []
      for (const node of [element, ...element.querySelectorAll('*')]) for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(node, pseudo)
        if (seconds(style.transitionDuration) > 0.001 || seconds(style.animationDuration) > 0.001) slow.push(`${node.className}${pseudo ?? ''}`)
      }
      return slow
    })
    await flow.getByRole('button', { name: 'Next' }).click()
    expect(await flow.locator('.visual-card__frames img').evaluateAll(images => images.map(item => (item as HTMLElement).dataset.layer))).toEqual(['shown'])
    expect(await moving(flow)).toEqual([])
    await shot(page, 'flowchart-reduced-motion-1280x800-dark.png')
    await page.emulateMedia({ reducedMotion: null })

    // Light and dark at every size, nothing clipped, the walkthrough's words at 4.5:1 on the card.
    await flow.getByRole('button', { name: 'Step 2' }).click()
    let appearance: 'dark' | 'light' = 'dark'
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        const drawing = await image(FLOW.title).getAttribute('src')
        await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        if (mode !== appearance) await expect.poll(() => image(FLOW.title).getAttribute('src'), { timeout: 15_000 }).not.toBe(drawing)
        appearance = mode
        for (const visual of [FLOW, SEQUENCE]) {
          const target = card(visual.title)
          await scrollTo(target)
          const fits = await target.evaluate(element => {
            const box = element.getBoundingClientRect()
            const inside = (selector: string): boolean => [...element.querySelectorAll(selector)].every(item => {
              const rect = item.getBoundingClientRect()
              return rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.width > 0
            })
            return { right: box.right <= innerWidth, overflow: element.scrollWidth <= element.clientWidth + 1, page: document.documentElement.scrollWidth <= innerWidth,
              header: inside('.visual-card__actions button'), stepper: inside('.visual-stepper button'), picture: inside('.visual-card__frames img'),
              text: inside('.visual-stepper__text') }
          })
          expect(fits, `${visual.title} at ${width}x${height} ${mode}`).toEqual({ right: true, overflow: true, page: true, header: true, stepper: true, picture: true, text: true })
          for (const ratio of await contrasts(target, ['.visual-stepper__count', '.visual-stepper__text', '.visual-card__read-all', '.visual-stepper__button'])) expect(ratio).toBeGreaterThanOrEqual(4.5)
        }
        await scrollTo(flow)
        if (width !== 1280 || mode === 'light') await shot(page, `flowchart-step-${width}x${height}-${mode}.png`)
        // The sequence diagram is taller than the minimum window, so its capture shows the lit arrow and the stepper.
        if (width === 820) { await scrollTo(sequence, -230); await shot(page, `sequence-step-${width}x${height}-${mode}.png`) }
      }
    }
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
