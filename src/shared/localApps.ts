export const LOCAL_APPS_GET = 'local-apps:get'
export const LOCAL_APPS_CHANGED = 'local-apps:changed'

/** What Settings shows of Let apps on this computer connect (ADR-0180). */
export interface LocalAppsState {
  /**
   * `on`: the loopback listener runs and `local-apps.json` names it. `failed`: the switch is on and the local host runs,
   * but Sotto could not read its local apps pairing, open the listener or write the file, so apps cannot connect.
   * `off` otherwise, the switch on without the local host included.
   */
  readonly phase: 'off' | 'on' | 'failed'
  readonly localHostRunning: boolean
}

export interface LocalAppsBridge {
  get(): Promise<LocalAppsState>
  onChanged(listener: (state: LocalAppsState) => void): () => void
}
