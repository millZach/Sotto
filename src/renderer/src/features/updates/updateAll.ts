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
 * host's working threads to finish; `by-hand` when Sotto cannot do it and shows how.
 */
export type UpdateAllItemState = 'offered' | 'running' | 'waiting' | 'done' | 'failed' | 'by-hand'
export interface UpdateAllItem {
  readonly key: string
  readonly machine: UpdateAllMachine
  readonly kind: 'app' | 'client' | 'host'
  readonly name: string
  /** "installed → published", or what is installed once it is done. */
  readonly versions: string
  readonly state: UpdateAllItemState
  readonly detail: string
  /** How far Sotto's download has come, while it downloads. */
  readonly percent?: number | undefined
  /** What to run by hand, for the user to copy. */
  readonly commands?: string | undefined
  readonly provider?: ProviderId | undefined
  /** A host's working threads, while its update waits for them. */
  readonly working?: number | undefined
  /** A host's update that Cancel update can still stop: waiting for its threads, or downloading and checking (ADR-0040). */
  readonly cancellable?: boolean | undefined
}
export interface UpdateAllSources {
  readonly app: UpdateStatus | null
  /** This computer's own client updates. */
  readonly local: readonly ProviderClientUpdate[]
  readonly hosts: readonly HostStatus[]
  readonly localHostId?: string | undefined
  readonly clientHosts: readonly AgentClientHost[]
  readonly hostUpdates: readonly HostUpdateState[]
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
}
export type UpdateAllPhase = 'hidden' | 'offer' | 'running' | 'restart' | 'done'
export interface UpdateAllView {
  readonly phase: UpdateAllPhase
  readonly items: readonly UpdateAllItem[]
  /** What the press counts: the items it touched, and how many of those have finished. */
  readonly total: number
  readonly finished: number
  /** The version Sotto installs when it restarts. */
  readonly ready?: string | undefined
  /** What a Not now puts away: everything offered as it is now. */
  readonly fingerprint: string
}

export const clientKey = (machine: 'local' | string, provider: ProviderId): string => `client:${machine}:${provider}`
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
    const versions = `${app.currentVersion} → ${phase.version}`
    if (refused || touched && phase.problem !== null && phase.failedStep === 'download') {
      return { ...base, versions, state: 'failed', detail: refused ?? phase.problem ?? 'The download did not finish. Nothing was installed.' }
    }
    if (touched) return { ...base, versions, state: 'running', detail: 'Starting the download…' }
    return { ...base, versions, state: 'offered', detail: 'Downloads now, and installs when Sotto restarts.' }
  }
  if (phase.phase === 'downloading') {
    return { ...base, versions: `${app.currentVersion} → ${phase.version}`, state: 'running', detail: `Downloading · ${phase.percent}%`, percent: phase.percent }
  }
  if (phase.phase === 'downloaded') {
    return { ...base, versions: `${app.currentVersion} → ${phase.version}`, state: 'done', detail: 'Downloaded. It installs when Sotto restarts.' }
  }
  if (phase.phase === 'failed' && touched) return { ...base, versions: app.currentVersion, state: 'failed', detail: refused ?? phase.problem ?? 'Sotto could not reach the update. Nothing was installed.' }
  return undefined
}

function clientItem(machine: UpdateAllMachine, update: ProviderClientUpdate, pass: UpdateAllPass | null): UpdateAllItem | undefined {
  const key = clientKey(machine.kind === 'host' ? machine.id : 'local', update.id)
  const name = PROVIDER_LABELS[update.id]
  const touched = pass?.touched.has(key) === true
  const behindVersions = update.published && update.published !== update.installed ? `${update.installed} → ${update.published}` : update.installed
  const base = { key, machine, kind: 'client' as const, name, provider: update.id, versions: behindVersions }
  const refused = pass?.refused.get(key)
  if (refused) return { ...base, state: 'failed', detail: refused }
  // A result already there when the press began is not the press's own: the line has yet to take the client.
  const ranSincePress = touched && update.ranAt !== pass?.ranBefore.get(key)
  if (update.state === 'queued') return { ...base, state: 'running', detail: 'Waiting for the update before it.' }
  if (update.state === 'updating') {
    const step = update.steps && update.steps > 1 ? `, step ${update.step ?? 1} of ${update.steps}` : ''
    return { ...base, state: 'running', detail: `Updating${step}…` }
  }
  if (ranSincePress && update.state === 'updated') return { ...base, versions: update.installed, state: 'done', detail: `Now ${update.installed}.` }
  if (ranSincePress && update.state === 'failed') {
    // What the installer printed stays where Sotto keeps it for each machine; the card says what happened and what next.
    const where = machine.kind === 'host' ? `Settings → Hosts shows what the installer said on ${machine.name}.` : 'Settings → Providers shows what the installer said.'
    return { ...base, state: 'failed', detail: `${name} did not update. Nothing was changed. ${where}`, commands: update.byHand?.length ? update.byHand.join('\n') : undefined }
  }
  if (ranSincePress && update.state === 'unchanged') {
    return { ...base, state: 'failed', detail: update.error ?? `The installer finished, but ${name} still reports ${update.installed}.` }
  }
  // The installer finished with the provider disconnected, so nothing could read the version yet (ADR-0042).
  if (ranSincePress && update.state === 'idle') return { ...base, state: 'done', detail: `The installer finished. Connect ${name} to see the version it runs now.` }
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
  const touched = pass?.touched.has(key) === true
  const base = { key, machine: { kind: 'host', id: update.id, name } as const, kind: 'host' as const, name: 'Sotto host', versions: `${update.from} → ${update.to}`, working }
  // A host's own note before any press, such as one still running thread management, explains rather than fails.
  const refused = pass?.refused.get(key) ?? (touched || update.phase === 'failed' ? update.error : undefined)
  const threads = plural(working, 'thread')
  if (update.phase === 'done') return touched ? { ...base, versions: update.to, state: 'done', detail: `${name} runs Sotto host ${update.to}.` } : undefined
  if (update.phase === 'updating') {
    const step = update.step ?? 'download'
    return { ...base, state: 'running', detail: `Step ${HOST_UPDATE_STEPS.indexOf(step) + 1} of 4 · ${stepTitle(update, step)}`, cancellable: step === 'download' || step === 'check' }
  }
  if (update.phase === 'waiting' || update.phase === 'confirm' && !touched) {
    return { ...base, state: 'waiting', detail: `Updates once its ${threads} ${working === 1 ? 'finishes' : 'finish'}.`, cancellable: true }
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

/** Everything out of date, in the card's order: Sotto, this computer's clients, then each host's update and clients. */
export function updateAllItems(sources: UpdateAllSources, pass: UpdateAllPass | null): UpdateAllItem[] {
  const items: UpdateAllItem[] = []
  const app = appItem(sources.app, pass)
  if (app) items.push(app)
  for (const update of sources.local) {
    const item = clientItem({ kind: 'local' }, update, pass)
    if (item) items.push(item)
  }
  // Each host's own update first, then its clients: hosts that need an update in their order, then the rest as saved.
  const updated = new Set(sources.hostUpdates.map(update => update.id))
  const hosts = [...sources.hostUpdates.map(update => update.id), ...sources.hosts.map(host => host.id).filter(id => !updated.has(id))]
  for (const id of hosts) {
    const update = sources.hostUpdates.find(item => item.id === id)
    const item = update && hostItem(update, pass)
    if (item) items.push(item)
    const host = sources.hosts.find(item => item.id === id)
    if (host) items.push(...hostClients(host, sources, pass))
  }
  return items
}

/** A connected host's client updates, which reach the window on its `clientHosts` entry (#480). */
function hostClients(host: HostStatus, sources: UpdateAllSources, pass: UpdateAllPass | null): UpdateAllItem[] {
  const client = host.hostId && host.hostId !== sources.localHostId ? sources.clientHosts.find(item => item.hostId === host.hostId) : undefined
  if (!client?.connected) return []
  const machine = { kind: 'host', id: host.id, name: host.name } as const
  return (client.clientUpdates ?? []).flatMap(update => clientItem(machine, update, pass) ?? [])
}

export function updateAllView(sources: UpdateAllSources, pass: UpdateAllPass | null): UpdateAllView {
  const items = updateAllItems(sources, pass)
  const touched = pass ? items.filter(item => pass.touched.has(item.key)) : []
  const finished = touched.filter(item => item.state === 'done' || item.state === 'failed' || item.state === 'waiting').length
  const app = items.find(item => item.kind === 'app')
  const ready = app?.state === 'done' && sources.app?.phase.phase === 'downloaded' ? sources.app.phase.version : undefined
  // What is still offered comes before the restart, so Sotto downloaded from the update control leaves the rest a press.
  const phase: UpdateAllPhase = items.some(item => item.state === 'running') || (pass?.after.size ?? 0) > 0 ? 'running'
    : items.some(item => item.state === 'offered') ? 'offer'
      : ready ? 'restart'
        : pass && touched.length ? 'done'
          : items.length ? 'offer' : 'hidden'
  const fingerprint = items.filter(item => item.state === 'offered' || item.state === 'by-hand' || item.state === 'failed')
    .map(item => `${item.key}@${item.versions}`).sort().join('|')
  return { phase, items, total: touched.length, finished, ready, fingerprint }
}

/** What the card and its pill say about where things stand. */
export interface UpdateAllWords {
  readonly title: string
  readonly sub: string
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

export function updateAllWords(view: UpdateAllView, context: UpdateAllContext): UpdateAllWords {
  const offered = view.items.filter(item => item.state === 'offered')
  const failed = view.items.filter(item => item.state === 'failed')
  const waiting = view.items.filter(item => item.state === 'waiting')
  const didNot = failed.length ? `${listed(failed.map(machineName))} did not update.` : ''
  const waitingNames = listed(waiting.map(item => item.machine.kind === 'host' ? item.machine.name : item.name))
  const one = waiting.length === 1
  // The wait lasts while Sotto is open (ADR-0077 decision 4): a restart first leaves the host for the next press.
  const waits = !waiting.length ? '' : view.phase === 'restart'
    ? `${waitingNames} ${one ? 'is' : 'are'} waiting for ${one ? 'its' : 'their'} threads. If Sotto restarts first, Update all offers ${one ? 'it' : 'them'} again.`
    : `${waitingNames} ${one ? 'updates' : 'update'} once ${one ? 'its' : 'their'} threads finish.`
  switch (view.phase) {
    case 'running': return { title: 'Updating', sub: `${view.finished} of ${view.total} · threads keep working`, notes: [], pill: `Updating · ${view.finished} of ${view.total}` }
    case 'restart': {
      const threads = context.working === 0 ? [] : [context.resumes
        ? `${plural(context.working, 'thread')} on this computer ${context.working === 1 ? 'is' : 'are'} working. ${context.working === 1 ? 'It stops' : 'They stop'} for the restart and ${context.working === 1 ? 'carries' : 'carry'} on after it.`
        : `${plural(context.working, 'thread')} on this computer ${context.working === 1 ? 'is' : 'are'} working. The restart stops ${context.working === 1 ? 'it' : 'them'}; drafts and history stay.`]
      return { title: 'Restart to finish', sub: [didNot, waits].filter(Boolean).join(' ') || 'The other updates are done.',
        notes: [`Sotto ${view.ready} is downloaded. Restarting installs it.`, ...threads], pill: 'Restart to finish' }
    }
    case 'done': return { title: failed.length ? 'Not everything updated' : 'Updated', sub: [didNot, waits].filter(Boolean).join(' ') || 'Nothing needs a restart.', notes: [],
      pill: failed.length ? `${plural(failed.length, 'update')} did not finish` : 'Updated' }
    default: {
      const app = offered.some(item => item.kind === 'app')
      const clients = offered.filter(item => item.kind === 'client').length
      const hosts = [...new Set(offered.filter(item => item.kind === 'host').map(item => item.machine.kind === 'host' ? item.machine.name : ''))]
      const parts = [...app ? ['Sotto'] : [], ...clients ? [plural(clients, 'client')] : [], ...hosts]
      const restarts = offered.filter(item => item.kind === 'host' && !item.working).map(item => item.machine.kind === 'host' ? item.machine.name : '')
      return {
        title: 'Updates',
        sub: parts.length ? listed(parts) : 'Sotto cannot install these itself.',
        notes: offered.length ? [
          ...clients ? ['Threads keep working while clients update.'] : [],
          ...restarts.length ? [`${listed(restarts.map(name => `${name}’s host`))} ${restarts.length === 1 ? 'restarts' : 'restart'}, so ${restarts.length === 1 ? 'its' : 'their'} threads are unavailable for a few seconds.`] : [],
          ...app ? ['Sotto restarts last, when you say.'] : view.ready ? [`Sotto ${view.ready} is downloaded. It restarts last, when you say.`] : [],
        ] : [],
        pill: offered.length ? 'Update all' : 'Updates',
      }
    }
  }
}
