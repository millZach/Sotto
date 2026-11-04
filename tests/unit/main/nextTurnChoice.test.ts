// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { mayGrantLocally, REMOTE_PERMISSION_DENIED, type Authority } from '../../../src/main/agents/authority'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import type { ClientIdentity } from '../../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

/**
 * A choice for a thread's next turn (#2158, ADR-0190): a model, effort, speed or permission pressed while the thread works
 * is kept in main and sent to the provider only once the thread rests, before its queue sends anything. It never reaches
 * a request that waits, and a wider permission is checked when it is pressed and again when it is sent. Stable refuses
 * the press as before.
 */
const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  for (const control of controls) { control.dispose(); await control.privacyChanged() }
  controls.clear()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-next-turn-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

/** A provider whose commands are recorded in the order they reach it. */
class RecordingHost extends E2EAgentHost {
  heard: AgentHostCommand[] = []
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.heard.push(command)
    return super.execute(command)
  }
  /** The thread's settings as the provider holds them. */
  async settings(threadId = 'workshop') {
    const thread = (await this.snapshot()).threads.find(item => item.id === threadId)!
    return { reasoningEffort: thread.reasoningEffort, runtimeMode: thread.runtimeMode }
  }
}

const phone: ClientIdentity = { clientId: 'phone', user: 'Fixture phone', transport: 'socket', selectedThreadId: 'workshop' }

async function fixture({ nextTurnChoice = true }: { readonly nextTurnChoice?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-next-turn-')); roots.push(root)
  // This scenario reports each turn the way a provider does, so the queue knows the last one completed.
  const host = new RecordingHost('queued-steering')
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  // The phone may grant while this is true; the desktop window on this machine always may (ADR-0004).
  const grants = { phone: true }
  const authority: Authority = { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => client.transport === 'socket' ? grants.phone ? { allowed: true, reason: 'paired-client' } : { allowed: false, reason: 'no-policy' } : mayGrantLocally(client) }
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: { ...e2eAgentReasoner }, authority,
    ...(nextTurnChoice ? { nextTurnChoice: true } : {}) })
  controls.add(control)
  await control.start(); await control.command({ type: 'connect' })
  // The thread starts asking for approval, at the model's default effort (low).
  expect((await control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'approval-required' })).error).toBeNull()
  host.heard = []
  const thread = () => control.shell().host.threads.find(item => item.id === 'workshop')!
  return { control, host, grants, thread,
    working: async () => {
      expect((await control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Start the work' })).error).toBeNull()
      await vi.waitFor(() => expect(thread().status).toBe('running'))
      host.heard = []
    },
    waitingOnRequest: async () => {
      expect((await control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Start the work' })).error).toBeNull()
      host.event({ type: 'permission', threadId: 'workshop', requestId: 'permission', text: 'May I run ls?', status: 'running' })
      await vi.waitFor(() => expect(thread().requests).toHaveLength(1))
      host.heard = []
    },
    rests: () => { host.event({ type: 'ready', threadId: 'workshop', text: 'Done.' }) },
    kept: () => control.shell().nextTurnSettings ?? [],
    configures: () => host.heard.filter(item => item.type === 'configure-thread'),
  }
}

describe('a choice for the next turn while a thread works (#2158)', () => {
  it('keeps a press made while a turn runs in main and sends nothing to the provider', async () => {
    const f = await fixture()
    await f.working()
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'medium' })).error).toBeNull()
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'auto-accept-edits' })).error).toBeNull()
    // Two presses make one choice; the running turn's settings are untouched.
    expect(f.kept()).toEqual([{ threadId: 'workshop', reasoningEffort: 'medium', runtimeMode: 'auto-accept-edits' }])
    expect(f.configures()).toEqual([])
    expect(await f.host.settings()).toEqual({ reasoningEffort: undefined, runtimeMode: 'approval-required' })
  })

  it('sends the choice once the thread rests, before its queue sends the next message', async () => {
    const f = await fixture()
    await f.working()
    await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'high' })
    // The user's next message waits in the queue behind the running turn.
    expect((await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Then do the next part' })).error).toBeNull()
    expect(f.host.heard.filter(item => item.type === 'send')).toEqual([])
    f.rests()
    await vi.waitFor(() => expect(f.host.heard.some(item => item.type === 'send')).toBe(true))
    expect(f.host.heard.map(item => item.type)).toEqual(['configure-thread', 'send'])
    expect(f.configures()[0]).toMatchObject({ reasoningEffort: 'high' })
    expect(f.kept()).toEqual([])
    expect((await f.host.settings()).reasoningEffort).toBe('high')
  })

  it('puts the kept choice away when the value in force is pressed', async () => {
    const f = await fixture()
    await f.working()
    await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'max' })
    expect(f.kept()).toHaveLength(1)
    // Keep current settings sends the values in force.
    await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'low' })
    expect(f.kept()).toEqual([])
    f.rests()
    await vi.waitFor(() => expect(f.thread().status).toBe('idle'))
    expect(f.configures()).toEqual([])
  })

  it('never answers, narrows or widens a request that waits, and waits for the user to answer it', async () => {
    const f = await fixture()
    await f.waitingOnRequest()
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })).error).toBeNull()
    expect(f.kept()).toEqual([{ threadId: 'workshop', runtimeMode: 'full-access' }])
    expect(f.host.heard).toEqual([])
    expect(f.thread().requests.map(item => item.id)).toEqual(['permission'])
    // The request card stays the only way to answer it; the user's own answer goes as it is.
    expect((await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'permission', answer: 'Deny', approved: false })).error).toBeNull()
    expect(f.host.heard.map(item => item.type)).toEqual(['answer'])
    expect(f.host.heard[0]).toMatchObject({ approved: false })
    f.rests()
    await vi.waitFor(() => expect(f.configures()).toHaveLength(1))
    expect(f.configures()[0]).toMatchObject({ runtimeMode: 'full-access' })
  })

  it('checks a wider permission when it is pressed and again when it is sent', async () => {
    const f = await fixture()
    await f.working()
    f.grants.phone = false
    expect((await f.control.commandShell({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' }, phone)).error).toBe(REMOTE_PERMISSION_DENIED)
    expect(f.kept()).toEqual([])
    f.grants.phone = true
    expect((await f.control.commandShell({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' }, phone)).error).toBeNull()
    expect(f.kept()).toEqual([{ threadId: 'workshop', runtimeMode: 'full-access' }])
    // The phone's grant ends before the thread rests: the choice is refused when it would be sent, and nothing changes.
    f.grants.phone = false
    f.rests()
    await vi.waitFor(() => expect(f.kept()).toEqual([]))
    expect(f.configures()).toEqual([])
    expect((await f.host.settings()).runtimeMode).toBe('approval-required')
    expect(f.control.shell().error).toMatch(/could not change Workshop’s settings for its next turn/u)
  })

  it('says so when the provider refuses the choice, and the next turn runs on what the thread had', async () => {
    const f = await fixture()
    await f.working()
    await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'xhigh' })
    f.host.event({ type: 'settings', threadId: 'workshop', text: 'refuse' })
    f.rests()
    await vi.waitFor(() => expect(f.kept()).toEqual([]))
    expect(f.configures()).toHaveLength(1)
    expect((await f.host.settings()).reasoningEffort).toBeUndefined()
    expect(f.control.shell().error).toMatch(/Its chips show what it runs on now/u)
    expect((await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Carry on' })).error).toBeNull()
  })

  it('refuses the press as before where the feature is off (stable)', async () => {
    const f = await fixture({ nextTurnChoice: false })
    await f.working()
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'medium' })).error)
      .toBe('Wait for this thread to finish and answer its pending requests before changing settings.')
    expect(f.kept()).toEqual([])
    expect(f.configures()).toEqual([])
  })
})
