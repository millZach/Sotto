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
  readonly log: (code: NativeDictationLifecycleDiagnostic) => void
}

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
    this.lastSnapshot = state
    this.updateNativeState(state)
    return this.deliver(state)
  }

  rendererProcessGone(kind: RendererRole): void {
    if (kind !== 'main') return

    const previous = this.lastSnapshot
    if (previous === null) {
      this.updateNativeState({ status: 'idle', cancellable: false })
      return
    }

    const idle: WidgetSnapshot = {
      status: 'idle',
      theme: previous.theme,
      reducedMotion: previous.reducedMotion,
      shortcut: previous.shortcut,
      cancellable: false,
    }
    this.lastSnapshot = idle
    this.updateNativeState(idle)
    void this.deliver(idle)
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
    // Every state reveals the widget: active sessions show the capsule and
    // idle shows the persistent resting sliver.
    const delivered = await this.dependencies.delivery.sendToWidget(
      WIDGET_STATE,
      state,
      true,
    )
    if (!delivered) this.dependencies.log('native-widget-state-delivery-failed')
    return delivered
  }
}
