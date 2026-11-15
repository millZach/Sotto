// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHostCommand, AgentHostResult, ShortTextPrompt, ShortTextTarget } from '../../../src/main/agents/host'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { testCredentials } from '../../fixtures/testCredentials'

/**
 * Model routing in the coordinator itself (ADR-0207): a routed thread's send is saved, classified, put on the pick and
 * then sent, in that order, through the real `dispatch` and its nested `configure-thread`. `routedSend.test.ts` covers
 * the routing rules with a scripted coordinator; this covers the seam it cannot.
 */
class RoutedHost extends E2EAgentHost {
  /** What reached the host and the store, in the order it did. */
  readonly order: string[] = []
  reply: string | null = JSON.stringify({ model: 'opus', effort: 'high', reason: 'Everyday debugging' })
  material: string | undefined
  constructor() {
    super()
    const state = this.inner()
    const template = state.models[0]!
    state.models = [['opus', 'Opus 5.5'], ['fable', 'Fable 5.2'], ['sonnet', 'Sonnet 5.5'], ['haiku', 'Haiku 5.5']].map(([id, name]) => ({ ...template, id: id!, name: name!, provider: 'Claude Code', providerId: 'claude' as const, defaultReasoningEffort: 'medium' }))
    for (const thread of state.threads) Object.assign(thread, { providerId: 'claude', modelId: 'sonnet', reasoningEffort: 'low', nativeSessionStarted: false, ...thread.id === 'workshop' ? { routed: true } : {} })
  }
  inner(): AgentHostSnapshot { return (this as unknown as { state: AgentHostSnapshot }).state }
  /** The turn the last send began ends, as a provider's does, so the next message goes at once and is not queued behind it. */
  rest(): void { for (const thread of this.inner().threads) thread.status = 'idle'; (this as unknown as { emit: () => void }).emit() }
  refuseSettings(): void { (this as unknown as { settingsGate: { refuse: boolean } }).settingsGate.refuse = true }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> { this.order.push(command.type); return super.execute(command) }
  async startThreadSession(threadId: string): Promise<void> {
    this.order.push('start-session')
    this.inner().threads.find(thread => thread.id === threadId)!.nativeSessionStarted = true
  }
  async writeShortTextOn(target: ShortTextTarget, prompt: ShortTextPrompt): Promise<string | null> {
    this.order.push(`classify ${target.modelId} ${target.effort}`); this.material = prompt.material
    return this.reply
  }
}

const roots: string[] = []
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-routed-send-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  }
})

async function coordinator(modelRouterEnabled = true, stayOnFirstModel = false): Promise<{ host: RoutedHost; control: AgentControl }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-routed-send-')); roots.push(root)
  const host = new RoutedHost()
  const control = createAgentControl({ directory: root, host, credentials: await testCredentials(join(root, 'vault'), { mode: 'unavailable' }), reasoner: {}, modelRouterEnabled, modelRouter: () => ({ stayOnFirstModel }) })
  cleanup.push(async () => { control.dispose(); await control.privacyChanged() })
  await control.start(); expect((await control.command({ type: 'connect' })).error).toBeNull()
  // Every write of the coordinator's own state, in the order it falls among what reaches the host.
  const persist = (control as unknown as { persist: () => Promise<void> }).persist.bind(control)
  vi.spyOn(control as unknown as { persist: () => Promise<void> }, 'persist').mockImplementation(async () => { host.order.push('persist'); await persist() })
  host.order.length = 0
  return { host, control }
}
const thread = (control: AgentControl, id = 'workshop') => control.get().host.threads.find(item => item.id === id)!

describe('a routed thread\'s send, in the coordinator', () => {
  it('waits for the first routed message before starting its session, so staying keeps the first pick', async () => {
    const { host, control } = await coordinator(true, true)
    await control.command({ type: 'start-thread-session', threadId: 'workshop' })
    expect(host.order).not.toContain('start-session')
    expect((await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Fix the sync bug.' })).error).toBeNull()
    expect(thread(control)).toMatchObject({ modelId: 'opus', reasoningEffort: 'high' })
    expect(host.material).toBe('User message:\nFix the sync bug.')
    const stable = await coordinator(false, true)
    await stable.control.command({ type: 'start-thread-session', threadId: 'workshop' })
    expect(stable.host.order).toContain('start-session')
  })

  it('saves the prompt, asks the classifier, puts the thread on the pick and only then sends', async () => {
    const { host, control } = await coordinator()
    expect((await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Fix the sync bug.' })).error).toBeNull()
    const classify = host.order.indexOf('classify opus low'), configure = host.order.indexOf('configure-thread'), send = host.order.indexOf('send')
    expect(host.order.indexOf('persist')).toBeGreaterThanOrEqual(0)
    expect(host.order.indexOf('persist')).toBeLessThan(classify)
    expect(classify).toBeLessThan(configure); expect(configure).toBeLessThan(send)
    expect(host.material).toBe('User message:\nFix the sync bug.')
    expect(thread(control)).toMatchObject({ modelId: 'opus', reasoningEffort: 'high' })
    expect(thread(control).messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Fix the sync bug.'])
    expect(control.get().routerPicks).toEqual([{ threadId: 'workshop', state: 'chose', modelId: 'opus', reasoningEffort: 'high', reason: 'Everyday debugging' }])
  })

  it('still sends, names no settings and shows no error when the settings change is not accepted', async () => {
    const { host, control } = await coordinator()
    host.refuseSettings()
    const result = await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Fix the sync bug.' })
    expect(result.error).toBeNull(); expect(control.get().error).toBeNull()
    expect(host.order).toContain('send')
    expect(thread(control)).toMatchObject({ modelId: 'sonnet', reasoningEffort: 'low' })
    expect(control.get().routerPicks).toEqual([{ threadId: 'workshop', state: 'unconfirmed', reason: 'Everyday debugging' }])
  })

  it('runs one message on an effort set by hand, as a paired phone can, and routes the message after it', async () => {
    const { host, control } = await coordinator()
    expect((await control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'xhigh' })).error).toBeNull()
    expect((await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Use my effort.' })).error).toBeNull()
    expect(host.order.some(item => item.startsWith('classify'))).toBe(false)
    expect(thread(control)).toMatchObject({ modelId: 'sonnet', reasoningEffort: 'xhigh' })
    host.rest()
    await vi.waitFor(() => { expect(thread(control).status).toBe('idle') })
    expect((await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Now you choose.' })).error).toBeNull()
    expect(host.order).toContain('classify opus low')
    expect(thread(control)).toMatchObject({ modelId: 'opus', reasoningEffort: 'high' })
  })

  it('sends on what the thread has when the classifier cannot be asked', async () => {
    const { host, control } = await coordinator()
    host.reply = null
    expect((await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Fix the sync bug.' })).error).toBeNull()
    expect(host.order).not.toContain('configure-thread'); expect(host.order).toContain('send')
    expect(control.get().routerPicks).toEqual([{ threadId: 'workshop', state: 'failed' }])
  })

  it('asks nothing for a thread that is not routed, or where the Owl feature is off', async () => {
    const { host, control } = await coordinator()
    expect((await control.command({ type: 'manual-send', threadId: 'docs', text: 'Fix the docs.' })).error).toBeNull()
    expect(host.order.some(item => item.startsWith('classify'))).toBe(false); expect(host.order).toContain('send')
    const off = await coordinator(false)
    expect((await off.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Fix the sync bug.' })).error).toBeNull()
    expect(off.host.order.some(item => item.startsWith('classify'))).toBe(false); expect(off.host.order).toContain('send')
    expect(off.control.get().routerPicks).toBeUndefined()
  })
})
