import { isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { build } from 'vite'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { hostRelease, localArchiveName, releasesPage, sidecar, tarGz } from '../fixtures/hostArchive'
import { version as desktopVersion } from '../../package.json'
import { closeSotto, launchSotto, openPage, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * #475 in the built app: forge runs an older Sotto host than this computer, and the user updates it from the pill beside
 * the window controls on the Threads page. A scripted ssh runs the real launch script on this machine against a flat
 * install of the real headless host (scripted providers) reporting 0.1.22, and a stand-in releases page publishes this
 * build's host. The first Update meets a checksum that does not match and fails, saying what happened and that the old
 * version still runs; Try again, with the release put right, installs it beside the old one, restarts forge's host and
 * connects to it again, and the pill says forge runs this version. No SSH server, no GitHub and no browser are touched.
 */
const OLD = '0.1.22'
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const

/** The contrast of the pill's and the panel's text against the surface each sits on. */
function updateContrast(page: Page) {
  return page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const parse = (value: string): number[] => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r!, g!, b!, a! / 255]
    }
    const background = (element: Element | null): number[] => {
      const layers: number[][] = []
      for (let node = element; node; node = node.parentElement) {
        const colour = parse(getComputedStyle(node).backgroundColor)
        if (colour[3]! > 0) layers.push(colour)
        if (colour[3] === 1) break
      }
      return layers.reverse().reduce((under, over) => under.map((channel, index) => index === 3 ? 1 : over[index]! * over[3]! + channel * (1 - over[3]!)), [0, 0, 0, 1])
    }
    const luminance = ([r, g, b]: number[]): number => {
      const linear = (channel: number): number => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!)
    }
    const selector = ['.host-update__pill-text', '.host-update__head', '.host-update__name strong', '.host-update__name small', '.host-update__body p', '.host-update__step-title', '.host-update__step-detail', '.host-update__commands'].join(', ')
    return [...document.querySelectorAll<HTMLElement>(selector)].filter(element => element.getClientRects().length && element.textContent?.trim()).map(element => {
      const surface = background(element), text = parse(getComputedStyle(element).color)
      const blended = text.map((channel, index) => index === 3 ? 1 : channel * text[3]! + surface[index]! * (1 - text[3]!))
      const [light, dark] = [luminance(blended), luminance(surface)].sort((a, b) => b - a)
      return { element: element.className || element.tagName.toLowerCase(), text: element.textContent!.trim().slice(0, 40), ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100 }
    })
  })
}
/** Whether an element sits wholly inside the window, so nothing clips at the minimum size. */
const inside = (locator: Locator) => locator.evaluate(element => {
  const box = element.getBoundingClientRect()
  return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5
})
/** Captures each size and appearance, checking that nothing overflows and that the pill's and panel's text is readable. */
async function capture(launched: LaunchedSotto, name: string, check: () => Promise<void>, sizes: readonly (readonly [number, number])[] = SIZES): Promise<void> {
  const { page } = launched
  for (const [width, height] of sizes) {
    await resizeWindow(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await check()
      for (const { element, text, ratio } of await updateContrast(page)) expect(ratio, `${text} (${element}) in ${name} at ${width} ${appearance}`).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: test.info().outputPath(`${name}-${width}x${height}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await resizeWindow(launched, 1280, 800)
}

test('an older host shows a pill on the Threads page, fails an update with its old version still running, then updates on Try again', async () => {
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-host-update-'))
  const root = join(profile, 'ssh-root')
  const installPath = join(root, '~', '.local', 'share', 'sotto-host')
  // forge's host as installed before host updates: one flat install, which says it is 0.1.22.
  await build({ configFile: false, logLevel: 'silent', define: { 'require.main': 'undefined' }, ssr: { noExternal: true },
    build: { ssr: resolve('tests/fixtures/e2eSshHost.ts'), target: 'node24', outDir: join(installPath, 'host'), emptyOutDir: false,
      rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'index.js' } } } })
  await writeFile(join(installPath, 'package.json'), JSON.stringify({ name: 'sotto-host', version: OLD }))
  const project = join(root, '~', 'code', 'render-farm')
  await mkdir(project, { recursive: true })
  // This build's host, published for this machine, and a checksum that does not match it until the release is put right.
  const file = localArchiveName(desktopVersion)
  const archive = tarGz(hostRelease(desktopVersion, await readFile(join(installPath, 'host', 'index.js'), 'utf8'), { commonjs: true }))
  const published = new Map<string, Uint8Array | string>([[`/v${desktopVersion}/${file}`, archive], [`/v${desktopVersion}/${file}.sha256`, `${'0'.repeat(64)}  ${file}\n`]])
  const releases = await releasesPage(published, 1500)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'SOTTO_E2E_HOST_RELEASES_URL', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    SOTTO_E2E_HOST_RELEASES_URL: releases.url, FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'),
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them out of the captures.
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))

    // Add forge, which answers with its old version.
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add host' })
    await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await form.getByRole('textbox', { name: 'SSH host' }).fill('forge')
    await form.getByRole('button', { name: 'Add host', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'forge is connected' })).toBeVisible({ timeout: 90_000 })
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.sotto!.hosts!.get())).hosts[0]?.version).toBe(OLD)

    // Two threads on forge, the second opened beside the first.
    const threads = await page.evaluate(async path => {
      const forgeHost = (await window.sotto!.hosts!.get()).hosts[0]!.hostId!
      await window.sotto!.hosts!.command({ type: 'select', hostId: forgeHost })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'create-project', title: 'render-farm', path, useExisting: true })
      const state = await agents.get()
      const projectId = state.host.projects.find(item => item.title === 'render-farm')!.id
      const ids: string[] = []
      for (const title of ['Bake the hero shot lighting', 'Move finished renders']) {
        await agents.command({ type: 'create-thread', projectId, title, modelId: state.host.models[0]!.id, workingCopy: 'shared' })
        ids.push((await agents.get()).host.threads.find(item => item.title === title)!.id)
      }
      return ids
    }, project)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Bake the hero shot lighting', exact: true }).click()

    // The pill, beside the window controls, before the panes in keyboard order, and outside the window's drag handle.
    const pill = page.getByRole('button', { name: 'Update for forge. Show host updates' })
    await expect(pill).toBeVisible()
    const pane = page.locator(`section.thread-pane[data-thread-id="${threads[0]}"]`)
    expect(await pill.evaluate((element, other) => Boolean(element.compareDocumentPosition(other!) & Node.DOCUMENT_POSITION_FOLLOWING), await pane.elementHandle())).toBe(true)
    const layout = async (): Promise<{ drag: string; headerRight: number; pillLeft: number; pillWidth: number; controlsLeft: number }> => page.evaluate(() => {
      const pillBox = document.querySelector('.host-update__pill')!.getBoundingClientRect()
      const header = document.querySelector('.thread-pane[data-under-controls] .thread-workspace__head')!.getBoundingClientRect()
      return { drag: getComputedStyle(document.querySelector('.host-update__pill')!).getPropertyValue('-webkit-app-region'), headerRight: header.right, pillLeft: pillBox.left, pillWidth: pillBox.width,
        // Linux and macOS draw no controls at the top right; the window's right edge stands in for them.
        controlsLeft: document.querySelector('.threads-view__winctl')?.getBoundingClientRect().left ?? window.innerWidth }
    })
    await capture(launched, 'pill', async () => {
      const box = await layout()
      expect(box.drag).toBe('no-drag')
      // The header, the window's drag handle, stops short of the pill, and the pill stops short of the window controls.
      expect(box.headerRight).toBeLessThanOrEqual(box.pillLeft + 0.5)
      expect(box.pillLeft + box.pillWidth).toBeLessThanOrEqual(box.controlsLeft + 0.5)
      expect(await inside(pill)).toBe(true)
    })

    // Beside a second pane, the pill keeps only its mark, so the last pane's title keeps its room.
    await sidebar.getByRole('button', { name: 'Move finished renders', exact: true }).hover()
    await sidebar.getByRole('button', { name: 'Open Move finished renders beside', exact: true }).click()
    const panes = page.getByRole('group', { name: 'Thread panes' })
    await expect(panes).toHaveAttribute('data-split', /.*/u)
    await capture(launched, 'pill-split', async () => {
      if (await panes.getAttribute('data-narrow') !== null) return
      const box = await layout()
      expect(box.pillWidth).toBeLessThanOrEqual(30)
      expect(box.headerRight).toBeLessThanOrEqual(box.pillLeft + 0.5)
      // The last pane keeps clear of the window controls and the pill's mark and nothing more: its layout controls, and the
      // title before them, move over by the mark's room alone.
      const inset = await page.locator(`section.thread-pane[data-thread-id="${threads[1]}"]`).evaluate(element =>
        element.getBoundingClientRect().right - element.querySelector('.thread-pane__controls')!.getBoundingClientRect().right - 12)
      expect(inset).toBeLessThanOrEqual(116 + 38 + 1)
    }, [[1600, 1000], [1280, 800]])
    await page.locator(`section.thread-pane[data-thread-id="${threads[1]}"]`).getByRole('button', { name: 'Close Move finished renders pane' }).click()

    // From the keyboard: the pill opens the panel on forge, Escape closes it and gives focus back.
    await pill.focus()
    await page.keyboard.press('Enter')
    const panel = page.getByRole('dialog', { name: 'Host updates' })
    await expect(panel.getByText('forge', { exact: true })).toBeFocused()
    await expect(panel.getByText(`${OLD} → ${desktopVersion}`)).toBeVisible()
    await expect(panel.getByText('forge’s threads keep working until you update. Updating restarts its host, so they are unavailable for a few seconds.')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(panel.getByRole('button', { name: `Update forge’s host to ${desktopVersion}` })).toBeFocused()
    await capture(launched, 'panel-needs', async () => { expect(await inside(panel)).toBe(true) })
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(pill).toBeFocused()

    // Update: the download is watched, then its checksum does not match, and nothing was installed.
    await page.keyboard.press('Enter')
    await panel.getByRole('button', { name: `Update forge’s host to ${desktopVersion}` }).click()
    const steps = panel.getByRole('list', { name: 'Steps to update forge' })
    await expect(steps).toBeVisible()
    await expect(page.getByRole('button', { name: 'Updating forge · 1 of 4. Hide host updates' })).toBeVisible()
    await expect(panel.getByRole('button', { name: `Cancel update, and leave forge on ${OLD}` })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('panel-updating-1280x800-dark.png'), animations: 'disabled' })
    await expect(panel.getByText("The download on forge did not match the release's checksum, so Sotto deleted it and installed nothing.")).toBeVisible({ timeout: 60_000 })
    await expect(panel.getByText(`forge still runs ${OLD}. Nothing was lost.`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'forge not updated. Hide host updates' })).toBeVisible()
    await panel.getByRole('button', { name: 'Show commands' }).click()
    await expect(panel.getByLabel('Commands to update forge by hand')).toContainText(`sha256sum -c ${file}.sha256`)
    await capture(launched, 'panel-failed', async () => { expect(await inside(panel)).toBe(true) })
    expect((await readdir(join(installPath, 'versions')).catch(() => [])).filter(name => name !== '.incoming')).toEqual([])
    await expect.poll(async () => (await page.evaluate(() => window.sotto!.hosts!.get())).hosts[0]).toMatchObject({ phase: 'connected', version: OLD })

    // The release is put right; Try again installs it beside the old version, restarts forge's host and reconnects.
    published.set(`/v${desktopVersion}/${file}.sha256`, sidecar(archive, file))
    await panel.getByRole('button', { name: 'Try again to update forge' }).click()
    await expect(panel.getByText(`forge runs Sotto ${desktopVersion}.`)).toBeVisible({ timeout: 90_000 })
    await expect(page.getByRole('button', { name: 'forge updated. Hide host updates' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('panel-done-1280x800-dark.png'), animations: 'disabled' })
    expect(await readFile(join(installPath, 'current'), 'utf8')).toBe(`${desktopVersion}\n`)
    expect(JSON.parse(await readFile(join(installPath, 'versions', desktopVersion, 'package.json'), 'utf8'))).toMatchObject({ version: desktopVersion })
    // The old install stays where it was, and forge's threads are back on the new host under the same IDs.
    await expect(readFile(join(installPath, 'host', 'index.js'), 'utf8')).resolves.toBeTruthy()
    await expect.poll(async () => (await page.evaluate(() => window.sotto!.hosts!.get())).hosts[0]).toMatchObject({ phase: 'connected', version: desktopVersion })
    await expect.poll(async () => (await page.evaluate(() => window.sotto!.agents!.get())).host.threads.filter(thread => thread.clientConnected).map(thread => thread.id)).toEqual(expect.arrayContaining(threads))
    expect(releases.requests.filter(path => path.endsWith('.tar.gz')).length).toBe(2)

    // Dismiss puts it away, and nothing is offered for a host that is up to date.
    await panel.getByRole('button', { name: 'Dismiss the note that forge was updated' }).click()
    await expect(page.locator('.host-update__pill')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    await releases.close()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
