import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'
import type { ActivitySubscriptionOptions } from './host'
import { ThreadChangesPublisher, threadChangesBetween, type ActivityChangesListener, type ActivityChangesSource, type ActivityChangesSubscription,
  type AgentHostRest, type ThreadChangeSet, type ThreadMap } from './threadChanges'

/**
 * What an adapter's thread changes are read from: the adapter's own activity view (ADR-0016, #925).
 *
 * `view` is the whole view, as its activity subscription publishes it. An adapter that marks its own changes also gives
 * `thread`, one thread as `view` lists it, undefined when `view` does not list it, and `rest`, every part of `view` but
 * its threads. Each reads the adapter's state when it is called, and takes ownership of activity and the catalog first,
 * as `view` does (`certifyActivityView`).
 */
export interface AdapterActivityView {
  view(historyFromEvents: boolean): AgentHostSnapshot
  thread?(id: string, historyFromEvents: boolean): AgentThread | undefined
  rest?(): AgentHostRest
}

/** Every part of an adapter's state but its threads, for `AdapterActivityView.rest`. */
export function restOf(state: AgentHostSnapshot): AgentHostRest {
  const rest: Partial<AgentHostSnapshot> = { ...state }
  delete rest.threads
  return rest as AgentHostRest
}

/** One form's marks: the threads marked since its last publication, or every thread. */
interface Marks { readonly ids: Set<string>; all: boolean }

/**
 * An adapter's thread changes, published beside its activity snapshots from the same emit.
 *
 * An adapter that does not mark its own changes gives `view` alone, and each publication is worked out by the shim
 * (`ThreadChangesPublisher.publishSnapshots`), one comparison per thread. An adapter that marks gives `thread` and `rest`
 * too, and calls `mark` once a path has changed a thread's state, or `markAll` after one that changed many or rebuilt its
 * threads, such as a connection or a disconnection. Its publication then carries only the marked threads, as upserts, or
 * as removals of the ones `view` no longer lists, through `publishChanges`, and never pays the shim's scan of every
 * thread. A thread marked that did not change costs one comparison and is left out.
 *
 * The marks are read when a publication is built, not when it is asked for: a publication asked for while another is
 * being delivered builds afterwards (`ThreadChangesPublisher`), and then carries whatever was marked by then. Each build
 * takes the marks it publishes and clears them in the same step, so a thread marked between the request and the build
 * goes out once, in that build, and one marked after it goes out in the next. The two forms of the view, with history
 * from events and without, keep marks of their own, since each is built from its own marks.
 *
 * The rest of the view, its catalog, projects and connection, is not marked: each publication reads it against the rest
 * last published, which costs what the rest holds rather than the threads.
 *
 * Order: an adapter keeps its threads in the order they were first added, so one new thread goes last, where an upsert
 * puts it. A publication that would bring more than one new thread, and one after `markAll`, is worked out by the shim,
 * which places each thread where the view has it.
 */
export class AdapterThreadChanges implements ActivityChangesSource {
  private readonly publisher = new ThreadChangesPublisher()
  private readonly forms = new Map<boolean, Marks>([[false, { ids: new Set(), all: true }], [true, { ids: new Set(), all: true }]])

  constructor(private readonly source: AdapterActivityView) {}

  /** Whether this adapter marks its own changes, rather than having the shim work them out. */
  get marking(): boolean { return this.source.thread !== undefined && this.source.rest !== undefined }

  /** This thread's state changed, or it came or went. Call it once the change is made. */
  mark(id: string): void {
    if (!this.marking) return
    for (const form of this.forms.values()) if (!form.all) form.ids.add(id)
  }

  /** Every thread may have changed, come or gone: the next publication of each form is worked out whole. */
  markAll(): void {
    for (const form of this.forms.values()) { form.all = true; form.ids.clear() }
  }

  subscribeActivityChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    return this.publisher.subscribe(listener, options)
  }

  /** Publishes what changed since the last publication, to each form someone subscribes to. Costs nothing with no subscriber. */
  publish(): void {
    if (!this.marking) { this.publisher.publishSnapshots(historyFromEvents => this.source.view(historyFromEvents)); return }
    this.publisher.publishChanges((historyFromEvents, published) => this.build(historyFromEvents, published))
  }

  private build(historyFromEvents: boolean, published: ThreadMap | undefined): ThreadChangeSet {
    const form = this.forms.get(historyFromEvents)!
    // A first publication, one after `markAll`, and one for a form nobody subscribed to until now, are worked out whole.
    if (!published || form.all) return this.whole(form, historyFromEvents, published)
    const ids = [...form.ids]
    form.ids.clear()
    const upserts: AgentThread[] = [], removals: string[] = []
    let added = 0
    for (const id of ids) {
      const thread = this.source.thread!(id, historyFromEvents)
      if (thread) {
        if (!published.has(id) && ++added > 1) return this.whole(form, historyFromEvents, published)
        upserts.push(thread)
      } else if (published.has(id)) removals.push(id)
    }
    return { upserts, removals, rest: this.source.rest!() }
  }

  private whole(form: Marks, historyFromEvents: boolean, published: ThreadMap | undefined): ThreadChangeSet {
    form.all = false
    form.ids.clear()
    return threadChangesBetween(published, this.source.view(historyFromEvents))
  }
}
