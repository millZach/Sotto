import { randomUUID } from 'node:crypto'
import type { AgentHost, AgentHostResult } from '../../src/main/agents/host'

/** Count only replies to this thread's held card. Keep wire IDs in memory, never record frames. */
export function observeCommandCenterLivePermissionAnswers(host: AgentHost, provider: 'codex' | 'claude' | 'grok', id: string, answered: () => void): void {
  type Wire = { write(frame: unknown): unknown; answer?(id: string | number, result: unknown): Promise<void>; reply?(id: string | number, result: unknown): Promise<void> }
  const wrap = (wire: Wire, ids: Set<string | number>) => {
    const write = wire.write.bind(wire)
    wire.write = frame => {
      const value = frame as { id?: string | number; method?: string; response?: { request_id?: string } }
      if (value.method === undefined && ids.has(value.id ?? value.response?.request_id ?? '')) answered()
      return write(frame)
    }
    for (const name of ['answer', 'reply'] as const) {
      const original = wire[name]?.bind(wire)
      if (original) wire[name] = (requestId, result) => { if (ids.has(requestId)) answered(); return original(requestId, result) }
    }
  }
  if (provider === 'codex') {
    const native = host as unknown as { requests: Map<string, { sessionId: string; id: string | number; server: Wire }> }
    const servers = new Map<Wire, Set<string | number>>()
    for (const pending of native.requests.values()) if (pending.sessionId === id) {
      const ids = servers.get(pending.server) ?? new Set(); ids.add(pending.id); servers.set(pending.server, ids)
    }
    for (const [server, ids] of servers) wrap(server, ids)
  } else if (provider === 'claude') {
    const native = host as unknown as { runtimes: Map<string, { requests: Map<string, unknown>; protocol: Wire }> }
    const runtime = native.runtimes.get(id)
    if (runtime) wrap(runtime.protocol, new Set(runtime.requests.keys()))
  } else {
    const native = host as unknown as { pending: Map<string, { threadId: string; wireId: string | number; rpc: Wire }> }
    const clients = new Map<Wire, Set<string | number>>()
    for (const pending of native.pending.values()) if (pending.threadId === id) {
      const ids = clients.get(pending.rpc) ?? new Set(); ids.add(pending.wireId); clients.set(pending.rpc, ids)
    }
    for (const [client, ids] of clients) wrap(client, ids)
  }
}

/**
 * Test-only cancellation. Ordinary Stop first declines held requests. Detach only
 * this disposable thread's held requests before Stop, so it sends native cancel
 * without a permission reply, including during subsequent disconnect cleanup.
 * This changes no production permission or interruption behavior.
 */
export async function interruptCommandCenterLiveTurn(host: AgentHost, provider: 'codex' | 'claude' | 'grok', id: string): Promise<AgentHostResult> {
  if (provider === 'codex') {
    const native = host as unknown as { requests: Map<string, { sessionId: string }>; removeRequest(id: string): void }
    for (const [requestId, pending] of native.requests) if (pending.sessionId === id) native.removeRequest(requestId)
  } else if (provider === 'claude') {
    const native = host as unknown as { runtimes: Map<string, { requests: Map<string, unknown> }> }
    native.runtimes.get(id)?.requests.clear()
  } else {
    type Pending = { threadId: string }
    const native = host as unknown as { pending: Map<string, Pending>; removeRequest(pending: Pending): void }
    for (const pending of native.pending.values()) if (pending.threadId === id) native.removeRequest(pending)
  }
  return host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: id })
}
