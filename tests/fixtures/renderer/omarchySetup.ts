import type { OmarchyPieceState, OmarchySetupBridge, OmarchySetupState } from '../../../src/shared/omarchySetup'

export function setupState(status: OmarchyPieceState['status'] = 'missing'): OmarchySetupState {
  const piece = () => ({ status, message: '', owned: status === 'done' || status === 'stale' })
  return { pieces: { keys: piece(), owl: piece(), theme: piece() }, busy: false, keyConflicts: [], voxtype: true, shellRunning: true, notice: '' }
}
export function setupBridgeFixture(initial = setupState()) {
  let state = initial
  const listeners = new Set<(state: OmarchySetupState) => void>()
  const change = (next: OmarchySetupState) => { state = next; for (const listener of listeners) listener(next) }
  const focusListeners = new Set<() => void>()
  const focus = () => { for (const listener of focusListeners) listener() }
  const calls: unknown[] = []
  const bridge: OmarchySetupBridge = {
    get: async () => state,
    command: async command => {
      calls.push(command)
      const next = structuredClone(state)
      const pieces = command.type === 'update-owl' ? ['owl'] as const : command.pieces
      for (const piece of pieces) {
        next.pieces[piece] = command.type === 'remove' ? { status: 'missing', owned: false, message: 'Removed.' }
          : { status: command.type === 'setup' && piece === 'keys' && command.keys === 'keep' ? 'skipped' : 'done', owned: true, message: '' }
      }
      change(next)
      return next
    },
    onFocus: listener => { focusListeners.add(listener); return () => { focusListeners.delete(listener) } },
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { bridge, change, calls, focus }
}
