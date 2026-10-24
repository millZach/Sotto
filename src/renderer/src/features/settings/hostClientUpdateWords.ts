import { plural, t } from '@lingui/core/macro'

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
export const targetVersion = (update: ProviderClientUpdate): string =>
  update.published ?? t({ message: 'the published version', comment: 'Stands in for a version number, as in "Updating to {to}…"' })
/** Whether mise runs the update, which the sentences about a failure name. */
const byMise = (update: ProviderClientUpdate): boolean => update.channel === 'mise'

/** "Codex, Claude Code and Grok Build". */
export function namesOf(ids: readonly ProviderId[]): string {
  const names = ids.map(id => PROVIDER_LABELS[id])
  if (names.length <= 1) return names.join('')
  const list = names.slice(0, -1).join(', '), last = names.at(-1)
  return t({ message: `${list} and ${last}`, comment: 'Names of coding agent clients: {list} is all but the last, separated by commas, as in "Codex, Claude Code and Grok Build".' })
}

/** The one line a failed tile keeps, and the popover's row: what happened, and what is still installed. */
export function failedShort(update: ProviderClientUpdate, host: string): string {
  const installed = update.installed
  if (update.state === 'unchanged') return t`The update ran, but ${host} still starts ${installed}.`
  if (update.failure === 'install-step') return t`The install step did not finish, so ${host} still starts ${installed}.`
  if (update.failure === 'download') return t`The download dropped partway. ${installed} is still installed.`
  return byMise(update) ? t`mise stopped with an error. ${installed} is still installed.` : t`The installer stopped with an error. ${installed} is still installed.`
}

/** What happened in full, under a failed tile's Details. */
export function failedLong(update: ProviderClientUpdate, host: string): string {
  const name = PROVIDER_LABELS[update.id], to = targetVersion(update), installed = update.installed
  // The host's own sentence, when it sent one.
  if (update.state === 'unchanged') return update.error ?? t`The update finished, but ${name} on ${host} still reports ${installed}. Nothing was lost, and your threads kept working.`
  if (update.failure === 'install-step') return t`mise installed ${to}, but ${name}'s install step did not finish, so ${host} still starts ${installed}. Nothing was lost, and your threads kept working.`
  if (update.failure === 'download') return byMise(update)
    ? t`mise could not download ${name} ${to} on ${host}. The connection dropped partway. Nothing was changed: ${installed} is still installed, and your threads kept working.`
    : t`The installer could not download ${name} ${to} on ${host}. The connection dropped partway. Nothing was changed: ${installed} is still installed, and your threads kept working.`
  return byMise(update)
    ? t`mise did not finish updating ${name} on ${host}. Nothing was changed: ${installed} is still installed, and your threads kept working.`
    : t`The installer did not finish updating ${name} on ${host}. Nothing was changed: ${installed} is still installed, and your threads kept working.`
}

/** The heading over what the installer printed, under Details. */
export function printedHeading(update: ProviderClientUpdate): string {
  if (update.channel === 'mise' || update.channel === 'npm') {
    const tool = update.channel
    return t({ message: `What ${tool} printed`, comment: '{tool} is an installer program, mise or npm.' })
  }
  const name = PROVIDER_LABELS[update.id]
  return t`What ${name}'s updater printed`
}

/** Why Sotto will not run this update itself, for a client it names but will not drive. */
export function byHandReason(update: ProviderClientUpdate, host: string): string {
  if (update.channel === 'mise') return t`Sotto could not find mise on ${host}, so it will not run the update itself.`
  if (update.channel === 'devin-app') return t`Devin updates with the Devin app.`
  const name = PROVIDER_LABELS[update.id]
  if (update.byHand?.length || update.command) return t`Sotto did not install ${name} this way, so it will not replace it.`
  return t`Sotto does not know how ${name} was installed, so it will not replace it.`
}
/** The lines to run by hand, or none when Sotto cannot name them. */
export const byHandLines = (update: ProviderClientUpdate): readonly string[] => update.byHand ?? (update.command ? [update.command] : [])

/** The line under a tile's version while it is behind, waiting, running or done. */
export function tileLine(update: ProviderClientUpdate, phase: ClientUpdatePhase, waitingFor: ProviderId | undefined): string {
  const to = targetVersion(update)
  switch (phase) {
    case 'behind': case 'by-hand': return t({ message: `${to} available`, comment: '{to} is a version number a client can update to.' })
    case 'queued': {
      if (!waitingFor) return t`Waiting to update to ${to}`
      const before = PROVIDER_LABELS[waitingFor]
      return t`Updates to ${to} after ${before}`
    }
    case 'updating': {
      const steps = update.steps ?? 0, step = update.step ?? 1
      return steps > 1 ? t`Updating to ${to} · step ${step} of ${steps}…` : t`Updating to ${to}…`
    }
    case 'failed': return t`Did not update to ${to}`
    default: return ''
  }
}

/** The popover row's state beside the versions. */
export function rowState(update: ProviderClientUpdate, phase: ClientUpdatePhase): string {
  const steps = update.steps ?? 0, step = update.step ?? 1
  switch (phase) {
    case 'queued': return t({ message: 'Waiting', comment: 'Where one client update stands: waiting its turn in the line of updates.' })
    case 'updating': return steps > 1 ? t`Step ${step} of ${steps}` : t({ message: 'Updating', comment: 'Where one client update stands: running now.' })
    case 'updated': return t({ message: 'Updated', comment: 'Where one client update stands: finished.' })
    case 'failed': return t({ message: 'Did not update', comment: 'Where one client update stands: it failed.' })
    case 'by-hand': return t({ message: 'By hand', comment: 'Where one client update stands: the user has to run it themselves.' })
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
    if (run && run.total > 1) {
      const current = Math.min(run.done + 1, run.total), total = run.total
      return { tone: 'update', text: t`Updating ${current} of ${total}` }
    }
    const name = PROVIDER_LABELS[running.id]
    return { tone: 'update', text: t`Updating ${name}` }
  }
  const failed = view.failed.length, updated = view.updated.length
  if (failed) {
    const updates = waiting + failed
    return { tone: 'error', text: waiting
      ? t`${plural(updates, { one: '# update', other: '# updates' })} · ${plural(failed, { one: '# failed', other: '# failed' })}`
      : plural(failed, { one: '# did not update', other: '# did not update' }) }
  }
  if (waiting) return { tone: 'update', text: plural(waiting, { one: '# update', other: '# updates' }) }
  if (updated) return { tone: 'done', text: plural(updated, { one: '# updated', other: '# updated' }) }
  return undefined
}

/** The popover's first line, which a screen reader hears as it changes. */
export function popoverStatus(view: HostClientUpdatesView, run: ClientUpdateRun | undefined, host: string): string {
  if (view.running) {
    const name = PROVIDER_LABELS[view.running.id]
    if (!run || run.total <= 1) return t`Updating ${name}…`
    const current = Math.min(run.done + 1, run.total), total = run.total
    return t`Updating ${name}, ${current} of ${total}…`
  }
  if (view.queued.length) {
    const names = namesOf(view.queued)
    return t`Waiting to update ${names}.`
  }
  const behind = view.behind.length + view.byHand.length + view.failed.length
  if (view.behind.length) return plural(behind, { one: `# client is behind on ${host}.`, other: `# clients are behind on ${host}.` })
  const updatedNames = namesOf(view.updated), failedNames = namesOf(view.failed)
  if (view.failed.length && view.updated.length) return t`Updated ${updatedNames} on ${host}. ${failedNames} did not update.`
  if (view.failed.length) return t`${failedNames} did not update.`
  const byHand = view.byHand.length, byHandNames = namesOf(view.byHand)
  if (byHand && !view.updated.length) return plural(byHand, { one: `${byHandNames} is behind on ${host}.`, other: `${byHandNames} are behind on ${host}.` })
  const updated = view.updated.length
  return plural(updated, { one: `Updated # client on ${host}.`, other: `Updated # clients on ${host}.` })
}
