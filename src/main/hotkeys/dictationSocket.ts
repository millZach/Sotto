import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, type Stats } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { dictationSocketPath, parseDictationCommand, type CompositorDictationCommand } from './dictationCommand'
import { assertDictationDirectories, validateDictationRuntime, type DictationDirectory } from './dictationRuntime'

interface Endpoint {
  stat: Stats
  target: string | null
  socketStat: Stats | null
}

/** The public command link is separate from libuv's automatically unlinked listening path. */
export class DictationSocket {
  private server: Server | null = null
  private readonly clients = new Set<Socket>()
  private ownedEndpoint: Stats | null = null
  private disposed = false
  private directories: DictationDirectory[] = []
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
    this.directories.push({ path: directory, stat: lstatSync(directory) })
    await this.removeStaleSocket()
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
    let endpoint: Endpoint
    try { endpoint = this.readEndpoint() } catch (error) {
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
          const current = this.readEndpoint()
          if (!this.sameFile(current.stat, endpoint.stat) || current.target !== endpoint.target ||
            !this.sameFile(current.socketStat, endpoint.socketStat)) throw new Error('Dictation socket changed.')
          unlinkSync(this.path)
          if (endpoint.target !== null && endpoint.socketStat !== null) unlinkSync(join(dirname(this.path), endpoint.target))
          resolve()
        } catch (failure) { reject(failure) }
      })
    })
  }

  private readEndpoint(): Endpoint {
    const stat = lstatSync(this.path)
    if (stat.uid !== process.getuid?.()) throw new Error('Dictation socket is unavailable.')
    // Recover sockets left by the earlier direct-binding implementation too.
    if (stat.isSocket()) return { stat, target: null, socketStat: stat }
    if (!stat.isSymbolicLink()) throw new Error('Dictation socket is unavailable.')
    const target = readlinkSync(this.path)
    if (!/^dictation-\d+-[a-f0-9]{8}\.sock$/.test(target)) throw new Error('Dictation socket is unavailable.')
    let socketStat: Stats | null = null
    try { socketStat = lstatSync(join(dirname(this.path), target)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (socketStat !== null && (!socketStat.isSocket() || socketStat.uid !== process.getuid?.())) {
      throw new Error('Dictation socket is unavailable.')
    }
    return { stat, target, socketStat }
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
      if (input.length > 16) { socket.removeAllListeners('data'); socket.end('invalid\n'); return }
      if (!input.includes('\n')) return
      socket.removeAllListeners('data')
      const command = parseDictationCommand(input.slice(0, -1))
      if (command === null || !input.endsWith('\n')) { socket.end('invalid\n'); return }
      void this.dispatch(command).then(
        delivered => socket.end(delivered ? 'ok\n' : 'unavailable\n'),
        () => socket.end('unavailable\n'),
      )
    })
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
