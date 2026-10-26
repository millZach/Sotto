/**
 * A remote parent's delegated threads in Tools › Agents (#1310, Zach's pick on October 23, 2026: variant B of the remote
 * roster prototype), in the built Owl app, over a real headless host in this process and the real paired socket, router,
 * IPC and renderer. Codex's fake app server is the provider there, and each tool call goes through the host's own loopback
 * `sotto_delegate` server with the thread's own token, as the provider makes it. The parent runs on the host and delegates
 * there: a build held to Ask for approval because the host had no desktop defaults yet, a research pass that answers and
 * delegates a list in turn, one refused for asking for another machine, and, once the desktop has told the host its
 * defaults without letting it answer there, a second build held for that. The roster groups them under the host's heading
 * with its count; the cards name the host; when the host goes away each row keeps its last outcome greyed, as of when Sotto
 * lost it, and reads afresh when it connects again.
 *
 *   npm run build && npx playwright test tests/e2e/remote-roster.spec.ts
 */
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { ScopedThreadTools } from '../../src/main/agents/threadToolServer'
import type { RemoteHostE2EConnection } from '../../src/main/e2e/remoteHost'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { codexFixture } from '../fixtures/codexFixture'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { OWL_E2E_VERSION, onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/remote-roster')
const PARENT = 'Tidy the host protocol docs'
/** The window on the host machine itself, which may give any permission, as the user at that machine may. */
const AT_HOST = { clientId: 'host-window', user: 'Synthetic user at the host', transport: 'ipc' } as const

type Delegated = { status: string; code?: string; delegation?: { id: string; thread: string } }

const tools = (page: Page): Locator => page.getByRole('complementary', { name: 'Tools', exact: true })
const pane = (page: Page): Locator => page.locator('section.thread-pane:not([data-hidden])')

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await launched.page.mouse.move(0, 0)
  await launched.page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' })
}

/** The roster fits Tools at every size, and its text, headings and notice are 4.5:1 on what they sit on. */
async function rosterFits(page: Page, where: string): Promise<void> {
  expect((await pageBoundProblems(page)).filter(problem => !/^button-Open .*-content-clipped$/u.test(problem)), where).toEqual([])
  expect(await tools(page).evaluate(panel => {
    const roster = panel.querySelector<HTMLElement>('.subagents-roster')
    return roster !== null && roster.scrollWidth > roster.clientWidth + 1
  }), `${where}: the roster scrolls sideways`).toBe(false)
  const pairs = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const pixel = (): string => `#${[...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    const backdrop = (element: Element): string => {
      const layers: string[] = []
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor
        if (color === 'rgba(0, 0, 0, 0)' || color === 'transparent') continue
        layers.push(color)
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
        if (context.getImageData(0, 0, 1, 1).data[3] === 255) break
      }
      context.clearRect(0, 0, 1, 1)
      for (const layer of layers.reverse()) { context.fillStyle = layer; context.fillRect(0, 0, 1, 1) }
      return pixel()
    }
    const ink = (element: Element): string => { context.clearRect(0, 0, 1, 1); context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1); return pixel() }
    const selectors = ['.roster-machine__name', '.roster-machine__head > span:not(.roster-machine__name)', '.roster-machine__note', '.roster-notice', '.delegated-row .subagent-title',
      '.delegated-row .subagent-description', '.delegated-row .subagent-meta', '.delegated-row .subagent-time', '.delegated-row__status', '.delegated-row__held', '.delegated-row__open',
      '.delegated-work__state', '.delegated-work__line', '.delegated-work__held', '.delegated-work__meta']
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0)
      .map((element, index) => ({ name: `${selector} ${index}`, ink: ink(element), on: backdrop(element) })))
  })
  const black = { r: 0, g: 0, b: 0 }
  expect(pairs.length, where).toBeGreaterThan(0)
  for (const { name, ink, on } of pairs) expect(contrastRatio(parseThemeRgb(ink, black), parseThemeRgb(on, black)), `${name}, ${where}`).toBeGreaterThanOrEqual(4.5)
}

test('a remote parent\'s delegated threads: grouped under its machine, held lines, the refusal, and kept greyed while the host is away', async () => {
  test.setTimeout(300_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-remote-roster-' })).directory
  const hostData = join(profile, 'remote-host')
  // Codex's own app server, faked as a child process, which takes Sotto's tool servers at each launch as the real one does.
  // The fake keeps its own folder under the system's temporary folder, which its cleanup checks before removing it.
  const native = await codexFixture(undefined, false, 10_000)
  const provider = { tools: [] as readonly ScopedThreadTools[] }
  const useThreadTools = native.adapter.useThreadTools.bind(native.adapter)
  native.adapter.useThreadTools = list => { provider.tools = list; useThreadTools(list) }
  let host: Awaited<ReturnType<typeof startFixtureHeadlessHost>> | undefined
  let launched: LaunchedSotto | undefined
  try {
    await mkdir(hostData, { recursive: true })
    const started = await startFixtureHeadlessHost({ dataDirectory: hostData, port: 0, sottoVersion: OWL_E2E_VERSION, providers: { codex: native.adapter } })
    host = started
    const url = `http://127.0.0.1:${host.descriptor!.port}`
    const command = async (value: Parameters<typeof started.service.command>[0]) => {
      const state = await started.service.command(value, AT_HOST)
      expect(state.error).toBeNull()
      return state
    }
    await command({ type: 'connect', provider: 'codex' })
    const folder = join(profile, 'host-project'); await mkdir(folder, { recursive: true })
    const project = (await command({ type: 'create-project', provider: 'codex', title: 'Sotto', path: folder, useExisting: true })).host.projects.find(item => item.path === folder)!
    const model = host.service.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
    const thread = (id: string) => host!.service.shell().host.threads.find(item => item.id === id)
    const session = async (threadId: string): Promise<string> => {
      let found: string | undefined
      await expect.poll(async () => {
        const registry = JSON.parse(await readFile(join(hostData, 'threads.json'), 'utf8').catch(() => '{"bindings":[]}')) as { bindings: { threadId: string; sessionId: string }[] }
        found = registry.bindings.find(binding => binding.threadId === threadId)?.sessionId
        return found
      }).toBeDefined()
      return found!
    }
    /** A tool call as the provider makes it: through the thread's own loopback server on the host, with its own token. */
    const call = async (threadId: string, name: string, args: Record<string, unknown>): Promise<Delegated> => {
      const server = await provider.tools.find(item => item.name === 'sotto_delegate')!.mcpServer(await session(threadId))
      const response = await fetch(server!.url, { method: 'POST', headers: { 'Content-Type': 'application/json', [server!.headers[0]!.name]: server!.headers[0]!.value },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
      return ((await response.json()) as { result: { structuredContent: Delegated } }).result.structuredContent
    }
    /** The provider ends the thread's running turn with a reply; the host has seen that turn end, whatever starts after it. */
    const reply = async (threadId: string, text: string): Promise<string | undefined> => {
      const turn = thread(threadId)?.lastTurn?.id
      await native.driver.completeTurn(await session(threadId), text)
      await expect.poll(() => { const last = thread(threadId)?.lastTurn; return last !== undefined && (last.id !== turn || last.status === 'completed') }).toBe(true)
      return turn
    }
    const delegate = (from: string, work: string, title: string, brief: string, extra: Record<string, unknown> = {}) =>
      call(from, 'delegate', { work, title, brief, provider: 'codex', model: model.id, effort: 'low', wait_seconds: 0, ...extra })

    // The user starts the parent at the host. It delegates before any desktop has told the host its defaults.
    const parentId = randomUUID()
    await command({ type: 'create-thread', threadId: parentId, projectId: project.id, title: PARENT, titleSource: 'user', modelId: model.id, runtimeMode: 'full-access', workingCopy: 'shared' })
    await command({ type: 'manual-send', threadId: parentId, draftId: randomUUID(), text: 'Get the host protocol docs in shape for the agents view. Have someone review the socket changes and run the contract tests.' })
    const tests = await delegate(parentId, 'building', 'Run the host contract tests', 'Run tests/integration/hostServiceContract.ts against the headless host on this machine and report which cases fail and why.')
    expect(tests.status, JSON.stringify(tests)).toBe('ok')
    const research = await delegate(parentId, 'research', 'Find what the iPhone reads for agents', 'Read docs/host-protocol.md for every field the phone reads from thread-delegations.', { permission: 'approval-required' })
    expect(research.status, JSON.stringify(research)).toBe('ok')
    const list = await delegate(research.delegation!.thread, 'research', 'List the agents-view fields', 'From docs/host-protocol.md, list each field of thread-delegations with its type.', { permission: 'approval-required' })
    expect(list.status, JSON.stringify(list)).toBe('ok')
    await reply(list.delegation!.thread, 'Synthetic list of fields')
    const researched = await reply(research.delegation!.thread, 'Synthetic research finding')
    // The list's answer reached the research thread while its turn ran, so it wakes that thread once the turn ends.
    await expect.poll(() => thread(research.delegation!.thread)?.lastTurn?.id).not.toBe(researched)
    await reply(research.delegation!.thread, 'Synthetic reply to the answer of the list')
    await expect.poll(() => thread(research.delegation!.thread)?.lastTurn?.status).toBe('completed')
    // Asked for a system the host is not: the start is refused, and its record keeps what was asked for.
    const otherSystem = process.platform === 'darwin' ? 'windows' : 'macos'
    expect(await delegate(parentId, 'building', 'Sign the Mac build', 'Notarize the Mac build.', { os: otherSystem })).toMatchObject({ status: 'refused', code: 'MACHINE_UNAVAILABLE' })

    // The desktop pairs, and the launch script's record makes it a desktop there. It gets no answers grant.
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
    await writeFile(join(hostData, DESKTOP_CLIENTS_FILE), JSON.stringify([paired.clientId]))
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on', appearance: 'dark' }))
    const connection: RemoteHostE2EConnection = { url, token: paired.token, hostId: paired.hostId }

    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page, app } = launched
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, connection)
      // Told on connecting: the host keeps this desktop's defaults, which count for nothing there without a grant.
      await expect.poll(async () => readFile(join(hostData, 'desktop-defaults.json'), 'utf8').catch(() => ''), { timeout: 30_000 }).toContain(paired.clientId)
      const review = await delegate(parentId, 'building', 'Review the delegation socket changes', 'Review the host\'s delegation changes in src/host/ against ADR-0081. Report findings with the file and line.')
      expect(review.status, JSON.stringify(review)).toBe('ok')

      await resizeWindow(launched, 1280, 800)
      await openThreads(page)
      await page.getByRole('button', { name: PARENT, exact: true }).click()
      await expect(pane(page).locator('.thread-workspace__head h2')).toHaveText(PARENT)

      // The parent's rows of delegated work name the host; the refusal names what it asked for, in Zach's words.
      const cards = pane(page)
      const work = (title: string): Locator => cards.getByRole('listitem', { name: new RegExp(`^Building: ${title}, `, 'u') })
      // A turn that folds keeps its rows in its Worked for fold.
      const fold = cards.getByRole('button', { name: /^Worked for/u }).last()
      if (await fold.count() && await fold.getAttribute('aria-expanded') === 'false') await fold.click()
      await expect(work('Review the delegation socket changes')).toBeVisible({ timeout: 30_000 })
      await expect(work('Run the host contract tests').locator('.delegated-work__meta')).toContainText('Forge')
      await expect(work('Run the host contract tests').locator('.delegated-work__held'))
        .toHaveText('Started at Ask for approval: Forge had no new-thread default from this computer yet.')
      await expect(work('Review the delegation socket changes').locator('.delegated-work__held'))
        .toHaveText('Held at Ask for approval: this computer can\'t answer on Forge.')
      await expect(cards.getByRole('listitem', { name: 'Building, not delegated, Refused' }).locator('.delegated-work__line'))
        .toHaveText(`Asked for ${process.platform === 'darwin' ? 'a Windows machine' : 'a Mac'}. Forge can start threads only on Forge for now. Nothing was started.`)
      await capture(launched, 'delegated-work-dark-1280x800')

      // Tools › Agents: a heading for Forge with its count, and its threads under it, both levels.
      await pane(page).getByRole('button', { name: 'Tools', exact: true }).click()
      await page.getByRole('tab', { name: 'Agents', exact: true }).click()
      const forge = tools(page).getByRole('region', { name: /^Forge/u })
      await expect(forge.getByRole('heading', { level: 3 })).toHaveText('Forge4 threads · 2 working', { timeout: 30_000 })
      const rows = forge.getByRole('list', { name: 'Delegated threads on Forge, newest first' })
      const row = (title: string): Locator => rows.locator('li', { has: page.locator('.subagent-title', { hasText: title }) })
      await expect(row('List the agents-view fields')).toHaveAttribute('data-nested', 'true')
      // Its last turn, the wake-up with the list's answer, finished while no one had it open.
      await expect(row('Find what the iPhone reads for agents').locator('.delegated-row__status')).toHaveText('Just finished')
      await expect(row('Run the host contract tests').locator('.delegated-row__held')).toHaveText('Started at Ask for approval: Forge had no new-thread default from this computer yet.')
      await expect(row('Review the delegation socket changes').locator('.delegated-row__held')).toHaveText('Held at Ask for approval: this computer can\'t answer on Forge.')
      await expect(row('Review the delegation socket changes').locator('.subagent-meta')).toContainText('Codex · Building')
      // The keyboard opens a row to its whole brief, read from the host, and the held reason; Escape closes it.
      const head = row('Review the delegation socket changes').locator('.subagent-head')
      await head.focus()
      await page.keyboard.press('Enter')
      await expect(row('Review the delegation socket changes').locator('.subagent-details')).toContainText('Report findings with the file and line.')
      await expect(row('Review the delegation socket changes').locator('.subagent-result')).toContainText('It started at Ask for approval, because this computer can\'t answer permission requests on Forge')
      await capture(launched, 'roster-opened-dark-1280x800')
      await page.keyboard.press('Escape')
      await expect(head).toHaveAttribute('aria-expanded', 'false')
      await expect(head).toBeFocused()
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await rosterFits(page, `connected ${appearance} ${width}x${height}`)
          await capture(launched, `roster-${appearance}-${width}x${height}`)
        }
      }

      // The host goes away: each row keeps its last outcome, greyed, as of when Sotto lost it, and the roster says so.
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
      await resizeWindow(launched, 1280, 800)
      await app.evaluate(async (_, hostId) => { await globalThis.sottoRemoteHostE2E!.disconnect(hostId, true) }, paired.hostId)
      await expect(row('Review the delegation socket changes').locator('.delegated-row__status')).toHaveText('Working when last read', { timeout: 30_000 })
      await expect(row('Find what the iPhone reads for agents').locator('.delegated-row__status')).toHaveText('Answered when last read')
      await expect(row('Review the delegation socket changes').locator('.subagent-time')).toHaveText(/^as of \d{1,2}:\d{2}/u)
      await expect(forge.getByRole('heading', { level: 3 })).toHaveText('Forge4 threadsnot connected')
      await expect(tools(page).getByRole('status').filter({ hasText: 'Forge is not connected.' })).toHaveText(/^Forge is not connected\. These threads are as Sotto last read them at \d{1,2}:\d{2}(?: [ap]m)?\. Losing the connection stops nothing on Forge\.$/u)
      await expect(work('Review the delegation socket changes').locator('.delegated-work__state')).toHaveText('Working when last read')
      await expect(work('Review the delegation socket changes').locator('.delegated-work__line')).toContainText('Forge is not connected, so Sotto cannot read how it went since.')
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await rosterFits(page, `away ${appearance} ${width}x${height}`)
          await capture(launched, `away-${appearance}-${width}x${height}`)
        }
      }

      // While it was away the review answered there. Connected again, the roster reads the host's own record afresh.
      await reply(review.delegation!.thread, 'Synthetic review finding')
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
      await resizeWindow(launched, 1280, 800)
      await app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, connection)
      await expect(row('Review the delegation socket changes').locator('.delegated-row__status')).toHaveText(/^(Answered|Just finished)$/u, { timeout: 30_000 })
      await expect(tools(page).getByRole('status').filter({ hasText: 'is not connected' })).toHaveCount(0)
      await expect(forge.getByRole('heading', { level: 3 })).not.toContainText('not connected')
      await capture(launched, 'reconnected-dark-1280x800')
      expect(errors).toEqual([])
      await writeFile(join(evidence, 'verification.json'), JSON.stringify({ groupedUnderForge: true, heldNotTold: true, heldNoAnswerGrant: true, refusedOtherMachine: true,
        nestedSecondLevel: true, keyboardOpensAndEscapeCloses: true, keptGreyedWhileAway: true, readAfreshOnReconnect: true, sizes: ['1600x1000', '1280x800', '820x560'],
        themes: ['dark', 'light'], reducedMotion: true, errors }, null, 2))
    })
  } catch (error) {
    await mkdir(evidence, { recursive: true }).catch(() => undefined)
    if (launched) await launched.page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
    throw error
  } finally {
    // Each step of the cleanup runs whatever the one before it did, and none hides the journey's own failure.
    if (launched) await closeSotto(launched).catch(() => undefined)
    await host?.close().catch(() => undefined)
    await native.cleanup().catch(() => undefined)
    await removeOwnedE2EProfile(profile)
  }
})
