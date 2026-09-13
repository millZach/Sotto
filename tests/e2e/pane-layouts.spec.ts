import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// Three, four and five thread panes across projects on the real app: snapping, row arrangement, dividers by pointer
// and keyboard, moving panes, zoom, compact windows, and restoring the arrangement after a restart. Providers are fixtures.
const SHOTS = 'artifacts/phase-three-layout'

async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    // The shipped minimum is an outer size; relax it slightly so the content area can be exactly 820x560.
    window.setMinimumSize(800, 540)
    window.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)).toBe(`${width}x${height}`)
}

async function capture(page: Page, name: string): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'teal' }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await page.screenshot({ path: `${SHOTS}/${name}-${appearance}.png`, animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', accent: 'teal' }))
}

interface Box { readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** The placed panes in reading order, relative to the pane area. */
const boxes = (page: Page): Promise<Box[]> => page.evaluate(() => {
  const area = document.querySelector('.thread-panes__area')!.getBoundingClientRect()
  return [...document.querySelectorAll<HTMLElement>('section.thread-pane')].filter(pane => !pane.hasAttribute('data-hidden')).map(pane => {
    const box = pane.getBoundingClientRect()
    return { id: pane.dataset['threadId']!, x: Math.round(box.x - area.x), y: Math.round(box.y - area.y), width: Math.round(box.width), height: Math.round(box.height) }
  })
})

const agents = (page: Page) => page.evaluate(async () => window.sotto!.agents!.get())

async function openBeside(page: Page, title: string): Promise<void> {
  const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
  await sidebar.getByRole('button', { name: title, exact: true }).hover()
  await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click()
}

/** Drag a divider by the pointer to a boundary, in pixels from the start of the pane area on its axis. */
async function dragDivider(page: Page, divider: Locator, to: number): Promise<void> {
  const box = (await divider.boundingBox())!
  const area = (await page.locator('.thread-panes__area').boundingBox())!
  const vertical = (await divider.getAttribute('aria-orientation')) === 'vertical'
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  const [x, y] = vertical ? [area.x + to, box.y + box.height / 2] : [box.x + box.width / 2, area.y + to]
  await page.mouse.move(x, y, { steps: 10 })
  await page.mouse.up()
}

test('three, four and five panes snap, resize, move, zoom and come back after a restart', async () => {
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-pane-layouts-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', accent: 'teal' }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false },
    assignments: [], queue: [], activeThreadId: 'grok-previews', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', outbox: [],
  }))
  let launched = await launchSotto('design-threads', profile)
  try {
    let page = launched.page
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    await size(launched, 1600, 1000)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    const panes = page.getByRole('group', { name: 'Thread panes' })
    const pane = (id: string) => panes.locator(`section.thread-pane[data-thread-id="${id}"]`)
    const prompt = (id: string) => pane(id).getByRole('textbox', { name: 'Prompt', exact: true })
    await expect(pane('grok-previews').getByRole('heading', { name: 'Grok voice previews' })).toBeVisible()

    // Two side by side, then a third from another project spans the row below.
    await openBeside(page, 'Footer links')
    await expect(panes.getByRole('region')).toHaveCount(2)
    await openBeside(page, 'Weekly note')
    await expect(panes.getByRole('region')).toHaveCount(3)
    await expect(pane('weekly-note')).toHaveAttribute('data-focused')
    let placed = await boxes(page)
    expect(placed.map(box => box.id)).toEqual(['grok-previews', 'footer-links', 'weekly-note'])
    expect(placed[0]!.y).toBe(placed[1]!.y)
    expect(placed[2]!.y).toBeGreaterThan(placed[0]!.y + placed[0]!.height)
    expect(Math.abs(placed[2]!.width - (placed[0]!.width + placed[1]!.width + 9))).toBeLessThanOrEqual(2)
    await expect(pane('weekly-note').getByText('notes', { exact: true })).toBeVisible()
    await expect(pane('footer-links').getByText('sotto-site', { exact: true })).toBeVisible()
    await prompt('grok-previews').fill('Grok draft stays with its pane.')
    await prompt('footer-links').fill('Footer draft stays with its pane.')
    await prompt('weekly-note').fill('Weekly draft stays with its pane.')
    await capture(page, 'three-1600')

    // A single row from the focused pane's controls, and back to the grid with its sizes.
    const rowToggle = pane('weekly-note').getByRole('button', { name: 'Single row' })
    await rowToggle.click()
    await expect(rowToggle).toHaveAttribute('aria-pressed', 'true')
    placed = await boxes(page)
    expect(new Set(placed.map(box => box.y)).size).toBe(1)
    expect(Math.max(...placed.map(box => box.width)) - Math.min(...placed.map(box => box.width))).toBeLessThanOrEqual(1)
    await capture(page, 'three-row-1600')
    await rowToggle.press('Enter')
    await expect(rowToggle).toHaveAttribute('aria-pressed', 'false')

    // A fourth pane makes a 2-by-2 grid.
    await openBeside(page, 'Visual gate flake')
    await expect(panes.getByRole('region')).toHaveCount(4)
    placed = await boxes(page)
    expect(placed.map(box => box.id)).toEqual(['grok-previews', 'footer-links', 'weekly-note', 'visual-gate'])
    expect(placed[0]!.y).toBe(placed[1]!.y)
    expect(placed[2]!.y).toBe(placed[3]!.y)
    expect(placed[2]!.x).toBe(placed[0]!.x)
    expect(Math.abs(placed[3]!.width - placed[1]!.width)).toBeLessThanOrEqual(1)
    // Its pending permission is live state that must survive every move.
    await expect(pane('visual-gate')).toContainText('npm test -- --run tests/unit/agents')

    // Dividers by pointer, snapping back to the even boundary within reach, and by keyboard.
    const rowsDivider = panes.getByRole('separator', { name: 'Resize rows 1 and 2' })
    const topDivider = panes.getByRole('separator', { name: 'Resize Grok voice previews and Footer links' })
    await expect(rowsDivider).toHaveAttribute('aria-valuenow', '50')
    const area = (await page.locator('.thread-panes__area').boundingBox())!
    await dragDivider(page, topDivider, (area.width - 9) * 0.65 + 4)
    await expect.poll(async () => Number(await topDivider.getAttribute('aria-valuenow'))).toBeGreaterThan(60)
    await dragDivider(page, topDivider, (area.width - 9) * 0.5 + 4 + 8)
    await expect(topDivider).toHaveAttribute('aria-valuenow', '50')
    await dragDivider(page, rowsDivider, (area.height - 9) * 0.4 + 4)
    await expect.poll(async () => Number(await rowsDivider.getAttribute('aria-valuenow'))).toBeLessThan(45)
    await rowsDivider.focus()
    await page.keyboard.press('Enter')
    await expect(rowsDivider).toHaveAttribute('aria-valuenow', '50')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(rowsDivider).toHaveAttribute('aria-valuenow', '60')
    await page.screenshot({ path: `${SHOTS}/four-row-divider-focus-dark.png`, animations: 'disabled' })
    await capture(page, 'four-1600')

    // A fifth pane dragged from the sidebar onto the slot it will take: three across and two below.
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    const wavRow = sidebar.getByRole('button', { name: 'Streaming WAV stall', exact: true })
    await wavRow.hover()
    await page.mouse.down()
    await page.mouse.move(area.x + area.width * 0.5, area.y + area.height * 0.5, { steps: 4 })
    const addHere = page.locator('.thread-panes__drop', { hasText: 'Add here' })
    await expect(addHere).toHaveCount(1)
    const addBox = (await addHere.boundingBox())!
    await page.mouse.move(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2, { steps: 8 })
    await expect(page.getByText('Add here', { exact: true })).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/five-drop-preview-dark.png`, animations: 'disabled' })
    await page.mouse.up()
    await expect(panes.getByRole('region')).toHaveCount(5)
    placed = await boxes(page)
    expect(placed.map(box => box.id)).toEqual(['grok-previews', 'footer-links', 'weekly-note', 'visual-gate', 'wav-stall'])
    expect(new Set(placed.slice(0, 3).map(box => box.y)).size).toBe(1)
    expect(placed[3]!.y).toBe(placed[4]!.y)
    expect(placed[3]!.y).toBeGreaterThan(placed[0]!.y)
    expect(placed[0]!.width).toBeGreaterThanOrEqual(400)
    await expect(prompt('footer-links')).toHaveValue('Footer draft stays with its pane.')
    await capture(page, 'five-1600')

    // Five in one row cannot fit here, so one shows at a time with tabs until there is room.
    await pane('wav-stall').getByRole('button', { name: 'Single row' }).click()
    const tabs = page.getByRole('tablist', { name: 'Open panes' })
    await expect(tabs).toBeVisible()
    await expect(tabs.getByRole('tab')).toHaveCount(5)
    await expect(tabs.getByRole('tab', { name: 'Streaming WAV stall' })).toHaveAttribute('aria-selected', 'true')
    await capture(page, 'five-row-compact-1600')
    await tabs.getByRole('tab', { name: 'Streaming WAV stall' }).focus()
    await page.keyboard.press('ArrowLeft')
    await expect(tabs.getByRole('tab', { name: 'Visual gate flake' })).toHaveAttribute('aria-selected', 'true')
    await expect(pane('visual-gate')).toContainText('npm test -- --run tests/unit/agents')
    await pane('visual-gate').getByRole('button', { name: 'Close Visual gate flake pane' }).click()
    await tabs.getByRole('tab', { name: 'Streaming WAV stall' }).click()
    await pane('wav-stall').getByRole('button', { name: 'Close Streaming WAV stall pane' }).click()
    // Three in a row fit again; the closed threads keep running or waiting in the sidebar.
    await expect(tabs).toHaveCount(0)
    placed = await boxes(page)
    expect(new Set(placed.map(box => box.y)).size).toBe(1)
    expect((await agents(page)).host.threads.find(thread => thread.id === 'visual-gate')!.status).toBe('running')
    await expect(sidebar.getByRole('button', { name: 'Visual gate flake', exact: true })).toBeVisible()
    await pane('weekly-note').click({ position: { x: 200, y: 200 } })
    await pane('weekly-note').getByRole('button', { name: 'Single row' }).click()
    await openBeside(page, 'Visual gate flake')
    await expect(panes.getByRole('region')).toHaveCount(4)
    // The grid kept its sizes through the row arrangement and back.
    await expect(rowsDivider).toHaveAttribute('aria-valuenow', '60')
    await expect(pane('visual-gate')).toContainText('npm test -- --run tests/unit/agents')

    // Move a pane from the keyboard, then by dragging its grip; drafts and focus travel with the pane.
    const grokGrip = pane('grok-previews').getByRole('button', { name: 'Move Grok voice previews pane' })
    await grokGrip.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await boxes(page)).map(box => box.id)).toEqual(['footer-links', 'grok-previews', 'weekly-note', 'visual-gate'])
    await expect(grokGrip).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await boxes(page)).map(box => box.id)).toEqual(['footer-links', 'visual-gate', 'weekly-note', 'grok-previews'])
    await expect(grokGrip).toBeFocused()
    await expect(prompt('grok-previews')).toHaveValue('Grok draft stays with its pane.')
    const footerGrip = pane('footer-links').getByRole('button', { name: 'Move Footer links pane' })
    const weeklyBox = (await pane('weekly-note').boundingBox())!
    await footerGrip.hover()
    await page.mouse.down()
    await page.mouse.move(weeklyBox.x + weeklyBox.width / 2, weeklyBox.y + 40, { steps: 4 })
    await page.mouse.move(weeklyBox.x + weeklyBox.width / 2, weeklyBox.y + weeklyBox.height / 2, { steps: 8 })
    await expect(page.locator('.thread-panes__drop[data-over]', { hasText: 'Move here' })).toHaveCount(1)
    await page.screenshot({ path: `${SHOTS}/four-move-preview-dark.png`, animations: 'disabled' })
    await page.mouse.up()
    await expect.poll(async () => (await boxes(page)).map(box => box.id)).toEqual(['weekly-note', 'visual-gate', 'footer-links', 'grok-previews'])
    await expect(prompt('footer-links')).toHaveValue('Footer draft stays with its pane.')

    // Zoom one pane and return to the same arrangement.
    await prompt('footer-links').focus()
    await page.keyboard.press('Control+Shift+M')
    await expect(panes).toHaveAttribute('data-zoomed')
    await expect(tabs.getByRole('tab', { name: 'Footer links' })).toHaveAttribute('aria-selected', 'true')
    await expect(prompt('footer-links')).toBeFocused()
    await expect(prompt('footer-links')).toHaveValue('Footer draft stays with its pane.')
    await capture(page, 'four-zoomed-1600')
    await pane('footer-links').getByRole('button', { name: 'Show all panes' }).click()
    await expect(panes).not.toHaveAttribute('data-zoomed')
    expect((await boxes(page)).map(box => box.id)).toEqual(['weekly-note', 'visual-gate', 'footer-links', 'grok-previews'])
    await expect(rowsDivider).toHaveAttribute('aria-valuenow', '60')

    // A typical laptop keeps the grid; opening Files leaves too little width, so one pane shows until it closes.
    await size(launched, 1280, 800)
    await expect(tabs).toHaveCount(0)
    await expect.poll(async () => (await boxes(page)).every(box => box.width >= 400 && box.height >= 300)).toBe(true)
    await capture(page, 'four-1280x800')
    const filesToggle = pane('footer-links').locator('[aria-controls="sotto-tools-panel"]')
    await filesToggle.click()
    await expect(page.locator('#sotto-tools-panel')).toBeVisible()
    await expect(tabs).toBeVisible()
    await expect(tabs.getByRole('tab', { name: 'Footer links' })).toHaveAttribute('aria-selected', 'true')
    await capture(page, 'four-1280x800-files')
    await page.locator('#sotto-tools-panel').getByRole('button', { name: 'Close tools panel' }).click()
    await expect(tabs).toHaveCount(0)

    // The shipped minimum window: tabs, one readable composer, keyboard between tabs.
    await size(launched, 820, 560)
    await expect(tabs).toBeVisible()
    await expect(prompt('footer-links')).toBeInViewport()
    await capture(page, 'four-820x560')
    await tabs.getByRole('tab', { name: 'Footer links' }).focus()
    await page.keyboard.press('End')
    await expect(tabs.getByRole('tab', { name: 'Grok voice previews' })).toHaveAttribute('aria-selected', 'true')
    await expect(prompt('grok-previews')).toHaveValue('Grok draft stays with its pane.')
    await page.keyboard.press('Home')
    await expect(tabs.getByRole('tab', { name: 'Weekly note' })).toHaveAttribute('aria-selected', 'true')

    // A short but wide window keeps two rows only while each can hold its content.
    await size(launched, 1600, 560)
    await expect(tabs).toBeVisible()
    await tabs.getByRole('tab', { name: 'Weekly note' }).click()
    await pane('weekly-note').getByRole('button', { name: 'Close Weekly note pane' }).click()
    await tabs.getByRole('tab', { name: 'Visual gate flake' }).click()
    await pane('visual-gate').getByRole('button', { name: 'Close Visual gate flake pane' }).click()
    await expect(tabs).toHaveCount(0)
    await expect(panes.getByRole('region')).toHaveCount(2)
    await capture(page, 'two-1600x560')
    await openBeside(page, 'Weekly note')
    await openBeside(page, 'Visual gate flake')
    await expect(panes.getByRole('region')).toHaveCount(0)
    await expect(tabs.getByRole('tab')).toHaveCount(4)

    // Reduced motion removes the divider and drop transitions.
    await size(launched, 1600, 1000)
    await expect(tabs).toHaveCount(0)
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    expect(parseFloat(await rowsDivider.evaluate(element => getComputedStyle(element, '::before').transitionDuration))).toBeLessThanOrEqual(0.001)
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))

    // Restart: the same threads, order, arrangement, sizes, focus and drafts, with no new work.
    await prompt('weekly-note').fill('Weekly draft survives the restart.')
    await prompt('grok-previews').click()
    await expect(pane('grok-previews')).toHaveAttribute('data-focused')
    await rowsDivider.focus()
    await page.keyboard.press('ArrowUp')
    await expect(rowsDivider).toHaveAttribute('aria-valuenow', '45')
    const columnDivider = panes.locator('[role="separator"][aria-orientation="vertical"]').first()
    await columnDivider.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(columnDivider).toHaveAttribute('aria-valuenow', '40')
    await prompt('grok-previews').click()
    const dividers = (target: Page) => target.getByRole('separator').evaluateAll(items => items.map(item => `${item.getAttribute('aria-label')} ${item.getAttribute('aria-valuenow')}`))
    const sizes = await dividers(page)
    const order = (await boxes(page)).map(box => box.id)
    const before = await agents(page)
    const userMessages = (state: typeof before) => state.host.threads.map(thread => [thread.id, thread.messages.filter(message => message.role === 'user').length])
    expect(before.assignments).toHaveLength(0)
    await page.waitForTimeout(800)
    await closeSotto(launched)

    launched = await launchSotto('design-threads', profile)
    page = launched.page
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    await size(launched, 1600, 1000)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    const restored = page.getByRole('group', { name: 'Thread panes' })
    await expect(restored.getByRole('region')).toHaveCount(4)
    expect((await boxes(page)).map(box => box.id)).toEqual(order)
    await expect(restored.locator('section.thread-pane[data-thread-id="grok-previews"]')).toHaveAttribute('data-focused')
    await expect.poll(() => dividers(page)).toEqual(sizes)
    await expect(restored.locator('section.thread-pane[data-thread-id="weekly-note"]').getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Weekly draft survives the restart.')
    await expect(restored.locator('section.thread-pane[data-thread-id="grok-previews"]').getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Grok draft stays with its pane.')
    const after = await agents(page)
    expect(after.assignments).toHaveLength(0)
    expect(userMessages(after)).toEqual(userMessages(before))
    await capture(page, 'four-restored-1600')
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
