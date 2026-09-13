import { useCallback, useEffect, useRef, useState } from 'react'

const FEEDBACK_MS = 1_600

/** A short-lived status message, cleared after a moment and on unmount. */
export function useTransientFlag(): [string | null, (value: string) => void] {
  const [value, setValue] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const show = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current)
    setValue(next)
    timer.current = setTimeout(() => { setValue(null); timer.current = null }, FEEDBACK_MS)
  }, [])
  return [value, show]
}

export async function writeClipboard(text: string): Promise<void> {
  // The production renderer deliberately denies browser clipboard permission.
  // Use the same main-owned, copy-only output path as the History page.
  if (window.sotto?.deliverOutput) {
    const result = await window.sotto.deliverOutput({ text, autoPaste: false, pasteDelayMs: 50 })
    if (result !== 'copied') throw new Error('Clipboard unavailable')
    return
  }
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
  await navigator.clipboard.writeText(text)
}
