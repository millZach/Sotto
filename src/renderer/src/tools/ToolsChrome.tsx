import React, { type ReactNode } from 'react'

export interface ToolsChromeProps {
  /** What is open on this surface, in a word or a short phrase. */
  readonly title?: ReactNode
  /** A quiet fact beside the title: a count, a branch, a folder. */
  readonly detail?: ReactNode
  /** The surface's own actions, at the line's right end. */
  readonly children?: ReactNode
  readonly className?: string
}

/**
 * A surface's one line of chrome above its work: what is open, then that surface's actions. Surfaces whose line
 * is a row of tabs (pages, shells) draw their own with the same class.
 */
export function ToolsChrome({ title, detail, children, className }: ToolsChromeProps): ReactNode {
  return <div className={className ? `tools-chrome ${className}` : 'tools-chrome'}>
    {title !== undefined ? <span className="tools-chrome__title">{title}</span> : null}
    {detail ? <span className="tools-chrome__detail">{detail}</span> : null}
    {children ? <div className="tools-chrome__actions">{children}</div> : null}
  </div>
}
