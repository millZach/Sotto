import type { OutputOutcome } from '../../shared/contracts'
import { buildPasteInvocation, type PasteInvocation } from './pasteCommand'

export interface ClipboardAdapter {
  writeText(text: string): void
}

export interface WidgetAdapter {
  hideWidget(): void | Promise<void>
}

export interface PasteProcessAdapter {
  run(invocation: PasteInvocation): boolean | Promise<boolean>
}

export interface OutputServiceDependencies {
  readonly clipboard: ClipboardAdapter
  readonly widget: WidgetAdapter
  readonly delay: (milliseconds: number) => void | Promise<void>
  readonly process: PasteProcessAdapter
}

export interface SpawnedProcessLike {
  once(event: 'error', listener: (error: Error) => void): SpawnedProcessLike
  once(
    event: 'exit',
    listener: (code: number | null, signal: string | null) => void,
  ): SpawnedProcessLike
}

export type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: {
    readonly shell: false
    readonly windowsHide: true
    readonly stdio: 'ignore'
  },
) => SpawnedProcessLike

export class OutputClipboardError extends Error {
  readonly code = 'OUTPUT_CLIPBOARD_FAILED'

  constructor() {
    super('Clipboard output failed')
    this.name = 'OutputClipboardError'
  }
}

export function createSpawnProcessAdapter(spawn: SpawnProcess): PasteProcessAdapter {
  return {
    run(invocation): Promise<boolean> {
      return new Promise((resolve) => {
        let settled = false
        const finish = (successful: boolean): void => {
          if (!settled) {
            settled = true
            resolve(successful)
          }
        }

        try {
          const child = spawn(invocation.executable, invocation.args, {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          })
          child.once('error', () => finish(false))
          child.once('exit', (code, signal) => finish(code === 0 && signal === null))
        } catch {
          finish(false)
        }
      })
    },
  }
}

export class OutputService {
  constructor(private readonly dependencies: OutputServiceDependencies) {}

  async deliver(
    text: string,
    options: { readonly autoPaste: boolean; readonly pasteDelayMs: number },
  ): Promise<OutputOutcome> {
    if (text.trim().length === 0) {
      return 'empty'
    }

    try {
      this.dependencies.clipboard.writeText(text)
    } catch {
      throw new OutputClipboardError()
    }

    if (!options.autoPaste) {
      return 'copied'
    }

    try {
      await this.dependencies.widget.hideWidget()
      await this.dependencies.delay(options.pasteDelayMs)
      const pasted = await this.dependencies.process.run(buildPasteInvocation())
      return pasted ? 'pasted' : 'copied'
    } catch {
      return 'copied'
    }
  }
}
