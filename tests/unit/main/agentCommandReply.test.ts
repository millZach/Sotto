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
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'
import { AGENT_COMMAND, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import { AgentControl } from '../../../src/main/agents/control'
import { AttachmentPreviews } from '../../../src/main/agents/attachmentPreviews'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { LocalHostService } from '../../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { DesktopHostRouter } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' } }))
import { registerAgentIpc } from '../../../src/main/agents/ipc'

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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-command-reply-')); roots.push(root)
  const host = new E2EAgentHost()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
  await credentials.load()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
  disposables.push(() => control.dispose())
  await control.start(); await control.command({ type: 'connect' })
  host.event({ type: 'manual', threadId: 'workshop', text: 'Pick the palette' })
  host.event({ type: 'ready', threadId: 'workshop', text: 'Indigo it is.' })
  await control.command({ type: 'refresh' })

  const router = new DesktopHostRouter(() => emptyDesktopState(HOST_ID))
  disposables.push(() => router.dispose())
  router.add({ hostId: HOST_ID, name: 'This computer', kind: 'local', service: new LocalHostService({ control }),
    detail: threadId => control.threadDetail(threadId), preview: () => null })

  const listeners = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcMainAdapter = { handle: (channel, handler) => { listeners.set(channel, handler) }, removeHandler: channel => { listeners.delete(channel) } }
  const url = 'file:///main.html'
  const main: TrustedIpcSender = { role: 'main', url, webContents: { mainFrame: { parent: null, url }, isDestroyed: () => false, getURL: () => url } }
  disposables.push(registerAgentIpc(ipc, router, router, () => [main], 'win32', { status: vi.fn(), download: vi.fn() },
    { synthesize: vi.fn(), voices: vi.fn(), cancel: vi.fn() }, { synthesize: vi.fn(), cancel: vi.fn() }))
  const send = (command: AgentCommand) =>
    listeners.get(AGENT_COMMAND)!({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, command) as Promise<AgentState>
  return { control, send }
}

describe('a command reply to the window', () => {
  it.each<[string, (draftId: string) => AgentCommand]>([
    ['voice', () => ({ type: 'voice', action: 'mute' })],
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
