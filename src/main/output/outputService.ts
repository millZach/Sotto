import type { OutputOutcome } from '../../shared/contracts'
import type { PasteInvocation } from './pasteCommand'

export interface ClipboardAdapter {
  writeText(text: string): void | Promise<void>
  canPaste?(): boolean
}

export interface WidgetAdapter {
  hideWidget(): void | Promise<void>
  showWidget(): void | Promise<void>
}

export interface PasteProcessAdapter {
  run(invocation: PasteInvocation): boolean | Promise<boolean>
}

export interface OutputServiceDependencies {
  readonly clipboard: ClipboardAdapter
  readonly widget: WidgetAdapter
  readonly delay: (milliseconds: number) => void | Promise<void>
  readonly process: PasteProcessAdapter
  readonly buildPasteInvocation: () => PasteInvocation | null
}

interface DeliveryOptions {
  readonly autoPaste: boolean
  readonly pasteDelayMs: number
  readonly restoreWidget?: boolean
}

export interface SpawnedProcessLike {
  once(event: 'error', listener: (error: Error) => void): SpawnedProcessLike
  once(
    event: 'exit',
    listener: (code: number | null, signal: string | null) => void,
  ): SpawnedProcessLike
  kill(): boolean
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

export const PASTE_SETTLE_MS = 150

export const PASTE_PROCESS_TIMEOUT_MS = 5_000

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
        let timeout: ReturnType<typeof setTimeout> | undefined
        const finish = (successful: boolean): void => {
          if (!settled) {
            settled = true
            if (timeout !== undefined) {
              clearTimeout(timeout)
            }
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
          if (!settled) {
            timeout = setTimeout(() => {
              finish(false)
              try {
                child.kill()
              } catch {
                // Timeout remains a finite copied outcome even if termination fails.
              }
            }, PASTE_PROCESS_TIMEOUT_MS)
          }
        } catch {
          finish(false)
        }
      })
    },
  }
}

export class OutputService {
  private deliveryTail: Promise<void> = Promise.resolve()

  constructor(private readonly dependencies: OutputServiceDependencies) {}

  async deliver(
    text: string,
    options: DeliveryOptions,
  ): Promise<OutputOutcome> {
    if (text.trim().length === 0) {
      return 'empty'
    }

    const snapshot = { ...options }
    const delivery = this.deliveryTail.then(() => this.deliverImmediately(text, snapshot))
    this.deliveryTail = delivery.then(() => undefined, () => undefined)
    return delivery
  }

  private async deliverImmediately(
    text: string,
    options: DeliveryOptions,
  ): Promise<OutputOutcome> {
    try {
      await this.dependencies.clipboard.writeText(text)
    } catch {
      throw new OutputClipboardError()
    }

    if (!options.autoPaste || this.dependencies.clipboard.canPaste?.() === false) {
      return 'copied'
    }

    // Hide only for the paste keystroke so the previously focused app stays
    // the paste target. When the idle sliver should remain on screen, restore
    // it afterward — otherwise auto-paste permanently conceals the widget.
    let hidForPaste = false
    try {
      const invocation = this.dependencies.buildPasteInvocation()
      if (invocation === null) return 'copied'
      await this.dependencies.widget.hideWidget()
      hidForPaste = true
      await this.dependencies.delay(options.pasteDelayMs)
      let pasted: boolean
      try {
        pasted = await this.dependencies.process.run(invocation)
      } finally {
        // A failed or lost acknowledgement can still follow dispatched input.
        await this.dependencies.delay(PASTE_SETTLE_MS)
      }
      return pasted ? 'pasted' : 'copied'
    } catch {
      return 'copied'
    } finally {
      if (hidForPaste && options.restoreWidget === true) {
        try {
          await this.dependencies.widget.showWidget()
        } catch {
          // Paste already finished; a restore failure must not change the outcome.
        }
      }
    }
  }
}
