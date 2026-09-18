import { WIDGET_STATE } from '../../shared/channels'
import type { WidgetSnapshot } from '../../shared/dictation'
import type { TrayState } from '../tray/trayController'
import type { RendererRole } from '../security'

export interface NativeDictationLifecycleDependencies {
  readonly delivery: {
    sendToWidget(channel: string, payload: unknown, reveal: boolean): Promise<boolean>
  }
  readonly getTrayState: () => TrayState
  readonly updateTray: (state: TrayState) => void
  readonly syncEscape: (state: Pick<WidgetSnapshot, 'status' | 'cancellable'>) => void
  readonly showWidgetWhenIdle: () => boolean
  /**
   * The widget's presentation from main's current settings. When given it
   * replaces the presentation a renderer publication carries, so a theme saved
   * mid-session cannot be undone by a publication built from older settings.
   */
  readonly presentation?: () => WidgetPresentationFields
  readonly log: (code: NativeDictationLifecycleDiagnostic) => void
}

export type WidgetPresentationFields = Pick<WidgetSnapshot, 'theme' | 'palette' | 'reducedMotion' | 'voiceCoordinator'>

export type NativeDictationLifecycleDiagnostic =
  | 'native-widget-state-delivery-failed'

/**
 * Owns native state derived from renderer dictation publications. This seam lets
 * native controls fail closed when the main renderer disappears mid-session.
 */
export class NativeDictationLifecycle {
  private lastSnapshot: WidgetSnapshot | null = null

  constructor(private readonly dependencies: NativeDictationLifecycleDependencies) {}

  publish(state: WidgetSnapshot): Promise<boolean> {
    const presented = this.present(state)
    this.lastSnapshot = presented
    this.updateNativeState(presented)
    return this.deliver(presented)
  }

  /**
   * Re-deliver the current active snapshot with fresh presentation after a
   * settings change. Idle is re-seeded by its own publication; with no active
   * session there is nothing to repaint, so this returns false.
   */
  repaint(): Promise<boolean> {
    const previous = this.lastSnapshot
    if (previous === null || previous.status === 'idle') return Promise.resolve(false)
    return this.publish(previous)
  }

  /** Whether the last published dictation snapshot left the session idle. */
  isIdle(): boolean {
    return this.lastSnapshot === null || this.lastSnapshot.status === 'idle'
  }

  rendererProcessGone(kind: RendererRole): void {
    if (kind !== 'main') return

    const previous = this.lastSnapshot
    if (previous === null) {
      this.updateNativeState({ status: 'idle', cancellable: false })
      return
    }

    const idle: WidgetSnapshot = this.present({
      status: 'idle',
      theme: previous.theme,
      palette: previous.palette,
      reducedMotion: previous.reducedMotion,
      shortcut: previous.shortcut,
      cancellable: false,
    })
    this.lastSnapshot = idle
    this.updateNativeState(idle)
    void this.deliver(idle)
  }

  private present(state: WidgetSnapshot): WidgetSnapshot {
    const presentation = this.dependencies.presentation?.()
    return presentation === undefined ? state : { ...state, ...presentation }
  }

  private updateNativeState(
    state: Pick<WidgetSnapshot, 'status' | 'cancellable'>,
  ): void {
    const currentTrayState = this.dependencies.getTrayState()
    this.dependencies.updateTray({
      ...currentTrayState,
      dictating: state.status === 'listening',
    })
    this.dependencies.syncEscape(state)
  }

  private async deliver(state: WidgetSnapshot): Promise<boolean> {
    const idle = state.status === 'idle'
    // Active states always reveal the capsule; the idle resting sliver is
    // revealed only while the idle-visibility setting is on.
    const reveal = !idle || this.dependencies.showWidgetWhenIdle()
    const delivered = await this.dependencies.delivery.sendToWidget(
      WIDGET_STATE,
      state,
      reveal,
    )
    if (!delivered) this.dependencies.log('native-widget-state-delivery-failed')
    return delivered
  }
}
