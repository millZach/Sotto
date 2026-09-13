import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

// Real Windows Electron renders of Mermaid diagrams inside answers, using the rich message fixture
// (production window security posture, Threads layout classes and tokens).
const shots = resolve(process.cwd(), 'artifacts/rich-diagrams')

interface FixtureRecord { opened: string[]; navigations: string[]; popups: string[]; requests: string[] }
declare global { interface Window { richFixture?: { stream: (text: string, streaming: boolean) => void }; pwned?: unknown } }
interface Launched { app: ElectronApplication; page: Page }

const fence = (source: string): string => ['```mermaid', source, '```'].join('\n')

const SEQUENCE = [
  'sequenceDiagram',
  '  accTitle: Sending a thread message',
  '  accDescr: You send a prompt, Sotto shows it at once, then Codex accepts and streams the answer.',
  '  participant You',
  '  participant Sotto',
  '  participant Codex',
  '  You->>Sotto: Send prompt',
  '  Sotto-->>You: Shows it as sending',
  '  Sotto->>Codex: turn/start',
  '  Codex-->>Sotto: Accepted',
  '  Note over Sotto,Codex: An uncertain send is never replayed',
  '  Codex-->>You: Streams the answer',
].join('\n')

const FLOW = [
  'flowchart LR',
  '  A[Draft saved] --> B{Send}',
  '  B -->|accepted| C[Running]',
  '  B -->|no answer| D[Uncertain]',
  '  D --> E[Reconcile with next status]',
  '  C --> F[Done]',
].join('\n')

const STATE = [
  'stateDiagram-v2',
  '  [*] --> Idle',
  '  Idle --> Running: prompt',
  '  Running --> Idle: turn completed',
  '  Running --> Error: provider failed',
  '  Error --> Idle: retry',
].join('\n')

const INVALID = ['flowchart TD', '  A[Start --> B', '  B -->> C(('].join('\n')
const UNSUPPORTED = ['pie title Pets', '  "Dogs" : 386', '  "Cats" : 85'].join('\n')

const HOSTILE_FLOW = [
  '%%{init: {"securityLevel": "loose", "themeCSS": "body{background:url(https://tracker.example/init.png)}"}}%%',
  'flowchart TD',
  '  A["<img src=https://tracker.example/label.png onerror=window.pwned=1>"] --> B["<a href=javascript:window.pwned=2>click</a>"]',
  '  click A "https://tracker.example/click" "Open"',
  '  click B call alert()',
  '  C["<script>window.pwned=3</script>"] --> D[Plain]',
  '  classDef bad fill:#f00',
  '  class C bad',
].join('\n')

// Mermaid's grammar refuses resource functions in styles, so this block must stay source.
const HOSTILE_STYLE = [
  'flowchart LR',
  '  A --> B',
  '  style B fill:url(https://tracker.example/fill.png)',
  '  classDef bad background:url(https://tracker.example/class.png)',
].join('\n')

const HOSTILE_SEQUENCE = [
  '---',
  'title: Hostile front matter',
  'config:',
  '  securityLevel: loose',
  '  themeCSS: "* { background: url(https://tracker.example/front.png) }"',
  '---',
  'sequenceDiagram',
  '  A->>B: <img src="https://tracker.example/seq.png" onerror="window.pwned=4">',
  '  B-->>A: <a href="https://tracker.example/link">link</a>',
].join('\n')

const ANSWER = [
  'Here is how a send moves through Sotto.',
  '',
  fence(SEQUENCE),
  '',
  'The draft and delivery states:',
  '',
  fence(FLOW),
  '',
  fence(STATE),
].join('\n')

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'tests/fixtures/richMessages/vite.config.mjs'], { stdio: 'inherit' })
  await mkdir(shots, { recursive: true })
})

async function launch(options: { width?: number; height?: number; scale?: string } = {}): Promise<Launched> {
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    SOTTO_RICH_FIXTURE: '1',
    SOTTO_RICH_FIXTURE_WIDTH: String(options.width ?? 1080),
    SOTTO_RICH_FIXTURE_HEIGHT: String(options.height ?? 760),
    SOTTO_RICH_FIXTURE_SCALE: options.scale,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await electron.launch({ args: [resolve('tests/fixtures/richMessages/electronMain.cjs')], env })
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.evaluate(() => document.fonts.ready)
  await expect(page.getByRole('img', { name: 'help-page-404.png' })).toBeVisible()
  return { app, page }
}

const record = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { richFixture: FixtureRecord }).richFixture)
const answer = (page: Page) => page.locator('.thread-message[data-role="assistant"]')
const stream = (page: Page, text: string, streaming = false) => page.evaluate(([value, live]) => window.richFixture!.stream(value, live), [text, streaming] as const)

async function drawn(block: Locator): Promise<Locator> {
  const image = block.locator('.rich-diagram__canvas img')
  await expect(image).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  return image
}

async function scrollTo(locator: Locator, offset = 80): Promise<void> {
  await locator.evaluate((element, gap) => {
    const transcript = element.closest('.thread-workspace__transcript')!
    transcript.scrollTop += element.getBoundingClientRect().top - transcript.getBoundingClientRect().top - gap
  }, offset)
}

async function withClipboard<T>(app: ElectronApplication, run: () => Promise<T>): Promise<T> {
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
  try { return await run() } finally { await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved) }
}

/** The Windows clipboard stores CRLF; the copied source is compared line for line. */
async function clipboardText(app: ElectronApplication): Promise<string> {
  return (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/gu, '\n')
}

async function horizontalOverflow(page: Page) {
  return page.getByLabel('Thread transcript').evaluate(element => element.scrollWidth - element.clientWidth)
}

/** Visible label text of a drawing: word tspans joined, styles removed. */
function svgText(svg: string): string {
  return svg.replace(/<style[\s\S]*?<\/style>/gu, '').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ')
}

/** Every node's centre lies well inside the drawing's viewBox, so no state or step is cut off. */
function nodesInsideViewBox(svg: string): boolean {
  const [x, y, width, height] = /viewBox="([^"]+)"/u.exec(svg)![1]!.split(/\s+/u).map(Number) as [number, number, number, number]
  const nodes = [...svg.matchAll(/<g class="node[^"]*"[^>]*?transform="translate\(([-\d.]+),\s*([-\d.]+)\)"/gu)]
  return nodes.length > 0 && nodes.every(([, nodeX, nodeY]) => Number(nodeX) > x + 10 && Number(nodeX) < x + width - 10 && Number(nodeY) > y + 10 && Number(nodeY) < y + height - 10)
}

function decodedSvg(dataUrl: string): string {
  expect(dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true)
  return Buffer.from(dataUrl.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
}

test('sequence, flow and state diagrams draw in place with readable names, in dark and light', async () => {
  const { app, page } = await launch()
  try {
    await stream(page, ANSWER)
    const blocks = answer(page).locator('.rich-diagram')
    await expect(blocks).toHaveCount(3)
    const sequence = await drawn(blocks.nth(0))
    const flow = await drawn(blocks.nth(1))
    const state = await drawn(blocks.nth(2))
    await expect(sequence).toHaveAttribute('alt', 'Sequence diagram: Sending a thread message')
    await expect(flow).toHaveAttribute('alt', 'Flowchart')
    await expect(state).toHaveAttribute('alt', 'State diagram')
    await expect(page.getByRole('figure', { name: 'Sequence diagram: Sending a thread message' })).toBeVisible()
    // The description travels with the image for assistive technology.
    await expect(sequence).toHaveAccessibleDescription(/Codex accepts and streams the answer/u)
    const svg = decodedSvg(await sequence.getAttribute('src') ?? '')
    for (const label of ['Send prompt', 'turn/start', 'An uncertain send is never replayed']) expect(svgText(svg)).toContain(label)
    expect(svgText(decodedSvg(await flow.getAttribute('src') ?? ''))).toContain('Reconcile with next status')
    expect(svgText(decodedSvg(await state.getAttribute('src') ?? ''))).toContain('provider failed')
    for (const image of [flow, state]) expect(nodesInsideViewBox(decodedSvg(await image.getAttribute('src') ?? ''))).toBe(true)
    // Labels render in the Sotto face embedded in the image, not a fallback.
    expect(svg).toContain('Bricolage Grotesque')
    expect(svg).toContain('@font-face')
    expect(await page.locator('[data-diagram-stage]').count()).toBe(0)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    for (const image of [sequence, flow, state]) {
      const fits = await image.evaluate(element => element.getBoundingClientRect().width <= element.parentElement!.getBoundingClientRect().width + 0.5)
      expect(fits).toBe(true)
    }
    await scrollTo(blocks.nth(0), 60)
    await page.screenshot({ path: resolve(shots, 'dark-1080-sequence.png') })
    await scrollTo(blocks.nth(1), 60)
    await page.screenshot({ path: resolve(shots, 'dark-1080-flow-state.png') })

    const darkSource = await sequence.getAttribute('src')
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await expect.poll(() => blocks.nth(0).locator('.rich-diagram__canvas img').getAttribute('src'), { timeout: 15_000 }).not.toBe(darkSource)
    await drawn(blocks.nth(2))
    await expect.poll(() => blocks.nth(2).locator('.rich-diagram__canvas img').evaluate(element => (element as HTMLImageElement).src.length)).toBeGreaterThan(0)
    await page.waitForTimeout(300)
    await scrollTo(blocks.nth(0), 60)
    await page.screenshot({ path: resolve(shots, 'light-1080-sequence.png') })
    await scrollTo(blocks.nth(1), 60)
    await page.screenshot({ path: resolve(shots, 'light-1080-flow-state.png') })
    const result = await record(app)
    expect(result.requests).toEqual([])
    expect(result.navigations).toEqual([])
  } finally { await app.close() }
})

test('a streaming diagram shows its source until the fence closes, then draws while the answer continues', async () => {
  const { app, page } = await launch()
  try {
    const opening = ['Mapping the flow now.', '', '```mermaid', ...FLOW.split('\n').slice(0, 3)].join('\n')
    await stream(page, opening, true)
    const block = answer(page).locator('.rich-diagram')
    await expect(block).toHaveCount(1)
    await expect(block.getByText('Draws when the block is complete.')).toBeVisible()
    await expect(block.getByLabel('Flowchart source', { exact: true })).toContainText('A[Draft saved] --> B{Send}')
    await expect(block.locator('img')).toHaveCount(0)
    await expect(page.locator('.rich-message[aria-busy="true"]')).toHaveCount(1)
    await scrollTo(block, 80)
    await page.screenshot({ path: resolve(shots, 'dark-1080-streaming-incomplete.png') })
    // More source arrives, still unclosed: still source, still no renderer work.
    await stream(page, [opening, ...FLOW.split('\n').slice(3)].join('\n'), true)
    await expect(block.getByLabel('Flowchart source', { exact: true })).toContainText('Reconcile with next status')
    await expect(block.locator('img')).toHaveCount(0)
    // The closing fence arrives mid-answer.
    await stream(page, [opening, ...FLOW.split('\n').slice(3), '```', '', 'Next I will check'].join('\n'), true)
    await drawn(block)
    await expect(block.getByText('Draws when the block is complete.')).toHaveCount(0)
    await expect(page.locator('.rich-message[data-streaming] > p').last()).toHaveText('Next I will check')
    await stream(page, [opening, ...FLOW.split('\n').slice(3), '```', '', 'Next I will check the retry path.'].join('\n'), false)
    await expect(page.locator('.rich-message[aria-busy="true"]')).toHaveCount(0)
    await drawn(block)
  } finally { await app.close() }
})

test('invalid and unsupported diagrams keep their source readable with a useful reason and copy', async () => {
  const { app, page } = await launch()
  try {
    await stream(page, ['This one has a typo:', '', fence(INVALID), '', 'And a chart type Sotto does not draw:', '', fence(UNSUPPORTED)].join('\n'))
    const blocks = answer(page).locator('.rich-diagram')
    await expect(blocks).toHaveCount(2)
    const invalid = blocks.nth(0)
    await expect(invalid).toHaveAttribute('data-state', 'failed', { timeout: 15_000 })
    await expect(invalid.locator('.rich-diagram__notice')).toHaveText("Couldn't draw this diagram. The source has a syntax error on line 3.")
    await expect(invalid.getByLabel('Flowchart source', { exact: true })).toContainText('A[Start --> B')
    await expect(invalid.locator('img')).toHaveCount(0)
    const unsupported = blocks.nth(1)
    await expect(unsupported).toHaveAttribute('data-state', 'failed')
    await expect(unsupported.locator('.rich-diagram__notice')).toContainText("Sotto doesn't draw “pie” diagrams.")
    await expect(unsupported.getByLabel('Diagram source', { exact: true })).toContainText('"Dogs" : 386')
    await withClipboard(app, async () => {
      await invalid.getByRole('button', { name: 'Copy diagram source' }).click()
      await expect(invalid.getByRole('status')).toHaveText('Copied')
      expect(await clipboardText(app)).toBe(INVALID)
    })
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    await scrollTo(invalid, 60)
    await page.screenshot({ path: resolve(shots, 'dark-1080-invalid-unsupported.png') })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await page.screenshot({ path: resolve(shots, 'light-1080-invalid-unsupported.png') })
  } finally { await app.close() }
})

test('hostile diagram markup cannot run script, fetch resources, navigate or reach the page', async () => {
  const { app, page } = await launch()
  try {
    const messages: string[] = []
    page.on('console', message => messages.push(message.text()))
    await stream(page, ['Hostile diagrams:', '', fence(HOSTILE_FLOW), '', fence(HOSTILE_SEQUENCE), '', fence(HOSTILE_STYLE)].join('\n'))
    const blocks = answer(page).locator('.rich-diagram')
    await expect(blocks).toHaveCount(3)
    for (const index of [0, 1, 2]) await expect(blocks.nth(index)).not.toHaveAttribute('data-state', 'source', { timeout: 15_000 })
    const states = await blocks.evaluateAll(elements => elements.map(element => element.getAttribute('data-state')))
    // Whatever Mermaid accepts is drawn inertly; whatever it rejects stays source. Neither can act.
    for (const index of [0, 1]) {
      if (states[index] !== 'drawn') continue
      const image = await drawn(blocks.nth(index))
      const svg = decodedSvg(await image.getAttribute('src') ?? '')
      // Hostile words may remain as label text; only the markup itself must be inert.
      const body = svg.replace(/url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\)/gu, '').replace(/(<text\b[^>]*>|<tspan\b[^>]*>)[^<]*/gu, '$1')
      // Mermaid drops HTML from flowchart labels but prints sequence messages as text.
      if (index === 1) expect(svgText(svg)).toContain('tracker.example')
      expect(body).not.toMatch(/<script|<foreignObject|<a[\s>]|<image|<iframe|\son\w+=|javascript:|tracker\.example|@import|xlink:href="(?!#)|href="(?!#)/iu)
      expect(body).not.toMatch(/url\((?!#|data:font)/iu)
    }
    expect(states).toEqual(['drawn', 'drawn', 'failed'])
    await expect(blocks.nth(2).getByLabel('Flowchart source', { exact: true })).toContainText('tracker.example/fill.png')
    await expect(blocks.nth(1).locator('img')).toHaveAttribute('alt', 'Sequence diagram: Hostile front matter')
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.pwned)).toBeUndefined()
    expect(await page.locator('.thread-workspace img:not(.rich-diagram__canvas img):not(.rich-attachment img)').count()).toBe(0)
    expect(await page.locator('script:not([src]), a[href^="javascript"], [data-diagram-stage]').count()).toBe(0)
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage)).toBe('none')
    // Opening the viewer and clicking the drawing does not follow any diagram link.
    await blocks.nth(1).getByRole('button', { name: 'Expand diagram' }).click()
    const viewer = page.getByRole('dialog', { name: 'Sequence diagram: Hostile front matter' })
    await expect(viewer).toBeVisible()
    await viewer.getByRole('group', { name: 'Diagram view' }).click()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await blocks.nth(0).locator('.rich-diagram__canvas, pre').first().click()
    await page.waitForTimeout(300)
    const result = await record(app)
    expect(result.requests).toEqual([])
    expect(result.navigations).toEqual([])
    expect(result.popups).toEqual([])
    expect(result.opened).toEqual([])
    expect(await page.evaluate(() => window.pwned)).toBeUndefined()
    expect(messages.filter(text => /Refused to (?:load|connect|execute)/u.test(text))).toEqual([])
    // Clicking the drawing opened its viewer, not a link.
    await expect(page.getByRole('dialog', { name: 'Flowchart' })).toBeVisible()
    await page.keyboard.press('Escape')
    await scrollTo(blocks.nth(0), 60)
    await page.screenshot({ path: resolve(shots, 'dark-1080-hostile.png') })
  } finally { await app.close() }
})

test('keyboard expands a diagram, zooms, pans, fits, copies and closes back to Expand', async () => {
  const { app, page } = await launch()
  try {
    await stream(page, ['Here is the flow.', '', fence(SEQUENCE)].join('\n'))
    const block = answer(page).locator('.rich-diagram')
    await drawn(block)
    const expand = block.getByRole('button', { name: 'Expand diagram' })
    let reached = false
    for (let step = 0; step < 40 && !reached; step += 1) {
      await page.keyboard.press('Tab')
      reached = await expand.evaluate(element => element === document.activeElement)
    }
    expect(reached).toBe(true)
    await expect(expand).toHaveCSS('outline-style', 'solid')
    await page.keyboard.press('Enter')
    const viewer = page.getByRole('dialog', { name: 'Sequence diagram: Sending a thread message' })
    await expect(viewer).toBeVisible()
    const view = viewer.getByRole('group', { name: 'Diagram view' })
    await expect(view).toBeFocused()
    await expect(view).toHaveAccessibleDescription(/arrow keys to move/u)
    const zoom = viewer.getByLabel('Zoom', { exact: true })
    const fitted = await zoom.textContent()
    const image = viewer.locator('img')
    // Layout width: the dialog's own opening scale does not count.
    const fittedWidth = await image.evaluate(element => (element as HTMLImageElement).offsetWidth)
    const viewportBox = (await view.boundingBox())!
    expect(fittedWidth).toBeLessThanOrEqual(viewportBox.width)
    await expect(viewer.getByRole('button', { name: 'Fit to window' })).toHaveAttribute('aria-pressed', 'true')
    await page.waitForTimeout(250)
    // The first painted frame is already fitted: nothing re-fits or animates after opening.
    await expect(zoom).toHaveText(fitted ?? '')
    expect(await image.evaluate(element => (element as HTMLImageElement).offsetWidth)).toBe(fittedWidth)
    await page.screenshot({ path: resolve(shots, 'dark-1080-viewer-fit.png') })
    await page.keyboard.press('+')
    await page.keyboard.press('+')
    await expect(zoom).not.toHaveText(fitted ?? '')
    await expect.poll(() => image.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(fittedWidth * 1.4)
    const before = await image.evaluate(element => element.style.transform)
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => image.evaluate(element => element.style.transform)).not.toBe(before)
    await expect(viewer.getByRole('button', { name: 'Fit to window' })).toHaveAttribute('aria-pressed', 'false')
    await page.waitForTimeout(250)
    await page.screenshot({ path: resolve(shots, 'dark-1080-viewer-zoomed.png') })
    // Pointer: dragging moves the drawing, the wheel zooms.
    const moved = await image.evaluate(element => element.style.transform)
    await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + viewportBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(viewportBox.x + viewportBox.width / 2 - 120, viewportBox.y + viewportBox.height / 2 - 40, { steps: 4 })
    await page.mouse.up()
    await expect.poll(() => image.evaluate(element => element.style.transform)).not.toBe(moved)
    const zoomedText = await zoom.textContent()
    await page.mouse.wheel(0, 400)
    await expect(zoom).not.toHaveText(zoomedText ?? '')
    await view.focus()
    await page.keyboard.press('0')
    await expect(zoom).toHaveText(fitted ?? '')
    await expect(viewer.getByRole('button', { name: 'Fit to window' })).toHaveAttribute('aria-pressed', 'true')
    await withClipboard(app, async () => {
      await viewer.getByRole('button', { name: 'Copy diagram source' }).click()
      await expect(viewer.getByRole('status').filter({ hasNot: page.getByLabel('Zoom') }).first()).toHaveText('Copied')
      expect(await clipboardText(app)).toBe(SEQUENCE)
    })
    await view.focus()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(expand).toBeFocused()
    // The source toggle keeps the exact text available beside the drawing.
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    const toggle = block.getByRole('button', { name: 'Show source' })
    await expect(toggle).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(block.getByLabel('Sequence diagram source', { exact: true })).toContainText('Note over Sotto,Codex')
    await scrollTo(block, 60)
    await page.screenshot({ path: resolve(shots, 'dark-1080-source-toggle.png') })
    await page.keyboard.press('Enter')
    await drawn(block)
    expect((await record(app)).navigations).toEqual([])
  } finally { await app.close() }
})

test('shipped 820px minimum and a 760px stress window keep diagrams inside the column', async () => {
  for (const width of [820, 760]) {
    const { app, page } = await launch({ width, height: 640 })
    try {
      expect(await page.evaluate(() => window.innerWidth)).toBe(width)
      await stream(page, ANSWER)
      const blocks = answer(page).locator('.rich-diagram')
      for (const index of [0, 1, 2]) await drawn(blocks.nth(index))
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
      const inside = await blocks.evaluateAll(elements => elements.map(element => {
        const image = element.querySelector('img')!.getBoundingClientRect()
        const frame = element.getBoundingClientRect()
        return image.left >= frame.left - 0.5 && image.right <= frame.right + 0.5
      }))
      expect(inside).toEqual([true, true, true])
      await scrollTo(blocks.nth(1), 40)
      await page.screenshot({ path: resolve(shots, `dark-${width}-flow.png`) })
      await blocks.nth(1).getByRole('button', { name: 'Expand diagram' }).click()
      const viewer = page.getByRole('dialog', { name: 'Flowchart' })
      await expect(viewer).toBeVisible()
      const box = (await viewer.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      await page.waitForTimeout(250)
      if (width === 820) await page.screenshot({ path: resolve(shots, 'dark-820-viewer.png') })
      await page.keyboard.press('Escape')
    } finally { await app.close() }
  }
})

test('150% scale and reduced motion keep the viewer still and the drawing legible', async () => {
  const { app, page } = await launch({ width: 1080, height: 720, scale: '1.5' })
  try {
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.5)
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await stream(page, ['The state machine:', '', fence(STATE)].join('\n'))
    const block = answer(page).locator('.rich-diagram')
    const image = await drawn(block)
    expect(nodesInsideViewBox(decodedSvg(await image.getAttribute('src') ?? ''))).toBe(true)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
    // Sotto's global reduced-motion rule shortens every transition to 1ms.
    const still = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).transitionDuration.split(',').every(value => parseFloat(value) <= 0.001))
    await block.getByRole('button', { name: 'Expand diagram' }).click()
    const viewer = page.getByRole('dialog', { name: 'State diagram' })
    await expect(viewer).toBeVisible()
    expect(await still(viewer)).toBe(true)
    expect(await still(viewer.locator('img'))).toBe(true)
    await page.keyboard.press('Escape')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'on' })
    await block.getByRole('button', { name: 'Expand diagram' }).click()
    await expect(viewer).toBeVisible()
    expect(await still(viewer.locator('img'))).toBe(true)
    await page.screenshot({ path: resolve(shots, 'light-1080-scale-150-viewer-reduced-motion.png') })
    await page.keyboard.press('Escape')
    await expect(image).toBeVisible()
    await scrollTo(block, 60)
    await page.screenshot({ path: resolve(shots, 'light-1080-scale-150-state.png') })
  } finally { await app.close() }
})
