// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { compareOwlHostTarget, HostUpdates, publishedAnswer, type HostUpdateCandidate, type HostUpdateClients, type HostUpdateHosts, type HostUpdateThreads } from '../../../src/main/hosts/hostUpdate'
import type { SshHostUpdateOperation, SshHostUpdateOptions, SshHostUpdateResult } from '../../../src/main/hosts/sshLauncher'
import { SshFailure } from '../../../src/main/hosts/sshFailure'
import type { HostUpdateState } from '../../../src/shared/hostUpdates'
import type { HostUpdateRestartResult } from '../../../src/shared/hostSelfUpdate'
import { deferred } from '../../fixtures/deferred'

const DESKTOP = '0.1.24'
const FILE = 'Sotto-host-0.1.24-linux-x64.tar.gz'
const SUM = 'a'.repeat(64)
const ID = '11111111-1111-4111-8111-111111111111'
const HOST_ID = '22222222-2222-4222-8222-222222222222'
const forge = (patch: Partial<HostUpdateCandidate> = {}): HostUpdateCandidate =>
  ({ id: ID, name: 'forge', hostId: HOST_ID, version: '0.1.22', owned: true, installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', ...patch })
type Step = (operation: SshHostUpdateOperation, options: SshHostUpdateOptions) => Promise<SshHostUpdateResult>
const ready: SshHostUpdateResult = { type: 'ready', v: 1, status: 'ready', hostId: HOST_ID, pid: 42, port: 4317, owned: true }

/** The saved hosts, scripted: each operation answers as `steps` says, and the restart brings the host back at `after`. */
class Hosts implements HostUpdateHosts {
  list: HostUpdateCandidate[] = [forge()]
  readonly operations: SshHostUpdateOperation[] = []
  readonly listeners = new Set<() => void>()
  steps: Partial<Record<SshHostUpdateOperation['op'], Step>> = {
    'update-fetch': async (_operation, options) => { options.onStep?.('check'); return { type: 'update-fetched', file: FILE, sha256: SUM } },
    'update-install': async (_operation, options) => { options.onStep?.('install'); return { type: 'update-installed', version: DESKTOP } },
    'update-restart': async () => ready,
  }
  /** The version the host answers with once it has restarted; null when this computer does not reconnect. */
  after: string | null = DESKTOP
  candidates(): readonly HostUpdateCandidate[] { return this.list }
  async run(_id: string, operation: SshHostUpdateOperation, options: SshHostUpdateOptions = {}): Promise<SshHostUpdateResult> {
    this.operations.push(operation)
    const step = this.steps[operation.op]
    if (!step) throw new Error(`no ${operation.op}`)
    return step(operation, options)
  }
  async restart(id: string, version: string, options: SshHostUpdateOptions = {}): Promise<SshHostUpdateResult | HostUpdateRestartResult | undefined> {
    let result: SshHostUpdateResult
    try { result = await this.run(id, { op: 'update-restart', version }, options) }
    catch (error) { if (this.after === null) { this.list = []; this.emit() } throw error }
    this.list = this.after === null ? [] : this.list.map(item => ({ ...item, version: result.type === 'ready' ? this.after! : item.version }))
    this.emit()
    return result
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(): void { for (const listener of this.listeners) listener() }
}
class Threads implements HostUpdateThreads {
  busy = new Map<string, string[]>()
  readonly interrupted: string[] = []
  readonly listeners = new Set<() => void>()
  /** Turns that began after the last publish: `working` does not show them yet. */
  begun: string[] = []
  working(hostId: string): readonly string[] { return this.busy.get(hostId) ?? [] }
  workingNow(hostId: string): readonly string[] { return [...this.working(hostId), ...hostId === HOST_ID ? this.begun : []] }
  async interrupt(threadId: string): Promise<void> {
    this.interrupted.push(threadId); this.busy.set(HOST_ID, this.working(HOST_ID).filter(id => id !== threadId)); this.begun = this.begun.filter(id => id !== threadId)
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  set(ids: string[]): void { this.busy.set(HOST_ID, ids); for (const listener of this.listeners) listener() }
}
/** The hosts' client update lines: forge's runs while `running` is true. */
class Clients implements HostUpdateClients {
  running = false
  readonly listeners = new Set<() => void>()
  updating(hostId: string): boolean { return hostId === HOST_ID && this.running }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  set(running: boolean): void { this.running = running; for (const listener of this.listeners) listener() }
}
function setup(options: { download?: (url: string, limit: number, signal: AbortSignal) => Promise<Uint8Array> } = {}) {
  const hosts = new Hosts(), threads = new Threads(), clients = new Clients()
  const updates = new HostUpdates({ hosts, threads, clients, version: DESKTOP, releasesUrl: 'https://releases.example/download', ...options })
  const seen: HostUpdateState[][] = []
  updates.subscribe(() => seen.push(updates.state()))
  const one = (): HostUpdateState => updates.state()[0]!
  const settled = () => vi.waitFor(() => expect(['done', 'failed', 'needs']).toContain(one().phase))
  return { hosts, threads, clients, updates, seen, one, settled }
}

describe('which hosts need an update', () => {
  it('offers the explicitly selected Owl target to stable or older Owl hosts without downgrading newer hosts', () => {
    const target = '0.1.38-owl.20261012.10'
    for (const [running, expected] of [
      ['0.1.37', true], ['0.1.38', true], ['0.1.38-owl.20261012.2', true], ['0.1.38-owl.20261011.100', true],
      [target, false], ['0.1.38-owl.20261012.11', false], ['0.1.38-owl.20261013.1', false], ['0.1.39', false], ['unknown', false], ['0.1.38-beta.1', false],
    ] as const) {
      const hosts = new Hosts(), threads = new Threads(); hosts.list = [forge({ version: running })]
      const updates = new HostUpdates({ hosts, threads, version: target })
      expect(updates.state().length > 0, running).toBe(expected)
      updates.dispose()
    }
    expect(compareOwlHostTarget('0.1.38-owl.20261012.2', target)).toBe(-1)
    expect(compareOwlHostTarget(target, '0.1.38-owl.20261012.2')).toBe(1)
    expect(compareOwlHostTarget('0.1.38', '0.1.38')).toBeUndefined()
  })
  it('offers and runs the existing update action while a same-version host reports legacy management', async () => {
    const hosts = new Hosts(), threads = new Threads()
    hosts.list = [forge({ version: DESKTOP })]
    let legacyManagement = true
    const updates = new HostUpdates({ hosts, threads, version: DESKTOP, requiresManagementUpdate: () => legacyManagement })
    expect(updates.state()).toMatchObject([{ phase: 'needs', error: expect.stringContaining('thread management running') }])
    hosts.steps['update-restart'] = async () => { legacyManagement = false; return ready }
    await updates.command(ID, 'update')
    await vi.waitFor(() => expect(updates.state()).toMatchObject([{ phase: 'done' }]))
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch', 'update-install', 'update-restart'])
    await updates.command(ID, 'dismiss'); expect(updates.state()).toEqual([])
    hosts.list = [forge({ version: '1.0.0' })]; legacyManagement = true; hosts.emit()
    expect(updates.state()).toEqual([])
    updates.dispose()
  })
  it('offers one for a host that runs an older Sotto than this computer, and for no other', () => {
    const { hosts, updates } = setup()
    expect(updates.state()).toMatchObject([{ id: ID, name: 'forge', from: '0.1.22', to: DESKTOP, phase: 'needs', owned: true, working: 0 }])
    for (const version of [DESKTOP, '0.1.25', '1.0.0', 'unknown']) {
      hosts.list = [forge({ version })]; hosts.emit()
      expect(updates.state()).toEqual([])
    }
    hosts.list = [forge({ version: '0.0.9' })]; hosts.emit()
    expect(updates.state()).toMatchObject([{ from: '0.0.9', phase: 'needs' }])
    // A host that goes away takes its offer with it.
    hosts.list = []; hosts.emit()
    expect(updates.state()).toEqual([])
  })
  it('gives the commands to do it by hand, for the host\'s own folders', () => {
    const { one } = setup()
    expect(one().commands).toBe([
      '# On forge:', 'cd ~/.local/share/sotto-host',
      `curl -fLO https://releases.example/download/v${DESKTOP}/${FILE}`, `curl -fLO https://releases.example/download/v${DESKTOP}/${FILE}.sha256`,
      `sha256sum -c ${FILE}.sha256`, `mkdir -p versions/${DESKTOP} && tar -xzf ${FILE} -C versions/${DESKTOP}`, `printf '${DESKTOP}\\n' > current`,
      '# Then press Stop host for forge in Settings > Hosts & phones, and switch forge on again.'].join('\n'))
  })
})

describe('an update', () => {
  it('downloads, checks, installs and restarts a host with nothing working, then says which version it runs', async () => {
    const { hosts, updates, seen, one, settled } = setup()
    await updates.command(ID, 'update')
    await settled()
    expect(one()).toMatchObject({ phase: 'done', to: DESKTOP })
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch', 'update-install', 'update-restart'])
    expect(hosts.operations[0]).toEqual({ op: 'update-fetch', version: DESKTOP, releasesUrl: 'https://releases.example/download' })
    expect(hosts.operations[1]).toEqual({ op: 'update-install', version: DESKTOP, file: FILE, sha256: SUM })
    // Every step shows, in order, and the route is the host's own download.
    const steps = seen.map(state => state[0]?.phase === 'updating' ? state[0].step : undefined).filter(Boolean)
    expect([...new Set(steps)]).toEqual(['download', 'check', 'install', 'restart'])
    expect(seen.find(state => state[0]?.phase === 'updating')![0]).toMatchObject({ route: 'host' })
    // Dismiss puts it away, and nothing is offered for a host that is up to date.
    await updates.command(ID, 'dismiss')
    expect(updates.state()).toEqual([])
  })
  it('asks first on a busy host: wait for its threads, or stop them, or cancel', async () => {
    const { hosts, threads, updates, one, settled } = setup()
    threads.set(['thread-a', 'thread-b'])
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'confirm', working: 2 })
    expect(hosts.operations).toEqual([])
    await updates.command(ID, 'cancel')
    expect(one()).toMatchObject({ phase: 'needs' })
    // Update when they finish: it waits, and starts by itself once none is working.
    await updates.command(ID, 'update')
    await updates.command(ID, 'when-idle')
    expect(one()).toMatchObject({ phase: 'waiting', working: 2 })
    threads.set(['thread-b'])
    expect(one()).toMatchObject({ phase: 'waiting', working: 1 })
    expect(hosts.operations).toEqual([])
    threads.set([])
    await settled()
    expect(one().phase).toBe('done')
    expect(threads.interrupted).toEqual([])
  })
  // What was published trails a turn that began in the last few milliseconds; a restart then would end it unasked.
  it('asks first, and stops, for a turn that began after the last publish', async () => {
    const { hosts, threads, updates, one, settled } = setup()
    threads.begun = ['thread-new']
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'confirm' })
    // The threads moving on does not start it while that turn still works.
    threads.set([])
    expect(one()).toMatchObject({ phase: 'confirm' })
    await updates.command(ID, 'when-idle')
    expect(one()).toMatchObject({ phase: 'waiting' })
    expect(hosts.operations).toEqual([])
    await updates.command(ID, 'stop-threads')
    expect(threads.interrupted).toEqual(['thread-new'])
    await settled()
    expect(one().phase).toBe('done')
  })
  it('starts the update when the threads finish while it asks, since Update was pressed', async () => {
    const { threads, updates, one, settled } = setup()
    threads.set(['thread-a'])
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'confirm', working: 1 })
    threads.set([])
    await settled()
    expect(one().phase).toBe('done')
  })
  it('shows the install step before the host is asked to unpack, so Cancel update is never offered for it', async () => {
    const { hosts, updates, one } = setup()
    let unpack!: () => void
    hosts.steps['update-install'] = () => { const pending = deferred<SshHostUpdateResult>(); unpack = () => pending.resolve({ type: 'update-installed', version: DESKTOP }); return pending.promise }
    await updates.command(ID, 'update')
    await vi.waitFor(() => expect(hosts.operations.map(operation => operation.op)).toContain('update-install'))
    expect(one()).toMatchObject({ phase: 'updating', step: 'install' })
    unpack()
    await vi.waitFor(() => expect(one().phase).toBe('done'))
  })
  it('stops the working threads and updates at once on Stop N threads and update', async () => {
    const { threads, updates, one, settled } = setup()
    threads.set(['thread-a', 'thread-b'])
    await updates.command(ID, 'update')
    await updates.command(ID, 'when-idle')
    await updates.command(ID, 'stop-threads')
    await settled()
    expect(threads.interrupted).toEqual(['thread-a', 'thread-b'])
    expect(one().phase).toBe('done')
  })
  it('cancels during the download and the check, and not once it installs', async () => {
    const { hosts, updates, one } = setup()
    let seenSignal: AbortSignal | undefined
    hosts.steps['update-fetch'] = (_operation, options) => new Promise((_resolve, reject) => {
      seenSignal = options.signal
      options.signal?.addEventListener('abort', () => reject(new SshFailure('cancelled')))
    })
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'updating', step: 'download' })
    await updates.command(ID, 'cancel')
    expect(seenSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(one()).toMatchObject({ phase: 'needs' }))
    expect(one().failure).toBeUndefined()
    let installing!: () => void
    hosts.steps['update-fetch'] = async (_operation, options) => { options.onStep?.('check'); return { type: 'update-fetched', file: FILE, sha256: SUM } }
    hosts.steps['update-install'] = (_operation, options) => { const pending = deferred<SshHostUpdateResult>(); options.onStep?.('install'); installing = () => pending.resolve({ type: 'update-installed', version: DESKTOP }); return pending.promise }
    await updates.command(ID, 'update')
    await vi.waitFor(() => expect(one()).toMatchObject({ step: 'install' }))
    await expect(updates.command(ID, 'cancel')).rejects.toThrow(`forge is already installing ${DESKTOP}, which cannot be stopped partway. Nothing was changed.`)
    // Other commands on the host wait while it updates.
    expect(updates.busy(ID)).toBe('Sotto is updating the host on forge. Nothing was changed. Wait for the update to finish, then try again.')
    installing()
    await vi.waitFor(() => expect(one().phase).toBe('done'))
    expect(updates.busy(ID)).toBeUndefined()
  })
  it('copies the archive from this computer when the host cannot reach GitHub, checked against the release first', async () => {
    const archive = Buffer.from('synthetic archive')
    const sum = createHash('sha256').update(archive).digest('hex')
    const downloads: string[] = []
    const { hosts, updates, seen, one, settled } = setup({ download: async url => { downloads.push(url); return url.endsWith('.sha256') ? Buffer.from(`${sum}  ${FILE}\n`) : archive } })
    hosts.steps['update-fetch'] = async () => ({ type: 'error', reason: 'download-unreachable', file: FILE })
    hosts.steps['update-receive'] = async operation => ({ type: 'update-received', size: operation.op === 'update-receive' ? operation.size : 0 })
    await updates.command(ID, 'update')
    await settled()
    expect(one().phase).toBe('done')
    expect(downloads).toEqual([`https://releases.example/download/v${DESKTOP}/${FILE}`, `https://releases.example/download/v${DESKTOP}/${FILE}.sha256`])
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch', 'update-receive', 'update-install', 'update-restart'])
    expect(hosts.operations[1]).toMatchObject({ op: 'update-receive', file: FILE, size: archive.byteLength })
    expect(hosts.operations[2]).toEqual({ op: 'update-install', version: DESKTOP, file: FILE, sha256: sum })
    // Downloaded and copied, then checked, then installed.
    const steps = seen.map(state => state[0]?.phase === 'updating' && state[0].route === 'desktop' ? state[0].step : undefined).filter(Boolean)
    expect([...new Set(steps)]).toEqual(['download', 'check', 'install', 'restart'])
  })
  it('says so when neither the host nor this computer can download it, and nothing was changed on the host', async () => {
    const { hosts, updates, one, settled } = setup({ download: async () => { throw new TypeError('fetch failed') } })
    hosts.steps['update-fetch'] = async () => ({ type: 'error', reason: 'download-unreachable', file: FILE })
    await updates.command(ID, 'update')
    await settled()
    expect(one()).toMatchObject({ phase: 'failed', failure: { step: 'download',
      message: `forge could not download ${DESKTOP} from GitHub, and this computer could not download it either.`,
      kept: 'forge still runs 0.1.22. Nothing was lost.' } })
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch'])
  })
  it('refuses a download that does not match the release, and Try again starts over', async () => {
    const { hosts, updates, one, settled } = setup()
    hosts.steps['update-fetch'] = async () => ({ type: 'error', reason: 'checksum-mismatch', file: FILE })
    await updates.command(ID, 'update')
    await settled()
    expect(one()).toMatchObject({ phase: 'failed', failure: { step: 'check',
      message: 'The download on forge did not match the release\'s checksum, so Sotto deleted it and installed nothing.',
      kept: 'forge still runs 0.1.22. Nothing was lost.', next: 'Try again to download it fresh, or update it by hand on forge.' } })
    expect(one().commands).toContain(`sha256sum -c ${FILE}.sha256`)
    hosts.steps['update-fetch'] = async () => ({ type: 'update-fetched', file: FILE, sha256: SUM })
    await updates.command(ID, 'update')
    await settled()
    expect(one().phase).toBe('done')
  })
  it('says the old version is back when the new one did not start, with the commands that show why', async () => {
    const { hosts, updates, one, settled } = setup()
    hosts.steps['update-restart'] = async () => ({ type: 'error', reason: 'update-start-failed', restarted: true })
    await updates.command(ID, 'update')
    await settled()
    expect(one()).toMatchObject({ phase: 'failed', failure: { step: 'restart',
      message: `${DESKTOP} installed on forge, but its host did not start, so Sotto started 0.1.22 again.`,
      kept: 'forge\'s threads are back. Nothing was lost.' } })
    expect(one().commands).toBe(`# On forge, with its host stopped, to see what ${DESKTOP} says:\ncd ~/.local/share/sotto-host/versions/${DESKTOP}\nnode host/index.js --data ~/.sotto`)
  })
  it('names a conflicting installed folder and offers inspection commands without overwriting it', async () => {
    const { hosts, updates, one, settled } = setup()
    hosts.list = [forge({ installPath: "~/installed host's $(literal)" })]; hosts.emit()
    hosts.steps['update-install'] = async () => ({ type: 'error', reason: 'update-version-conflict' })
    await updates.command(ID, 'update')
    await settled()
    expect(one()).toMatchObject({ phase: 'failed', failure: { step: 'install',
      message: `The existing versions/${DESKTOP} folder on forge differs from the release. Sotto kept it unchanged.`,
      kept: 'forge still runs 0.1.22. Nothing was lost.',
      next: 'Use a newer Sotto build, or stop the host on forge, keep that folder as a backup and move it aside before trying again.' } })
    expect(one().commands).toBe([
      '# On forge, inspect the existing folder before changing it:', "cd ~/'installed host'\\''s $(literal)'", `ls -ld versions/${DESKTOP}`,
      `cat versions/${DESKTOP}/package.json`, `cat versions/${DESKTOP}/runtime-manifest.json`,
      '# Keep this folder as a backup. Do not unpack a different build over it.',
      '# Use a newer Sotto build, or stop the host and move this folder aside before pressing Try again.'].join('\n'))
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch', 'update-install'])
  })
  it('says what it knows when the connection is lost during the restart, by the version the host reconnects with', async () => {
    const { hosts, updates, one, settled } = setup()
    hosts.steps['update-restart'] = async () => { throw new SshFailure('update-failed') }
    hosts.after = null
    await updates.command(ID, 'update')
    await settled()
    expect(one()).toMatchObject({ phase: 'failed', failure: { step: 'restart', message: 'The connection to forge closed while its host restarted, so Sotto cannot tell which version is running.' } })
    // Back on the old version: the update did not take, and the host says so.
    hosts.after = DESKTOP; hosts.list = [forge()]; hosts.emit()
    await updates.command(ID, 'update')
    await vi.waitFor(() => expect(one().failure?.message).toBe('The connection to forge closed while its host restarted, and it came back on 0.1.22.'))
    expect(one().failure?.kept).toBe('forge\'s threads are back. Nothing was lost.')
  })
  it('reads a restart sent over the host’s socket the way it reads one over SSH, with the same sentences (ADR-0088)', async () => {
    // The host's outcome said the new host started.
    const started = setup()
    started.hosts.restart = async () => { started.hosts.list = [forge({ version: DESKTOP })]; started.hosts.emit(); return { type: 'ready', hostId: HOST_ID, pid: 43 } }
    await started.updates.command(ID, 'update')
    await started.settled()
    expect(started.one()).toMatchObject({ phase: 'done', from: DESKTOP })
    // The outcome could not say, and the host came back on the new version: done all the same.
    const unsaid = setup()
    unsaid.hosts.restart = async () => { unsaid.hosts.list = [forge({ version: DESKTOP })]; unsaid.hosts.emit(); return undefined }
    await unsaid.updates.command(ID, 'update')
    await unsaid.settled()
    expect(unsaid.one()).toMatchObject({ phase: 'done', from: DESKTOP })
    // It could not say, and the host came back on the old one.
    const old = setup()
    old.hosts.restart = async () => undefined
    await old.updates.command(ID, 'update')
    await old.settled()
    expect(old.one()).toMatchObject({ phase: 'failed', failure: { step: 'restart', message: 'The connection to forge closed while its host restarted, and it came back on 0.1.22.' } })
    // It could not say, and nothing came back by the deadline.
    const gone = setup()
    gone.hosts.restart = async () => { gone.hosts.list = []; gone.hosts.emit(); return undefined }
    await gone.updates.command(ID, 'update')
    await vi.waitFor(() => expect(gone.updates.state()[0]?.phase).toBe('failed'))
    expect(gone.one().failure?.message).toBe('The connection to forge closed while its host restarted, so Sotto cannot tell which version is running.')
    // The outcome said the old version was started again.
    const rolled = setup()
    rolled.hosts.restart = async () => ({ type: 'error', reason: 'update-start-failed', restarted: true, cause: 'host-start-failed' })
    await rolled.updates.command(ID, 'update')
    await rolled.settled()
    expect(rolled.one()).toMatchObject({ phase: 'failed', failure: { step: 'restart', message: `${DESKTOP} installed on forge, but its host did not start, so Sotto started 0.1.22 again.` } })
    for (const each of [started, unsaid, old, gone, rolled]) each.updates.dispose()
  })
  it('says the old version still runs when the restart could not be asked for, and nothing was stopped', async () => {
    const { hosts, updates, one, settled } = setup()
    hosts.restart = async () => { throw new Error('Sotto did not start the host on forge, so it cannot stop it. Stop it on that machine.') }
    await updates.command(ID, 'update')
    await settled()
    expect(one()).toMatchObject({ phase: 'failed', failure: { step: 'restart',
      message: `Sotto could not ask forge's host to restart, so ${DESKTOP} is installed beside 0.1.22, which still runs.`, kept: 'forge still runs 0.1.22. Nothing was lost.' } })
  })
  it('does not restart a host Sotto did not start, and offers the commands instead', async () => {
    const { hosts, updates, one } = setup()
    hosts.list = [forge({ owned: false })]; hosts.emit()
    expect(one()).toMatchObject({ phase: 'needs', owned: false })
    expect(one().commands).toMatch(/# Then stop the host on forge, and connect to it again from Settings > Hosts & phones\.$/u)
    await expect(updates.command(ID, 'update')).rejects.toThrow('Sotto did not start the host on forge, so it cannot restart it. Nothing was changed.')
    expect(hosts.operations).toEqual([])
  })
  it('says a host that is no longer connected cannot be updated, and changes nothing', async () => {
    const { hosts, updates, one, settled } = setup()
    hosts.steps['update-fetch'] = async () => ({ type: 'error', reason: 'checksum-mismatch', file: FILE })
    await updates.command(ID, 'update')
    await settled()
    // A failed update stays to be read after its host goes away; Try again then says why nothing happens.
    hosts.list = []; hosts.emit()
    expect(one().phase).toBe('failed')
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'failed', error: 'forge is not connected, so nothing was updated. Switch it on in Settings > Hosts & phones, then try again.' })
  })
})

// The incident of October 16, 2026: Try again on forge's host restarted it while Codex was installing there.
describe('a host whose client update line is running (ADR-0077 decision 2)', () => {
  it('waits on Update, and begins by itself once the line is empty', async () => {
    const { hosts, clients, updates, one, settled } = setup()
    clients.set(true)
    expect(one()).toMatchObject({ phase: 'needs', clientsUpdating: true })
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'waiting', clientsUpdating: true, working: 0 })
    expect(hosts.operations).toEqual([])
    clients.set(false)
    await settled()
    expect(one().phase).toBe('done')
    expect(one().clientsUpdating).toBeUndefined()
  })
  it('waits on Try again after a failure the same way', async () => {
    const { hosts, clients, updates, one, settled } = setup()
    hosts.steps['update-fetch'] = async () => ({ type: 'error', reason: 'download-failed' })
    await updates.command(ID, 'update')
    await settled()
    expect(one().phase).toBe('failed')
    hosts.steps['update-fetch'] = async (_operation, options) => { options.onStep?.('check'); return { type: 'update-fetched', file: FILE, sha256: SUM } }
    clients.set(true)
    const before = hosts.operations.length
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'waiting', clientsUpdating: true })
    expect(one().failure).toBeUndefined()
    expect(hosts.operations.length).toBe(before)
    clients.set(false)
    await vi.waitFor(() => expect(one().phase).toBe('done'))
  })
  it('waits for the line after the threads, whichever answer the busy question got', async () => {
    const { hosts, threads, clients, updates, one, settled } = setup()
    clients.set(true)
    threads.set(['thread-a'])
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'confirm', working: 1 })
    await updates.command(ID, 'when-idle')
    expect(one()).toMatchObject({ phase: 'waiting', working: 1, clientsUpdating: true })
    threads.set([])
    expect(one()).toMatchObject({ phase: 'waiting', working: 0, clientsUpdating: true })
    // Stop N threads stops them, and the update still waits for the line.
    threads.set(['thread-b'])
    await updates.command(ID, 'stop-threads')
    expect(threads.interrupted).toEqual(['thread-b'])
    expect(one()).toMatchObject({ phase: 'waiting', clientsUpdating: true })
    expect(hosts.operations).toEqual([])
    clients.set(false)
    await settled()
    expect(one().phase).toBe('done')
  })
  it('asks nothing more of a host whose threads finish while it asks, and waits for its line', async () => {
    const { hosts, threads, clients, updates, one } = setup()
    threads.set(['thread-a'])
    await updates.command(ID, 'update')
    clients.set(true)
    threads.set([])
    expect(one()).toMatchObject({ phase: 'waiting', clientsUpdating: true })
    expect(hosts.operations).toEqual([])
    updates.dispose()
  })
  it('goes back to needing an update on Cancel update while it waits, and does not begin when the line empties', async () => {
    const { hosts, clients, updates, one } = setup()
    clients.set(true)
    await updates.command(ID, 'update')
    expect(one().phase).toBe('waiting')
    await updates.command(ID, 'cancel')
    expect(one()).toMatchObject({ phase: 'needs', clientsUpdating: true })
    clients.set(false)
    expect(one().phase).toBe('needs')
    expect(hosts.operations).toEqual([])
    updates.dispose()
  })
  it('never interrupts an update already under way when a client joins the line, and holds only its restart', async () => {
    const { hosts, clients, updates, one } = setup()
    let unpack!: () => void
    hosts.steps['update-install'] = (_operation, options) => { const pending = deferred<SshHostUpdateResult>(); options.onStep?.('install'); unpack = () => pending.resolve({ type: 'update-installed', version: DESKTOP }); return pending.promise }
    await updates.command(ID, 'update')
    await vi.waitFor(() => expect(one()).toMatchObject({ phase: 'updating', step: 'install' }))
    clients.set(true)
    expect(one()).toMatchObject({ phase: 'updating', step: 'install', clientsUpdating: true })
    unpack()
    // The install finishes and stays; the restart waits for the line, and cannot be cancelled.
    await vi.waitFor(() => expect(one()).toMatchObject({ phase: 'updating', step: 'restart', clientsUpdating: true }))
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch', 'update-install'])
    await expect(updates.command(ID, 'cancel')).rejects.toThrow(`forge is already installing ${DESKTOP}, which cannot be stopped partway. Nothing was changed.`)
    clients.set(false)
    await vi.waitFor(() => expect(one().phase).toBe('done'))
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch', 'update-install', 'update-restart'])
  })
  // Sol's review of #1084: a client queued during the download was cut off by the restart.
  it('holds the restart for a client put in the line during the download, without downloading again', async () => {
    const { hosts, clients, updates, one } = setup()
    let fetched!: () => void
    hosts.steps['update-fetch'] = (_operation, options) => {
      const pending = deferred<SshHostUpdateResult>()
      fetched = () => { options.onStep?.('check'); pending.resolve({ type: 'update-fetched', file: FILE, sha256: SUM }) }
      return pending.promise
    }
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'updating', step: 'download' })
    clients.set(true)
    fetched()
    await vi.waitFor(() => expect(one()).toMatchObject({ phase: 'updating', step: 'restart', clientsUpdating: true }))
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch', 'update-install'])
    expect(updates.restartHold()).toContain('forge')
    clients.set(false)
    await vi.waitFor(() => expect(one().phase).toBe('done'))
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch', 'update-install', 'update-restart'])
  })
})

describe('Not now', () => {
  it('hides a host until Sotto next starts, whatever reconnects meanwhile', async () => {
    const { hosts, threads, updates } = setup()
    await updates.command(ID, 'not-now')
    expect(updates.state()).toEqual([])
    hosts.list = []; hosts.emit()
    hosts.list = [forge()]; hosts.emit()
    expect(updates.state()).toEqual([])
    // The next start offers it again.
    const next = new HostUpdates({ hosts, threads, version: DESKTOP })
    expect(next.state()).toMatchObject([{ id: ID, phase: 'needs' }])
    next.dispose()
  })
  it('is refused while the update runs', async () => {
    const { hosts, updates } = setup()
    hosts.steps['update-fetch'] = () => new Promise(() => undefined)
    await updates.command(ID, 'update')
    await expect(updates.command(ID, 'not-now')).rejects.toThrow('The update of forge is under way and cannot be hidden. Nothing was changed.')
  })
})

describe('the version this computer is downloading (ADR-0077 decision 6)', () => {
  const RUNNING = '0.1.38-owl.20261014.1', WAITING = '0.1.38-owl.20261014.2'
  const RELEASES = 'https://releases.example/download'
  const archive = (version: string, system = 'linux-x64') => `${RELEASES}/v${version}/Sotto-host-${version}-${system}.tar.gz`
  /** A releases page that publishes the files named, answers 404 for the rest, and records every request. */
  function page(published: string[]) {
    const asked: string[] = []
    const probe = vi.fn(async (url: string) => { asked.push(url); return published.includes(url) })
    return { asked, probe }
  }
  /** forge on this computer's version, a Linux host whose launch said so, unless `patch` says otherwise. */
  function aimed(published: string[], patch: Partial<HostUpdateCandidate> = {}) {
    const hosts = new Hosts(), threads = new Threads(), releases = page(published)
    hosts.list = [forge({ version: RUNNING, system: 'linux-x64', ...patch })]
    hosts.steps['update-fetch'] = async (operation, options) => { options.onStep?.('check'); return { type: 'update-fetched', file: `Sotto-host-${(operation as { version: string }).version}-linux-x64.tar.gz`, sha256: SUM } }
    const updates = new HostUpdates({ hosts, threads, version: RUNNING, releasesUrl: RELEASES, probe: releases.probe })
    return { hosts, threads, updates, releases, one: () => updates.state()[0] }
  }

  it('offers a host on this computer’s own version the version it is downloading, once the releases page has its host', async () => {
    const { updates, releases, one } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`])
    expect(updates.state()).toEqual([])
    updates.pending(WAITING)
    await vi.waitFor(() => expect(one()).toMatchObject({ from: RUNNING, to: WAITING, phase: 'needs' }))
    expect(releases.asked).toEqual([archive(WAITING), `${archive(WAITING)}.sha256`])
    // The next phase of the same download asks nothing new.
    updates.pending(WAITING); updates.pending(WAITING)
    expect(releases.asked).toHaveLength(2)
    updates.dispose()
  })

  it('installs the waiting version, restarts the host into it, and leaves it alone once it runs it', async () => {
    const { hosts, updates } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`])
    hosts.after = WAITING
    updates.pending(WAITING)
    await vi.waitFor(() => expect(updates.state()).toHaveLength(1))
    await updates.command(ID, 'update')
    await vi.waitFor(() => expect(updates.state()[0]).toMatchObject({ phase: 'done', from: WAITING, to: WAITING }))
    expect(hosts.operations).toEqual([
      { op: 'update-fetch', version: WAITING, releasesUrl: RELEASES },
      { op: 'update-install', version: WAITING, file: `Sotto-host-${WAITING}-linux-x64.tar.gz`, sha256: SUM },
      { op: 'update-restart', version: WAITING },
    ])
    await updates.command(ID, 'dismiss')
    expect(updates.state()).toEqual([])
    // The update going away, as after Sotto restarts or a check finds nothing newer, never takes the host back down.
    updates.pending(undefined)
    expect(updates.state()).toEqual([])
    updates.dispose()
  })

  it('leaves a host off the card until after the restart when the release has no host archive', async () => {
    const { updates, releases } = aimed([])
    updates.pending(WAITING)
    await vi.waitFor(() => expect(releases.asked).toEqual([archive(WAITING)]))
    await vi.waitFor(() => expect(updates.checking()).toEqual([]))
    expect(updates.state()).toEqual([])
    updates.dispose()
  })

  it('does not offer it while an archive has no checksum beside it', async () => {
    const { updates, releases } = aimed([archive(WAITING)])
    updates.pending(WAITING)
    await vi.waitFor(() => expect(releases.asked).toEqual([archive(WAITING), `${archive(WAITING)}.sha256`]))
    await vi.waitFor(() => expect(updates.checking()).toEqual([]))
    expect(updates.state()).toEqual([])
    updates.dispose()
  })

  it('asks only for the host’s own system, so another system’s archive never offers it a version (Sol, review)', async () => {
    // A release with a Linux host only, and a Mac host: nothing qualifies it.
    const { updates, releases } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`], { system: 'darwin-arm64' })
    updates.pending(WAITING)
    await vi.waitFor(() => expect(releases.asked).toEqual([archive(WAITING, 'darwin-arm64')]))
    await vi.waitFor(() => expect(updates.checking()).toEqual([]))
    expect(updates.state()).toEqual([])
    updates.dispose()
  })

  it('asks nothing for a host whose system Sotto has not heard, and leaves it for after the restart', () => {
    const { updates, releases } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`], { system: undefined })
    updates.pending(WAITING)
    expect(releases.asked).toEqual([])
    expect(updates.checking()).toEqual([])
    expect(updates.state()).toEqual([])
    updates.dispose()
  })

  it('names a host as checking from the moment it is asked about until the releases page answers', async () => {
    const { updates, releases } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`])
    const answer = deferred<boolean>()
    releases.probe.mockImplementationOnce(async (url: string) => { releases.asked.push(url); return answer.promise })
    const published: string[][] = []
    updates.subscribe(() => published.push(updates.checking()))
    expect(updates.checking()).toEqual([])
    updates.pending(WAITING)
    // Published with the state, so the window sees the check begin and end in the same changes as the offer.
    expect(updates.checking()).toEqual([ID])
    expect(published.at(-1)).toEqual([ID])
    expect(updates.state()).toEqual([])
    answer.resolve(true)
    await vi.waitFor(() => expect(updates.state()).toMatchObject([{ to: WAITING, phase: 'needs' }]))
    expect(updates.checking()).toEqual([])
    expect(published.at(-1)).toEqual([])
    updates.dispose()
  })

  it('asks again on the next phase change when the releases page did not answer', async () => {
    const { updates, releases, one } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`])
    releases.probe.mockImplementationOnce(async (url: string) => { releases.asked.push(url); return undefined as unknown as boolean })
    updates.pending(WAITING)
    await vi.waitFor(() => expect(releases.asked).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updates.state()).toEqual([])
    updates.pending(WAITING)
    await vi.waitFor(() => expect(one()).toMatchObject({ to: WAITING }))
    updates.dispose()
  })

  it('aims an older host at the waiting version too, and keeps a started update on the version it began with', async () => {
    const { hosts, updates, releases, one } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`], { version: '0.1.37' })
    expect(one()).toMatchObject({ from: '0.1.37', to: RUNNING })
    const fetching = deferred<SshHostUpdateResult>()
    hosts.steps['update-fetch'] = () => fetching.promise
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'updating', to: RUNNING })
    updates.pending(WAITING)
    await vi.waitFor(() => expect(releases.asked).toHaveLength(2))
    expect(one()).toMatchObject({ phase: 'updating', to: RUNNING })
    expect(hosts.operations[0]).toMatchObject({ version: RUNNING })
    updates.dispose()
  })

  it('asks for the host’s own system once its download has named it, when its launch did not', async () => {
    const { hosts, updates, releases } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`], { version: '0.1.37', system: undefined })
    hosts.steps['update-fetch'] = async () => ({ type: 'error', reason: 'archive-unavailable', file: `Sotto-host-${RUNNING}-darwin-arm64.tar.gz` })
    await updates.command(ID, 'update')
    await vi.waitFor(() => expect(updates.state()[0]).toMatchObject({ phase: 'failed' }))
    updates.pending(WAITING)
    await vi.waitFor(() => expect(releases.asked).toEqual([archive(WAITING, 'darwin-arm64')]))
    expect(updates.state()[0]).toMatchObject({ to: RUNNING })
    updates.dispose()
  })

  it('offers the waiting version to a host whose earlier update this session is done', async () => {
    const { hosts, updates, one } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`], { version: '0.1.37' })
    hosts.after = RUNNING
    await updates.command(ID, 'update')
    await vi.waitFor(() => expect(one()).toMatchObject({ phase: 'done', to: RUNNING }))
    // Later in the session Sotto finds a newer version of itself: the finished update makes way for the next.
    updates.pending(WAITING)
    await vi.waitFor(() => expect(one()).toMatchObject({ phase: 'needs', from: RUNNING, to: WAITING }))
    updates.dispose()
  })

  it('asks again on the next phase change when the release had no host archive yet', async () => {
    const published: string[] = []
    const { updates, releases, one } = aimed(published)
    updates.pending(WAITING)
    await vi.waitFor(() => expect(releases.asked).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updates.state()).toEqual([])
    // The host archive is uploaded after the installer, as the release procedure allows.
    published.push(archive(WAITING), `${archive(WAITING)}.sha256`)
    updates.pending(WAITING)
    await vi.waitFor(() => expect(one()).toMatchObject({ to: WAITING }))
    updates.dispose()
  })

  it('ignores a waiting version that is not later than this computer’s own, and asks nothing', () => {
    const { updates, releases } = aimed([], { version: '0.1.37' })
    for (const version of [RUNNING, '0.1.38-owl.20261013.9', 'not-a-version']) updates.pending(version)
    expect(releases.asked).toEqual([])
    expect(updates.state()[0]).toMatchObject({ to: RUNNING })
    updates.dispose()
  })

  it('stops an update still downloading a waiting version that goes away, and offers this computer’s again (Sotto Bug Bot, review)', async () => {
    const { hosts, updates, one } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`], { version: '0.1.37' })
    updates.pending(WAITING)
    await vi.waitFor(() => expect(one()).toMatchObject({ to: WAITING, phase: 'needs' }))
    let signal: AbortSignal | undefined
    hosts.steps['update-fetch'] = (_operation, options) => { signal = options.signal; return new Promise(() => undefined) }
    await updates.command(ID, 'update')
    expect(one()).toMatchObject({ phase: 'updating', to: WAITING })
    updates.pending(undefined)
    expect(signal?.aborted).toBe(true)
    expect(one()).toMatchObject({ phase: 'needs', to: RUNNING })
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch'])
    updates.dispose()
  })

  it('lets an update the host is already unpacking finish, and says plainly what happened', async () => {
    const { hosts, updates, one } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`])
    hosts.after = WAITING
    updates.pending(WAITING)
    await vi.waitFor(() => expect(one()).toMatchObject({ to: WAITING }))
    const installing = deferred<SshHostUpdateResult>()
    hosts.steps['update-install'] = () => installing.promise
    await updates.command(ID, 'update')
    await vi.waitFor(() => expect(one()).toMatchObject({ step: 'install' }))
    updates.pending(undefined)
    expect(one()).toMatchObject({ phase: 'updating', to: WAITING })
    installing.resolve({ type: 'update-installed', version: WAITING })
    await vi.waitFor(() => expect(one()).toMatchObject({ phase: 'done', to: WAITING }))
    expect(one()?.error).toBe(`forge was already installing ${WAITING} when this computer stopped updating to it, so it finished. Nothing was lost. forge runs a newer Sotto than this computer until this computer updates too.`)
    expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch', 'update-install', 'update-restart'])
    updates.dispose()
  })

  it('waits for the archive check before fixing the version, so one press downloads once (Sotto Bug Bot, review)', async () => {
    const { hosts, updates, releases, one } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`], { version: '0.1.37' })
    hosts.after = WAITING
    const answer = deferred<boolean>()
    releases.probe.mockImplementationOnce(async (url: string) => { releases.asked.push(url); return answer.promise })
    updates.pending(WAITING)
    expect(updates.checking()).toEqual([ID])
    await updates.command(ID, 'update')
    // Shown as started, but nothing is fetched until the releases page answers.
    expect(one()).toMatchObject({ phase: 'updating', step: 'download' })
    expect(hosts.operations).toEqual([])
    expect(updates.restartHold()).toContain('the host on forge')
    answer.resolve(true)
    await vi.waitFor(() => expect(one()).toMatchObject({ phase: 'done', to: WAITING }))
    expect(hosts.operations.map(operation => [operation.op, (operation as { version?: string }).version])).toEqual([
      ['update-fetch', WAITING], ['update-install', WAITING], ['update-restart', WAITING],
    ])
    updates.dispose()
  })

  it('lets Cancel update stop a press still waiting for the archive check', async () => {
    const { hosts, updates, releases, one } = aimed([archive(WAITING), `${archive(WAITING)}.sha256`], { version: '0.1.37' })
    const answer = deferred<boolean>()
    releases.probe.mockImplementationOnce(async (url: string) => { releases.asked.push(url); return answer.promise })
    updates.pending(WAITING)
    await updates.command(ID, 'update')
    await updates.command(ID, 'cancel')
    expect(one()).toMatchObject({ phase: 'needs' })
    answer.resolve(true)
    await vi.waitFor(() => expect(one()).toMatchObject({ phase: 'needs', to: WAITING }))
    expect(hosts.operations).toEqual([])
    updates.dispose()
  })
})

describe('Sotto quitting or restarting during a host update (Sotto Bug Bot, review)', () => {
  it('names the hosts being updated, so the restart into Sotto’s update waits for them', async () => {
    const { hosts, updates } = setup()
    expect(updates.restartHold()).toBeUndefined()
    hosts.steps['update-fetch'] = () => new Promise(() => undefined)
    await updates.command(ID, 'update')
    expect(updates.restartHold()).toBe('Sotto did not restart while it was updating the host on forge. Nothing was lost. Restart again once that update has finished.')
    updates.dispose()
  })

  it('stops a download on quit, and leaves an update the host is unpacking to finish', async () => {
    const downloading = setup()
    let signal: AbortSignal | undefined
    downloading.hosts.steps['update-fetch'] = (_operation, options) => { signal = options.signal; return new Promise(() => undefined) }
    await downloading.updates.command(ID, 'update')
    downloading.updates.dispose()
    expect(signal?.aborted).toBe(true)

    const { hosts, updates, one } = setup()
    const installing = deferred<SshHostUpdateResult>()
    hosts.steps['update-install'] = () => installing.promise
    await updates.command(ID, 'update')
    await vi.waitFor(() => expect(one()).toMatchObject({ step: 'install' }))
    updates.dispose()
    installing.resolve({ type: 'update-installed', version: DESKTOP })
    // Nothing was aborted: the restart is still asked for, as the launch script would finish it on the host anyway.
    await vi.waitFor(() => expect(hosts.operations.map(operation => operation.op)).toEqual(['update-fetch', 'update-install', 'update-restart']))
  })
})

describe('whether the releases page has a file (Sotto Bug Bot, review)', () => {
  it('counts a redirect only when it points at GitHub’s release asset host', () => {
    expect(publishedAnswer(200, null)).toBe(true)
    expect(publishedAnswer(404, null)).toBe(false)
    expect(publishedAnswer(302, 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r')).toBe(true)
    expect(publishedAnswer(302, 'https://github.com/login')).toBeUndefined()
    expect(publishedAnswer(302, 'http://release-assets.githubusercontent.com/file')).toBeUndefined()
    expect(publishedAnswer(302, 'https://release-assets.githubusercontent.com.example/file')).toBeUndefined()
    expect(publishedAnswer(302, '/errors/404')).toBeUndefined()
    expect(publishedAnswer(302, null)).toBeUndefined()
    expect(publishedAnswer(500, null)).toBeUndefined()
  })
})
