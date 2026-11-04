import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import type { RemoteHostE2EConnection } from '../../src/main/e2e/remoteHost'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, toggleTerminalDrawer, type LaunchedSotto } from './support/sottoLaunch'
import { promptField } from './support/prompt'
import { holdContentSize } from './support/sottoWindow'

// A pane's header (ADR-0163, ADR-0182): the title, project and folder, then pinned to the right in a fixed order the Git
// action (once the host has read the folder), Watch, Tools, the Terminal drawer, one ··· menu and, in a split, close. The
// ··· menu holds the other layout rows and the thread's own, Initialize Git among them; the title is the handle that moves
// a pane.
// Run after `npm run build`. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/pane-header-tools-terminal.
const SHOTS = evidenceDirectory('artifacts/pane-header-tools-terminal')

const pane = (page: Page, id: string): Locator => page.locator(`section.thread-pane[data-thread-id$="${id}"]`)
const header = (page: Page, id: string): Locator => pane(page, id).locator('header.thread-workspace__head')

/** The header's controls, left to right, by what they are. */
const controls = (scope: Locator): Promise<string[]> => scope.locator('.thread-workspace__actions').evaluate(actions =>
  [...actions.children].map(child => child.classList.contains('git-action') ? 'git' : child.classList.contains('watch-toggle') ? 'watch'
    : child.classList.contains('tools-toggle') ? 'tools' : child.hasAttribute('data-pane-terminal-toggle') ? 'terminal'
    : child.classList.contains('pane-menu') ? 'more' : child.classList.contains('thread-pane__close') ? 'close' : child.className))

/** Where each control sits, from the pane's right edge, so a control that keeps its place reads the same. */
const fromRight = (scope: Locator): Promise<number[]> => scope.evaluate(head => {
  const edge = head.closest('section.thread-pane')!.getBoundingClientRect().right
  return [...head.querySelectorAll<HTMLElement>('.thread-workspace__actions > *')].map(control => Math.round(edge - control.getBoundingClientRect().left))
})

/** The parts of the title that are cut off: the name, the project and the folder. */
const cut = (scope: Locator): Promise<string[]> => scope.evaluate(head =>
  [...head.querySelectorAll<HTMLElement>('h2, .thread-workspace__crumb > span:first-of-type, .working-copy__trigger, .working-copy__label')]
    .filter(part => part.offsetWidth > 0 && part.scrollWidth > part.clientWidth + 1).map(part => part.textContent ?? ''))

/** The window's content at exactly this size, held: the nested Linux desktop can hand a new window its first size back. */
async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await holdContentSize(launched, width, height, [820, 560])
}

async function capture(page: Page, name: string): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode, accent: 'teal' }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await page.screenshot({ path: `${SHOTS}/${name}-${appearance}.png`, animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', accent: 'teal' }))
}

test('a pane header carries the Git action, Watch, Tools, the Terminal drawer, one ··· menu and close, and keeps them still', async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-pane-header-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', accent: 'teal' }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true },
    activeThreadId: 'wav-stall', activeProjectId: 'workshop', draft: '', draftThreadId: null, draftRequestId: null, composing: false, outbox: [],
  }))
  const launched = await launchSotto('design-threads', profile)
  try {
    const page = launched.page
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    await size(launched, 1600, 1000)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Footer links', exact: true }).hover({ position: { x: 16, y: 12 } })
    await sidebar.getByRole('button', { name: 'Open Footer links beside', exact: true }).click()
    const left = header(page, 'wav-stall'), right = header(page, 'footer-links')
    await expect(pane(page, 'footer-links')).toBeVisible()

    // The order is fixed and the same in both panes; nothing is drawn for the layout outside the menu.
    for (const head of [left, right]) {
      expect((await controls(head)).filter(control => control !== 'git')).toEqual(['watch', 'tools', 'terminal', 'more', 'close'])
      await expect(head.getByRole('button', { name: /^(Initialize Git|Zoom|Move)/ })).toHaveCount(0)
    }
    await expect(page.locator('.thread-pane__controls, .thread-pane__grip')).toHaveCount(0)
    // The symbols keep their places as focus moves between the panes.
    const unfocused = await fromRight(right)
    await promptField(pane(page, 'footer-links')).click()
    await expect(pane(page, 'footer-links')).toHaveAttribute('data-focused')
    expect(await fromRight(right)).toEqual(unfocused)
    await promptField(pane(page, 'wav-stall')).click()
    await expect(pane(page, 'wav-stall')).toHaveAttribute('data-focused')
    // Two panes side by side at 1600x1000: the title, project and folder are shown, and whole.
    await expect(left.locator('.thread-workspace__crumb > span').first()).toHaveText('workshop')
    await expect(left.locator('.thread-workspace__crumb > span').first()).toBeVisible()
    await expect(right.locator('.thread-workspace__crumb > span').first()).toBeVisible()
    expect(await cut(left)).toEqual([])
    expect(await cut(right)).toEqual([])
    await capture(page, 'split-1600x1000')

    // The ··· menu: the other layout rows with their keys, then the thread's own. The fixture's folders have no Git status, so
    // Initialize Git, first of the thread's own for a folder without Git, is proved in git-actions.spec.ts.
    const more = left.getByRole('button', { name: 'More actions', exact: true })
    await more.click()
    const menu = left.getByRole('menu', { name: 'More actions' })
    const rows = await menu.locator('[role^="menuitem"]').evaluateAll(items => items.map(item => item.querySelector('.pane-menu__label')?.textContent ?? item.textContent))
    expect(rows.slice(0, 3)).toEqual(['Open beside', 'Zoom pane', 'Move pane right'])
    expect(rows).toContain('Rename')
    expect(rows).not.toContain('Tools')
    expect(rows).not.toContain('Terminal drawer')
    await expect(menu.getByRole('menuitem', { name: 'Zoom pane' })).toHaveAttribute('aria-keyshortcuts', /Shift\+M$/)
    await capture(page, 'menu-1600x1000')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(more).toBeFocused()

    // The drawer's keys find the pane and its symbol says whether it shows; the symbol opens it below the thread too.
    const drawerSymbol = left.getByRole('button', { name: 'Terminal drawer', exact: true })
    await expect(drawerSymbol).toHaveAttribute('aria-keyshortcuts', /J$/)
    await promptField(pane(page, 'wav-stall')).focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyJ' : 'Control+KeyJ')
    await expect(pane(page, 'wav-stall').locator('.pane-terminal')).toBeVisible()
    await expect(drawerSymbol).toHaveAttribute('aria-pressed', 'true')
    await toggleTerminalDrawer(pane(page, 'wav-stall'))
    await expect(pane(page, 'wav-stall').locator('.pane-terminal')).toHaveCount(0)
    await expect(drawerSymbol).toHaveAttribute('aria-pressed', 'false')

    // Tools in the pane that does not hold focus moves to that thread and opens; a press there once it holds focus closes it.
    // (With the panel open, a 1600px window shows the panes on tabs, so the two panes side by side are back once it closes.)
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await right.locator('.tools-toggle').click()
    await expect(panel).toBeVisible()
    await expect(pane(page, 'footer-links')).toHaveAttribute('data-focused')
    await expect(right.locator('.tools-toggle')).toHaveAttribute('aria-pressed', 'true')
    await right.locator('.tools-toggle').click()
    await expect(panel).toHaveCount(0)
    await expect(pane(page, 'wav-stall')).toBeVisible()
    await promptField(pane(page, 'wav-stall')).click()

    // Dragging the divider moves the left pane's edge and its controls with it, and moves nothing in either header against
    // its own pane's right edge: the right pane's controls stay where they were on screen. Only Watch, first in the row, takes
    // its word back as the right pane passes 720px, which grows it leftward into the room beside the name.
    const leftBefore = await fromRight(left), rightBefore = await fromRight(right)
    const rightOnScreen = await right.locator('.thread-workspace__actions').boundingBox()
    const divider = page.getByRole('separator', { name: 'Resize panes' })
    const box = (await divider.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x - 160, box.y + box.height / 2, { steps: 12 })
    await page.mouse.up()
    expect(await fromRight(left)).toEqual(leftBefore)
    expect((await fromRight(right)).slice(1)).toEqual(rightBefore.slice(1))
    const rightNow = (await right.locator('.thread-workspace__actions').boundingBox())!
    expect(rightNow.x + rightNow.width).toBeCloseTo(rightOnScreen!.x + rightOnScreen!.width, 0)
    await divider.dblclick()

    // Move pane from the menu, by the keyboard: the panes trade places and focus stays on the ··· button.
    await more.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('End')
    await expect(left.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Move pane right' })).toBeVisible()
    await left.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Move pane right' }).click()
    await expect.poll(() => page.locator('section.thread-pane').evaluateAll(sections => sections.map(section => section.getAttribute('aria-label')))).toEqual(['Footer links', 'Streaming WAV stall'])
    await expect(pane(page, 'wav-stall').getByRole('button', { name: 'More actions', exact: true })).toBeFocused()

    // The title is the handle: dragged onto the other pane, the panes trade places back.
    const title = pane(page, 'wav-stall').locator('.thread-workspace__title h2')
    await title.dragTo(pane(page, 'footer-links').locator('.thread-workspace__transcript, [role="log"]').first())
    await expect.poll(() => page.locator('section.thread-pane').evaluateAll(sections => sections.map(section => section.getAttribute('aria-label')))).toEqual(['Streaming WAV stall', 'Footer links'])

    await size(launched, 1280, 800)
    expect((await controls(left)).filter(control => control !== 'git')).toEqual(['watch', 'tools', 'terminal', 'more', 'close'])
    await capture(page, 'split-1280x800')
    await size(launched, 820, 560)
    // At the minimum the panes become tabs, and the shown pane keeps the same header, nothing clipped.
    const shown = page.locator('section.thread-pane:not([data-hidden]) header.thread-workspace__head')
    expect((await controls(shown)).filter(control => control !== 'git')).toEqual(['watch', 'tools', 'terminal', 'more', 'close'])
    const overflow = await shown.evaluate(head => [...head.querySelectorAll<HTMLElement>('.thread-workspace__actions > *')]
      .filter(control => control.getBoundingClientRect().right > head.getBoundingClientRect().right + 0.5 || control.getBoundingClientRect().left < head.getBoundingClientRect().left).length)
    expect(overflow).toBe(0)
    await capture(page, 'tabs-820x560')

    // The name gives way first, as far as it must. Beside a long name the project and folder stay whole while there is
    // room; a short name has no gap after it; hovering shows the full name; every control keeps its place.
    const LONG = 'Fix the desktop thread top bar so the Tools and Terminal symbols come back beside Watch and a long thread name gives way first'
    await page.evaluate(async title => { await window.sotto!.agents!.command({ type: 'rename-thread', threadId: 'wav-stall', title }) }, LONG)
    await size(launched, 1600, 1000)
    await pane(page, 'footer-links').getByRole('button', { name: 'Close Footer links pane', exact: true }).click()
    await expect(pane(page, 'footer-links')).toHaveCount(0)
    await size(launched, 1280, 800)
    const only = header(page, 'wav-stall')
    const name = only.locator('h2')
    await expect(name).toHaveAttribute('title', LONG)
    expect(await cut(only)).toEqual([LONG])
    expect((await name.boundingBox())!.width).toBeGreaterThanOrEqual(150)
    // The floor: with something too wide to give way beside it, a long name stops at 14em (about 210px) and goes no further,
    // while a name narrower than that keeps its own width.
    const squeezed = (): Promise<{ readonly width: number; readonly full: number }> => only.evaluate(head => {
      const crumb = head.querySelector<HTMLElement>('.thread-workspace__crumb')!, heading = head.querySelector<HTMLElement>('h2')!
      crumb.style.cssText = 'flex: none; width: 2000px'
      const measured = { width: heading.getBoundingClientRect().width, full: heading.scrollWidth }
      crumb.style.cssText = ''
      return measured
    })
    const longSqueezed = await squeezed()
    expect(longSqueezed.width).toBeGreaterThanOrEqual(190)
    expect(longSqueezed.width).toBeLessThanOrEqual(230)
    expect((await controls(only)).filter(control => control !== 'git')).toEqual(['watch', 'tools', 'terminal', 'more'])
    await capture(page, 'long-name-1280x800')
    // With room for all of it, the same name shows whole.
    await size(launched, 1600, 1000)
    expect(await cut(only)).toEqual([])
    await capture(page, 'long-name-1600x1000')
    // A short name of narrow letters, the kind an estimate of its width would hold open.
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'rename-thread', threadId: 'wav-stall', title: 'Initial fill' }) })
    await expect(name).toHaveText('Initial fill')
    expect(await cut(only)).toEqual([])
    const shortSqueezed = await squeezed()
    expect(Math.round(shortSqueezed.width)).toBe(shortSqueezed.full)
    const afterName = await only.evaluate(head => {
      const text = document.createRange()
      text.selectNodeContents(head.querySelector('h2')!)
      return Math.round(head.querySelector('.thread-workspace__crumb')!.getBoundingClientRect().left - text.getBoundingClientRect().right)
    })
    expect(afterName).toBeLessThanOrEqual(12)
    await capture(page, 'short-name-1600x1000')
  } finally {
    await closeSotto(launched)
  }
})

// A real paired headless host: the main-only harness bypasses SSH launch, never the remote protocol.
test('a thread on a paired host keeps the Terminal symbol, greyed, saying where its terminal is', async () => {
  test.setTimeout(120_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-pane-header-host-' })).directory
  let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
  let launched: LaunchedSotto | undefined
  try {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on', historyEnabled: false, appearance: 'dark', accent: 'teal' }))
    const native = new E2EAgentHost()
    await native.initializeWorkingFolders(join(profile, 'working-folders', 'codex'))
    host = await startHeadlessHost({ dataDirectory: join(profile, 'remote-host'), port: 0, providers: { codex: native } })
    const url = `http://127.0.0.1:${host.descriptor!.port}`
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
    await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: randomUUID(), name: 'Forge fixture', target: 'forge', identityFile: '',
      installPath: '/opt/sotto', dataDirectory: '/data/sotto', enabled: false, hostId: paired.hostId, clientId: paired.clientId }]))
    const setup = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false })
    await setup.connect()
    await setup.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await setup.command({ type: 'connect', provider: 'codex' })
    const nativeId = setup.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await setup.command({ type: 'rename-thread', threadId: nativeId, title: 'Thread on the host' })
    await setup.close()

    launched = await launchSotto('success', profile)
    const connection: RemoteHostE2EConnection = { url, token: paired.token, hostId: paired.hostId }
    await launched.app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, connection)
    const { page } = launched
    await size(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('button', { name: 'Thread on the host', exact: true }).click()
    const head = page.locator('section.thread-pane[data-focused] header.thread-workspace__head')

    expect((await controls(head)).filter(control => control !== 'git')).toEqual(['watch', 'tools', 'terminal', 'more'])
    const drawerSymbol = head.getByRole('button', { name: 'Terminal drawer', exact: true })
    const where = 'This thread’s terminal is on Forge. Open it there.'
    await expect(drawerSymbol).toHaveAttribute('aria-disabled', 'true')
    await expect(drawerSymbol).toHaveAttribute('title', where)
    await expect(drawerSymbol).toHaveAccessibleDescription(where)
    // It stays reachable from the keyboard, so the reason can be read, and a press opens nothing.
    await drawerSymbol.focus()
    await expect(drawerSymbol).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.pane-terminal')).toHaveCount(0)
    await capture(page, 'paired-host-1280x800')

    // Tools works here as it did, and the menu lists neither.
    await head.locator('.tools-toggle').click()
    await expect(page.getByRole('complementary', { name: 'Tools', exact: true })).toBeVisible()
    await head.locator('.tools-toggle').click()
    await head.getByRole('button', { name: 'More actions', exact: true }).click()
    const rows = await head.getByRole('menu', { name: 'More actions' }).locator('[role^="menuitem"]').allTextContents()
    expect(rows).not.toContain('Tools')
    expect(rows.some(row => row.startsWith('Terminal drawer'))).toBe(false)
  } finally {
    if (launched) await closeSotto(launched)
    await host?.close()
  }
})
