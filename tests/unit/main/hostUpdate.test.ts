// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { HostUpdates, type HostUpdateCandidate, type HostUpdateHosts, type HostUpdateThreads } from '../../../src/main/hosts/hostUpdate'
import type { SshHostUpdateOperation, SshHostUpdateOptions, SshHostUpdateResult } from '../../../src/main/hosts/sshLauncher'
import { SshFailure } from '../../../src/main/hosts/sshFailure'
import type { HostUpdateState } from '../../../src/shared/hostUpdates'

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
  async restart(id: string, version: string, options: SshHostUpdateOptions = {}): Promise<SshHostUpdateResult> {
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
  working(hostId: string): readonly string[] { return this.busy.get(hostId) ?? [] }
  async interrupt(threadId: string): Promise<void> { this.interrupted.push(threadId); this.busy.set(HOST_ID, this.working(HOST_ID).filter(id => id !== threadId)) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  set(ids: string[]): void { this.busy.set(HOST_ID, ids); for (const listener of this.listeners) listener() }
}
function setup(options: { download?: (url: string, limit: number, signal: AbortSignal) => Promise<Uint8Array> } = {}) {
  const hosts = new Hosts(), threads = new Threads()
  const updates = new HostUpdates({ hosts, threads, version: DESKTOP, releasesUrl: 'https://releases.example/download', ...options })
  const seen: HostUpdateState[][] = []
  updates.subscribe(() => seen.push(updates.state()))
  const one = (): HostUpdateState => updates.state()[0]!
  const settled = () => vi.waitFor(() => expect(['done', 'failed', 'needs']).toContain(one().phase))
  return { hosts, threads, updates, seen, one, settled }
}

describe('which hosts need an update', () => {
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
      '# Then press Stop host for forge in Settings > Hosts, and switch forge on again.'].join('\n'))
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
    hosts.steps['update-install'] = () => new Promise(resolve => { unpack = () => resolve({ type: 'update-installed', version: DESKTOP }) })
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
    hosts.steps['update-install'] = (_operation, options) => new Promise(resolve => { options.onStep?.('install'); installing = () => resolve({ type: 'update-installed', version: DESKTOP }) })
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
    expect(one().commands).toMatch(/# Then stop the host on forge, and connect to it again from Settings > Hosts\.$/u)
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
    expect(one()).toMatchObject({ phase: 'failed', error: 'forge is not connected, so nothing was updated. Switch it on in Settings > Hosts, then try again.' })
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
