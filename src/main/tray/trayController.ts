import { t } from '@lingui/core/macro'

export interface TrayMenuItem {
  readonly type?: 'normal' | 'separator' | 'checkbox'
  readonly label?: string
  readonly checked?: boolean
  readonly click?: () => void
}

export interface TrayAdapter {
  setMenu(items: readonly TrayMenuItem[]): void
  destroy(): void
}

export interface TrayActions {
  toggleDictation(): void
  /** False while dictation is turned off (ADR-0107): the menu leaves Start/Stop Dictation out. */
  dictationOn?: () => boolean
  setAutoPaste(enabled: boolean): void
  show(): void
  /** Windows has no application menu, so the tray carries "Check for Updates…". */
  checkForUpdates?: () => void
  showTurnRecords?: () => void
  quit(): void
}

export interface TrayState {
  readonly dictating: boolean
  readonly autoPaste: boolean
}

export class TrayController {
  private disposed = false

  constructor(
    private readonly tray: TrayAdapter,
    private readonly actions: TrayActions,
  ) {}

  /** Builds the menu in the interface language shown now; main calls it again when that language changes (ADR-0123). */
  update(state: TrayState): void {
    if (this.disposed) {
      return
    }

    this.tray.setMenu([
      ...(this.actions.dictationOn?.() === false
        ? []
        : [{
            type: 'normal' as const,
            label: state.dictating ? t`Stop Dictation` : t`Start Dictation`,
            click: this.actions.toggleDictation,
          }]),
      { type: 'normal', label: t`Show Sotto`, click: this.actions.show },
      ...(this.actions.checkForUpdates
        ? [{ type: 'normal' as const, label: t`Check for Updates…`, click: this.actions.checkForUpdates }]
        : []),
      ...(this.actions.showTurnRecords
        ? [{ label: t`Show recent turn records`, click: this.actions.showTurnRecords }]
        : []),
      { type: 'separator' },
      {
        type: 'checkbox',
        label: t`Auto-paste`,
        checked: state.autoPaste,
        click: () => this.actions.setAutoPaste(!state.autoPaste),
      },
      { type: 'separator' },
      { type: 'normal', label: t`Quit`, click: this.actions.quit },
    ])
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.tray.destroy()
  }
}
