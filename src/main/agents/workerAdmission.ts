/** A start reserved on a machine, or waiting its turn there. Briefs remain with the owning service. */
interface WorkerAdmissionEntry {
  readonly id: string
  readonly machine: string
  readonly start: () => void
  threadId: string | undefined
  state: 'working' | 'queued'
}

interface MachineAdmission {
  readonly active: Map<string, WorkerAdmissionEntry>
  readonly queue: WorkerAdmissionEntry[]
}

export interface WorkerAdmissionOptions {
  readonly ceiling: (machine: string) => number
  /** Running thread IDs on this machine, including work started outside a swarm. */
  readonly working: (machine: string) => ReadonlySet<string>
}

/**
 * One admission owner per process, shared by Watcher and delegation. Reserving a place is synchronous: two callers
 * cannot claim the same last slot while their first prompts are in flight. A reservation remains until its owner
 * releases it, and a thread already in the machine's running set is counted only once. Each machine promotes queued
 * starts in order. Owners retain their durable identities and reconcile them before rejoining after a restart;
 * this service holds no prompt, result or permission, and grants none.
 */
export class WorkerAdmission {
  private readonly entries = new Map<string, WorkerAdmissionEntry>()
  private readonly machines = new Map<string, MachineAdmission>()
  private closed = false

  constructor(private readonly options: WorkerAdmissionOptions) {}

  /** The caller starts a `working` admission itself. A queued one's callback runs only when its slot is reserved. */
  join(id: string, machine: string, start: () => void, threadId?: string): 'working' | 'queued' {
    const prior = this.entries.get(id)
    if (prior) return prior.state
    if (this.closed) throw new Error('Worker admission is closed.')
    let places = this.machines.get(machine)
    if (!places) { places = { active: new Map(), queue: [] }; this.machines.set(machine, places) }
    this.pump(machine, places)
    const state = !places.queue.length && this.used(machine, places) < this.options.ceiling(machine) ? 'working' : 'queued'
    const entry: WorkerAdmissionEntry = { id, machine, start, threadId, state }
    this.entries.set(id, entry)
    if (state === 'working') places.active.set(id, entry)
    else places.queue.push(entry)
    return state
  }

  /** Bind a reservation to its created thread so a later snapshot cannot count the same start twice. */
  bind(id: string, threadId: string): void {
    const entry = this.entries.get(id)
    if (entry) entry.threadId = threadId
  }

  /** Completion and cancellation both give the slot back. Cancelling a queued entry never calls its start. */
  leave(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    const places = this.machines.get(entry.machine)!
    if (entry.state === 'working') places.active.delete(id)
    else places.queue.splice(places.queue.indexOf(entry), 1)
    this.pump(entry.machine, places)
    if (!places.active.size && !places.queue.length) this.machines.delete(entry.machine)
  }

  /** Call when machine activity or its ceiling changes. Lowering a ceiling never interrupts work already admitted. */
  refresh(machine?: string): void {
    if (this.closed) return
    if (machine !== undefined) {
      const places = this.machines.get(machine)
      if (places) this.pump(machine, places)
      return
    }
    for (const [key, places] of this.machines) this.pump(key, places)
  }

  /** Queued entries ahead, excluding running reservations. A running entry has zero ahead. */
  ahead(id: string): number | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    return entry.state === 'working' ? 0 : this.machines.get(entry.machine)!.queue.indexOf(entry)
  }

  ceiling(machine: string): number { return this.options.ceiling(machine) }
  waiting(machine: string): number { return this.machines.get(machine)?.queue.length ?? 0 }
  reserved(machine: string): number { return this.machines.get(machine)?.active.size ?? 0 }

  view(id: string): { readonly state: 'working' | 'queued'; readonly ahead: number; readonly waiting: number } | undefined {
    const entry = this.entries.get(id)
    return entry ? { state: entry.state, ahead: this.ahead(id)!, waiting: this.waiting(entry.machine) } : undefined
  }

  close(): void { this.closed = true; this.entries.clear(); this.machines.clear() }

  private used(machine: string, places: MachineAdmission): number {
    const running = this.options.working(machine)
    let used = running.size
    for (const entry of places.active.values()) if (!entry.threadId || !running.has(entry.threadId)) used++
    return used
  }

  private pump(machine: string, places: MachineAdmission): void {
    if (this.closed || !places.queue.length) return
    let available = this.options.ceiling(machine) - this.used(machine, places)
    while (available > 0 && places.queue.length) {
      const entry = places.queue.shift()!
      entry.state = 'working'
      places.active.set(entry.id, entry)
      available--
      queueMicrotask(() => {
        if (!this.closed && this.entries.get(entry.id) === entry && entry.state === 'working') entry.start()
      })
    }
  }
}
