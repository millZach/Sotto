import { SocketHostService } from '../agents/socketHostService'
import type { RetainedDraftStore } from '../agents/retainedDraftStore'
import type { DesktopHostRouter } from '../hosts/desktopHostRouter'

export interface RemoteHostE2EConnection { url: string; token: string; hostId: string; holdReceipts?: boolean }
export interface RemoteHostE2E {
  connect(input: RemoteHostE2EConnection): Promise<void>
  disconnect(hostId: string, keepThreads?: boolean): Promise<void>
  receiptReads(hostId: string): number
  completedReceiptReads(hostId: string): number
  completedIdleReceiptReads(hostId: string): number
  releaseReceipts(hostId: string): void
  close(): Promise<void>
}

declare global { var sottoRemoteHostE2E: RemoteHostE2E | undefined }

/**
 * Unpackaged E2E main-process harness only. Bypasses SSH discovery/launch, while retaining the real
 * paired socket, router, request drafts, preload and renderer. Never installed in a normal session.
 */
export function installRemoteHostE2E(router: DesktopHostRouter, retainedDrafts: RetainedDraftStore): RemoteHostE2E {
  const sockets = new Map<string, SocketHostService>()
  const gates = new Map<string, { wait: Promise<void>; release: () => void; reads: number; completed: number; completedIdle: number }>()
  const harness: RemoteHostE2E = {
    async connect(input) {
      const url = new URL(input.url)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('The remote host test requires a loopback listener.')
      if (sockets.has(input.hostId)) throw new Error('The remote host test is already connected.')
      const socket = new SocketHostService({ url: input.url, token: input.token, expectedHostId: input.hostId, catchUpEvents: false, retainedDrafts })
      try {
        const hello = await socket.connect()
        let release = (): void => {}
        const wait = input.holdReceipts ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
        const gate = { wait, release, reads: 0, completed: 0, completedIdle: 0 }
        gates.set(hello.hostId, gate)
        router.replace({ hostId: hello.hostId, name: 'Forge', kind: 'remote', service: socket,
          refreshRequestAnswer: async (id, target) => {
            const state = socket.shell()
            const idle = !state.busyThreadIds?.includes(target.threadId)
              && state.host.threads.find(thread => thread.id === target.threadId)?.requests.every(request => request.id !== target.requestId)
            gate.reads++; await gate.wait; await socket.refreshRequestAnswer(id, target)
            gate.completed++
            if (idle) gate.completedIdle++
          },
          detail: id => socket.readThreadDetail(id), preview: request => socket.attachmentPreview(request),
          observe: ids => socket.observe(ids), subscribeDetail: listener => socket.subscribeThreadDetail(listener),
        })
        sockets.set(hello.hostId, socket)
      } catch (error) { await socket.close(); throw error }
    },
    async disconnect(hostId, keepThreads = false) {
      const socket = sockets.get(hostId)
      sockets.delete(hostId)
      gates.get(hostId)?.release()
      gates.delete(hostId)
      if (keepThreads) router.setReconnecting(hostId, true)
      else router.remove(hostId)
      await socket?.close()
    },
    receiptReads: hostId => gates.get(hostId)?.reads ?? 0,
    completedReceiptReads: hostId => gates.get(hostId)?.completed ?? 0,
    completedIdleReceiptReads: hostId => gates.get(hostId)?.completedIdle ?? 0,
    releaseReceipts: hostId => gates.get(hostId)?.release(),
    async close() {
      if (globalThis.sottoRemoteHostE2E === harness) globalThis.sottoRemoteHostE2E = undefined
      const active = [...sockets.entries()]
      sockets.clear()
      for (const gate of gates.values()) gate.release()
      gates.clear()
      for (const [id] of active) router.remove(id)
      await Promise.all(active.map(([, socket]) => socket.close()))
    },
  }
  globalThis.sottoRemoteHostE2E = harness
  return harness
}
