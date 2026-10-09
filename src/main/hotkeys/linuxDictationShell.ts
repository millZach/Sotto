import type { WidgetSnapshot } from '../../shared/dictation'
import type { ShellWidgetMonitor } from '../windows/shellWidgetMonitor'
import type { WidgetEdge } from '../windows/widgetPlacementMath'
import type { CompositorDictationCommand } from './dictationCommand'
import { DictationSocket } from './dictationSocket'
import { DictationStateFile } from './dictationStateFile'

interface ExitSource {
  on(event: 'exit', listener: () => void): unknown
  off(event: 'exit', listener: () => void): unknown
}

/** Constructed only on Linux. Process exit also covers Electron's forced app.exit(). */
export class LinuxDictationShell {
  private readonly socket: DictationSocket
  private stateFile: DictationStateFile | null = null
  private stopped = false
  private readonly onExit = (): void => this.dispose()

  constructor(
    private readonly runtimeDirectory: string | undefined,
    private readonly monitor: ShellWidgetMonitor,
    dispatch: (command: CompositorDictationCommand) => Promise<boolean>,
    private readonly edge: () => WidgetEdge,
    private readonly onFailure: () => void,
    private readonly exitSource: ExitSource = process,
  ) {
    this.socket = new DictationSocket(runtimeDirectory, dispatch)
    this.exitSource.on('exit', this.onExit)
    this.monitor.start()
  }

  async start(): Promise<void> {
    if (this.stopped) return
    await this.socket.start()
    if (this.stopped) return
    this.stateFile = new DictationStateFile(this.runtimeDirectory, this.edge(), this.onFailure)
  }

  publish(state: WidgetSnapshot): void { this.stateFile?.publish(state) }
  place(edge: WidgetEdge): void { this.stateFile?.place(edge) }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    // The state publisher unlinks synchronously, before any other teardown can fail.
    this.stateFile?.dispose()
    this.stateFile = null
    this.monitor.dispose()
    this.socket.dispose()
    this.exitSource.off('exit', this.onExit)
  }
}
