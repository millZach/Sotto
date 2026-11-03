import { useEffect, useState } from 'react'
import type { ProductEventsState } from '../../../../shared/productEvents'

/** Whether this build can send product events and what turned them off, read once from main; null until it answers, or without a bridge. */
export function useProductEventsState(): ProductEventsState | null {
  const [state, setState] = useState<ProductEventsState | null>(null)
  useEffect(() => {
    let live = true
    void window.sotto?.productEvents?.state().then(answer => { if (live) setState(answer) }, () => undefined)
    return () => { live = false }
  }, [])
  return state
}
