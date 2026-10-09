import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openPage, openThreads, paneMenuAction, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const ARTIFACTS = evidenceDirectory('artifacts/command-receipt')

/** What main's agent handlers have seen since `watchAgentTraffic`, as counts and sizes only. */
interface AgentTraffic {
  /** Reads of the whole state through `AGENT_GET`. */
  readonly reads: number
  readonly lastReadBytes: number
  /** Commands the page has sent that main has not answered yet. */
  readonly inFlight: number
  /** How many commands of each type main has answered. */
  readonly answered: Readonly<Record<string, number>>
  /** The last command receipt main sent, as it crosses: its size and what it names for `host.models`. */
  readonly lastReply: { readonly bytes: number; readonly activeThreadId: string | null; readonly models: { readonly revision?: number; readonly omitted?: boolean; readonly models?: unknown } } | null
  /** The text of the last `save-thread-draft` main answered. */
  readonly lastDraft: string | null
  /** The exact creation request and its own receipt, independent of later observation commands. */
  readonly lastCreation: { readonly threadId: string; readonly activeThreadId: string | null; readonly createdThreadId: string | null; readonly modelId: string | null; readonly error: string | null } | null
}

/**
 * Wraps main's `sotto:agents:get` and `sotto:agents:command` handlers to watch them. Electron keeps
 * `ipcMain.handle` handlers in a private map; wrapping there is the only way to see whether the page recovered
 * a catalog, since the page reaches main through `contextBridge` and cannot be observed from the window. The
 * command wrapper sees the receipt exactly as main sends it, before the preload or the page touch it.
 */
async function watchAgentTraffic(launched: LaunchedSotto): Promise<() => Promise<AgentTraffic>> {
  await launched.app.evaluate(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers
    const get = handlers?.get('sotto:agents:get')
    const command = handlers?.get('sotto:agents:command')
    if (!handlers || !get || !command) throw new Error('This Electron keeps its invoke handlers elsewhere; update the watcher.')
    const traffic = { reads: 0, lastReadBytes: 0, inFlight: 0, answered: {} as Record<string, number>, lastReply: null as unknown, lastDraft: null as string | null, lastCreation: null as AgentTraffic['lastCreation'] }
    ;(globalThis as unknown as { agentTraffic: typeof traffic }).agentTraffic = traffic
    handlers.set('sotto:agents:get', async (...args: unknown[]) => {
      traffic.reads++
      const state = await get(...args)
      traffic.lastReadBytes = JSON.stringify(state).length
      return state
    })
    handlers.set('sotto:agents:command', async (...args: unknown[]) => {
      const request = args[1] as { type?: string; text?: string; threadId?: string } | undefined
      traffic.inFlight++
      try {
        const receipt = await command(...args) as { activeThreadId: string | null; error: string | null; host: { models: unknown; threads: { id: string; modelId: string }[] } }
        traffic.lastReply = { bytes: JSON.stringify(receipt).length, activeThreadId: receipt.activeThreadId, models: receipt.host.models }
        if (request?.type === 'save-thread-draft') traffic.lastDraft = request.text ?? ''
        if (request?.type === 'create-thread' && request.threadId) {
          const thread = receipt.host.threads.find(thread => thread.id === request.threadId)
          traffic.lastCreation = { threadId: request.threadId, activeThreadId: receipt.activeThreadId,
            createdThreadId: thread?.id ?? null, modelId: thread?.modelId ?? null, error: receipt.error }
        }
        return receipt
      } finally {
        traffic.inFlight--
        if (request?.type) traffic.answered[request.type] = (traffic.answered[request.type] ?? 0) + 1
      }
    })
  })
  return () => launched.app.evaluate(() => structuredClone((globalThis as unknown as { agentTraffic: AgentTraffic }).agentTraffic))
}

/**
 * Waits until `ready` holds, main has answered every command the page sent, and the page has made one round
 * trip to main after that. A read the page makes on receiving a receipt is sent before that round trip's own
 * request, so main has counted it by the time the round trip answers.
 */
async function settled(page: Page, traffic: () => Promise<AgentTraffic>, ready: (seen: AgentTraffic) => boolean = () => true): Promise<AgentTraffic> {
  await expect.poll(async () => {
    const seen = await traffic()
    if (!ready(seen) || seen.inFlight > 0) return false
    await page.evaluate(async () => { await window.sotto!.getSettings() })
    return true
  }).toBe(true)
  return traffic()
}

const answered = (seen: AgentTraffic, type: string): number => seen.answered[type] ?? 0
const replyRevision = (seen: AgentTraffic): number => seen.lastReply!.models.revision!

test('drafts save, settings stay and a model can be picked after a reconnect, with command receipts', async () => {
  test.setTimeout(120_000)
  await mkdir(ARTIFACTS, { recursive: true })
  const launched = await launchSotto('phase3-workspace')
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    const traffic = await watchAgentTraffic(launched)

    // 1. Type in a thread's composer and see the draft save.
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Grok voice previews', exact: true }).click()
    const start = await settled(page, traffic)
    const input = page.locator('#thread-workspace-prompt')
    await input.pressSequentially('Draft kept by a command receipt', { delay: 15 })
    // Draft saves are debounced: wait for main to answer the save of the whole text, and for the page to take it.
    const typed = await settled(page, traffic, seen => seen.lastDraft === 'Draft kept by a command receipt')
    const draftReads = typed.reads - start.reads
    // The wire: the save's answer names the catalog by revision and lists no models.
    expect(typed.lastReply!.models).toEqual({ revision: expect.any(Number), omitted: true })
    const wholeBytes = await page.evaluate(async () => JSON.stringify(await window.sotto!.agents!.get()).length)
    console.info(`command receipt wire: ${JSON.stringify({ receiptBytes: typed.lastReply!.bytes, wholeStateBytes: wholeBytes })}`)
    const threadId = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.title === 'Grok voice previews')!.id)
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.agents!.get()).threadDrafts?.find(draft => draft.threadId === id)?.text, threadId))
      .toBe('Draft kept by a command receipt')
    await page.screenshot({ path: `${ARTIFACTS}/draft-saved.png`, animations: 'disabled' })
    await page.reload()
    await openThreads(page)
    await expect(page.locator('#thread-workspace-prompt')).toHaveValue('Draft kept by a command receipt')
    await expect(page.getByRole('alert')).toHaveCount(0)

    // 2. Change a setting and see the card keep it once its receipt has come back.
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Agents', exact: true }).click()
    const account = page.locator('#settings-agents').getByRole('combobox', { name: 'Reasoning account', exact: true })
    const chosen = await account.inputValue() === 'claude' ? 'codex' : 'claude'
    const beforeSetting = await settled(page, traffic)
    await account.selectOption(chosen)
    await settled(page, traffic, seen => answered(seen, 'configure') > answered(beforeSetting, 'configure'))
    expect((await page.evaluate(async () => window.sotto!.agents!.get())).configuration.reasoning).toBe(chosen)
    await expect(account).toHaveValue(chosen)
    await page.screenshot({ path: `${ARTIFACTS}/setting-kept.png`, animations: 'disabled' })

    // 3. Pick a model after the provider reconnects. The disconnect goes straight to main; the reconnect is the
    // pane's own Reconnect, so its receipt names a catalog revision the page has not been sent yet unless the
    // broadcast of it lands first. Each revision is read from the receipt main sent for that command.
    const connectedRevision = replyRevision(await settled(page, traffic))
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'disconnect' }) })
    const disconnected = await settled(page, traffic, seen => answered(seen, 'disconnect') > 0)
    const disconnectedRevision = replyRevision(disconnected)
    await openThreads(page)
    const beforeReconnect = await settled(page, traffic)
    await paneMenuAction(page, 'Reconnect')
    await expect(page.getByRole('button', { name: 'More actions', exact: true }).first()).toBeVisible()
    const reconnected = await settled(page, traffic, seen => answered(seen, 'connect') > answered(beforeReconnect, 'connect'))
    const reconnectReads = reconnected.reads - beforeReconnect.reads
    const reconnectedRevision = replyRevision(reconnected)
    console.info(`catalog revisions across a reconnect: ${JSON.stringify({ connectedRevision, disconnectedRevision, reconnectedRevision, reconnectReads })}`)
    // The Reasoning account chosen in step 2 is a subscription whose own model the fixture does not list, and
    // an unset "New threads start with" follows it, so choose a model the fixture has. A main-process receipt
    // alone does not show that the renderer has accepted a direct bridge configuration.
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    const defaultModel = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await defaultModel.click()
    await page.getByRole('tab', { name: 'Codex', exact: true }).click()
    await page.getByRole('option', { name: 'GPT-5.4', exact: true }).click()
    await expect(defaultModel).toHaveText(/GPT-5.4/)
    await openThreads(page)
    const beforePick = await settled(page, traffic, seen => answered(seen, 'configure') > answered(reconnected, 'configure'))
    // The pen opens a thread at once on the new-thread defaults (issue #347); its model is then picked from
    // the composer's model chip.
    await page.getByRole('button', { name: /^New thread in / }).first().click()
    const created = await settled(page, traffic, seen => answered(seen, 'create-thread') > answered(beforePick, 'create-thread'))
    expect(created.lastCreation?.threadId).toBeTruthy()
    const newThreadId = created.lastCreation!.threadId
    expect(created.lastCreation).toMatchObject({ activeThreadId: newThreadId, createdThreadId: newThreadId, modelId: 'codex:gpt', error: null })
    const chip = page.locator(`form.thread-prompt[data-thread-id="${newThreadId}"]`).getByRole('combobox', { name: 'Thread model', exact: true })
    await expect(chip).toBeEnabled()
    await chip.click()
    const picker = page.getByRole('dialog', { name: 'Choose model' })
    await expect(picker).toBeVisible()
    await picker.getByRole('tab', { name: 'Grok', exact: true }).click()
    await expect(picker.getByRole('option', { name: 'Grok 4.6', exact: true })).toBeEnabled()
    await page.screenshot({ path: `${ARTIFACTS}/model-picker-after-reconnect.png`, animations: 'disabled' })
    await picker.getByRole('option', { name: 'Grok 4.6', exact: true }).click()
    await expect(chip).toContainText('Grok 4.6')
    const picked = await settled(page, traffic, seen => answered(seen, 'configure-thread') > answered(beforePick, 'configure-thread'))
    const pickReads = picked.reads - beforePick.reads
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)?.modelId, newThreadId))
      .toMatch(/grok:4$/)
    await page.screenshot({ path: `${ARTIFACTS}/thread-on-picked-model.png`, animations: 'disabled' })
    console.info(`AGENT_GET reads: ${JSON.stringify({ whileTyping: draftReads, whileReconnecting: reconnectReads, whilePicking: pickReads })}`)
    expect(draftReads).toBe(0)
    expect(disconnectedRevision).toBeGreaterThan(connectedRevision)
    expect(reconnectedRevision).toBeGreaterThan(disconnectedRevision)
    // A receipt naming a revision the page was not sent yet is recovered once, and the catalog it recovered
    // serves the pick that follows.
    expect(reconnectReads).toBeLessThanOrEqual(1)
    expect(pickReads).toBe(0)
    expect(errors).toEqual([])
  } finally { await closeSotto(launched) }
})
