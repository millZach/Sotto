import { resizeWindow } from './support/sottoWindow'
import { buildSshHost } from './support/sshHost'
import { insideWindow } from './support/hostCapture'
async function capture(launched: LaunchedSotto, name: string, check: () => Promise<void>): Promise<void> {
  const { page } = launched
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resizeWindow(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await check()
      // Text meets 4.5:1 on the surface it sits on, in both rooms.
      for (const { element, text, ratio } of await contrast(page)) expect(ratio, `${text} (${element}) in ${name} at ${width} ${appearance}`).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: test.info().outputPath(`${name}-${width}x${height}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await resizeWindow(launched, 1280, 800)
}
import { ownedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

/**
 * #461 in the built app: Have my agent install it on Devin's tile, over a scripted ssh that runs the real launch script and
 * a real headless host whose Devin is not installed (as on forge on September 28) until `devin.installed` appears, as an
 * agent's install would put it where the host looks. From the keyboard: the dialog, with Escape; Start install; the
 * working tile with Show thread, which opens the job's thread, and Stop; and a second job that ends when the host finds
 * Devin, which then waits for the user to sign in. The job's tool is called the way a provider calls it, through the
 * end-to-end bridge, since the scripted provider calls no tools.
 */

/** Whether an element sits wholly inside the window and does not scroll sideways, so nothing is clipped at the minimum size. */
const inside = (locator: Locator) => insideWindow(locator, true)
/** The contrast of each piece of the tiles' and the dialog's text against the surface it sits on, as host-agent-setup.spec measures it. */
function contrast(page: Page) {
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
    const selector = ['.host-agent p', '.host-agent b', '.host-agent .host-setup__model label', '.host-provider__state', '.host-provider__detail', '.host-provider__detail b', '.host-provider__note'].join(', ')
    return [...document.querySelectorAll<HTMLElement>(selector)].filter(element => element.getClientRects().length && element.textContent?.trim()).map(element => {
      const surface = background(element)
      const text = parse(getComputedStyle(element).color)
      const blended = text.map((channel, index) => index === 3 ? 1 : channel * text[3]! + surface[index]! * (1 - text[3]!))
      const [light, dark] = [luminance(blended), luminance(surface)].sort((a, b) => b - a)
      return { element: element.className || element.tagName, text: element.textContent!.trim().slice(0, 40), ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100 }
    })
  })
}
type ToolReply = Awaited<ReturnType<NonNullable<SottoE2EBridge['hostSetupTool']>>>
const tool = (page: Page, name: string): Promise<ToolReply> => page.evaluate(value => window.sottoE2E!.hostSetupTool!({ name: value }), name)
const reply = (value: ToolReply): Record<string, unknown> => {
  const text = value.content.find(item => item.type === 'text')
  return JSON.parse(text?.type === 'text' ? text.text : '{}') as Record<string, unknown>
}
const job = (page: Page) => page.evaluate(async () => (await window.sotto!.hosts!.get()).providerJob ?? null)

test('an agent installs a host’s provider from its tile, with Show thread and Stop, and stops once the host finds it', async () => {
  test.setTimeout(300_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-host-provider-agent-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await buildSshHost(install)
  // The local host runs: the job's thread is a thread on this computer.
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: true, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  const marks = join(root, 'sign-ins')
  await mkdir(marks, { recursive: true })
  await writeFile(modeFile, 'run')
  await writeFile(join(marks, 'codex.signed-in'), '')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'SOTTO_E2E_SIGN_IN_DIR', 'SOTTO_E2E_SIGN_IN_SCRIPT', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'),
    SOTTO_E2E_SIGN_IN_DIR: marks, SOTTO_E2E_SIGN_IN_SCRIPT: resolve('tests/fixtures/fakeSignInCli.mjs'),
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()

    // Add forge yourself: Add it, since the agent is chosen where it is offered.
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add host' })
    await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await form.getByRole('textbox', { name: 'SSH host' }).fill('forge')
    await form.getByRole('radio', { name: 'Add it' }).check()
    await form.getByRole('button', { name: 'Add host', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'forge is connected' })).toBeVisible({ timeout: 90_000 })
    await page.keyboard.press('Enter')

    const row = page.getByRole('region', { name: 'forge', exact: true })
    const showProviders = async (): Promise<Locator> => {
      await row.getByRole('button', { name: 'Show providers on forge' }).click()
      return row.getByRole('list', { name: 'Providers on forge' })
    }
    let grid = await showProviders()
    const tile = (name: string) => grid.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) })
    await expect(tile('Devin')).toContainText('Not installed', { timeout: 30_000 })
    const agentButton = tile('Devin').getByRole('button', { name: 'Have my agent install Devin on forge' })
    await expect(agentButton).toHaveText('Have my agent install it')
    await expect(tile('Devin').getByRole('button', { name: 'Check forge for Devin again' })).toBeVisible()

    // The dialog, from the keyboard: what the agent does, the Model picker on the model used most, and Escape.
    await agentButton.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Install Devin on forge' })
    await expect(dialog).toContainText("An agent installs Devin on forge from this computer, in a thread you can watch. It reaches forge through this computer's SSH, and its tool works only on forge. It stops once forge's host finds Devin; you then sign in.")
    await expect(dialog).toContainText('The thread Install Devin on forge goes in the Host setup project.')
    await expect(dialog.getByRole('combobox', { name: 'Model' })).toHaveValue('claude:test')
    await expect(dialog.getByRole('button', { name: 'Start install' })).toBeFocused()
    await capture(launched, 'agent-dialog', async () => {
      await expect(dialog).toBeVisible()
      expect(await inside(dialog)).toBe(true)
    })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(agentButton).toBeFocused()
    expect(await job(page)).toBeNull()

    // Start install: the tile follows the agent, naming its thread.
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('button', { name: 'Start install' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })
    await expect(tile('Devin')).toContainText('Agent is installing it')
    await expect(tile('Devin')).toContainText('In the thread Install Devin on forge on this computer.')
    const showThread = tile('Devin').getByRole('button', { name: 'Show thread Install Devin on forge' })
    await expect(showThread).toBeFocused()
    await expect.poll(async () => (await job(page))?.phase, { timeout: 60_000 }).toBe('running')
    await capture(launched, 'agent-working', async () => {
      await tile('Devin').scrollIntoViewIfNeeded()
      await expect(tile('Devin')).toContainText('Agent is installing it')
      expect(await inside(tile('Devin'))).toBe(true)
    })

    // The job's tool reads forge's Devin, and Check again finds nothing yet.
    expect(reply(await tool(page, 'provider_status'))).toMatchObject({ host: 'forge', provider: 'Devin', job: 'install', found: false, problem: 'not-installed' })
    expect(reply(await tool(page, 'provider_check'))).toMatchObject({ found: false, problem: 'not-installed' })
    expect((await tool(page, 'host_add')).isError).toBe(true)

    // Show thread: the Threads page, on the job's thread in the Host setup project.
    await showThread.click()
    await openThreads(page)
    await expect(page.getByRole('heading', { name: 'Install Devin on forge' }).first()).toBeVisible()

    // Back on the tile, Stop stops the thread and leaves what it installed; the tool goes with it.
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    grid = await showProviders()
    await tile('Devin').getByRole('button', { name: 'Stop the agent working on Devin on forge' }).click()
    await expect(tile('Devin')).toContainText('Not installed')
    await expect(tile('Devin')).toContainText('Stopped. Anything the agent installed on forge stays there, and the thread Install Devin on forge stays in your Threads list.')
    await expect(agentButton).toBeFocused()
    expect(await job(page)).toMatchObject({ phase: 'stopped' })
    expect((await tool(page, 'provider_status')).isError).toBe(true)

    // A second job: the agent installs Devin where forge's host looks, and the job ends at found, before any sign-in.
    await agentButton.click()
    await dialog.getByRole('button', { name: 'Start install' }).click()
    await expect(tile('Devin')).toContainText('Agent is installing it', { timeout: 60_000 })
    await expect.poll(async () => (await job(page))?.phase, { timeout: 60_000 }).toBe('running')
    await writeFile(join(marks, 'devin.installed'), '')
    expect(reply(await tool(page, 'provider_check'))).toMatchObject({ found: true })
    await expect(tile('Devin')).toContainText('Not signed in')
    await expect(tile('Devin')).toContainText("forge's host found it. Claude Test worked in the thread Install Devin on forge.")
    await expect(tile('Devin').getByText('devin auth login --force-manual-token-flow')).toBeVisible()
    expect(await job(page)).toMatchObject({ phase: 'found' })
    await capture(launched, 'agent-found', async () => {
      await tile('Devin').scrollIntoViewIfNeeded()
      await expect(tile('Devin')).toContainText('Not signed in')
      expect(await inside(tile('Devin'))).toBe(true)
    })
    await writeFile(test.info().outputPath('provider-job.json'), JSON.stringify({ job: await job(page) }, null, 2))
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
