import { useSyncExternalStore } from 'react'
import { TO_DO_UNDO_MS, type ToDo, type ToDosBridge, type ToDosView } from '../../../../shared/toDos'

/** One to-do as the list shows it, with the computer that holds it. */
export interface ToDoRow {
  readonly key: string
  readonly hostId: string
  readonly thisComputer: boolean
  readonly item: ToDo
  /** Checked off, with Undo standing: nothing has reached the computer that holds it yet. */
  readonly held: boolean
  /** The wait is over and the press is on its way: it stays until the list says it is gone, so a refusal has somewhere to show. */
  readonly sending: boolean
}

/** A press that failed: which press, for the words that say what is true after it. */
export interface ToDoFailure {
  readonly press: 'check' | 'tell' | 'add'
  readonly title: string
}

/** What the corner reads: every row, and the last press if it failed. */
export interface ToDoSnapshot {
  readonly view: ToDosView
  readonly rows: readonly ToDoRow[]
  /** The rows that are not held: what the badge counts. */
  readonly left: number
  readonly unseen: number
  readonly failure: ToDoFailure | null
  /** Whether the computer the user's own would go to is keeping a list. */
  readonly canAdd: boolean
}

type Hold = { readonly hostId: string; readonly id: string; readonly title: string; timer: ReturnType<typeof setTimeout> | null }
const EMPTY: ToDosView = { machines: [] }

/**
 * The window's side of the to-do list (ADR-0188). It outlives any one page's corner, because the five seconds a check-off
 * waits go on through rolling up and through moving to another page: the wait is here, and nothing reaches the computer
 * that holds the item until it ends. A window that goes away in those seconds leaves the item unchecked, which loses nothing.
 */
export class ToDoClient {
  private view: ToDosView = EMPTY
  private readonly holds = new Map<string, Hold>()
  private readonly listeners = new Set<() => void>()
  private readonly asked = new Set<string>()
  private failure: ToDoFailure | null = null
  private current: ToDoSnapshot = { view: EMPTY, rows: [], left: 0, unseen: 0, failure: null, canAdd: false }
  constructor(private readonly bridge: ToDosBridge) {
    void bridge.read().then(view => { this.take(view) }, () => undefined)
    bridge.onChanged(view => { this.take(view) })
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  readonly snapshot = (): ToDoSnapshot => this.current
  /** Takes it off in five seconds, unless Undo comes first. */
  check(row: Pick<ToDoRow, 'key' | 'hostId' | 'item'>): void {
    if (this.holds.has(row.key)) return
    const hold: Hold = { hostId: row.hostId, id: row.item.id, title: row.item.title, timer: null }
    hold.timer = setTimeout(() => { hold.timer = null; this.publish(); void this.send(row.key, hold) }, TO_DO_UNDO_MS)
    this.holds.set(row.key, hold)
    this.failure = null
    this.publish()
  }
  undo(key: string): void {
    const hold = this.holds.get(key)
    if (!hold?.timer) return
    clearTimeout(hold.timer)
    this.holds.delete(key)
    this.publish()
  }
  /** It did not work: the user's words go at once, with no wait, since they asked to send them. */
  async didNotWork(row: Pick<ToDoRow, 'hostId' | 'item'>, words: string): Promise<boolean> {
    this.failure = null
    this.publish()
    try {
      await this.bridge.request({ hostId: row.hostId, request: { kind: 'check', id: row.item.id, didNotWork: words } })
      return true
    } catch {
      this.failure = { press: 'tell', title: row.item.title }
      this.publish()
      return false
    }
  }
  /** The user's own goes to the computer they are on, and only there (ADR-0188, decision 8). */
  async add(title: string): Promise<boolean> {
    const machine = this.view.machines.find(item => item.thisComputer)
    if (!machine) return false
    this.failure = null
    this.publish()
    try {
      await this.bridge.request({ hostId: machine.hostId, request: { kind: 'add', title } })
      return true
    } catch {
      this.failure = { press: 'add', title }
      this.publish()
      return false
    }
  }
  /** Opened: what is new is new no longer, on each computer that holds it. A press that fails is asked again at the next opening. */
  seen(): void {
    for (const machine of this.view.machines) {
      const fresh = machine.items.filter(item => !item.seen && !this.asked.has(rowKey(machine.hostId, item.id)))
      if (!fresh.length) continue
      for (const item of fresh) this.asked.add(rowKey(machine.hostId, item.id))
      void this.bridge.request({ hostId: machine.hostId, request: { kind: 'seen' } }).catch(() => undefined)
    }
  }
  /** Rolled up: a failure has been read, and what is new can be asked about again. */
  rolledUp(): void {
    this.asked.clear()
    if (!this.failure) return
    this.failure = null
    this.publish()
  }
  private async send(key: string, hold: Hold): Promise<void> {
    try {
      await this.bridge.request({ hostId: hold.hostId, request: { kind: 'check', id: hold.id } })
    } catch {
      if (this.holds.get(key) !== hold) return
      this.holds.delete(key)
      this.failure = { press: 'check', title: hold.title }
      this.publish()
    }
  }
  private take(view: ToDosView): void {
    this.view = view
    for (const [key, hold] of this.holds) {
      if (view.machines.some(machine => machine.hostId === hold.hostId && machine.items.some(item => item.id === hold.id))) continue
      // Gone from under the wait, checked off on another client or its computer gone: there is nothing left to send.
      if (hold.timer) clearTimeout(hold.timer)
      this.holds.delete(key)
    }
    this.publish()
  }
  private publish(): void {
    const rows: ToDoRow[] = []
    let left = 0, unseen = 0
    for (const machine of this.view.machines) {
      for (const item of machine.items) {
        const key = rowKey(machine.hostId, item.id), hold = this.holds.get(key)
        rows.push({ key, hostId: machine.hostId, thisComputer: machine.thisComputer, item, held: hold !== undefined, sending: hold !== undefined && !hold.timer })
        if (hold) continue
        left += 1
        if (!item.seen) unseen += 1
      }
    }
    this.current = { view: this.view, rows, left, unseen, failure: this.failure, canAdd: this.view.machines.some(machine => machine.thisComputer) }
    for (const listener of [...this.listeners]) listener()
  }
}

const rowKey = (hostId: string, id: string): string => `${hostId}\u0000${id}`
const clients = new WeakMap<ToDosBridge, ToDoClient>()

export function toDoClientOf(bridge: ToDosBridge): ToDoClient {
  let client = clients.get(bridge)
  if (!client) { client = new ToDoClient(bridge); clients.set(bridge, client) }
  return client
}

export function useToDos(client: ToDoClient): ToDoSnapshot {
  return useSyncExternalStore(client.subscribe, client.snapshot)
}
