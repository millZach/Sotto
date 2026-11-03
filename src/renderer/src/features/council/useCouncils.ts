import { useCallback, useEffect, useRef, useState } from 'react'
import type { CouncilBridge, CouncilView } from '../../../../shared/council'
import { useOwlFeature } from '../../state/owlFeature'

/**
 * Whether the Council exists in this window: its Owl feature is on and main gave the window its bridge, which needs
 * this computer's threads. It then has a button in each pane's header and a tab on the pane's drawer (ADR-0177).
 */
export function useCouncilEnabled(): boolean {
  return useOwlFeature('council') && window.sotto?.council !== undefined
}

/**
 * The Councils as main keeps them (ADR-0177), read when the Council's tab opens and again whenever main says one changed. Main
 * tells only identities, so a burst of changes is read once.
 */
export function useCouncils(bridge: CouncilBridge | undefined): { readonly councils: readonly CouncilView[] | null; readonly failed: boolean; readonly read: () => void } {
  const [councils, setCouncils] = useState<readonly CouncilView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const reading = useRef<{ busy: boolean; again: boolean }>({ busy: false, again: false })
  const read = useCallback((): void => {
    if (!bridge) return
    const state = reading.current
    if (state.busy) { state.again = true; return }
    state.busy = true
    void bridge.read().then(views => { setCouncils(views); setFailed(false) }, () => setFailed(true)).finally(() => {
      state.busy = false
      if (state.again) { state.again = false; read() }
    })
  }, [bridge])
  useEffect(() => {
    if (!bridge) return
    read()
    return bridge.onChanged(() => read())
  }, [bridge, read])
  return { councils, failed, read }
}
