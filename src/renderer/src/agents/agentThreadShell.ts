import type { AgentThread, AgentThreadsBroadcast } from '../../../shared/agents'
import { cloneAgentThread } from '../../../shared/cloneAgentThread'

/** Page-owned content, distinct from every writable state handed to a consumer. */
export class AgentThreadShell {
  private revision: number | null = null
  private bodies = new Map<string, { revision: number; thread: AgentThread }>()

  clear(): void { this.bodies.clear(); this.revision = null }

  assemble(raw: unknown): { threads: AgentThread[]; commit: () => void } | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const envelope = raw as AgentThreadsBroadcast
    const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
    if (!validRevision(envelope.revision) || !(envelope.baseRevision === null || validRevision(envelope.baseRevision))
      || !Array.isArray(envelope.roster) || !Array.isArray(envelope.changed)) return undefined
    if (envelope.baseRevision !== null && envelope.baseRevision >= envelope.revision) return undefined
    if (envelope.baseRevision !== null && envelope.baseRevision !== this.revision && envelope.revision !== this.revision) return undefined
    if (this.revision !== null && envelope.revision < this.revision) return undefined
    const changed = new Map<string, { revision: number; thread: AgentThread }>()
    for (const body of envelope.changed) {
      if (!body || !validRevision(body.revision) || !body.thread || typeof body.thread.id !== 'string' || changed.has(body.thread.id)) return undefined
      changed.set(body.thread.id, body)
    }
    const next = new Map<string, { revision: number; thread: AgentThread }>()
    for (const entry of envelope.roster) {
      if (!entry || typeof entry.id !== 'string' || !validRevision(entry.revision) || next.has(entry.id)) return undefined
      const carried = changed.get(entry.id)
      const body = carried ?? (envelope.baseRevision === null ? undefined : this.bodies.get(entry.id))
      if (!body || body.revision !== entry.revision) return undefined
      // Carried bodies came through contextBridge but may also be retained by another raw listener.
      next.set(entry.id, carried ? { revision: body.revision, thread: cloneAgentThread(body.thread) } : body)
    }
    if ([...changed.keys()].some(id => !next.has(id))) return undefined
    // Every delivered shell owns its thread objects, including relative to earlier shells. The
    // cache never leaks mutable aliases to consumers or to another subscription.
    const threads = [...next.values()].map(body => cloneAgentThread(body.thread))
    return { threads, commit: () => { this.bodies = next; this.revision = envelope.revision } }
  }
}

