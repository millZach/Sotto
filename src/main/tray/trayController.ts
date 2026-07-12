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
  setAutoPaste(enabled: boolean): void
  show(): void
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

  update(state: TrayState): void {
    if (this.disposed) {
      return
    }

    this.tray.setMenu([
      {
        type: 'normal',
        label: state.dictating ? 'Stop Dictation' : 'Start Dictation',
        click: this.actions.toggleDictation,
      },
      { type: 'normal', label: 'Show TalkType', click: this.actions.show },
      { type: 'separator' },
      {
        type: 'checkbox',
        label: 'Auto-paste',
        checked: state.autoPaste,
        click: () => this.actions.setAutoPaste(!state.autoPaste),
      },
      { type: 'separator' },
      { type: 'normal', label: 'Quit', click: this.actions.quit },
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
