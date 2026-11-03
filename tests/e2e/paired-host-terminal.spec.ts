import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import type { RemoteHostE2EConnection } from '../../src/main/e2e/remoteHost'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'
import { waitForShellPrompt } from './support/terminal'

// A thread on a paired host opens its terminal over SSH (ADR-0183), on Owl: a real paired headless host for the thread,
// and for ssh a stand-in under the app's real terminal that runs the remote command here. Run after `npm run build`.
// Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/paired-host-terminal.
const SHOTS = evidenceDirectory('artifacts/paired-host-terminal')

/** What the drawer's or Tools' shell has printed, as main holds it: the view draws on a canvas. */
async function printed(page: Page, threadTitle: string, place: 'drawer' | 'tools'): Promise<string> {
  return page.evaluate(async ({ threadTitle, place }) => {
    const threads = (await window.sotto!.agents!.get()).host.threads
    const threadId = threads.find(thread => thread.title === threadTitle)!.id
    const list = await window.sotto!.terminal!.list({ threadId, place })
    if (!list.ok) return `refused: ${list.error.message}`
    const session = list.value.sessions.at(-1)
    if (!session) return ''
    const read = await window.sotto!.terminal!.read({ threadId, workspaceId: list.value.workspace.workspaceId, sessionId: session.id })
    return read.ok ? read.value.output : `refused: ${read.error.message}`
  }, { threadTitle, place })
}

for (const appearance of ['dark', 'light'] as const) test(`a thread on a paired host opens a working terminal in the drawer and in Tools, over SSH (${appearance})`, async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-paired-terminal-' })).directory
  const record = join(profile, 'ssh.jsonl')
  const keys = ['SOTTO_OWL_FEATURES', 'SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_RECORD']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_OWL_FEATURES: 'paired-host-terminal=1', SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSshShell.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath, FAKE_SSH_RECORD: record })
  let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
  let launched: LaunchedSotto | undefined
  try {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on', historyEnabled: false, appearance, accent: 'teal' }))
    const native = new E2EAgentHost()
    const folders = join(profile, 'working-folders', 'codex')
    await native.initializeWorkingFolders(folders)
    host = await startHeadlessHost({ dataDirectory: join(profile, 'remote-host'), port: 0, providers: { codex: native } })
    const url = `http://127.0.0.1:${host.descriptor!.port}`
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
    await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: randomUUID(), name: 'Forge fixture', target: 'zach@forge', identityFile: '',
      installPath: '/opt/sotto', dataDirectory: '/data/sotto', enabled: false, hostId: paired.hostId, clientId: paired.clientId }]))
    const setup = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false })
    await setup.connect()
    await setup.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await setup.command({ type: 'connect', provider: 'codex' })
    const shell = setup.shell().host
    const nativeThread = shell.threads.find(thread => thread.title === 'Workshop')!
    const projectFolder = await realpath(shell.projects.find(project => project.id === nativeThread.projectId)!.path)
    await setup.command({ type: 'rename-thread', threadId: nativeThread.id, title: 'Thread on the host' })
    await setup.close()

    launched = await launchSotto('success', profile)
    const connection: RemoteHostE2EConnection = { url, token: paired.token, hostId: paired.hostId }
    await launched.app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, connection)
    const { page } = launched
    await holdContentSize(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('button', { name: 'Thread on the host', exact: true }).click()
    const head = page.locator('section.thread-pane[data-focused] header.thread-workspace__head')
    const name = 'Thread on the host'

    // The button simply works: pressed, it opens a drawer whose shell starts in the project folder on the host.
    const button = head.getByRole('button', { name: 'Terminal drawer', exact: true })
    await expect(button).not.toHaveAttribute('aria-disabled', 'true')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    const drawer = page.locator('section.thread-pane[data-focused] .pane-terminal')
    await expect(drawer.getByText('on Forge', { exact: true })).toBeVisible()
    await expect(drawer.getByRole('tab', { name: /^shell/u })).toBeVisible()
    const input = drawer.locator('.xterm-helper-textarea')
    await waitForShellPrompt(async () => ({ output: await printed(page, name, 'drawer'), status: 'running' }))
    await input.focus()
    await page.keyboard.type(process.platform === 'win32' ? 'Write-Output ("MARK"+"ER:"+$PWD.Path)\n' : 'printf "%s:%s\\n" "MARK""ER" "$PWD"\n')
    await expect.poll(async () => (await printed(page, name, 'drawer')).replace(/\s+/gu, ''), { timeout: 30_000 }).toContain(`MARKER:${projectFolder}`.replace(/\s+/gu, ''))
    await page.screenshot({ path: join(SHOTS, `drawer-1280x800-${appearance}.png`) })
    // Where a shell runs stays on the bar at every size, with nothing cut off or spilling out.
    for (const [width, height] of [[1600, 1000], [820, 560]] as const) {
      await holdContentSize(launched, width, height)
      await expect(drawer.getByText('on Forge', { exact: true })).toBeVisible()
      const bar = drawer.locator('.terminal-bar')
      expect(await bar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.screenshot({ path: join(SHOTS, `drawer-${width}x${height}-${appearance}.png`) })
    }
    await holdContentSize(launched, 1280, 800)

    // The window named only a thread: main built the target and everything else from the saved host.
    const first = JSON.parse((await readFile(record, 'utf8')).trim().split('\n')[0]!) as string[]
    expect(first[0]).toBe('-tt')
    expect(first[first.indexOf('--') + 1]).toBe('zach@forge')

    // Tools' Terminal works too, starting its own shell, and the drawer's stays its own.
    await head.locator('.tools-toggle').click()
    const tools = page.getByRole('complementary', { name: 'Tools', exact: true })
    await tools.getByRole('tab', { name: 'Terminal', exact: true }).click()
    await tools.getByRole('button', { name: 'Start terminal', exact: true }).click()
    await expect(tools.getByText('on Forge', { exact: true })).toBeVisible()
    await expect.poll(async () => (await readFile(record, 'utf8')).trim().split('\n').length).toBe(2)
    await page.screenshot({ path: join(SHOTS, `tools-1280x800-${appearance}.png`) })
    await head.locator('.tools-toggle').click()

    // A shell's end by a lost connection is ssh's 255, which says so and offers Reopen.
    await input.focus()
    await page.keyboard.type('exit 255\n')
    await expect(drawer.getByText('The connection to Forge ended.', { exact: true })).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: join(SHOTS, `connection-ended-1280x800-${appearance}.png`) })
    await drawer.getByRole('button', { name: 'Reopen', exact: true }).click()
    await expect(drawer.getByText('The connection to Forge ended.', { exact: true })).toHaveCount(0)
    await expect.poll(async () => (await readFile(record, 'utf8')).trim().split('\n').length).toBe(3)

    // A pass through the keys: Ctrl+J hides it, and the shell keeps its tab.
    await input.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+J' : 'Control+J')
    await expect(drawer).toHaveCount(0)
    await expect(button).toHaveAttribute('aria-pressed', 'false')
  } finally {
    if (launched) await closeSotto(launched)
    await host?.close()
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
  }
})
