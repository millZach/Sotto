import React, { type ReactNode } from 'react'

export interface ToolsChromeProps {
  /** What is open on this surface, in a word or a short phrase. */
  readonly title?: ReactNode
  /** A quiet fact beside the title: a count, a branch, a folder. */
  readonly detail?: ReactNode
  /** The surface's own actions, at the line's right end. */
  readonly children?: ReactNode
}

/**
 * A surface's one line of chrome above its work: what is open, then that surface's actions. Surfaces whose line
 * is a row of tabs (pages, shells) draw their own with the same class.
 */
export function ToolsChrome({ title, detail, children }: ToolsChromeProps): ReactNode {
  return <div className="tools-chrome">
    <ToolsChromeLead title={title} detail={detail} />
    {children ? <div className="tools-chrome__actions">{children}</div> : null}
  </div>
}

/**
 * The line's title and its quiet fact. The fact shows as a readable run of at least six characters or not at all:
 * when that much does not fit beside the title it drops to a second line the lead never shows, and stays in the
 * accessible text.
 */
export function ToolsChromeLead({ title, detail }: Pick<ToolsChromeProps, 'title' | 'detail'>): ReactNode {
  return <span className="tools-chrome__lead">
    {title !== undefined ? <span className="tools-chrome__title">{title}</span> : null}
    {detail ? <span className="tools-chrome__detail">{detail}</span> : null}
  </span>
}
