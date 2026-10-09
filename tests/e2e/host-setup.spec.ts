import { buildSshHost } from './support/sshHost'
import { ownedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Add host's setup checklist (#429) in the built app, over a scripted ssh: a failed step, Tailscale SSH holding
 * the connection for approval, and, once approved, the real launch script starting a real headless host
 * (scripted providers) that this computer pairs with. No SSH server, no Tailscale and no browser are touched.
 */
const APPROVAL_URL = 'https://login.tailscale.com/a/l1fixture2b3c'

/**
 * The contrast of each piece of the checklist's text against the surface it sits on, the notice cards'
 * sunken surface included. Computed colours arrive as oklab or oklch; a canvas turns any of them into sRGB.
 */
function checklistContrast(page: Page) {
  return page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const parse = (value: string): number[] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
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
    const selector = ['.host-setup__summary b', '.host-setup__summary p > span', '.host-setup__title', '.host-setup__card p', '.host-setup__link', '.host-setup__command code'].join(', ')
    return [...document.querySelectorAll<HTMLElement>(selector)].filter(element => element.getClientRects().length && element.textContent?.trim()).map(element => {
      const surface = background(element)
      const text = parse(getComputedStyle(element).color)
      const blended = text.map((channel, index) => index === 3 ? 1 : channel * text[3]! + surface[index]! * (1 - text[3]!))
      const [light, dark] = [luminance(blended), luminance(surface)].sort((a, b) => b - a)
      return { element: element.className || element.tagName.toLowerCase(), text: element.textContent!.trim().slice(0, 40), ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100 }
    })
  })
}
/** The lowest contrast measured for each kind of text, by state and appearance, for the verification note. */
const contrast: Record<string, Record<string, number>> = {}

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  const { page } = launched
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await launched.app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width, size.height)
    }, { width, height })
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      // Nothing overflows: the dialog sits inside the window and scrolls in itself rather than sideways.
      expect(await page.getByRole('dialog').evaluate(element => {
        const box = element.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && element.scrollWidth <= element.clientWidth
      })).toBe(true)
      // Text meets 4.5:1 on the surface it sits on, in both rooms.
      for (const { element, text, ratio } of await checklistContrast(page)) {
        expect(ratio, `${text} (${element}) in ${name} at ${width} ${appearance}`).toBeGreaterThanOrEqual(4.5)
        const key = `${name} ${appearance}`
        contrast[key] = { ...contrast[key], [element]: Math.min(contrast[key]?.[element] ?? Infinity, ratio) }
      }
      await page.screenshot({ path: test.info().outputPath(`${name}-${width}-${appearance}.png`), animations: 'disabled' })
    }
  }
}
const steps = (page: Page) => page.getByRole('list', { name: 'Connection steps' }).getByRole('listitem')
/** Types a host through Add host's Another SSH host, the last entry of its Device list (this run's profile lists no devices). */
async function typeAHost(page: Page, target: string): Promise<void> {
  const form = page.getByRole('dialog', { name: 'Add host' })
  await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  const field = form.getByRole('textbox', { name: 'SSH host' })
  await expect(field).toBeFocused()
  await field.fill(target)
}
/** Each step's name, without the card under it. */
const titles = (page: Page) => page.getByRole('list', { name: 'Connection steps' }).locator('.host-setup__title')

test('Add host shows each step, waits for Tailscale approval, shows a failure on its step, and says when the host is connected', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-host-setup-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(root, { recursive: true })
  // The fake host installation at the dialog's default folder: the real headless host, built for Node.
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await buildSshHost(install)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  const previous = Object.fromEntries(['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD'].map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl') })
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()

    // Failed: forge's Node is too new. The failure shows on its own step, with what to do.
    await writeFile(modeFile, 'node-new')
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add host' })
    await typeAHost(page, 'forge')
    await form.getByRole('button', { name: 'Add host', exact: true }).click()
    const failed = page.getByRole('dialog', { name: 'forge could not be added' })
    await expect(failed).toBeVisible({ timeout: 60_000 })
    await expect(failed.getByText('forge · user and port from your SSH configuration')).toBeVisible()
    await expect(titles(page)).toHaveText(['Reached forge', 'Signed in', 'The host cannot run on forge yet', 'Start the host', 'Pair this computer', 'Reach forge over your tailnet'])
    await expect(steps(page).nth(2).getByRole('alert')).toHaveText('The SSH host runs Node 26.1.0, which is newer than this host release supports. Nothing was saved. Install Node 24 for that SSH account, then add the host again.')
    await expect(failed.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled()
    await capture(launched, 'host-setup-failed')
    // Escape closes the dialog and keeps nothing.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('No remote hosts yet.')).toBeVisible()

    // Waiting: Tailscale SSH holds the connection until it is approved in the browser.
    await writeFile(modeFile, 'run+tailscale')
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    await typeAHost(page, 'forge')
    await page.getByRole('dialog', { name: 'Add host' }).getByRole('button', { name: 'Add host', exact: true }).click()
    const connecting = page.getByRole('dialog', { name: 'Connecting to forge' })
    await expect(connecting).toBeVisible()
    const approval = connecting.getByRole('button', { name: 'Open approval page' })
    await expect(approval).toBeFocused({ timeout: 60_000 })
    await expect(titles(page).nth(1)).toHaveText('Waiting for your approval in Tailscale')
    await expect(steps(page).nth(1)).toHaveAttribute('aria-current', 'step')
    await expect(steps(page).nth(1).getByRole('status')).toContainText('forge uses Tailscale SSH, which asks you to approve new connections in your browser. Sotto waits up to 5 minutes and carries on when you approve.')
    await expect(connecting.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
    await capture(launched, 'host-setup-waiting')
    // Nothing opens until pressed; main opens only Tailscale's page (an end-to-end run records it instead).
    const snapshot = () => page.evaluate(() => (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E.snapshot())
    expect((await snapshot()).openedExternalLink ?? null).toBeNull()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await snapshot()).openedExternalLink).toBe(APPROVAL_URL)

    // Approved in the browser: the checklist carries on to Paired without another press.
    await writeFile(join(root, 'approved'), '')
    // forge's Tailscale is not running, so the tailnet step keeps it on SSH and says why (ADR-0053).
    const connected = page.getByRole('dialog', { name: 'forge is connected over SSH' })
    await expect(connected).toBeVisible({ timeout: 90_000 })
    await expect(titles(page)).toHaveText(['Reached forge', 'Approved in Tailscale', 'Signed in', 'Host installed', 'Host started', 'Paired', 'Could not reach forge over your tailnet'])
    await expect(connected.getByText('Tailscale isn’t running on forge, so forge is connected over SSH and nothing was lost. Start Tailscale there, then press Try the tailnet again.')).toBeVisible()
    await expect(connected.getByRole('status').filter({ hasText: 'forge is added and connected over SSH.' })).toBeVisible()
    await expect(connected.getByRole('button', { name: 'Done' })).toBeFocused()
    await capture(launched, 'host-setup-connected')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const row = page.getByRole('region', { name: 'forge', exact: true })
    await expect(row.getByText('SSH forge · Connected')).toBeVisible()
    await row.scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('host-setup-row.png'), animations: 'disabled' })
    expect((JSON.parse(await readFile(join(profile, 'remote-hosts.json'), 'utf8')) as { name: string }[]).map(host => host.name)).toEqual(['forge'])
    expect(await readFile(join(profile, 'remote-hosts.json'), 'utf8')).not.toContain('tailscale.com')
    expect(errors).toEqual([])
    await writeFile(test.info().outputPath('host-setup-contrast.json'), JSON.stringify(contrast, null, 2))
  } finally {
    // The host the launch script started outlives Sotto, as a real one does; this run stops it first. Started
    // on this computer, it holds a copy of the app's output handles, which would keep the app from closing.
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
