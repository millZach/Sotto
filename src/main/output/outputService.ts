import type { OutputOutcome } from '../../shared/contracts'
import type { PasteInvocation } from './pasteCommand'
import { deliveredAppName } from '../../shared/dictationRecord'

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
  readonly keepWidgetVisibleDuringPaste?: boolean
  readonly preparePasteText?: (text: string) => string
  /**
   * Reads the delivered app: the display name of the app that has focus, never a window title or anything read from
   * the app (ADR-0100). Null when it cannot be read. Unset where nothing can read it.
   */
  readonly readFocusedApp?: () => Promise<string | null>
  readonly onPasted?: () => void
  readonly log?: (event: 'delivered-app-unreadable') => void
}

/** A dictation's delivery: what happened, and the app it went into when Sotto could read one. */
export interface DictationDelivery {
  readonly outcome: OutputOutcome
  readonly app: string | null
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
    const prepared = this.prepare(text, options)
    if (prepared === null) return 'empty'
    return this.afterDeliveries(() => this.deliverImmediately(prepared.text, prepared.options))
  }

  /** The text as it will be delivered, with the options as they stand now; null when nothing is left to deliver. */
  private prepare(text: string, options: DeliveryOptions): { readonly text: string; readonly options: DeliveryOptions } | null {
    const prepared = options.autoPaste && this.dependencies.preparePasteText ? this.dependencies.preparePasteText(text) : text
    return prepared.trim().length === 0 ? null : { text: prepared, options: { ...options } }
  }

  /**
   * Delivers a dictation as `deliver` does and reads the delivered app as delivery starts, before the widget hides,
   * on the copy-only path as well as the paste path. The app is kept only when the text was pasted or copied.
   */
  async deliverDictation(text: string, options: DeliveryOptions): Promise<DictationDelivery> {
    const prepared = this.prepare(text, options)
    if (prepared === null) return { outcome: 'empty', app: null }
    return this.afterDeliveries(async () => {
      // Read while the clipboard is written, and finished before the widget hides, so the answer is the app in front.
      const app = this.readFocusedApp()
      const outcome = await this.deliverImmediately(prepared.text, prepared.options, app).catch(async (error: unknown) => {
        await app
        throw error
      })
      return { outcome, app: outcome === 'pasted' || outcome === 'copied' ? await app : null }
    })
  }

  private async readFocusedApp(): Promise<string | null> {
    const read = this.dependencies.readFocusedApp
    if (read === undefined) return null
    try {
      return deliveredAppName(await read())
    } catch {
      this.dependencies.log?.('delivered-app-unreadable')
      return null
    }
  }

  /** Runs `work` once every delivery before it has finished, so another clipboard write cannot replace text waiting to be pasted. */
  afterDeliveries<T>(work: () => T | Promise<T>): Promise<T> {
    const run = this.deliveryTail.then(work)
    this.deliveryTail = run.then(() => undefined, () => undefined)
    return run
  }

  /** `beforeHide` is waited for before the widget hides for a paste. */
  private async deliverImmediately(
    text: string,
    options: DeliveryOptions,
    beforeHide?: Promise<unknown>,
  ): Promise<OutputOutcome> {
    try {
      await this.dependencies.clipboard.writeText(text)
    } catch {
      // Wayland availability still matters if Electron's own fallback also fails.
      if (options.autoPaste && this.dependencies.clipboard.canPaste?.() === false) return 'clipboard-unavailable'
      throw new OutputClipboardError()
    }

    if (!options.autoPaste) {
      return 'copied'
    }
    if (this.dependencies.clipboard.canPaste?.() === false) {
      return 'clipboard-unavailable'
    }

    // Hide only for the paste keystroke so the previously focused app stays
    // the paste target. When the idle sliver should remain on screen, restore
    // it afterward — otherwise auto-paste permanently conceals the widget.
    let hidForPaste = false
    try {
      const invocation = this.dependencies.buildPasteInvocation()
      if (invocation === null) return 'copied'
      if (!this.dependencies.keepWidgetVisibleDuringPaste) {
        await beforeHide
        await this.dependencies.widget.hideWidget()
        hidForPaste = true
      }
      await this.dependencies.delay(options.pasteDelayMs)
      let pasted: boolean
      try {
        pasted = await this.dependencies.process.run(invocation)
      } finally {
        // A failed or lost acknowledgement can still follow dispatched input.
        await this.dependencies.delay(PASTE_SETTLE_MS)
      }
      if (pasted) this.dependencies.onPasted?.()
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
