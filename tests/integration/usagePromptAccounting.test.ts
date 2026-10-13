// @vitest-environment node
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { createAgentControl } from '../fixtures/agentControlFixture'
import { deferred } from '../fixtures/deferred'
import { testCredentials } from '../fixtures/testCredentials'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { UsageService } from '../../src/main/agents/usageService'
import { UsageStore } from '../../src/main/agents/usageStore'
import type { AgentHostCommand } from '../../src/main/agents/host'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { RESUME_NOTE } from '../../src/shared/restartResume'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const f = await workspaceFixture()
  const credentials = await testCredentials(join(f.root, 'vault'), { mode: 'unavailable' })
  const usage = new UsageService({ directory: f.root, host: f.host,
    acceptedPromptIdentities: identities => f.host.recordedUserMessages(identities) })
  usage.start()
  const control = createAgentControl({ directory: f.root, host: f.host, credentials, usage })
  cleanup.push(async () => { control.dispose(); await control.privacyChanged(); usage.close(); await f.stop(); await f.remove() })
  await control.start(); await control.command({ type: 'connect' })
  const thread = control.get().host.threads.find(item => item.providerId === 'codex')!
  return { ...f, control, usage, thread }
}

describe('coordinator numeric prompt acceptance', () => {
  it('counts a restarted runtime\'s resume note once as a wake-up without replaying or relabeling the original prompt', async () => {
    const f = await workspaceFixture()
    cleanup.push(async () => { await f.stop(); await f.registry.flush(); await f.remove() })
    // Borrow the fixture's provider stack, closing its unused workspace before the runtime owns the stores.
    await f.stop()
    const credentials = await testCredentials(join(f.root, 'vault'), { mode: 'unavailable' })
    const settings = { ...DEFAULT_SETTINGS, resumeThreadsAfterRestart: true }
    const start = async () => {
      const runtime = await createAgentRuntime({ directory: f.root, credentials, host: f.native, reasoner: {},
        usageEnabled: true, resumeAfterRestart: true, settings: () => settings, writingSettings: async () => settings,
        historyEnabled: () => true, openExternal: async () => undefined })
      cleanup.push(() => runtime.close())
      return runtime
    }
    const sends = () => f.adapters.codex.commands.filter((command): command is Extract<AgentHostCommand, { type: 'send' }> => command.type === 'send')
    const first = await start()
    await first.agentControl.command({ type: 'connect' })
    const thread = first.agentControl.get().host.threads.find(item => item.providerId === 'codex')!
    const running = deferred()
    const stopWatching = first.agentControl.subscribe(state => {
      if (state.host.threads.find(item => item.id === thread.id)?.status === 'running') running.resolve()
    })
    cleanup.push(async () => stopWatching())
    const text = 'Keep this accepted synthetic prompt on its original model'
    const sent = await first.agentControl.command({ type: 'manual-send', threadId: thread.id, draftId: randomUUID(), text })
    expect(sent.error).toBeNull()
    await running.promise
    stopWatching()
    const original = sends()[0]!
    expect(sends()).toHaveLength(1)
    expect((await first.usage!.read()).activity!.totals.prompts).toEqual({ user: 1, watcher: 0, wakeUp: 0, total: 1, steered: 0 })
    await first.close()
    const stopped = JSON.parse(await readFile(join(f.root, 'restart-resume.json'), 'utf8')) as { working: { threadId: string }[] }
    expect(stopped.working.map(item => item.threadId)).toEqual([thread.id])

    // Restart the provider session idle, with its old exact echo replayed and a different current model.
    const native = f.adapters.codex.state.threads.find(item => item.id === original.threadId)!
    native.status = 'idle'
    native.lastTurn = { id: original.commandId, status: 'interrupted' }
    // Real adapters retain this head outside the loaded message window (ThreadMessageLog); this legacy fake does not.
    native.lastUserMessageId = native.messages.findLast(message => message.role === 'user')!.id
    expect(native.lastUserMessageId === original.messageId).toBe(true)
    const nextModel = { ...f.adapters.codex.state.models[0]!, id: 'fake:after-restart', name: 'After restart' }
    f.adapters.codex.state.models.push(nextModel)
    native.modelId = nextModel.id
    // Observe only this run's native execution, and surface a refusal instead of waiting forever for its echo.
    const resumeEcho = deferred<Extract<AgentHostCommand, { type: 'send' }>>()
    void resumeEcho.promise.catch(() => undefined)
    const execute = f.adapters.codex.execute.bind(f.adapters.codex)
    vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
      const isResume = command.type === 'send' && command.text === RESUME_NOTE
      try {
        if (isResume && command.type === 'send') expect(command.expectedLastUserMessageId === native.lastUserMessageId).toBe(true)
        const result = await execute(command)
        if (isResume && command.type === 'send') resumeEcho.resolve(command)
        return result
      } catch (error) {
        if (isResume) resumeEcho.reject(error)
        throw error
      }
    })
    const restarted = await start()
    await restarted.agentControl.command({ type: 'connect' })
    const resume = await resumeEcho.promise
    await restarted.agentControl.command({ type: 'refresh' })
    const selected = await restarted.agentControl.command({ type: 'select-thread', threadId: thread.id })
    expect(selected.error).toBeNull()
    const resumedThread = restarted.agentControl.get().host.threads.find(item => item.id === thread.id)!
    const resumedModelId = resumedThread.modelId
    expect(resumedModelId).not.toBe(thread.modelId)
    // The workspace keeps Sotto's origin; it deliberately removes wakeUp before the native adapter hears the command.
    expect(resume).toMatchObject({ threadId: original.threadId, text: RESUME_NOTE })
    expect(resumedThread.wakeUpMessageIds).toContain(resume.messageId)
    expect(resumedThread.messages.find(message => message.id === resume.messageId)).toMatchObject({ role: 'user', text: RESUME_NOTE, wakeUp: true })
    expect(resume.messageId).not.toBe(original.messageId)

    // Repeated ready snapshots replay both exact echoes without adding another send or numeric count.
    native.status = 'idle'
    native.lastTurn = { id: resume.commandId, status: 'completed' }
    native.lastUserMessageId = native.messages.findLast(message => message.role === 'user')!.id
    f.adapters.codex.emit()
    await restarted.agentControl.command({ type: 'refresh' })
    f.adapters.codex.emit()
    await restarted.agentControl.command({ type: 'refresh' })
    await restarted.close()
    expect(sends().map(command => command.text)).toEqual([text, RESUME_NOTE])
    expect(native.messages.filter(message => message.role === 'user').map(message => message.id)).toEqual([original.messageId, resume.messageId])
    const store = new UsageStore(join(f.root, 'usage.sqlite'))
    store.open()
    try {
      const activity = store.query({})
      expect(activity.totals.prompts).toEqual({ user: 1, watcher: 0, wakeUp: 1, total: 2, steered: 0 })
      expect(activity.models.find(model => model.modelId === thread.modelId)!.prompts).toEqual({ user: 1, watcher: 0, wakeUp: 0, total: 1, steered: 0 })
      expect(activity.models.find(model => model.modelId === resumedModelId)!.prompts).toEqual({ user: 0, watcher: 0, wakeUp: 1, total: 1, steered: 0 })
    } finally { store.close() }
  })

  it('counts a manual send once under its original model and keeps it when transcript history is removed', async () => {
    const f = await fixture()
    const result = await f.control.command({ type: 'manual-send', threadId: f.thread.id, draftId: randomUUID(), text: 'A private synthetic prompt' })
    expect(result.error).toBeNull()
    expect(f.adapters.codex.commands.filter(command => command.type === 'send')).toHaveLength(1)
    const first = (await f.usage.read()).activity!
    expect(first.totals.prompts.user).toBe(1)
    expect(first.models.find(model => model.modelId === f.thread.modelId)!.prompts.user).toBe(1)
    await f.control.command({ type: 'refresh' })
    f.setHistory(false); await f.host.privacyChanged(); await f.control.privacyChanged()
    expect((await f.usage.read()).activity!.totals.prompts.user).toBe(1)
  })

  it('retains uncertainty without counting or replaying and counts the exact late echo once', async () => {
    const f = await fixture()
    let submitted: Extract<AgentHostCommand, { type: 'send' }> | undefined
    const original = f.adapters.codex.execute.bind(f.adapters.codex)
    vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
      if (command.type !== 'send') return original(command)
      submitted = command
      return { accepted: false, uncertain: true }
    })
    const result = await f.control.command({ type: 'manual-send', threadId: f.thread.id, draftId: randomUUID(), text: 'Keep this uncertain synthetic prompt' })
    expect(result.error).toBeTruthy()
    expect((await f.usage.read()).activity!.totals.prompts.total).toBe(0)
    expect(submitted).toBeDefined()
    const native = f.adapters.codex.state.threads.find(thread => thread.id === submitted!.threadId)!
    native.messages.push({ id: submitted!.messageId, role: 'user', text: submitted!.text, createdAt: new Date().toISOString() })
    f.adapters.codex.emit()
    await f.control.command({ type: 'refresh' })
    expect((await f.usage.read()).activity!.totals.prompts.total).toBe(1)
    f.adapters.codex.emit(); await f.control.command({ type: 'refresh' })
    expect((await f.usage.read()).activity!.totals.prompts.total).toBe(1)
  })

  it('does not count a definitive native refusal', async () => {
    const f = await fixture()
    vi.spyOn(f.adapters.codex, 'execute').mockResolvedValueOnce({ accepted: false })
    const result = await f.control.command({ type: 'manual-send', threadId: f.thread.id, text: 'Refused synthetic prompt' })
    expect(result.error).toBeTruthy()
    expect((await f.usage.read()).activity!.totals.prompts.total).toBe(0)
  })
})
