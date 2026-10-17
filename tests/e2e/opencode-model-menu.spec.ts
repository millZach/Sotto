import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/opencode-model-menu')
const sizes = [[1600, 1000], [1280, 800], [820, 560]] as const

/** A model as OpenCode 2 lists it, from the model source `providerID`. */
const native = (providerID: string, id: string, name: string) => ({ id, modelID: id, providerID, name, capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], enabled: true, status: 'active', limit: { context: 200000, output: 32000 } })
/** OpenCode Zen's free models, and three model sources signed in to inside Sotto's OpenCode folder: a long one, to scroll. */
const models = [
  ...['Big Pickle', 'Nemotron 3.5 Super VL Free', 'GLM 5.3 Flash Free', 'DeepSeek V4.1 Flash Free'].map((name, index) => native('opencode', `zen-${index}`, name)),
  ...['Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Sonnet 4.6', 'Claude Haiku 4.5'].map((name, index) => native('anthropic', `claude-${index}`, name)),
  ...['GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.5'].map((name, index) => native('openai', `gpt-${index}`, name)),
  ...['Claude Opus 5.5', 'Claude Sonnet 5', 'GPT-6-Sol', 'Gemini 3.5 Pro', 'Gemini 3.5 Flash', 'Grok 4.7', 'DeepSeek V4.1', 'Qwen 4 Coder 480B', 'Kimi K3',
    'GLM 5.3', 'MiniMax M3', 'Llama 5 Maverick', 'Mistral Large 3', 'Devstral 3'].map((name, index) => native('openrouter', `router-${index}`, name)),
]
const providers = [['opencode', 'OpenCode'], ['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['openrouter', 'OpenRouter']]
  .map(([id, name]) => ({ id, name, activation: 'enabled', package: '@opencode/ai/providers/openai-compatible' }))

/** Resolve color-mix and translucent theme surfaces as Chromium renders them. */
async function textContrast(locator: Locator): Promise<number> {
  return locator.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d')!
    const rgba = (color: string): number[] => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value)
    }
    const blend = (front: number[], back: number[]): number[] => front.slice(0, 3).map((value, index) => value * front[3]! + back[index]! * (1 - front[3]!))
    const ancestors: Element[] = []; let current: Element | null = element
    while (current) { ancestors.unshift(current); current = current.parentElement }
    let background = [255, 255, 255]
    for (const ancestor of ancestors) background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background)
    const foreground = blend(rgba(getComputedStyle(element).color), background)
    const luminance = (color: number[]): number => color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
    return (Math.max(luminance(foreground), luminance(background)) + .05) / (Math.min(luminance(foreground), luminance(background)) + .05)
  })
}

/**
 * The element has stopped moving. The window lays out again for a while after a resize or a change of appearance, and
 * under reduced motion every property still takes a 1ms transition (global.css), which a test window in the background
 * only finishes when it next paints, so the menu reaches the place it was given a moment after it is given it.
 */
async function still(element: Locator): Promise<void> {
  let last = ''
  await expect.poll(async () => {
    const box = JSON.stringify(await element.boundingBox())
    const same = box === last
    last = box
    return same
  }, { intervals: [250] }).toBe(true)
}

/** Nothing the menu draws is cut off, and the menu is inside the window and clear of the chip. */
async function expectWhole(page: Page): Promise<void> {
  await still(page.locator('.model-picker__dialog'))
  const layout = await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('.model-picker__dialog')!.getBoundingClientRect()
    const chip = document.querySelector<HTMLElement>('.model-picker__trigger[aria-expanded="true"]')!.getBoundingClientRect()
    const clipped = [...document.querySelectorAll<HTMLElement>('.model-picker__dialog b, .model-picker__dialog small, .model-picker__step > span, .model-picker__group, [role="option"] > span')]
      .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.textContent)
    const panel = document.querySelector<HTMLElement>('.model-picker__panel')!
    const note = document.querySelector<HTMLElement>('.model-picker__note')?.getBoundingClientRect()
    return { menu: { left: menu.left, top: menu.top, right: menu.right, bottom: menu.bottom }, chip: { top: chip.top, bottom: chip.bottom }, width: innerWidth, height: innerHeight,
      clipped, panelOverflow: panel.scrollWidth - panel.clientWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth,
      noteInside: note === undefined || note.bottom <= menu.bottom + 1 }
  })
  expect(layout.clipped).toEqual([])
  // A long list scrolls; the note under it stays in view.
  expect(layout.noteInside).toBe(true)
  expect(layout.panelOverflow).toBeLessThanOrEqual(1)
  expect(layout.pageOverflow).toBeLessThanOrEqual(1)
  expect(layout.menu.left).toBeGreaterThanOrEqual(0)
  expect(layout.menu.top).toBeGreaterThanOrEqual(0)
  expect(layout.menu.right).toBeLessThanOrEqual(layout.width)
  expect(layout.menu.bottom).toBeLessThanOrEqual(layout.height)
  // Above the chip or below it, never over it.
  expect(layout.menu.bottom <= layout.chip.top + 1 || layout.menu.top >= layout.chip.bottom - 1).toBe(true)
}

test('opens OpenCode’s model menu on its model sources, steps back with Escape and names the source on the chip', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-opencode-menu-' })).directory
  const root = join(profile, 'opencode-fixture')
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  await mkdir(evidence, { recursive: true })
  await writeFile(join(root, 'script.json'), JSON.stringify({ models, providers }))
  const previousEnvironment = {
    SOTTO_E2E_OPENCODE_ROOT: process.env.SOTTO_E2E_OPENCODE_ROOT,
    SOTTO_E2E_OPENCODE_EXECUTABLE: process.env.SOTTO_E2E_OPENCODE_EXECUTABLE,
    SOTTO_OWL_FEATURES: process.env.SOTTO_OWL_FEATURES,
  }
  process.env.SOTTO_E2E_OPENCODE_ROOT = root
  process.env.SOTTO_E2E_OPENCODE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'opencode=1'
  const contrasts: { surface: string; width: number; appearance: string; ratio: number }[] = []
  const pageErrors: string[] = []
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }))
    await page.reload()

    // An OpenCode project whose new thread starts on Claude Sonnet 5 from Anthropic.
    const prepared = await page.evaluate(async path => {
      await window.sotto!.agents!.command({ type: 'connect', provider: 'opencode' })
      await window.sotto!.agents!.command({ type: 'connect', provider: 'codex' })
      const state = await window.sotto!.agents!.get()
      const model = state.host.models.find(candidate => candidate.providerId === 'opencode' && candidate.source === 'Anthropic' && candidate.name === 'Claude Sonnet 5')
      if (!model) return { error: 'no Anthropic model', sources: [...new Set(state.host.models.map(candidate => candidate.source))] }
      await window.sotto!.agents!.command({ type: 'configure', patch: { newThreadModelId: model.id } })
      const created = await window.sotto!.agents!.command({ type: 'create-project', provider: 'opencode', title: 'OpenCode project', path, useExisting: true })
      return { error: created.error, sources: [...new Set(state.host.models.filter(candidate => candidate.providerId === 'opencode').map(candidate => candidate.source))] }
    }, projectPath)
    expect(prepared).toEqual({ error: null, sources: ['OpenCode Zen', 'Anthropic', 'OpenAI', 'OpenRouter'] })
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread in OpenCode project', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New thread', exact: true })).toBeVisible()
    await resizeWindow(launched, 1280, 800)

    // The chip: the OpenCode mark, the source before the model, and the lot in its tooltip and description.
    const chip = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await expect(chip).toHaveText('Anthropic/Claude Sonnet 5')
    await expect(chip).toHaveAttribute('title', 'Claude Sonnet 5 from Anthropic, in OpenCode')
    await expect(chip).toHaveAccessibleDescription('Claude Sonnet 5 from Anthropic, in OpenCode')
    await expect(chip.locator('svg.provider-mark')).toHaveAttribute('data-provider', 'opencode')

    // The keyboard path: open, Down into the sources, Enter into one, Escape back to its row, Escape to the chip.
    const menu = page.getByRole('dialog', { name: 'Choose model', exact: true })
    const search = menu.getByRole('textbox', { name: 'Search models', exact: true })
    const sources = menu.getByRole('group', { name: 'OpenCode model sources', exact: true })
    const row = (name: string): Locator => sources.getByRole('button', { name: new RegExp(`^Show ${name} models`, 'u') })
    await chip.focus()
    await page.keyboard.press('Enter')
    await expect(search).toBeFocused()
    await expect(menu.getByRole('tab', { name: 'OpenCode', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(sources.getByRole('button')).toHaveText(['OpenCode Zen4 models · Free with OpenCode Zen', 'Anthropic4 models', 'OpenAI3 models', 'OpenRouter14 models'])
    await expect(row('Anthropic')).toHaveAttribute('aria-current', 'true')
    // The glossary's words: a model source is neither a service nor a provider (the note under the list means Sotto's providers).
    expect(await menu.locator('.model-picker__panel').evaluate(panel => [...panel.children].filter(child => !child.classList.contains('model-picker__note')).map(child => child.textContent).join(' '))).not.toMatch(/service|provider/iu)
    await page.keyboard.press('ArrowDown')
    await expect(row('OpenCode Zen')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(row('Anthropic')).toBeFocused()
    await page.keyboard.press('Enter')
    const anthropic = menu.getByRole('listbox', { name: 'Anthropic models', exact: true })
    await expect(anthropic.getByRole('option')).toHaveText(['Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Sonnet 4.6', 'Claude Haiku 4.5'])
    await expect(anthropic.getByRole('option', { name: 'Claude Sonnet 5', exact: true })).toBeFocused()
    await expect(menu.getByRole('button', { name: 'Back to model sources', exact: true })).toHaveText('Model sources')
    await page.keyboard.press('Escape')
    await expect(row('Anthropic')).toBeFocused()
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(chip).toBeFocused()

    // Typing skips the step and searches every source; Escape clears it, then leaves the source, then closes.
    await page.keyboard.press('Enter')
    await expect(search).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('End')
    await expect(row('OpenRouter')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu.getByRole('listbox', { name: 'OpenRouter models', exact: true })).toBeVisible()
    await search.focus()
    await page.keyboard.type('claude')
    const everywhere = menu.getByRole('listbox', { name: 'OpenCode models', exact: true })
    await expect(everywhere.getByRole('group')).toHaveCount(2)
    await expect(menu.locator('.model-picker__count')).toHaveText('6 models')
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    await expect(search).toBeFocused()
    await expect(menu.getByRole('listbox', { name: 'OpenRouter models', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(row('OpenRouter')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(chip).toBeFocused()

    // The wheel over the rail still steps providers, and coming back to OpenCode starts on its sources.
    await still(chip)
    await chip.click()
    await row('OpenAI').click()
    const rail = menu.getByRole('tablist', { name: 'Model providers', exact: true })
    const chosen = (): Promise<string> => rail.locator('[role="tab"][aria-selected="true"]').getAttribute('aria-label').then(name => name ?? '')
    const tiles = await rail.getByRole('tab').evaluateAll(items => items.map(item => item.getAttribute('aria-label') ?? ''))
    const at = tiles.indexOf('OpenCode')
    const away = at > 0 ? -100 : 100
    await still(rail)
    const box = (await rail.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, away)
    await expect.poll(chosen).toBe(tiles[at + Math.sign(away)])
    await page.waitForTimeout(300)
    await page.mouse.wheel(0, -away)
    await expect.poll(chosen).toBe('OpenCode')
    await expect(sources).toBeVisible()

    // Pick a model from another source by keyboard; the chip names it.
    await search.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(row('OpenAI')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu.getByRole('option', { name: 'GPT-6-Sol', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(chip).toHaveText('OpenAI/GPT-6-Luna')
    await expect(chip).toHaveAttribute('title', 'GPT-6-Luna from OpenAI, in OpenCode')
    await expect(chip).toBeFocused()

    // Each size, light and dark: the sources, one source and a search, nothing cut off, text readable.
    const shots: string[] = []
    for (const [width, height] of sizes) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
        await still(chip)
        await chip.click()
        await expect(sources).toBeVisible()
        await expectWhole(page)
        for (const [surface, locator] of [['Source count', row('OpenRouter').locator('small')], ['Chosen source', row('OpenAI').locator('b')], ['Source name', row('Anthropic').locator('b')]] as const) {
          const ratio = await textContrast(locator)
          expect(ratio, `${surface} at ${width} ${appearance}`).toBeGreaterThanOrEqual(4.5)
          contrasts.push({ surface, width, appearance, ratio })
        }
        await page.screenshot({ animations: 'disabled', path: join(evidence, `sources-${width}-${appearance}.png`) }); shots.push(`sources-${width}-${appearance}.png`)
        await row('OpenRouter').click()
        await expect(menu.getByRole('listbox', { name: 'OpenRouter models', exact: true })).toBeVisible()
        await expectWhole(page)
        const count = menu.locator('.model-picker__step > span')
        const ratio = await textContrast(count)
        expect(ratio).toBeGreaterThanOrEqual(4.5)
        contrasts.push({ surface: 'Source header count', width, appearance, ratio })
        await page.screenshot({ animations: 'disabled', path: join(evidence, `openrouter-${width}-${appearance}.png`) }); shots.push(`openrouter-${width}-${appearance}.png`)
        await search.fill('claude')
        await expect(menu.getByRole('listbox', { name: 'OpenCode models', exact: true })).toBeVisible()
        await expectWhole(page)
        // The heading is the menu's own surface, so it reads as part of it rather than a band across it.
        expect(await menu.evaluate(element => getComputedStyle(element.querySelector('.model-picker__group')!).backgroundColor === getComputedStyle(element).backgroundColor)).toBe(true)
        const heading = menu.locator('.model-picker__group').first()
        const headingRatio = await textContrast(heading)
        expect(headingRatio).toBeGreaterThanOrEqual(4.5)
        contrasts.push({ surface: 'Source heading', width, appearance, ratio: headingRatio })
        await page.screenshot({ animations: 'disabled', path: join(evidence, `search-${width}-${appearance}.png`) }); shots.push(`search-${width}-${appearance}.png`)
        await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
        await expect(menu).toBeHidden()
        // The chip keeps the model's name whole, and its source is readable beside it.
        const chipText = await chip.evaluate(element => {
          const clipped = (selector: string): boolean => { const part = element.querySelector<HTMLElement>(selector)!; return part.scrollWidth > part.clientWidth }
          return { name: clipped('.model-picker__name'), source: clipped('.model-picker__source'), path: clipped('.model-picker__path') }
        })
        // OpenAI is a short source: neither it nor the model's name gives way at any size.
        expect(chipText).toEqual({ name: false, source: false, path: false })
        const chipRatio = await textContrast(chip.locator('.model-picker__source'))
        expect(chipRatio).toBeGreaterThanOrEqual(4.5)
        contrasts.push({ surface: 'Chip source', width, appearance, ratio: chipRatio })
      }
    }

    // A long model name at the minimum: the source gives way, down to its floor, and the model's name stays whole.
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark', reducedMotion: 'on' }))
    await still(chip)
    await chip.click()
    await search.fill('super vl')
    await menu.getByRole('option', { name: 'Nemotron 3.5 Super VL Free', exact: true }).click()
    await expect(chip).toHaveText('OpenCode Zen/Nemotron 3.5 Super VL Free')
    const longName = await chip.evaluate(element => {
      const name = element.querySelector<HTMLElement>('.model-picker__name')!
      const path = element.querySelector<HTMLElement>('.model-picker__path')!
      const source = element.querySelector<HTMLElement>('.model-picker__source')!
      return { nameClipped: name.scrollWidth > name.clientWidth || path.scrollWidth > path.clientWidth, sourceWidth: source.getBoundingClientRect().width, fontSize: parseFloat(getComputedStyle(source).fontSize),
        chipRight: element.getBoundingClientRect().right, width: innerWidth }
    })
    expect(longName.nameClipped).toBe(false)
    expect(longName.sourceWidth).toBeGreaterThanOrEqual(4.5 * longName.fontSize - 1)
    expect(longName.chipRight).toBeLessThanOrEqual(longName.width)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'chip-long-name-820-dark.png') }); shots.push('chip-long-name-820-dark.png')

    // Motion as the system has it: the menu rises as it opens and settles in the same place.
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark', reducedMotion: 'system' }))
    await still(chip)
    await chip.click()
    await expect(sources).toBeVisible()
    await expect.poll(() => menu.evaluate(element => getComputedStyle(element).animationName)).toBe('thread-chip-rise')
    await page.waitForTimeout(400)
    await expectWhole(page)
    await page.screenshot({ path: join(evidence, 'sources-1280-dark-motion.png') }); shots.push('sources-1280-dark-motion.png')
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await page.evaluate(() => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await chip.click()
    await expect.poll(() => menu.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    await page.keyboard.press('Escape')

    expect(pageErrors).toEqual([])
    await writeFile(join(evidence, 'contrast.json'), `${JSON.stringify(contrasts, null, 2)}\n`)
    await writeFile(join(evidence, 'journey.json'), `${JSON.stringify({ shots, sources: prepared.sources }, null, 2)}\n`)
  } finally {
    if (launched) await closeSotto(launched)
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await removeOwnedE2EProfile(profile)
  }
})
