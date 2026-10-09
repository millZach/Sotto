import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { dictationSocketPath, parseDictationCommand, type CompositorDictationCommand } from './dictationCommand'

/** One private Unix socket per desktop session. It never listens on a network interface. */
export class DictationSocket {
  private server: Server | null = null
  private readonly clients = new Set<Socket>()
  private ownedInode: number | null = null
  private disposed = false
  readonly path: string

  constructor(runtimeDirectory: string | undefined, private readonly dispatch: (command: CompositorDictationCommand) => Promise<boolean>) {
    this.path = dictationSocketPath(runtimeDirectory)
  }

  async start(): Promise<void> {
    if (this.disposed || this.server !== null) throw new Error('Dictation command is unavailable.')
    const directory = dirname(this.path)
    try { mkdirSync(directory, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    this.secureDirectory(directory)
    await this.removeStaleSocket()
    if (this.disposed) return
    const server = createServer(socket => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.path, () => { server.removeListener('error', reject); resolve() })
      })
      this.ownedInode = lstatSync(this.path).ino
      chmodSync(this.path, 0o600)
      // Keep a native listener error out of the process's uncaught-error path.
      server.on('error', () => this.dispose())
      if (this.disposed) { server.close(); this.cleanupSocket() }
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  dispose(): void {
    this.disposed = true
    for (const client of this.clients) client.destroy()
    this.clients.clear()
    this.server?.close()
    this.server = null
    this.cleanupSocket()
  }

  private secureDirectory(directory: string): void {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error('Dictation folder is unavailable.')
    chmodSync(directory, 0o700)
  }

  private async removeStaleSocket(): Promise<void> {
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(this.path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('Dictation socket is unavailable.')
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(this.path)
      probe.setTimeout(1_000, () => { probe.destroy(); reject(new Error('Dictation socket is busy.')) })
      probe.once('connect', () => { probe.destroy(); reject(new Error('Sotto is already listening for dictation commands.')) })
      probe.once('error', error => {
        probe.destroy()
        if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') { reject(error); return }
        try {
          // A live or replaced endpoint belongs to its owner, even during recovery.
          if (lstatSync(this.path).ino !== stat.ino) throw new Error('Dictation socket changed.')
          unlinkSync(this.path)
          resolve()
        } catch (failure) { reject(failure) }
      })
    })
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

  private cleanupSocket(): void {
    if (this.ownedInode === null) return
    try {
      if (lstatSync(this.path).ino === this.ownedInode) unlinkSync(this.path)
    } catch { /* Quitting also works when the runtime directory has disappeared. */ }
    this.ownedInode = null
  }
}
