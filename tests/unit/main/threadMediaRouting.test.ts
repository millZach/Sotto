// @vitest-environment node
/**
 * A window reads an agent's picture by its handle (ADR-0170): the router asks the host that runs the thread for the whole
 * picture and makes the tile's thumbnail itself, keeping the newest ones; the IPC answers only the main window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcRegistry, trustedIpcSender } from '../../fixtures/ipcHarness'
import { receiptEncoders } from '../../fixtures/receiptEncoders'
import { AGENT_THREAD_MEDIA, type AgentState, type AgentThreadMediaRequest } from '../../../src/shared/agents'
import { hostEntityKey } from '../../../src/shared/clientIdentity'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' } }))
import { registerAgentIpc } from '../../../src/main/agents/ipc'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'

const REMOTE = '22222222-2222-4222-8222-222222222222'
const WHOLE = 'data:image/png;base64,AAAA'
const TILE = 'data:image/jpeg;base64,BBBB'
const disposables: Array<() => void> = []
afterEach(() => { for (const dispose of disposables.splice(0)) dispose(); vi.clearAllMocks() })

function remoteHost() {
  const state = emptyDesktopState(REMOTE)
  state.host.connected = true; state.connection = 'connected'
  state.host.threads = [{ id: 'thread', projectId: 'project', title: 'T', modelId: '', providerId: 'claude', status: 'idle', messages: [], requests: [] }]
  const media = vi.fn(async (request: AgentThreadMediaRequest) => { void request; return { dataUrl: WHOLE } })
  const connection: DesktopHostConnection = { hostId: REMOTE, name: 'Forge', kind: 'remote',
    service: { shell: () => structuredClone(state), view: () => ({ ...state }), subscribe: () => () => undefined, command: vi.fn() } as unknown as DesktopHostConnection['service'],
    detail: async () => null, preview: () => null as never, available: () => true, media }
  return { connection, media }
}

describe('reading an agent\'s picture from the window', () => {
  it('reads the whole picture from the thread\'s host and makes and keeps the tile itself', async () => {
    const host = remoteHost()
    const thumbnail = vi.fn(() => TILE)
    const router = new DesktopHostRouter(emptyDesktopState, { mediaThumbnail: thumbnail })
    router.add(host.connection)
    const threadId = hostEntityKey(REMOTE, 'thread')
    const tile = { threadId, activityId: 'claude-tool-shot', mediaId: 'm0', size: 'tile' as const }
    await expect(router.threadMedia(tile)).resolves.toEqual({ dataUrl: TILE })
    expect(host.media).toHaveBeenCalledWith({ threadId: 'thread', activityId: 'claude-tool-shot', mediaId: 'm0' })
    expect(thumbnail).toHaveBeenCalledWith(WHOLE)
    // Scrolled back into view, the tile is not read again.
    await expect(router.threadMedia(tile)).resolves.toEqual({ dataUrl: TILE })
    expect(host.media).toHaveBeenCalledTimes(1)
    // The viewer reads the whole picture, with no thumbnail.
    await expect(router.threadMedia({ ...tile, size: 'full' })).resolves.toEqual({ dataUrl: WHOLE })
    expect(thumbnail).toHaveBeenCalledTimes(1)
  })

  it('reads nothing while the Owl feature is off, or when the host keeps no such picture', async () => {
    const host = remoteHost()
    const off = new DesktopHostRouter(emptyDesktopState)
    off.add(host.connection)
    const request = { threadId: hostEntityKey(REMOTE, 'thread'), activityId: 'a', mediaId: 'm0', size: 'tile' as const }
    await expect(off.threadMedia(request)).resolves.toBeNull()
    expect(host.media).not.toHaveBeenCalled()
    const on = new DesktopHostRouter(emptyDesktopState, { mediaThumbnail: () => TILE })
    on.add(host.connection)
    host.media.mockResolvedValueOnce(null as never)
    await expect(on.threadMedia(request)).resolves.toBeNull()
  })

  it('answers only the main window, and only a well-formed request', async () => {
    const registry = ipcRegistry()
    const threadMedia = vi.fn(async () => ({ dataUrl: TILE }))
    const control = { get: () => ({} as AgentState), shell: () => ({} as AgentState), threadDetail: () => null, attachmentPreview: async () => null, threadMedia }
    disposables.push(registerAgentIpc(registry.ipc, control, { command: vi.fn() }, () => [registry.main, registry.widget], { ...receiptEncoders() }))
    const request = { threadId: 'thread', activityId: 'a', mediaId: 'm0', size: 'tile' }
    await expect(registry.invoke(AGENT_THREAD_MEDIA, [request], registry.event(registry.main))).resolves.toEqual({ dataUrl: TILE })
    await expect(registry.invoke(AGENT_THREAD_MEDIA, [request], registry.event(registry.widget))).rejects.toThrow('AGENT_SENDER_REJECTED')
    const stranger = trustedIpcSender('main'); stranger.webContents.getURL = () => 'https://elsewhere.test/'
    await expect(registry.invoke(AGENT_THREAD_MEDIA, [request], registry.event(stranger))).rejects.toThrow('AGENT_SENDER_REJECTED')
    for (const payload of [{ ...request, mediaId: 'm8' }, { ...request, size: 'huge' }, { ...request, digest: 'a'.repeat(64) }]) {
      await expect(registry.invoke(AGENT_THREAD_MEDIA, [payload], registry.event(registry.main))).rejects.toThrow()
    }
    expect(threadMedia).toHaveBeenCalledTimes(1)
  })
})
