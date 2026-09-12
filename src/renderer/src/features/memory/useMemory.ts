import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryBridge, MemoryCommand, MemorySnapshot } from '../../../../shared/memory'

export function useMemory(bridge: MemoryBridge | undefined) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const mounted = useRef(false)
  const pending = useRef(false)
  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const value = await bridge?.get() ?? { available: false, questionnaireCompletedAt: null, memories: [], policies: [] }
      if (mounted.current && current === generation.current) { setSnapshot(value); setError('') }
    } catch { if (mounted.current && current === generation.current) setError('Could not read memory. Try again.') }
  }, [bridge])
  useEffect(() => {
    mounted.current = true
    const stop = bridge?.onChanged(value => { ++generation.current; setSnapshot(value) })
    void refresh()
    return () => { mounted.current = false; ++generation.current; stop?.() }
  }, [bridge, refresh])
  const command = async (input: MemoryCommand): Promise<boolean> => {
    if (!bridge || pending.current) return false
    pending.current = true
    setBusy(true); setError('')
    const current = ++generation.current
    try {
      const value = await bridge.command(input)
      if (mounted.current && current === generation.current) setSnapshot(value)
      return true
    } catch (failure) {
      // Refresh stale IDs while keeping the user's unsaved text in the editor.
      await refresh()
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not save memory. Try again.')
      return false
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  return { snapshot, error, busy, command, refresh }
}
export type MemoryController = ReturnType<typeof useMemory>
