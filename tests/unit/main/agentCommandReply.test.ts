// @vitest-environment node
/**
 * A command's answer as the window receives it (issue #313): through the agent IPC handler, the
 * desktop host router and the local host service, the way `index.ts` joins them. The answer is the
 * shell. Building it copies no history and places no attachment preview marker.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AGENT_COMMAND, type AgentCommand, type AgentState } from '../../../src/shared/agents'

import { AttachmentPreviews } from '../../../src/main/agents/attachmentPreviews'

import { LocalHostService } from '../../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'
import { DesktopHostRouter } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' } }))
import { registerAgentIpc } from '../../../src/main/agents/ipc'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { ipcRegistry } from '../../fixtures/ipcHarness'
import { receiptEncoders } from '../../fixtures/receiptEncoders'

const HOST_ID = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []
const disposables: Array<() => void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of disposables.splice(0)) dispose()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-command-reply-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(options: { replyBuilt?: (state: AgentState) => void; encoders?: ReturnType<typeof receiptEncoders> } = {}) {
  const { replyBuilt } = options
  const root = await mkdtemp(join(tmpdir(), 'sotto-command-reply-')); roots.push(root)
  const host = new E2EAgentHost()
  const credentials = await testCredentials(root, { mode: 'unavailable' })

  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
  })
  disposables.push(() => control.dispose())
  await control.start(); await control.command({ type: 'connect' })
  host.event({ type: 'manual', threadId: 'workshop', text: 'Pick the palette' })
  host.event({ type: 'ready', threadId: 'workshop', text: 'Indigo it is.' })
  await control.command({ type: 'refresh' })

  const router = new DesktopHostRouter(() => emptyDesktopState(HOST_ID), replyBuilt ? { replyBuilt } : {})
  disposables.push(() => router.dispose())
  router.add({ hostId: HOST_ID, name: 'This computer', kind: 'local', service: new LocalHostService({ control }),
    detail: threadId => control.threadDetail(threadId), preview: () => null })

  const registry = ipcRegistry()
  const { ipc, main } = registry
  disposables.push(registerAgentIpc(ipc, router, router, () => [main], { ...options.encoders ?? receiptEncoders() }))
  const send = (command: AgentCommand) =>
    registry.invoke(AGENT_COMMAND, [command]) as Promise<AgentState>
  return { control, send, router }
}

describe('a command reply to the window', () => {
  it.each<[string, (draftId: string) => AgentCommand]>([
    ['save-thread-draft', draftId => ({ type: 'save-thread-draft', threadId: 'workshop', draftId, text: 'Keep this draft' })],
    ['select-thread', () => ({ type: 'select-thread', threadId: 'workshop' })],
    ['refresh', () => ({ type: 'refresh' })],
  ])('carries no thread messages and places no preview markers for %s', async (_name, build) => {
    const f = await fixture()
    const get = vi.spyOn(f.control, 'get')
    const decorate = vi.spyOn(AttachmentPreviews.prototype, 'decorate')
    const reply = await f.send(build(randomUUID()))
    expect(get).not.toHaveBeenCalled()
    expect(decorate).not.toHaveBeenCalled()
    expect(reply.error ?? null).toBeNull()
    expect(reply.host.threads.length).toBeGreaterThan(0)
    expect(reply.host.threads.every(thread => thread.messages.length === 0 && !thread.activities?.length)).toBe(true)
    // The row facts the sidebar reads still arrive, and the history is still there for a window that asks.
    expect(reply.host.threads.find(thread => thread.id.endsWith('workshop'))!.summary).toMatchObject({ messageCount: 2 })
    expect(f.control.threadDetail('workshop')?.messages.map(message => message.text)).toEqual(['Pick the palette', 'Indigo it is.'])
  })
})

describe('a command reply numbered as it is built (#306)', () => {
  it.each<[string, AgentCommand]>([
    ['a command that publishes', { type: 'select-thread', threadId: 'workshop' }],
    ['a command answered without publishing', { type: 'refresh-thread-worktree', threadId: 'workshop', background: true }],
    // Clearing answers without the threads' history, which gives the answer a `host` of its own after it is built.
    ['clearing threads', { type: 'clear-threads', olderThanDays: 0, threadIds: ['workshop'] }],
  ])('tells the broadcaster of the very reply the window is sent before it is encoded, for %s', async (_name, command) => {
    const built = new WeakSet<object>()
    const numbered: boolean[] = []
    const { encodeReceipt, encodeChangedThreadRecordsReceipt } = receiptEncoders()
    const f = await fixture({ replyBuilt: state => { built.add(state.host) },
      encoders: { encodeReceipt: state => { numbered.push(built.has(state.host)); return encodeReceipt(state) },
        encodeChangedThreadRecordsReceipt: state => { numbered.push(built.has(state.host)); return encodeChangedThreadRecordsReceipt(state) } } })
    // With the window listening, the router publishes a command's effect and answers with that publication.
    disposables.push(f.router.subscribe(() => undefined))
    await f.send(command)
    expect(numbered).toEqual([true])
  })

  it('keeps the revision a clearing answer took when it was built, behind a broadcast sent before it is encoded', async () => {
    const broadcaster = new AgentStateBroadcaster()
    const revisions: { reply?: number; broadcast?: number } = {}
    const f = await fixture({ replyBuilt: broadcaster.replyBuilt, encoders: { ...receiptEncoders(broadcaster),
      encodeReceipt: state => {
        // A newer state goes out between the answer's build and its encoding.
        broadcaster.send({ ...state, host: { ...state.host } }, payload => { revisions.broadcast = payload.host.threads.revision; return true })
        revisions.reply = broadcaster.encodeChangedThreadRecordsReceipt(state).host.threads.revision
        return broadcaster.encodeReceipt(state)
      } } })
    disposables.push(f.router.subscribe(() => undefined))
    await f.send({ type: 'clear-threads', olderThanDays: 0, threadIds: ['workshop'] })
    expect(revisions.reply).toBeLessThan(revisions.broadcast!)
  })
})
