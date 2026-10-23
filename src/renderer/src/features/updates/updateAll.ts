import { PROVIDER_LABELS, type AgentClientHost, type ProviderClientUpdate, type ProviderId } from '../../../../shared/agents'
import type { UpdateStatus } from '../../../../shared/contracts'
import type { HostStatus } from '../../../../shared/hosts'
import { HOST_UPDATE_STEPS, type HostUpdateState, type HostUpdateStep } from '../../../../shared/hostUpdates'

/**
 * Update all (ADR-0077): one view of everything that is out of date, read from what the update control, the client
 * update lines and the host updates already publish, and of what one press set going. Nothing here sends anything.
 */

/** Where an item lives: Sotto itself, this computer, or a connected host by its saved ID. */
export type UpdateAllMachine =
  | { readonly kind: 'sotto' }
  | { readonly kind: 'local' }
  | { readonly kind: 'host'; readonly id: string; readonly name: string }
/**
 * `offered` until a press; `running` while it goes, and between the press and its updater taking it; `waiting` for a
 * host's working threads to finish; `by-hand` when Sotto cannot do it and shows how; `checking` while the releases page
 * is asked whether a host's update to the version Sotto is downloading is published (ADR-0077).
 */
export type UpdateAllItemState = 'offered' | 'running' | 'waiting' | 'done' | 'failed' | 'by-hand' | 'checking'
/** What is installed, and what an update installs while there is one: `to` is absent once it is done. */
export interface UpdateAllVersions { readonly from: string; readonly to?: string | undefined }
/** "installed → published", or what is installed: the only place versions become words. */
export const versionsText = (versions: UpdateAllVersions): string => versions.to === undefined ? versions.from : `${versions.from} → ${versions.to}`
const sameVersions = (left: UpdateAllVersions, right: UpdateAllVersions | undefined): boolean => left.from === right?.from && left.to === right.to
export interface UpdateAllItem {
  readonly key: string
  readonly machine: UpdateAllMachine
  readonly kind: 'app' | 'client' | 'host'
  readonly name: string
  readonly versions: UpdateAllVersions
  readonly state: UpdateAllItemState
  readonly detail: string
  /** How far Sotto's download has come, while it downloads. */
  readonly percent?: number | undefined
  /** What to run by hand, for the user to copy. */
  readonly commands?: string | undefined
  readonly provider?: ProviderId | undefined
  /** A host's working threads, while its update waits for them. */
  readonly working?: number | undefined
  /** A host's update that, once its threads finish, still waits for the host's client updates: stopping them does not start it. */
  readonly clientsUpdating?: boolean | undefined
  /** A host's update that Cancel update can still stop: waiting for its threads, or downloading and checking (ADR-0040). */
  readonly cancellable?: boolean | undefined
  /** The version a host's own update installs. */
  readonly target?: string | undefined
}
export interface UpdateAllSources {
  readonly app: UpdateStatus | null
  /** This computer's own client updates. */
  readonly local: readonly ProviderClientUpdate[]
  readonly hosts: readonly HostStatus[]
  readonly localHostId?: string | undefined
  readonly clientHosts: readonly AgentClientHost[]
  readonly hostUpdates: readonly HostUpdateState[]
  /** Saved hosts whose update to the version Sotto is downloading is still being asked about (ADR-0077). */
  readonly hostChecks?: readonly string[] | undefined
}
/** What one press of Update all set going, kept by the card until it is put away. */
export interface UpdateAllPass {
  /** Every item the press asked an updater for. */
  readonly touched: ReadonlySet<string>
  /** Saved hosts whose own update waits for the clients the press put in their line, so its restart cuts none off. */
  readonly after: ReadonlySet<string>
  /** Why an updater refused a part of the press, by item. */
  readonly refused: ReadonlyMap<string, string>
  /** Each client's last finished update when the press began, so a result from before it is not read as its own. */
  readonly ranBefore: ReadonlyMap<string, string | undefined>
  /**
   * Client steps on a host seen waiting or updating in its client update line since the press or their Try again. One
   * that is out of the line again with no result of its own lost its line: the host restarted, or came back as a new
   * process. Never set between a press and the host's first word about it, so the reply's head start is not a loss. Each
   * is kept as it was seen, so it stays listed while its host is out of reach or has yet to report it again.
   */
  readonly seen?: ReadonlyMap<string, UpdateAllItem> | undefined
  /**
   * Seen steps whose host was out of reach since, as while it restarts: a line lost then went with the restart. One lost
   * without that, as when Cancel update on the host's tile took it out, is not said to be a restart.
   */
  readonly dropped?: ReadonlySet<string> | undefined
  /** Client steps the press finished, by item, kept as they were if their machine forgets them, as a host's restart does. */
  readonly kept?: ReadonlyMap<string, UpdateAllItem> | undefined
  /**
   * The version each host and client the press asked for was to get, so a newer one offered later is not read as the
   * press's.
   */
  readonly targets?: ReadonlyMap<string, string> | undefined
  /**
   * Set by a press of Update all, not by a step's own Try again: while it is under way, a client found behind joins it.
   * Cleared once the press is no longer under way, so a Try again after it opens nothing (ADR-0077, October 21 amendment).
   */
  readonly pressed?: true | undefined
  /**
   * Set by a press of Update all, not by a step's own Try again: the saved hosts it covers whose check of the releases
   * page had not ended. Each joins the press once its check does, aimed at what the check found, and the restart waits
   * for it (ADR-0077). A host whose check begins while the press is under way joins it the same way.
   */
  readonly joining?: ReadonlySet<string> | undefined
}
export type UpdateAllPhase = 'hidden' | 'offer' | 'running' | 'restart' | 'done'
export interface UpdateAllView {
  readonly phase: UpdateAllPhase
  readonly items: readonly UpdateAllItem[]
  /** The steps the card shows, the restart counted, and how many of them are done. */
  readonly total: number
  readonly finished: number
  /** The version Sotto installs when it restarts. */
  readonly ready?: string | undefined
  /** Sotto's own versions, which the card's head carries once for every step. */
  readonly sotto?: UpdateAllVersions | undefined
  /** What a Not now puts away: everything offered as it is now. */
  readonly fingerprint: string
}

/** What every client step's key on a machine begins with. */
const clientPrefix = (machine: 'local' | string): string => `client:${machine}:`
export const clientKey = (machine: 'local' | string, provider: ProviderId): string => `${clientPrefix(machine)}${provider}`
export const hostKey = (id: string): string => `host:${id}`
export const APP_KEY = 'sotto'

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`
/** "a", "a and b", "a, b and c". */
export function listed(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function appItem(app: UpdateStatus | null, pass: UpdateAllPass | null): UpdateAllItem | undefined {
  if (!app) return undefined
  const touched = pass?.touched.has(APP_KEY) === true
  const base = { key: APP_KEY, machine: { kind: 'sotto' } as const, kind: 'app' as const, name: app.releaseTrack === 'owl' ? 'Sotto Owl' : 'Sotto' }
  const refused = pass?.refused.get(APP_KEY)
  const { phase } = app
  if (phase.phase === 'available') {
    const versions = { from: app.currentVersion, to: phase.version }
    if (refused || touched && phase.problem !== null && phase.failedStep === 'download') {
      return { ...base, versions, state: 'failed', detail: refused ?? phase.problem ?? 'The download did not finish. Nothing was installed.' }
    }
    if (touched) return { ...base, versions, state: 'running', detail: 'Starting the download…' }
    return { ...base, versions, state: 'offered', detail: 'Downloads now, and installs when Sotto restarts.' }
  }
  if (phase.phase === 'downloading') {
    return { ...base, versions: { from: app.currentVersion, to: phase.version }, state: 'running', detail: `Downloading · ${phase.percent}%`, percent: phase.percent }
  }
  if (phase.phase === 'downloaded') {
    return { ...base, versions: { from: app.currentVersion, to: phase.version }, state: 'done', detail: 'Downloaded. It installs when Sotto restarts.' }
  }
  if (phase.phase === 'failed' && touched) return { ...base, versions: { from: app.currentVersion }, state: 'failed', detail: refused ?? phase.problem ?? 'Sotto could not reach the update. Nothing was installed.' }
  return undefined
}

/** What a host client step whose line was lost says: that the host restarted, when it was out of reach meanwhile. */
function lostDetail(host: string, name: string, restarted: boolean): string {
  return restarted ? `${host} restarted before ${name} updated. Nothing was changed. Try again.` : `The ${name} update on ${host} stopped before it finished. Nothing was changed. Try again.`
}

function clientItem(machine: UpdateAllMachine, update: ProviderClientUpdate, pass: UpdateAllPass | null): UpdateAllItem | undefined {
  const key = clientKey(machine.kind === 'host' ? machine.id : 'local', update.id)
  const name = PROVIDER_LABELS[update.id]
  // A release newer than the one the press asked for, found once the client is out of its line, is a new offer: the
  // finding about the release before it gave way to it (ADR-0042).
  const target = pass?.targets?.get(key)
  const renewed = target !== undefined && update.published !== undefined && update.published !== target && update.behind
    && update.state !== 'queued' && update.state !== 'updating'
  const touched = pass?.touched.has(key) === true && !renewed
  const behindVersions = { from: update.installed, ...update.published && update.published !== update.installed ? { to: update.published } : {} }
  const base = { key, machine, kind: 'client' as const, name, provider: update.id, versions: behindVersions }
  const refused = pass?.refused.get(key)
  if (refused) return { ...base, state: 'failed', detail: refused }
  // A result already there when the press began is not the press's own: the line has yet to take the client. A host keeps
  // its results in memory, so one that restarted has none, and that is no result either.
  const ranSincePress = touched && update.ranAt !== undefined && update.ranAt !== pass?.ranBefore.get(key)
  // In its host's line since the press, and out of it with no result: the host restarted, or reconnected as a new process,
  // and the line went with it, or the update was cancelled on the host's tile. This computer's line cannot go without the
  // card going too.
  const lost = machine.kind === 'host' && touched && pass?.seen?.has(key) === true
  if (update.state === 'queued') return { ...base, state: 'running', detail: 'Waiting for the update before it.' }
  if (update.state === 'updating') {
    const step = update.steps && update.steps > 1 ? `, step ${update.step ?? 1} of ${update.steps}` : ''
    return { ...base, state: 'running', detail: `Updating${step}…` }
  }
  if (ranSincePress && update.state === 'updated') return { ...base, versions: { from: update.installed }, state: 'done', detail: `Now ${update.installed}.` }
  if (ranSincePress && update.state === 'failed') {
    // What the installer printed stays where Sotto keeps it for each machine; the card says what happened and what next.
    const where = machine.kind === 'host' ? `Settings → Hosts & phones shows what the installer said on ${machine.name}.` : 'Settings → Providers shows what the installer said.'
    return { ...base, state: 'failed', detail: `${name} did not update. Nothing was changed. ${where}`, commands: update.byHand?.length ? update.byHand.join('\n') : undefined }
  }
  if (ranSincePress && update.state === 'unchanged') {
    return { ...base, state: 'failed', detail: update.error ?? `The installer finished, but ${name} still reports ${update.installed}.` }
  }
  // The installer finished with the provider disconnected, so nothing could read the version yet (ADR-0042).
  if (ranSincePress && update.state === 'idle') return { ...base, state: 'done', detail: `The installer finished. Connect ${name} to see the version it runs now.` }
  if (lost && machine.kind === 'host') {
    // It finished before the line went only if the host now runs another version than when the step was seen. Whether
    // the client reads as behind cannot say: one whose registry did not answer reads as not behind (Sol, review of #1084).
    if (update.installed !== pass?.seen?.get(key)?.versions.from) return { ...base, versions: { from: update.installed }, state: 'done', detail: `Now ${update.installed}.` }
    return { ...base, state: 'failed', detail: lostDetail(machine.name, name, pass?.dropped?.has(key) === true) }
  }
  if (!update.behind) return undefined
  if (!update.canInstall) {
    const commands = update.byHand?.length ? update.byHand.join('\n') : update.command
    return { ...base, state: 'by-hand', detail: commands ? `Update it yourself with ${commands.split('\n')[0]}.` : 'Sotto cannot update this install. Update it the way you installed it.', commands }
  }
  if (touched) return { ...base, state: 'running', detail: 'Starting…' }
  return { ...base, state: 'offered', detail: '' }
}

function stepTitle(update: HostUpdateState, step: HostUpdateStep): string {
  switch (step) {
    case 'download': return `Download ${update.to}`
    case 'check': return 'Check the download'
    case 'install': return `Install beside ${update.from}`
    case 'restart': return `Restart ${update.name}’s host`
  }
}

function hostItem(update: HostUpdateState, pass: UpdateAllPass | null): UpdateAllItem | undefined {
  const key = hostKey(update.id)
  const { name, working } = update
  // A press touched this update only if it was for the version offered now: a newer one found later is a new offer.
  const touched = pass?.touched.has(key) === true && (pass.targets?.get(key) ?? update.to) === update.to
  const base = { key, machine: { kind: 'host', id: update.id, name } as const, kind: 'host' as const, name: 'Sotto host', versions: { from: update.from, to: update.to }, working, target: update.to }
  // A host's own note before any press, such as one still running thread management, explains rather than fails.
  const refused = pass?.refused.get(key) ?? (touched || update.phase === 'failed' ? update.error : undefined)
  const threads = plural(working, 'thread')
  // A finished update's note, such as one that finished a version this computer stopped updating to, says what happened.
  if (update.phase === 'done') return touched ? { ...base, versions: { from: update.to }, state: 'done', detail: update.error ?? `${name} runs Sotto host ${update.to}.` } : undefined
  if (update.phase === 'updating') {
    const step = update.step ?? 'download'
    // A client update running on the host holds the restart, however far the update has come (ADR-0077 decision 2).
    const held = !update.clientsUpdating ? '' : step === 'restart' ? ' once its clients have' : ` · Restarts once ${name}’s clients have.`
    return { ...base, state: 'running', detail: `Step ${HOST_UPDATE_STEPS.indexOf(step) + 1} of 4 · ${stepTitle(update, step)}${held}`, cancellable: step === 'download' || step === 'check' }
  }
  // Waiting for the host's client update line and nothing else reads as the press's own wait for its clients.
  if (update.phase === 'waiting' && update.clientsUpdating && !working) return { ...base, state: 'running', detail: `Updates once ${name}’s clients have.`, cancellable: true }
  if (update.phase === 'waiting' || update.phase === 'confirm' && !touched) {
    const clientsUpdating = update.phase === 'waiting' && update.clientsUpdating === true
    return { ...base, state: 'waiting', detail: `Updates once its ${threads} ${working === 1 ? 'finishes' : 'finish'}${clientsUpdating ? ' and its clients have' : ''}.`, cancellable: true,
      ...clientsUpdating ? { clientsUpdating } : {} }
  }
  if (refused) return { ...base, state: 'failed', detail: refused }
  if (update.phase === 'failed') {
    return { ...base, state: 'failed', detail: update.failure ? `${update.failure.message} ${update.failure.kept} ${update.failure.next}` : `${name} was not updated.`, commands: update.commands }
  }
  if (!update.owned) {
    return { ...base, state: 'by-hand', detail: `Sotto did not start the host on ${name}, so it cannot restart it. Update it there with these commands.`, commands: update.commands }
  }
  if (pass?.after.has(update.id)) return { ...base, state: 'running', detail: `Updates once ${name}’s clients have.` }
  if (touched) return { ...base, state: 'running', detail: 'Starting…' }
  return { ...base, state: 'offered', detail: update.error ?? (working
    ? `${threads} on ${name} ${working === 1 ? 'is' : 'are'} working. It updates once they finish.`
    : `Restarts ${name}’s host, so its threads are unavailable for a few seconds.`) }
}

/**
 * A host the releases page is still being asked about, for the version this computer is downloading (ADR-0077): in a
 * moment it is offered that version, or its update to this computer's own, or nothing. Update all covers it either way.
 */
function checkingItem(host: HostStatus, update: HostUpdateState | undefined): UpdateAllItem {
  return { key: hostKey(host.id), machine: { kind: 'host', id: host.id, name: host.name }, kind: 'host', name: 'Sotto host',
    versions: { from: update?.from ?? host.version ?? '' }, state: 'checking', detail: 'Checking the releases page for its update…' }
}
/**
 * Whether a host's step is its check: while it lasts, in place of an offer, or of nothing to show, for a host Sotto can
 * update. A host Sotto did not start keeps its commands, which Update all never runs.
 */
function checksFirst(host: HostStatus, update: HostUpdateState | undefined, item: UpdateAllItem | undefined, sources: UpdateAllSources): boolean {
  if (!sources.hostChecks?.includes(host.id)) return false
  return update ? update.owned && (update.phase === 'needs' || update.phase === 'done' && !item) : host.owned === true
}

/**
 * Everything out of date, in the order one press runs it: Sotto's download, this computer's clients, then each host's
 * clients followed by the host's own update.
 */
export function updateAllItems(sources: UpdateAllSources, pass: UpdateAllPass | null): UpdateAllItem[] {
  const items: UpdateAllItem[] = []
  const app = appItem(sources.app, pass)
  if (app) items.push(app)
  items.push(...withKept('local', sources.local.flatMap(update => clientItem({ kind: 'local' }, update, pass) ?? []), pass))
  // Hosts that need an update in their order, then the rest as saved: each one's clients, then its own update.
  const updated = new Set(sources.hostUpdates.map(update => update.id))
  const hosts = [...sources.hostUpdates.map(update => update.id), ...sources.hosts.map(host => host.id).filter(id => !updated.has(id))]
  for (const id of hosts) {
    const host = sources.hosts.find(item => item.id === id)
    if (host) items.push(...withKept(id, hostClients(host, sources, pass), pass))
    const update = sources.hostUpdates.find(item => item.id === id)
    const item = update && hostItem(update, pass)
    if (host && checksFirst(host, update, item, sources)) items.push(checkingItem(host, update))
    else if (item) items.push(item)
  }
  return items
}

/**
 * A machine's client steps, with the ones this press finished that the machine no longer reports: a host's restart
 * forgets what its update line ran, and the step stays done rather than leaving the list.
 */
function withKept(machine: string, items: readonly UpdateAllItem[], pass: UpdateAllPass | null): UpdateAllItem[] {
  const kept = [...pass?.kept?.values() ?? []].filter(item => clientMachine(item) === machine && !items.some(other => other.key === item.key))
  return [...items, ...kept]
}
const clientMachine = (item: UpdateAllItem): string => item.machine.kind === 'host' ? item.machine.id : 'local'

/** A connected host's client updates, which reach the window on its `clientHosts` entry (#480). */
function hostClientUpdates(host: HostStatus, sources: UpdateAllSources): readonly ProviderClientUpdate[] {
  const client = host.hostId && host.hostId !== sources.localHostId ? sources.clientHosts.find(item => item.hostId === host.hostId) : undefined
  return client?.connected ? client.clientUpdates ?? [] : []
}
function hostClients(host: HostStatus, sources: UpdateAllSources, pass: UpdateAllPass | null): UpdateAllItem[] {
  const machine = { kind: 'host', id: host.id, name: host.name } as const
  const updates = hostClientUpdates(host, sources)
  // A step seen in the host's line that the host does not report now stays listed, so the press is not read as over.
  // While the host is out of reach it waits to hear from it. A connected host says everything it still has in its
  // first shell, so one that leaves the client out lost its line, as a restarted host without results or checks does.
  const reachable = sources.clientHosts.some(item => item.hostId === host.hostId && item.connected)
  const unheard = [...pass?.seen?.values() ?? []].filter(item => clientMachine(item) === host.id && !pass?.kept?.has(item.key) && !updates.some(update => clientKey(host.id, update.id) === item.key))
    .map(item => reachable
      ? { ...item, state: 'failed' as const, detail: lostDetail(host.name, item.name, pass?.dropped?.has(item.key) === true) }
      : { ...item, state: 'running' as const, detail: `Waiting to hear from ${host.name}…` })
  return [...updates.flatMap(update => clientItem(machine, update, pass) ?? []), ...unheard]
}

/**
 * Client steps the press asked of a host that are in the host's update line now, waiting or updating, and not yet in
 * the pass's `seen`: the card adds them, so a line the host loses later reads as lost rather than as starting.
 */
export function newlyInLine(sources: UpdateAllSources, pass: UpdateAllPass | null): string[] {
  if (!pass) return []
  return sources.hosts.flatMap(host => hostClientUpdates(host, sources)
    .filter(update => update.state === 'queued' || update.state === 'updating')
    .map(update => clientKey(host.id, update.id))
    .filter(key => pass.touched.has(key) && pass.seen?.has(key) !== true))
}

/**
 * Seen steps whose host is out of reach now, as while it restarts, and not yet in the pass's `dropped`: the card adds
 * them, so a line lost to the restart says so.
 */
export function newlyDropped(sources: UpdateAllSources, pass: UpdateAllPass | null): string[] {
  if (!pass?.seen?.size) return []
  return sources.hosts.filter(host => !sources.clientHosts.some(item => item.hostId === host.hostId && item.connected))
    .flatMap(host => [...pass.seen?.keys() ?? []].filter(key => key.startsWith(clientPrefix(host.id)) && pass.dropped?.has(key) !== true))
}

/**
 * Clients found behind while a press of Update all is under way, as when a new version of Sotto has every machine check
 * its clients afresh: each joins the press in its machine's update line, the way the press's own clients did, and a host's
 * update already waits for that line before it restarts (ADR-0077). The press is under way while a step it asked for is
 * still going, a host waits for its clients or its releases page, or the Sotto it downloaded waits for the restart.
 */
export function clientsJoining(view: UpdateAllView, pass: UpdateAllPass | null): UpdateAllItem[] {
  return pass?.pressed && pressUnderWay(view, pass) ? view.items.filter(item => item.kind === 'client' && item.state === 'offered') : []
}
/**
 * Whether what a pass set going still goes: a step it asked for is running or waiting, a host waits for its clients or
 * its releases page, or the Sotto it downloaded waits for the restart. Once a press is not, joining closes for good: a
 * step's own Try again afterwards opens nothing (ADR-0077, October 21 amendment).
 */
export function pressUnderWay(view: UpdateAllView, pass: UpdateAllPass): boolean {
  return view.items.some(item => pass.touched.has(item.key) && (item.state === 'running' || item.state === 'waiting' || item.state === 'checking'))
    || pass.after.size > 0 || (pass.joining?.size ?? 0) > 0 || pass.touched.has(APP_KEY) && view.ready !== undefined
}

/** Whether the list ends with the restart: whenever Sotto has a download, offered, under way or ready. */
const restartsLast = (items: readonly UpdateAllItem[]): boolean => items.some(item => item.kind === 'app')

export function updateAllView(sources: UpdateAllSources, pass: UpdateAllPass | null): UpdateAllView {
  const items = updateAllItems(sources, pass)
  const app = items.find(item => item.kind === 'app')
  const ready = app?.state === 'done' && sources.app?.phase.phase === 'downloaded' ? sources.app.phase.version : undefined
  // What is still offered, or still being checked, comes before the restart, so Sotto downloaded from the update control
  // leaves the rest a press, and a host the releases page has not answered for is never left behind by it: whatever its
  // step, the restart waits for every answer. A press of Update all covers a host's check, so the press runs until it ends.
  // Only a host whose own step is shown holds it: one Sotto did not start has none until its commands are offered.
  const unanswered = items.some(item => item.state === 'checking')
    || (sources.hostChecks ?? []).some(id => items.some(item => item.kind === 'host' && item.machine.kind === 'host' && item.machine.id === id))
  const phase: UpdateAllPhase = items.some(item => item.state === 'running') || (pass?.after.size ?? 0) > 0 || unanswered && pass?.joining !== undefined ? 'running'
    : items.some(item => item.state === 'offered') || unanswered ? 'offer'
      : ready ? 'restart'
        : pass && items.some(item => pass.touched.has(item.key)) ? 'done'
          : items.length ? 'offer' : 'hidden'
  const fingerprint = items.filter(item => item.state === 'offered' || item.state === 'by-hand' || item.state === 'failed')
    .map(item => `${item.key}@${versionsText(item.versions)}`).sort().join('|')
  const sotto = app?.versions.to === undefined ? undefined : app.versions
  // The count is the list's: every step shown, the restart among them, and those of them that are done.
  const total = items.length + (restartsLast(items) ? 1 : 0)
  return { phase, items, total, finished: items.filter(item => item.state === 'done').length, ready, sotto, fingerprint }
}

/** What the card and its pill say about where things stand. */
export interface UpdateAllWords {
  readonly title: string
  /** Under the title: Sotto's own versions, or how many of the steps shown are done while a press runs. */
  readonly sub: string
  /** What one press of Update all updates, which its button's name says: "Sotto, 2 clients and forge". */
  readonly summary: string
  /** What no step says, below the steps. */
  readonly notes: readonly string[]
  /** The folded card's words. */
  readonly pill: string
}
export interface UpdateAllContext {
  /** Threads on this computer that a restart would stop. */
  readonly working: number
  /** Whether they carry on after it (ADR-0076). */
  readonly resumes: boolean
}

function machineName(item: UpdateAllItem): string {
  return item.machine.kind === 'host' ? `${item.machine.name}’s ${item.name === 'Sotto host' ? 'host' : item.name}` : item.name
}
export function updateAllWords(view: UpdateAllView): UpdateAllWords {
  const offered = view.items.filter(item => item.state === 'offered')
  // A host still being checked is part of what a press covers, and of what its button names.
  const covered = view.items.filter(item => item.state === 'offered' || item.state === 'checking')
  const failed = view.items.filter(item => item.state === 'failed')
  const waiting = view.items.filter(item => item.state === 'waiting')
  const didNot = failed.length ? `${listed(failed.map(machineName))} did not update.` : ''
  const waitingNames = listed(waiting.map(item => item.machine.kind === 'host' ? item.machine.name : item.name))
  const one = waiting.length === 1
  // The wait lasts while Sotto is open (ADR-0077 decision 4): a restart first leaves the host for the next press.
  const waits = !waiting.length ? '' : view.phase === 'restart'
    ? `${waitingNames} ${one ? 'is' : 'are'} waiting for ${one ? 'its' : 'their'} threads. If Sotto restarts first, Update all offers ${one ? 'it' : 'them'} again.`
    : `${waitingNames} ${one ? 'updates' : 'update'} once ${one ? 'its' : 'their'} threads finish.`
  const app = offered.some(item => item.kind === 'app')
  const clients = offered.filter(item => item.kind === 'client').length
  const hosts = [...new Set(covered.filter(item => item.kind === 'host').map(item => item.machine.kind === 'host' ? item.machine.name : ''))]
  const parts = [...app ? ['Sotto'] : [], ...clients ? [plural(clients, 'client')] : [], ...hosts]
  const summary = parts.length ? listed(parts) : 'Sotto cannot install these itself.'
  switch (view.phase) {
    case 'running': return { title: 'Updating', sub: `${view.finished} of ${view.total} done`, summary, notes: [], pill: `Updating · ${view.finished} of ${view.total}` }
    // Each step says how it ended, and the restart step what restarting does; only a wait that a restart cuts short is left.
    case 'restart': return { title: 'Restart to finish', sub: view.sotto ? versionsText(view.sotto) : `Sotto ${view.ready}`, summary, notes: waits ? [waits] : [], pill: 'Restart to finish' }
    case 'done': return { title: failed.length ? 'Not everything updated' : 'Updated', sub: [didNot, waits].filter(Boolean).join(' ') || 'Nothing needs a restart.', summary, notes: [],
      pill: failed.length ? `${plural(failed.length, 'update')} did not finish` : 'Updated' }
    default: return {
      title: 'Updates',
      sub: view.sotto ? versionsText(view.sotto) : summary,
      summary,
      // A host's restart, and Sotto's, are said by their own steps; that threads keep working through client updates is not.
      notes: clients ? ['Threads keep working while clients update.'] : [],
      pill: covered.length ? 'Update all' : 'Updates',
    }
  }
}

/** The restart that ends a press, after every other step: `last` until Sotto's download is ready, then `ready`. */
export const RESTART_KEY = 'restart'
export type UpdateAllStepState = UpdateAllItemState | 'last' | 'ready'
/** One line of the card's ordered list (ADR-0077, Steps): an item, or the restart that ends the press. */
export interface UpdateAllStep {
  readonly key: string
  /** The item behind the step; the restart has none. */
  readonly item?: UpdateAllItem | undefined
  /** What the step does: "Download Sotto Owl", "Update Codex", "Update forge’s host", "Restart Sotto". */
  readonly title: string
  /** "installed → published" for a step whose versions the head does not already give. */
  readonly versions?: string | undefined
  /** Where it happens, unless the title says, then the item's own sentence: "forge · Updating…". */
  readonly detail: string
  readonly state: UpdateAllStepState
}

function itemStep(item: UpdateAllItem, view: UpdateAllView): UpdateAllStep {
  const host = item.machine.kind === 'host' ? item.machine.name : ''
  const title = item.kind === 'app' ? `Download ${item.name}` : item.kind === 'client' ? `Update ${item.name}` : `Update ${host}’s host`
  // A host's own step names it, so it carries no place. A client's versions are its own, and a host's are shown only
  // when they are not Sotto's pair in the head; once either is done, its sentence says the version it runs, and while a
  // host is checked, the version it is to get is what the check finds out.
  const where = item.kind === 'host' ? '' : host || 'This computer'
  const hidden = item.state === 'done' || item.state === 'checking' || item.kind === 'app' || item.kind === 'host' && sameVersions(item.versions, view.sotto)
  const versions = hidden ? undefined : versionsText(item.versions)
  return { key: item.key, item, title, versions, detail: [where, item.detail].filter(Boolean).join(' · '), state: item.state }
}

function restartStep(view: UpdateAllView, context: UpdateAllContext): UpdateAllStep {
  const base = { key: RESTART_KEY, title: 'Restart Sotto' }
  if (view.phase !== 'restart' || !view.ready) return { ...base, detail: 'Last. Sotto asks before it restarts.', state: 'last' }
  const { working, resumes } = context
  const threads = working === 0 ? '' : resumes
    ? ` ${plural(working, 'working thread')} here ${working === 1 ? 'stops and resumes' : 'stop and resume'} after.`
    : ` ${plural(working, 'working thread')} here ${working === 1 ? 'stops' : 'stop'}; drafts and history stay.`
  return { ...base, detail: `Installs ${view.ready}.${threads}`, state: 'ready' }
}

/**
 * The card's list, in the order one press runs it: Sotto's download, this computer's clients, each host's clients and
 * then the host, and last the restart, which is there whenever Sotto has a download.
 */
export function updateAllSteps(view: UpdateAllView, context: UpdateAllContext): UpdateAllStep[] {
  const steps = view.items.map(item => itemStep(item, view))
  if (restartsLast(view.items)) steps.push(restartStep(view, context))
  return steps
}
