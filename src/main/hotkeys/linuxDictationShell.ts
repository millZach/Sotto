import type { WidgetSnapshot } from '../../shared/dictation'
import type { ShellWidgetMonitor } from '../windows/shellWidgetMonitor'
import type { WidgetEdge } from '../windows/widgetPlacementMath'
import type { CompositorDictationCommand } from './dictationCommand'
import { DictationSocket } from './dictationSocket'
import { DictationStateFile } from './dictationStateFile'
import { readLinuxProcessStart } from './linuxProcessStart'

interface ExitSource {
  on(event: 'exit', listener: () => void): unknown
  off(event: 'exit', listener: () => void): unknown
}

/** Constructed only on Linux. Process exit also covers Electron's forced app.exit(). */
export class LinuxDictationShell {
  private socket: DictationSocket | null = null
  private stateFile: DictationStateFile | null = null
  private stopped = false
  private disposed = false
  private readonly pidStart: number | undefined
  private readonly onExit = (): void => {
    this.stopped = true
    this.removeStateFile()
    this.exitSource.off('exit', this.onExit)
  }

  constructor(
    private readonly runtimeDirectory: string | undefined,
    private readonly monitor: ShellWidgetMonitor,
    private readonly dispatch: (command: CompositorDictationCommand) => Promise<boolean>,
    private readonly edge: () => WidgetEdge,
    private readonly log: (event: 'native-dictation-state-write-failed' | 'native-dictation-pid-start-unavailable') => void,
    private readonly exitSource: ExitSource = process,
  ) {
    this.pidStart = readLinuxProcessStart(this.log)
    this.exitSource.on('exit', this.onExit)
    this.monitor.start()
  }

  async start(): Promise<void> {
    if (this.stopped) return
    // Runtime validation belongs to the controller's guarded command startup,
    // so an unavailable compositor endpoint cannot prevent Sotto from opening.
    try {
      this.socket = new DictationSocket(this.runtimeDirectory, this.dispatch)
      await this.socket.start()
      if (this.stopped) return
      this.stateFile = new DictationStateFile(this.runtimeDirectory, this.edge(),
        () => this.log('native-dictation-state-write-failed'), this.pidStart,
        live => this.monitor.setStateFileLive(live))
    } catch (error) {
      this.removeStateFile()
      this.socket?.dispose()
      throw error
    }
  }

  publish(state: WidgetSnapshot): void { this.stateFile?.publish(state) }
  place(edge: WidgetEdge): void { this.stateFile?.place(edge) }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopped = true
    this.removeStateFile()
    this.monitor.dispose()
    this.socket?.dispose()
    this.exitSource.off('exit', this.onExit)
  }

  private removeStateFile(): void {
    // At process exit, only synchronous file cleanup is safe. Native handle
    // teardown belongs to runtime disposal, before Electron starts exiting.
    this.stateFile?.dispose()
    this.stateFile = null
    this.monitor.setStateFileLive(false)
  }
}
