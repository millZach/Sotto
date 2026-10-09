// Same-user processes are trusted: they can already drive Sotto, read its settings
// and control Hyprland through $XDG_RUNTIME_DIR/hypr/. This socket protects against
// other users and unsafe runtime folders, not same-user renames in a private 0700 folder.
import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, type Stats } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { DICTATION_REQUEST_MAX_BYTES, DICTATION_STAMP_FUTURE_SKEW_NS, DICTATION_STAMP_MAX_AGE_NS, dictationSocketPath, parseDictationRequest, type CompositorDictationCommand, type DictationRequest } from './dictationCommand'
import { assertDictationDirectories, validateDictationRuntime, type DictationDirectory } from './dictationRuntime'
import { privateDictationSocketPattern, readDictationEndpoint, validateDictationFolder, type DictationEndpoint } from './dictationEndpoint'

/** The public command link is separate from libuv's automatically unlinked listening path. */
export class DictationSocket {
  private server: Server | null = null
  private readonly clients = new Set<Socket>()
  private ownedEndpoint: Stats | null = null
  private disposed = false
  private directories: DictationDirectory[] = []
  private latestEndStamp: bigint | null = null
  private delivery: Promise<unknown> = Promise.resolve()
  readonly path: string
  private readonly listeningPath: string

  constructor(private readonly runtimeDirectory: string | undefined, private readonly dispatch: (command: CompositorDictationCommand) => Promise<boolean>) {
    this.path = dictationSocketPath(runtimeDirectory)
    this.listeningPath = join(dirname(this.path), `dictation-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
  }

  async start(): Promise<void> {
    if (this.disposed || this.server !== null) throw new Error('Dictation command is unavailable.')
    this.directories = validateDictationRuntime(this.runtimeDirectory)
    const directory = dirname(this.path)
    try { mkdirSync(directory, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    this.secureDirectory(directory)
    this.directories.push(validateDictationFolder(directory))
    await this.removeStaleSocket()
    await this.removeUnpublishedSockets()
    if (this.disposed) return
    assertDictationDirectories(this.directories)
    const server = createServer(socket => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.listeningPath, () => { server.removeListener('error', reject); resolve() })
      })
      // Keep a native listener error out of the process's uncaught-error path.
      server.on('error', () => this.dispose())
      if (this.disposed) { server.close(); return }
      assertDictationDirectories(this.directories)
      chmodSync(this.listeningPath, 0o600)
      // symlink is an atomic, exclusive publication: a concurrent listener or a
      // replacement endpoint wins rather than being overwritten by this instance.
      symlinkSync(basename(this.listeningPath), this.path)
      this.ownedEndpoint = lstatSync(this.path)
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  dispose(): void {
    this.disposed = true
    for (const client of this.clients) client.destroy()
    this.clients.clear()
    this.cleanupEndpoint()
    this.server?.close()
    this.server = null
  }

  private secureDirectory(directory: string): void {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error('Dictation folder is unavailable.')
    chmodSync(directory, 0o700)
  }

  private async removeStaleSocket(): Promise<void> {
    let endpoint: DictationEndpoint
    try { endpoint = readDictationEndpoint(this.path, true) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(this.path)
      probe.setTimeout(1_000, () => { probe.destroy(); reject(new Error('Dictation socket is busy.')) })
      probe.once('connect', () => { probe.destroy(); reject(new Error('Sotto is already listening for dictation commands.')) })
      probe.once('error', error => {
        probe.destroy()
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ECONNREFUSED' && !(code === 'ENOENT' && endpoint.target !== null && endpoint.socketStat === null)) {
          reject(error); return
        }
        try {
          // A live or replaced endpoint belongs to its owner, even during recovery.
          assertDictationDirectories(this.directories)
          const current = readDictationEndpoint(this.path, true)
          if (!this.sameFile(current.stat, endpoint.stat) || current.target !== endpoint.target ||
            !this.sameFile(current.socketStat, endpoint.socketStat)) throw new Error('Dictation socket changed.')
          unlinkSync(this.path)
          if (endpoint.target !== null && endpoint.socketStat !== null) unlinkSync(join(dirname(this.path), endpoint.target))
          resolve()
        } catch (failure) { reject(failure) }
      })
    })
  }

  private isPublishedTarget(name: string): boolean {
    try { return readDictationEndpoint(this.path, true).target === name } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async removeUnpublishedSockets(): Promise<void> {
    const directory = dirname(this.path)
    for (const name of readdirSync(directory)) {
      if (!privateDictationSocketPattern.test(name) || this.isPublishedTarget(name)) continue
      const path = join(directory, name)
      let stat: Stats
      try { stat = lstatSync(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!stat.isSocket() || stat.uid !== process.getuid?.()) continue
      const dead = await new Promise<boolean>(resolve => {
        const probe = createConnection(path)
        probe.setTimeout(1_000, () => { probe.destroy(); resolve(false) })
        probe.once('connect', () => { probe.destroy(); resolve(false) })
        probe.once('error', error => {
          probe.destroy()
          resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED')
        })
      })
      if (!dead) continue
      assertDictationDirectories(this.directories)
      try {
        if (!this.isPublishedTarget(name) && this.sameFile(lstatSync(path), stat)) unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  private sameFile(current: Stats | null, previous: Stats | null): boolean {
    if (current === null || previous === null) return current === previous
    return current.dev === previous.dev && current.ino === previous.ino &&
      current.uid === previous.uid && current.mode === previous.mode
  }

  private accept(socket: Socket): void {
    if (this.disposed || this.clients.size >= 32) { socket.destroy(); return }
    this.clients.add(socket)
    socket.once('close', () => this.clients.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(1_000, () => socket.destroy())
    let input = ''
    socket.setEncoding('utf8')
    socket.on('data', data => {
      input += data
      if (Buffer.byteLength(input) > DICTATION_REQUEST_MAX_BYTES) { socket.removeAllListeners('data'); socket.end('invalid\n'); return }
      if (!input.includes('\n')) return
      socket.removeAllListeners('data')
      const request = parseDictationRequest(input.slice(0, -1))
      if (request === null || !input.endsWith('\n') || !this.acceptStamp(request)) { socket.end('invalid\n'); return }
      // Keep delivery ordered too: recreating the main window must not let a
      // later release dispatch first, followed by a delayed microphone start.
      const delivery = this.delivery.then(() => {
        if (this.disposed) return false
        if (request.command === 'start' && request.at !== undefined &&
          this.latestEndStamp !== null && request.at <= this.latestEndStamp) return true
        return this.dispatch(request.command)
      })
      this.delivery = delivery.catch(() => {})
      void delivery.then(
        delivered => socket.end(delivered ? 'ok\n' : 'unavailable\n'),
        () => socket.end('unavailable\n'),
      )
    })
  }

  private acceptStamp({ command, at }: DictationRequest): boolean {
    if (at === undefined) return true
    const now = BigInt(Date.now()) * 1_000_000n
    if (at < now - DICTATION_STAMP_MAX_AGE_NS || at > now + DICTATION_STAMP_FUTURE_SKEW_NS) return false
    if ((command === 'stop' || command === 'cancel') && (this.latestEndStamp === null || at > this.latestEndStamp)) {
      // Remember even an unpaired release; a late key-down must not open the mic.
      this.latestEndStamp = at
    }
    return true
  }

  private cleanupEndpoint(): void {
    if (this.ownedEndpoint === null) return
    try {
      assertDictationDirectories(this.directories)
      const stat = lstatSync(this.path)
      if (stat.isSymbolicLink() && this.sameFile(stat, this.ownedEndpoint) &&
        readlinkSync(this.path) === basename(this.listeningPath)) unlinkSync(this.path)
    } catch { /* Quitting also works when the runtime directory has disappeared. */ }
    this.ownedEndpoint = null
  }
}
