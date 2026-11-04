import { PROVIDER_LABELS, type AgentHostSnapshot, type AgentState, type ProviderClientUpdate, type ProviderId } from '../../shared/agents'
import { clientVersionOf, compareClientVersions, isComparableVersion } from './clientVersions'
import type { AgentHost } from './host'
import { compareMuseVersions } from './museClientInstall'
import { CLIENT_CHECK_INTERVAL_MS, locateClient as locateClientOnDisk, type ProviderClients } from './providerClients'

/** Where a client's last update left it, carried over a new reading: its state and what that run said. */
function outcomeOf(before: ProviderClientUpdate): Partial<ProviderClientUpdate> {
  const kept: Partial<ProviderClientUpdate> = { state: before.state }
  for (const key of ['error', 'ranAt', 'step', 'failure', 'printed'] as const) if (before[key] !== undefined) Object.assign(kept, { [key]: before[key] })
  return kept
}
/**
 * Whether a client's last update still describes a new reading of it: the same version installed, measured against the
 * same release. A newer release makes the client behind again, and "is now 2.1.287" would hide 2.1.288. A registry that
 * could not be read moves nothing.
 */
const outcomeHolds = (before: ProviderClientUpdate, reading: ProviderClientUpdate): boolean =>
  before.installed === reading.installed && (reading.published === undefined || reading.published === before.published)
/**
 * Whether `release` is newer than the one the user put away with Not now, so the card comes back. A client that was not
 * behind then has no release put away, and any release it is behind now is new.
 */
function newerThanDismissed(provider: ProviderId, release: string, dismissed: string | undefined): boolean {
  if (dismissed === undefined) return true
  if (provider === 'muse') return (compareMuseVersions(dismissed, release) ?? (release === dismissed ? 0 : -1)) < 0
  return isComparableVersion(release) && isComparableVersion(dismissed) ? compareClientVersions(release, dismissed) > 0 : release !== dismissed
}
/** Whether two lists of client readings say the same thing, whenever each was checked. */
function sameClientReadings(left: readonly ProviderClientUpdate[] | undefined, right: readonly ProviderClientUpdate[] | undefined): boolean {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false
  const said = (reading: ProviderClientUpdate): string =>
    JSON.stringify(Object.entries(reading).filter(([key]) => key !== 'checkedAt').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  return left.every((reading, index) => said(reading) === said(right[index]!))
}
/** A new reading with a client's last update on it. A registry not read this time leaves the release that update was measured against. */
const withOutcome = (reading: ProviderClientUpdate, before: ProviderClientUpdate): ProviderClientUpdate => ({
  ...reading, ...reading.published === undefined && before.published !== undefined ? { published: before.published } : {}, ...outcomeOf(before),
})

/** What client updates need from the coordinator, which owns the state they read and write. */
export interface ClientUpdatesContext {
  state(): Pick<AgentState, 'clientUpdates' | 'clientUpdateRun' | 'clientUpdatesDismissedAt' | 'configuration' | 'host'>
  disposed(): boolean
  publish(): void
  say(text: string): void
  acceptSnapshot(snapshot: AgentHostSnapshot): void
  readonly clients: Pick<ProviderClients, 'check' | 'install'>
  /** Read at each use, as the coordinator reads them. */
  readonly dependencies: { readonly host: Pick<AgentHost, 'clientUpdated' | 'snapshot'>; readonly locateClient?: (provider: ProviderId) => Promise<string | undefined> }
  logHandoffFailure(provider: ProviderId): void
}

/**
 * This machine's provider clients: what each publishes against what it runs, and the update line that replaces them one
 * at a time while threads keep working (ADR-0042, ADR-0077).
 */
export class ClientUpdates {
  private updatingClient: ProviderId | null = null
  /** The client updates waiting behind `updatingClient`, one at a time on this machine (#480). */
  private readonly clientLine: ProviderId[] = []
  /** Whoever waits for a client's update to end: an `update-client` command, which answers when it has run. */
  private readonly clientWaiters = new Map<ProviderId, { resolve: () => void; reject: (error: unknown) => void }[]>()
  private clientLineRunning = false
  /** Where each waiting client stood before it joined the line, so Cancel update puts it back. */
  private readonly clientLineBefore = new Map<ProviderId, ProviderClientUpdate>()
  /** How many checks of the installed clients are waiting on the registry and the disk right now. */
  private clientChecks = 0
  /** How many times the update line has changed each client's record, so a check that ran meanwhile knows its reading is older. */
  private readonly clientLineMoves = new Map<ProviderId, number>()
  /** A check afresh asked for while the update line ran, which runs once the line is empty. */
  private clientCheckOwed = false
  /** The release each behind client was at when the user pressed Not now: only a newer one brings the card back. */
  private dismissedReleases = new Map<ProviderId, string>()
  /** The check every machine runs every five minutes while Sotto is open (ADR-0042). */
  private clientCheckTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly context: ClientUpdatesContext) {}

  private get state(): ReturnType<ClientUpdatesContext['state']> { return this.context.state() }
  private get disposed(): boolean { return this.context.disposed() }

  /** The client being replaced right now, if any. */
  get updating(): ProviderId | null { return this.updatingClient }
  get checksWaiting(): number { return this.clientChecks }
  startChecking(): void {
    this.clientCheckTimer = setInterval(() => { void this.backgroundClientCheck() }, CLIENT_CHECK_INTERVAL_MS)
    this.clientCheckTimer.unref?.()
  }
  stopChecking(): void {
    if (this.clientCheckTimer) clearInterval(this.clientCheckTimer)
    this.clientCheckTimer = null
  }
  letGoOfLine(): void {
    // Updates still waiting in the line never start; whoever waits for one is told rather than left waiting.
    this.clientLine.length = 0
    for (const [provider, waiting] of this.clientWaiters) {
      const said = provider === this.updatingClient ? 'Sotto stopped while the update ran. Check the client\'s version when Sotto is back.' : 'Sotto is stopping. The update did not start.'
      for (const waiter of waiting) waiter.reject(new Error(said))
    }
    this.clientWaiters.clear()
  }
  /** Not now: the card goes until a client is behind a newer release than it is now. */
  dismiss(): void {
    this.state.clientUpdatesDismissedAt = new Date().toISOString()
    this.dismissedReleases = new Map((this.state.clientUpdates ?? []).flatMap(item => item.behind && item.published !== undefined ? [[item.id, item.published] as const] : []))
  }
  /**
   * What every connected client publishes, against what it is running. A provider that is not
   * connected has no known installed version, so nothing is claimed about it. Findings from an
   * update already run are kept, so "is now 2.1.278" survives the next check, until a newer
   * release is published: then the client is behind again and the old finding would hide it.
   *
   * `fresh` is the user's own Check, and a host's `check-client-updates`: it shows the card again and asks the registry
   * afresh. `afresh` alone asks afresh and leaves the card as it was. Neither sets aside a finding that still describes
   * the client, which an Update all press may be reading (ADR-0077); only a newer release or another installed version
   * does.
   */
  async check(fresh = false, afresh = fresh): Promise<void> {
    if (!this.state.configuration.checkClientUpdates) { delete this.state.clientUpdates; return }
    this.clientChecks += 1
    try { await this.readClientUpdates(fresh, afresh) } finally { this.clientChecks -= 1 }
  }
  private async readClientUpdates(fresh: boolean, afresh: boolean): Promise<void> {
    const previous = this.state.clientUpdates ?? []
    const moves = new Map(this.clientLineMoves)
    const readings: ProviderClientUpdate[] = []
    for (const provider of this.state.host.providers ?? []) {
      if (provider.connection !== 'connected') continue
      const installed = clientVersionOf(provider.version)
      if (!installed) continue
      const executable = await this.clientPath(provider.id)
      const before = previous.find(item => item.id === provider.id)
      let reading = await this.context.clients.check(provider.id, installed, executable, process.env, { afresh })
      // A registry that did not answer says nothing new: the release last read for the same install still stands, so a
      // check that failed and one that came back with the same release do not read as a new release.
      if (reading.published === undefined && before?.published !== undefined && before.installed === reading.installed) {
        reading = { ...reading, published: before.published, behind: before.behind, canInstall: before.canInstall }
      }
      // A client in the update line keeps where it stands there, even through a fresh check.
      const lined = this.inClientLine(provider.id)
      readings.push(before && (lined || (before.state !== 'idle' && outcomeHolds(before, reading))) ? withOutcome(reading, before) : reading)
    }
    if (this.disposed) return
    // The update line runs while this check waits on the registry and the disk: whatever it said about a client
    // meanwhile (its step, how it ended) is newer than what the check started from, and wins. How it ended gives way to
    // a newer release the check found, while waiting or running never does. A client the line installed meanwhile was
    // read again after the install, so its record stands whole: this check's reading of it predates the install.
    const latest = this.state.clientUpdates ?? []
    for (const [index, reading] of readings.entries()) {
      const now = latest.find(item => item.id === reading.id)
      if (!now) continue
      const moved = (this.clientLineMoves.get(reading.id) ?? 0) !== (moves.get(reading.id) ?? 0)
      if (moved && now.installed !== reading.installed) { readings[index] = now; continue }
      if (now !== previous.find(item => item.id === reading.id)
        && (now.state === 'queued' || now.state === 'updating' || reading.published === undefined || reading.published === now.published)) readings[index] = withOutcome(reading, now)
    }
    // A client that updated, failed or did not change still has something to say after its provider
    // drops: losing the record here would take the sentence about it off the card with it.
    for (const before of latest) {
      if (before.state !== 'idle' && !readings.some(item => item.id === before.id)) readings.push(before)
    }
    if (readings.length) this.state.clientUpdates = readings
    else delete this.state.clientUpdates
    if (fresh || this.state.clientUpdatesDismissedAt && readings.some(item => item.behind && item.published !== undefined
      && newerThanDismissed(item.id, item.published, this.dismissedReleases.get(item.id)))) {
      delete this.state.clientUpdatesDismissedAt
      this.dismissedReleases.clear()
    }
  }
  /**
   * The check every machine runs every five minutes (ADR-0042). It installs nothing, and the user's setting turning
   * checks off stops it. A tick is let go while an update runs, which reads the new version itself, and while the last
   * check is still waiting on the registry: the next tick asks again.
   */
  private async backgroundClientCheck(): Promise<void> {
    if (this.clientChecks > 0) return
    await this.readClientsAfresh()
  }
  /**
   * Asks the registry afresh what every connected client publishes, keeping what an update already run said, and
   * publishes only when a reading moved. A newer release brings the card back by itself, as it always has. Main calls
   * this when Sotto finds a new version of itself, so the clients' updates are listed beside it (ADR-0077). Asked while
   * the update line runs, it is remembered and runs once, when the line is empty.
   */
  async checkAfresh(): Promise<void> {
    if (this.updatingClient || this.clientLineRunning) { if (!this.disposed) this.clientCheckOwed = true; return }
    await this.readClientsAfresh()
  }
  private async readClientsAfresh(): Promise<void> {
    if (this.disposed || !this.state.configuration.checkClientUpdates || this.updatingClient || this.clientLineRunning) return
    const before = this.state.clientUpdates, dismissed = this.state.clientUpdatesDismissedAt
    try { await this.check(false, true) } catch { return }
    // When it was checked is all that moved most times; the next publish carries that.
    if (!this.disposed && (dismissed !== this.state.clientUpdatesDismissedAt || !sameClientReadings(before, this.state.clientUpdates))) this.context.publish()
  }
  private clientPath(provider: ProviderId): Promise<string | undefined> {
    return (this.context.dependencies.locateClient ?? locateClientOnDisk)(provider)
  }
  /** Changes one client's reading. What the last run said (its step, failure and output) goes unless `patch` says it again. */
  private setClientUpdate(provider: ProviderId, patch: Partial<ProviderClientUpdate>, keepOutcome = true): void {
    // Only the update line changes a record in place.
    this.clientLineMoves.set(provider, (this.clientLineMoves.get(provider) ?? 0) + 1)
    this.state.clientUpdates = (this.state.clientUpdates ?? []).map(item => {
      if (item.id !== provider) return item
      const next = { ...item, ...patch }
      if (!keepOutcome) for (const key of ['error', 'step', 'failure', 'printed'] as const) if (!(key in patch)) delete next[key]
      return next
    })
  }
  private inClientLine(provider: ProviderId): boolean { return this.updatingClient === provider || this.clientLine.includes(provider) }
  /** Why a client cannot join the update line, or undefined when it can. */
  private clientUpdateRefusal(provider: ProviderId): string | undefined {
    const label = PROVIDER_LABELS[provider]
    if (this.inClientLine(provider)) return `${label} is already updating. Wait for it to finish.`
    const record = this.state.clientUpdates?.find(item => item.id === provider)
    if (!record) return `Sotto has not checked ${label} yet. Check again, then update it.`
    if (record.canInstall) return undefined
    return record.channel === 'devin-app' ? 'Devin updates with the Devin app.'
      : !record.behind ? `${label} is already at the published version.`
      : record.channel === 'mise' && record.command ? `Sotto could not find mise, so it did not update ${label}. Run ${record.command} yourself.`
      : record.command ? `Sotto did not install ${label}, so it will not replace it. Run ${record.command} yourself.`
      : `Sotto does not know how ${label} was installed, so it will not replace it.`
  }
  /**
   * Puts clients in this machine's update line, one at a time behind whatever is running, and answers at once. A client
   * that cannot join is left out; when none can, the first reason is the refusal. Each reading says how its update went,
   * and a failure does not stop the ones after it: Update all carries on with the rest (#480).
   */
  queue(providers: readonly ProviderId[]): void {
    const refusals: string[] = []
    let added = 0
    for (const provider of new Set(providers)) {
      const refusal = this.clientUpdateRefusal(provider)
      if (refusal) { refusals.push(refusal); continue }
      this.clientLine.push(provider)
      const record = this.state.clientUpdates?.find(item => item.id === provider)
      if (record) this.clientLineBefore.set(provider, record)
      this.setClientUpdate(provider, { state: 'queued' }, false)
      added += 1
    }
    if (!added) throw new Error(refusals[0] ?? 'Nothing to update.')
    const run = this.state.clientUpdateRun
    this.setClientRun(Math.min(64, (run?.total ?? 0) + added), run?.done ?? 0)
    this.context.publish()
    if (!this.clientLineRunning) { this.clientLineRunning = true; void this.runClientLine() }
  }
  /** Takes clients still waiting out of the update line, as they were before. One already running is left to finish. */
  cancel(providers: readonly ProviderId[]): void {
    let removed = 0
    for (const provider of new Set(providers)) {
      const at = this.clientLine.indexOf(provider)
      if (at < 0) continue
      this.clientLine.splice(at, 1)
      // Back as it was before it joined the line: behind, or with the failure it had, unless a newer release came out meanwhile.
      const before = this.clientLineBefore.get(provider)
      const record = this.state.clientUpdates?.find(item => item.id === provider)
      this.setClientUpdate(provider, before && record && outcomeHolds(before, record) ? outcomeOf(before) : { state: 'idle' }, false)
      this.clientLineBefore.delete(provider)
      const waiting = this.clientWaiters.get(provider) ?? []
      this.clientWaiters.delete(provider)
      for (const waiter of waiting) waiter.reject(new Error(`The ${PROVIDER_LABELS[provider]} update was cancelled before it started. Nothing was changed.`))
      removed += 1
    }
    if (!removed) {
      const running = providers.find(provider => provider === this.updatingClient)
      throw new Error(running ? `${PROVIDER_LABELS[running]} is already updating, so it cannot be cancelled. Your threads keep working.` : 'That update is not waiting any more. Nothing was changed.')
    }
    const run = this.state.clientUpdateRun
    if (run) this.setClientRun(Math.max(run.done + 1, run.total - removed), run.done)
  }
  /** The line's count, and the order its waiting clients will run in, which a waiting tile names. */
  private setClientRun(total: number, done: number): void {
    this.state.clientUpdateRun = { total, done: Math.min(total, done), ...(this.clientLine.length ? { line: [...this.clientLine] } : {}) }
  }
  /** The update line, one client at a time, until it is empty. Each ends by telling whoever waits for it. */
  private async runClientLine(): Promise<void> {
    while (!this.disposed) {
      const provider = this.clientLine.shift()
      if (!provider) break
      this.clientLineBefore.delete(provider)
      const started = this.state.clientUpdateRun
      if (started) this.setClientRun(started.total, started.done)
      let failure: unknown
      try { await this.updateOneClient(provider) } catch (error) { failure = error }
      const run = this.state.clientUpdateRun
      if (run) this.setClientRun(run.total, run.done + 1)
      const waiting = this.clientWaiters.get(provider) ?? []
      this.clientWaiters.delete(provider)
      for (const waiter of waiting) { if (failure === undefined) waiter.resolve(); else waiter.reject(failure) }
      if (!this.disposed) this.context.publish()
    }
    // Cleared in the same turn as the last look at the line, so a client queued from now on starts a new run.
    this.clientLineRunning = false
    delete this.state.clientUpdateRun
    if (!this.disposed) this.context.publish()
    // A check afresh asked for while the line ran asks now, once.
    if (this.clientCheckOwed && !this.disposed) { this.clientCheckOwed = false; void this.readClientsAfresh().catch(() => undefined) }
  }
  /** Update one client and wait for it, in the same line as every other update on this machine. */
  async update(provider: ProviderId): Promise<void> {
    const done = new Promise<void>((resolve, reject) => { this.clientWaiters.set(provider, [...this.clientWaiters.get(provider) ?? [], { resolve, reject }]) })
    try { this.queue([provider]) } catch (error) {
      const waiting = this.clientWaiters.get(provider)?.slice(0, -1) ?? []
      if (waiting.length) this.clientWaiters.set(provider, waiting); else this.clientWaiters.delete(provider)
      void done.catch(() => undefined)
      throw error
    }
    await done
  }
  /**
   * Replace one client while everything keeps running, the way T3 Code does (ADR-0042). The installer puts the
   * new client beside the one in use: Windows lets a running executable's folder be renamed, and every channel
   * Sotto drives does that or replaces the file for itself. Nothing disconnects and no turn is stopped. After a
   * good install each host is told, and moves each thread to the new client as it goes idle; a failed install
   * changes nothing, so there is nothing to put back.
   */
  private async updateOneClient(provider: ProviderId): Promise<void> {
    const label = PROVIDER_LABELS[provider]
    const record = this.state.clientUpdates?.find(item => item.id === provider)
    if (!record) throw new Error(`Sotto has not checked ${label} yet. Check again, then update it.`)
    this.updatingClient = provider
    this.setClientUpdate(provider, { state: 'updating', ...(record.steps && record.steps > 1 ? { step: 1 } : {}) }, false)
    this.context.publish()
    try {
      const result = await this.context.clients.install(provider, await this.clientPath(provider), process.env, step => {
        if (step > 1 && !this.disposed) { this.setClientUpdate(provider, { step }); this.context.publish() }
      }, record.behind ? record.published : undefined)
      if (!result.ok) {
        this.setClientUpdate(provider, { state: 'failed', ranAt: new Date().toISOString(), ...(result.detail ? { error: result.detail } : {}),
          ...(result.step && record.steps && record.steps > 1 ? { step: result.step } : {}), ...(result.failure ? { failure: result.failure } : {}),
          ...(result.printed ? { printed: result.printed } : {}) }, false)
        throw new Error(result.failure === 'install-step'
          ? `mise installed ${label}${record.published ? ` ${record.published}` : ''}, but its install step did not finish${result.detail ? ` (${result.detail})` : ''}. Sotto still starts ${record.installed}, and your threads kept working.`
          : result.failure === 'not-listed'
            ? `mise does not list ${label} ${record.published ?? 'the published version'} yet, so Sotto could not install it. ${record.installed} is still installed, and your threads kept working. Try again later.`
          : `${label} did not update${result.detail ? `. ${result.detail}` : '.'} Your installed version is unchanged, and your threads kept working.`)
      }
      // Each host finds the new client and reads its version. One that cannot says why, stays on the client it
      // has, and keeps its threads running; its sentence is the one the update reports.
      const told = await Promise.allSettled([this.context.dependencies.host.clientUpdated?.(provider)])
      const refused = told.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      if (refused) this.context.logHandoffFailure(provider)
      const handoff = refused ? refused.reason instanceof Error && refused.reason.message ? refused.reason.message
        : `${label} was updated, but Sotto could not move to the new version. Threads that are working carry on and nothing was lost. Connect ${label} again to try the new version.` : undefined
      // The version the host now reads from disk, taken in before the check compares it.
      const snapshot = await this.context.dependencies.host.snapshot(provider).catch(() => undefined)
      if (snapshot && !this.disposed) this.context.acceptSnapshot(snapshot)
      const connected = this.state.host.providers?.some(item => item.id === provider && item.connection === 'connected') ?? false
      if (!connected) {
        // Nothing of this provider is running to read the version from; the next connection reads it.
        this.setClientUpdate(provider, { state: 'idle', ranAt: new Date().toISOString() }, false)
        this.context.say(`The installer finished. Connect ${label} to see the version it runs now.`)
        return
      }
      await this.check()
      // The installer can finish and the client on disk still answer with the version it did before: a second
      // copy found first, or an install script npm did not run. Saying "updated" then would be a lie the user can
      // check, so the reading says what the client actually reports.
      const running = this.state.clientUpdates?.find(item => item.id === provider)?.installed
      const moved = running !== undefined && running !== record.installed
      this.setClientUpdate(provider, { state: moved ? 'updated' : 'unchanged', ranAt: new Date().toISOString(), ...(handoff ? { error: handoff } : {}) }, false)
      if (handoff) throw new Error(handoff)
      if (!moved) {
        throw new Error(`The installer finished, but ${label} still reports ${record.installed}. Nothing was lost and your threads kept working. ${record.command ? `Run ${record.command} in a terminal to see what the installer says.` : `Check how ${label} was installed, then try again.`}`)
      }
      // Threads still working finish on the client they have and move over when idle; that is true without
      // being said, so the notice says only what changed (the user's pick, ADR-0042).
      this.context.say(`${label} updated.`)
    } finally { this.updatingClient = null }
  }
}
