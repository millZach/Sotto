import { PROVIDER_LABELS, type ClientUpdateRun, type ProviderClientUpdate, type ProviderId } from '../../../../shared/agents'

/**
 * A host's client updates as its provider tiles and its chip show them (#480, variant D of
 * `prototype/host-client-updates`): what is behind, what is waiting and running in the host's one-at-a-time line, what
 * did not update and why, and what the user must run by hand. Every word the tiles and the popover say is here.
 */

/** Where one client stands, as the tile and the popover show it. `current` shows nothing: nothing announces up to date. */
export type ClientUpdatePhase = 'current' | 'behind' | 'by-hand' | 'queued' | 'updating' | 'updated' | 'failed'

/**
 * The phase of one reading. An update the user has put away with Done reads as current, and one that left the client
 * still behind what is published reads as behind: "is now 2.1.287" must not hide 2.1.288.
 */
export function clientUpdatePhase(update: ProviderClientUpdate, acknowledged = false): ClientUpdatePhase {
  switch (update.state) {
    case 'queued': return 'queued'
    case 'updating': return 'updating'
    case 'failed': case 'unchanged': return 'failed'
    case 'updated': if (!update.behind) return acknowledged ? 'current' : 'updated'
    // falls through
    default: return !update.behind ? 'current' : update.canInstall ? 'behind' : 'by-hand'
  }
}

/** The version a press updates to, or what the user reads in its place when the registry was not reached. */
export const targetVersion = (update: ProviderClientUpdate): string => update.published ?? 'the published version'
const installerName = (update: ProviderClientUpdate): string =>
  update.channel === 'mise' ? 'mise' : update.channel === 'npm' ? 'npm' : `${PROVIDER_LABELS[update.id]}'s updater`

/** "Codex, Claude Code and Grok Build". */
export function namesOf(ids: readonly ProviderId[]): string {
  const names = ids.map(id => PROVIDER_LABELS[id])
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** The one line a failed tile keeps, and the popover's row: what happened, and what is still installed. */
export function failedShort(update: ProviderClientUpdate, host: string): string {
  if (update.state === 'unchanged') return `The update ran, but ${host} still starts ${update.installed}.`
  if (update.failure === 'install-step') return `The install step did not finish, so ${host} still starts ${update.installed}.`
  if (update.failure === 'download') return `The download dropped partway. ${update.installed} is still installed.`
  return `${installerName(update) === 'mise' ? 'mise' : 'The installer'} stopped with an error. ${update.installed} is still installed.`
}

/** What happened in full, under a failed tile's Details. */
export function failedLong(update: ProviderClientUpdate, host: string): string {
  const name = PROVIDER_LABELS[update.id], to = targetVersion(update), by = installerName(update)
  if (update.state === 'unchanged') return update.error ?? `The update finished, but ${name} on ${host} still reports ${update.installed}. Nothing was lost, and your threads kept working.`
  if (update.failure === 'install-step') return `mise installed ${to}, but ${name}'s install step did not finish, so ${host} still starts ${update.installed}. Nothing was lost, and your threads kept working.`
  if (update.failure === 'download') return `${by === 'mise' ? 'mise' : 'The installer'} could not download ${name} ${to} on ${host}. The connection dropped partway. Nothing was changed: ${update.installed} is still installed, and your threads kept working.`
  return `${by === 'mise' ? 'mise' : 'The installer'} did not finish updating ${name} on ${host}. Nothing was changed: ${update.installed} is still installed, and your threads kept working.`
}

/** The heading over what the installer printed, under Details. */
export const printedHeading = (update: ProviderClientUpdate): string => `What ${installerName(update)} printed`

/** Why Sotto will not run this update itself, for a client it names but will not drive. */
export function byHandReason(update: ProviderClientUpdate, host: string): string {
  if (update.channel === 'mise') return `Sotto could not find mise on ${host}, so it will not run the update itself.`
  if (update.channel === 'devin-app') return 'Devin updates with the Devin app.'
  const name = PROVIDER_LABELS[update.id]
  if (update.byHand?.length || update.command) return `Sotto did not install ${name} this way, so it will not replace it.`
  return `Sotto does not know how ${name} was installed, so it will not replace it.`
}
/** The lines to run by hand, or none when Sotto cannot name them. */
export const byHandLines = (update: ProviderClientUpdate): readonly string[] => update.byHand ?? (update.command ? [update.command] : [])

/** The line under a tile's version while it is behind, waiting, running or done. */
export function tileLine(update: ProviderClientUpdate, phase: ClientUpdatePhase, waitingFor: ProviderId | undefined): string {
  const to = targetVersion(update)
  switch (phase) {
    case 'behind': case 'by-hand': return `${to} available`
    case 'queued': return waitingFor ? `Updates to ${to} after ${PROVIDER_LABELS[waitingFor]}` : `Waiting to update to ${to}`
    case 'updating': return `Updating to ${to}${update.steps && update.steps > 1 ? ` · step ${update.step ?? 1} of ${update.steps}` : ''}…`
    case 'failed': return `Did not update to ${to}`
    default: return ''
  }
}

/** The popover row's state beside the versions. */
export function rowState(update: ProviderClientUpdate, phase: ClientUpdatePhase): string {
  switch (phase) {
    case 'queued': return 'Waiting'
    case 'updating': return update.steps && update.steps > 1 ? `Step ${update.step ?? 1} of ${update.steps}` : 'Updating'
    case 'updated': return 'Updated'
    case 'failed': return 'Did not update'
    case 'by-hand': return 'By hand'
    default: return ''
  }
}

export interface HostClientUpdatesView {
  /** The clients with something to say, in tile order. */
  readonly shown: readonly ProviderClientUpdate[]
  readonly phases: ReadonlyMap<ProviderId, ClientUpdatePhase>
  readonly running: ProviderClientUpdate | undefined
  /** Behind, and Sotto can update it: what Update all starts with. */
  readonly behind: readonly ProviderId[]
  readonly failed: readonly ProviderId[]
  readonly updated: readonly ProviderId[]
  readonly byHand: readonly ProviderId[]
  readonly queued: readonly ProviderId[]
  /** Update all's clients: every one that is behind and every one that did not update. Empty hides Update all. */
  readonly updateAll: readonly ProviderId[]
}
/** A host's readings, as the chip and the popover take them. `acknowledged` holds the updates put away with Done. */
export function hostClientUpdatesView(updates: readonly ProviderClientUpdate[], order: readonly ProviderId[],
  acknowledged: (update: ProviderClientUpdate) => boolean): HostClientUpdatesView {
  const phases = new Map<ProviderId, ClientUpdatePhase>()
  for (const update of updates) phases.set(update.id, clientUpdatePhase(update, acknowledged(update)))
  const shown = order.flatMap(id => updates.filter(update => update.id === id && phases.get(id) !== 'current'))
  const having = (phase: ClientUpdatePhase): ProviderId[] => shown.filter(update => phases.get(update.id) === phase).map(update => update.id)
  const behind = having('behind'), failed = having('failed')
  return {
    shown, phases, running: shown.find(update => phases.get(update.id) === 'updating'),
    behind, failed, updated: having('updated'), byHand: having('by-hand'), queued: having('queued'),
    updateAll: behind.length ? [...behind, ...failed] : [],
  }
}

/** What the chip beside Show providers says, or undefined when it is not there. */
export function chipText(view: HostClientUpdatesView, run: ClientUpdateRun | undefined): { readonly text: string; readonly tone: 'update' | 'error' | 'done' } | undefined {
  const waiting = view.behind.length + view.byHand.length
  if (view.running || view.queued.length) {
    const running = view.running ?? view.shown.find(update => view.queued.includes(update.id))!
    return { tone: 'update', text: run && run.total > 1 ? `Updating ${Math.min(run.done + 1, run.total)} of ${run.total}` : `Updating ${PROVIDER_LABELS[running.id]}` }
  }
  const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
  if (view.failed.length) return { tone: 'error', text: waiting ? `${plural(waiting + view.failed.length, 'update')} · ${view.failed.length} failed` : `${view.failed.length} did not update` }
  if (waiting) return { tone: 'update', text: plural(waiting, 'update') }
  if (view.updated.length) return { tone: 'done', text: `${view.updated.length} updated` }
  return undefined
}

/** The popover's first line, which a screen reader hears as it changes. */
export function popoverStatus(view: HostClientUpdatesView, run: ClientUpdateRun | undefined, host: string): string {
  if (view.running) return `Updating ${PROVIDER_LABELS[view.running.id]}${run && run.total > 1 ? `, ${Math.min(run.done + 1, run.total)} of ${run.total}` : ''}…`
  if (view.queued.length) return `Waiting to update ${namesOf(view.queued)}.`
  const behind = view.behind.length + view.byHand.length + view.failed.length
  if (view.behind.length) return `${behind} client${behind === 1 ? ' is' : 's are'} behind on ${host}.`
  if (view.failed.length && view.updated.length) return `Updated ${namesOf(view.updated)} on ${host}. ${namesOf(view.failed)} did not update.`
  if (view.failed.length) return `${namesOf(view.failed)} did not update.`
  if (view.byHand.length && !view.updated.length) return `${namesOf(view.byHand)} ${view.byHand.length === 1 ? 'is' : 'are'} behind on ${host}.`
  return `Updated ${view.updated.length} client${view.updated.length === 1 ? '' : 's'} on ${host}.`
}
