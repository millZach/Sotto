import React, { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from './Button'

export function SideSheet({ title, onClose, children }: {
  readonly title: string
  readonly onClose: () => void
  readonly children: ReactNode
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    if (element?.showModal) element.showModal()
    else element?.setAttribute('open', '')
    return () => {
      element?.close?.()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return <dialog ref={dialog} className="side-sheet" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose() }}>
    <header className="side-sheet__head"><h2 id={titleId}>{title}</h2><Button variant="ghost" iconOnly aria-label={`Close ${title}`} onClick={onClose}><X size={18} /></Button></header>
    <div className="side-sheet__body">{children}</div>
  </dialog>
}
