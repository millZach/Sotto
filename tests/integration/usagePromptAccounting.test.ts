// @vitest-environment node
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { createAgentControl } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'
import { UsageService } from '../../src/main/agents/usageService'
import type { AgentHostCommand } from '../../src/main/agents/host'

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
