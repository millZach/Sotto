import { isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { build } from 'vite'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Have my agent set this up (issue #431, ADR-0035) in the built app: Add host starts a host setup thread, and the
 * dialog follows it while its tool checks the device (a Node the host cannot run), the thread waits for a command,
 * the agent's next check passes, and the thread asks "Add forge as a host?", answered in the thread, which adds and
 * pairs the real headless host the real launch script starts over a scripted ssh. The tool is called the way a
 * provider calls it, through the end-to-end bridge, since the scripted provider calls no tools. Stop setup, in a
 * second run, leaves no saved host.
 */

/** The contrast of each piece of the setup view's text against the surface it sits on, as host-setup.spec measures it. */
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
    const selector = ['.host-setup__choice-name', '.host-setup__choice-text', '.host-setup__model label', '.host-setup__agent p', '.host-setup__title', '.host-setup__by', '.host-setup__note', '.host-setup__card p', '.hosts-setup-line p'].join(', ')
    return [...document.querySelectorAll<HTMLElement>(selector)].filter(element => element.getClientRects().length && element.textContent?.trim()).map(element => {
      const surface = background(element)
      const text = parse(getComputedStyle(element).color)
      const blended = text.map((channel, index) => index === 3 ? 1 : channel * text[3]! + surface[index]! * (1 - text[3]!))
      const [light, dark] = [luminance(blended), luminance(surface)].sort((a, b) => b - a)
      return { element: element.className, text: element.textContent!.trim().slice(0, 40), ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100 }
    })
  })
}
const lowest: Record<string, Record<string, number>> = {}

/** The dialog at the three window sizes AGENTS.md names, in both rooms: inside the window, 4.5:1 text, a screenshot each. */
async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  const { page } = launched
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await launched.app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width, size.height)
    }, { width, height })
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      const dialog = page.getByRole('dialog')
      if (await dialog.count()) {
        expect(await dialog.evaluate(element => {
          const box = element.getBoundingClientRect()
          return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && element.scrollWidth <= element.clientWidth
        }), `${name} fits at ${width}x${height}`).toBe(true)
      }
      for (const { element, text, ratio } of await contrast(page)) {
        expect(ratio, `${text} (${element}) in ${name} at ${width} ${appearance}`).toBeGreaterThanOrEqual(4.5)
        const key = `${name} ${appearance}`
        lowest[key] = { ...lowest[key], [element]: Math.min(lowest[key]?.[element] ?? Infinity, ratio) }
      }
      await page.screenshot({ path: test.info().outputPath(`${name}-${width}-${appearance}.png`), animations: 'disabled' })
    }
  }
}
const titles = (page: Page) => page.getByRole('list', { name: 'Connection steps' }).locator('.host-setup__title')
type ToolReply = Awaited<ReturnType<NonNullable<SottoE2EBridge['hostSetupTool']>>>
const tool = (page: Page, name: string): Promise<ToolReply> => page.evaluate(value => window.sottoE2E!.hostSetupTool!({ name: value }), name)
const reply = (value: ToolReply): Record<string, unknown> => {
  const text = value.content.find(item => item.type === 'text')
  return JSON.parse(text?.type === 'text' ? text.text : '{}') as Record<string, unknown>
}

async function prepare(): Promise<{ profile: string; root: string; modeFile: string; restore: () => void }> {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-host-agent-setup-'))
  const root = join(profile, 'ssh-root')
  await mkdir(root, { recursive: true })
  // The fake host installation at the dialog's default folder: the real headless host, built for Node.
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await build({ configFile: false, logLevel: 'silent', define: { 'require.main': 'undefined' }, ssr: { noExternal: true },
    build: { ssr: resolve('tests/fixtures/e2eSshHost.ts'), target: 'node24', outDir: install, emptyOutDir: false,
      rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'index.js' } } } })
  // The local host runs: the setup thread is a thread on this computer.
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: true, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl') })
  return { profile, root, modeFile, restore: () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } } }
}
async function finish(launched: LaunchedSotto | undefined, root: string, profile: string, restore: () => void): Promise<void> {
  // The host the launch script started outlives Sotto, as a real one does; this run stops it first.
  const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
  if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
  if (launched) await closeSotto(launched)
  restore()
  await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
async function connectAgents(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
}
/** Types a host through Add host's Another SSH host, the last entry of its Device list. */
async function typeAHost(page: Page, target: string): Promise<void> {
  const form = page.getByRole('dialog', { name: 'Add host' })
  await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  const field = form.getByRole('textbox', { name: 'SSH host' })
  await expect(field).toBeFocused()
  await field.fill(target)
}
/** Settings > Hosts, Add host, forge, and Start setup on the model the picker starts on. */
async function startSetup(page: Page): Promise<void> {
  await openPage(page, 'Settings')
  await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
  await page.getByRole('button', { name: 'Add host', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Add host' })
  await typeAHost(page, 'forge')
  await expect(form.getByRole('radio', { name: 'Have my agent set this up' })).toBeChecked()
  await expect(form.getByRole('combobox', { name: 'Model' })).toHaveValue('claude:test')
  await form.getByRole('button', { name: 'Start setup' }).click()
}
/** The setup thread's own ID on this computer's host, which the scripted provider's events name. */
const setupThread = async (page: Page): Promise<string> => (await page.evaluate(async () => (await window.sotto!.hosts!.get()).setup?.threadId ?? '')).replace(/^host:[0-9a-f-]+:/iu, '')

test('Add host follows a setup thread as it checks forge, waits in the thread, and adds forge once answered', async () => {
  test.setTimeout(300_000)
  const { profile, root, modeFile, restore } = await prepare()
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await connectAgents(page)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    await typeAHost(page, 'forge')
    await capture(launched, 'agent-setup-choose')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Start setup: a normal thread named for the device, and the dialog following it.
    await writeFile(modeFile, 'node-new')
    await startSetup(page)
    const dialog = page.getByRole('dialog', { name: 'Setting up forge' })
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    await expect(dialog.locator('.host-setup__agent p')).toHaveText('Claude Test is setting up forge in the thread Set up forge. You answer each command it wants to run.', { timeout: 60_000 })
    await expect(titles(page)).toHaveText(['Reach forge', 'Sign in', 'Check the host installation', 'Start the host', 'Pair this computer'])
    const threadId = await setupThread(page)
    expect(threadId).not.toBe('')

    // The agent checks: forge's Node is too new, which stays with the agent rather than asking the user to act.
    const first = await tool(page, 'host_check')
    expect(first.isError).toBe(true)
    expect(reply(first)).toMatchObject({ ok: false, step: 'install', reason: 'node-too-new' })
    await expect(dialog.getByText(/^The last check stopped here\. The SSH host runs Node 26\.1\.0/)).toBeVisible()
    await expect(titles(page)).toHaveText(['Reached forge', 'Signed in', 'Check the host installation', 'Start the host', 'Pair this computer'])

    // The thread asks to run a command: a card on the step the setup has reached, with Open thread.
    await page.evaluate(async id => window.sottoE2E!.agentEvent!({ type: 'permission', threadId: id, requestId: 'install-node', text: 'ssh forge mise install node@24' }), threadId)
    const waiting = dialog.getByRole('status').filter({ hasText: 'The agent wants to run a command on forge. Answer it in the thread to carry on.' })
    await expect(waiting).toBeVisible()
    await capture(launched, 'agent-setup-working')

    // Open thread: the setup thread on the Threads page, with the command to answer.
    await waiting.getByRole('button', { name: 'Open thread' }).click()
    await openThreads(page)
    await expect(page.getByRole('heading', { name: 'Set up forge' }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Allow', exact: true }).click()

    // Back in Settings > Hosts: the setup is still running, and Show setup brings the dialog back.
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await expect(page.locator('.hosts-setup-line p')).toHaveText('Claude Test is setting up forge in the thread Set up forge.')
    await page.getByRole('button', { name: 'Show setup of forge' }).click()
    await expect(page.getByRole('dialog', { name: 'Setting up forge' })).toBeVisible()

    // The agent fixed Node; the next check starts the host and pairs nothing.
    await writeFile(modeFile, 'run')
    expect(reply(await tool(page, 'host_check'))).toMatchObject({ ok: true })
    await expect(titles(page)).toHaveText(['Reached forge', 'Signed in', 'Host installed by the agent', 'Host started', 'Pair this computer'])
    await expect.poll(async () => (await page.evaluate(async () => (await window.sotto!.hosts!.get()).hosts.length))).toBe(0)

    // host_add asks in the thread first; the dialog says so on the Pair step, and nothing is added yet.
    const adding = tool(page, 'host_add')
    const asking = page.getByRole('dialog', { name: 'Setting up forge' }).getByRole('status').filter({ hasText: 'Sotto is asking in the thread whether to add forge as a host. Answer it there to carry on.' })
    await expect(asking).toBeVisible()
    await capture(launched, 'agent-setup-asking')
    await asking.getByRole('button', { name: 'Open thread' }).click()
    await openThreads(page)
    const card = page.getByRole('region').filter({ hasText: 'Add forge as a host?' }).first()
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Add forge' }).click()
    expect(reply(await adding)).toMatchObject({ added: true })

    // Connected: saved, paired, and the dialog says who set it up.
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await expect(page.getByRole('region', { name: 'forge', exact: true }).getByText('SSH forge · Connected')).toBeVisible({ timeout: 90_000 })
    expect((JSON.parse(await readFile(join(profile, 'remote-hosts.json'), 'utf8')) as { name: string }[]).map(host => host.name)).toEqual(['forge'])
    // The finished setup stays on the Hosts page until put away; Show setup gives the dialog's last word on it.
    await expect(page.locator('.hosts-setup-line p')).toHaveText('forge is set up and connected. Claude Test set it up in the thread Set up forge.')
    await page.getByRole('button', { name: 'Show setup of forge' }).click()
    const done = page.getByRole('dialog', { name: 'forge is connected' })
    await expect(titles(page)).toHaveText(['Reached forge', 'Signed in', 'Host installed by the agent', 'Host started', 'Paired'])
    await expect(done.getByText(/^forge is added and connected\. Claude Test set it up in/)).toBeVisible()
    await capture(launched, 'agent-setup-connected')
    await done.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.hosts-setup-line')).toHaveCount(0)
    expect(await page.evaluate(async () => (await window.sotto!.hosts!.get()).setup)).toBeUndefined()
    // The actual SSH setup grants this desktop authority immediately. Create a permissive remote
    // thread, then change its mode from the composer over the real socket, without a second prompt.
    const remoteThread = await page.evaluate(async folder => {
      const hostId = (await window.sotto!.hosts!.get()).hosts[0]!.hostId!
      await window.sotto!.hosts!.command({ type: 'select', hostId })
      const projects = await window.sotto!.agents!.command({ type: 'create-project', provider: 'codex', title: 'Remote permissions', path: folder, useExisting: true })
      const project = projects.host.projects.find(item => item.path === folder)!
      const model = (await window.sotto!.agents!.get()).host.models.find(item => item.providerId === 'codex')!
      const created = await window.sotto!.agents!.command({ type: 'create-thread', projectId: project.id, modelId: model.id,
        title: 'Change permissions on forge', managed: false, runtimeMode: 'full-access' })
      if (created.error) throw new Error(created.error)
      return created.host.threads.find(item => item.title === 'Change permissions on forge')!.id
    }, root)
    await openThreads(page)
    await page.getByRole('button', { name: 'Change permissions on forge', exact: true }).click()
    const chip = page.getByRole('combobox', { name: 'Thread permissions', exact: true })
    await expect(chip).toHaveText('Full access')
    await chip.click()
    await page.getByRole('listbox', { name: 'Thread permissions' }).getByRole('option', { name: 'Auto', exact: true }).click()
    await expect.poll(async () => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(item => item.id === id)?.runtimeMode, remoteThread)).toBe('auto')
    await expect(chip).toHaveText('Auto')
    await expect(chip).not.toHaveAttribute('data-pending')
    await expect(page.locator('.thread-workspace__error, .thread-options__notice')).toHaveCount(0)
    for (const [width, height, appearance] of [[1280, 800, 'dark'], [820, 560, 'light']] as const) {
      await resizeWindow(launched, width, height)
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(chip).toBeVisible()
      await page.screenshot({ path: test.info().outputPath(`remote-permissions-${appearance}-${width}.png`), animations: 'disabled' })
    }
    expect(errors).toEqual([])
    await writeFile(test.info().outputPath('agent-setup-contrast.json'), JSON.stringify(lowest, null, 2))
  } finally { await finish(launched, root, profile, restore) }
})

test('Stop setup stops the thread and saves nothing as a host', async () => {
  test.setTimeout(240_000)
  const { profile, root, modeFile, restore } = await prepare()
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    await connectAgents(page)
    await writeFile(modeFile, 'node-new')
    await startSetup(page)
    const dialog = page.getByRole('dialog', { name: 'Setting up forge' })
    await expect(dialog.locator('.host-setup__agent p')).toContainText('is setting up forge', { timeout: 60_000 })
    expect(reply(await tool(page, 'host_check'))).toMatchObject({ reason: 'node-too-new' })
    await dialog.getByRole('button', { name: 'Stop setup' }).click()
    const stopped = page.getByRole('dialog', { name: 'Setup of forge stopped' })
    await expect(stopped.getByText(/Nothing was saved as a host\. Anything the agent installed on forge stays there/)).toBeVisible()
    await capture(launched, 'agent-setup-stopped')
    // The tool is gone with the setup.
    expect((await tool(page, 'host_add')).isError).toBe(true)
    await stopped.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('No remote hosts yet.')).toBeVisible()
    expect(await page.evaluate(async () => (await window.sotto!.hosts!.get()).setup)).toBeUndefined()
    // No file, or an empty list: either way, no host was saved.
    expect(await readFile(join(profile, 'remote-hosts.json'), 'utf8').then(text => JSON.parse(text) as unknown[], () => [])).toEqual([])
  } finally { await finish(launched, root, profile, restore) }
})
