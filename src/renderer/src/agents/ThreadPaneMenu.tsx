import React, { type ReactNode } from 'react'
import type { AgentState } from '../../../shared/agents'
import { usePaneTerminalMenuItem } from '../tools/PaneTerminalToggle'
import { TOOLS_OPENER, useToolsMenu } from '../tools/toolsMenu'
import type { ToolsPanelStore } from '../tools/toolsPanelStore'
import { PaneMenu, type PaneMenuItem } from './PaneMenu'

/**
 * A thread pane's one ··· menu (ADR-0163): the layout first (Open beside, Tools, the Terminal drawer, then what the pane
 * area adds: Zoom pane, the arrangement and Move pane), then the thread's own actions in their groups. Tools and the
 * drawer read stores that change often, so they are read here rather than in the pane, and a change re-renders the
 * button and its menu alone.
 */
export function ThreadPaneMenu({ threadId, beside, layout, groups, tools, terminal, toolsStore, state }: {
  readonly threadId: string
  /** Open beside, first of the layout rows; absent where the page cannot split. */
  readonly beside?: PaneMenuItem | undefined
  /** The pane area's own rows, after Tools and the drawer. */
  readonly layout: readonly PaneMenuItem[]
  /** The thread's own rows, in their groups. */
  readonly groups: readonly (readonly PaneMenuItem[])[]
  /** The focused pane lists Tools, as it carried the Tools toggle. */
  readonly tools: boolean
  /** The pane has its own Terminal drawer; a thread on a paired host has none. */
  readonly terminal: boolean
  /** The window's state as the pane has it, for what Tools' dot says about this thread. */
  readonly state: AgentState
  readonly toolsStore?: ToolsPanelStore | undefined
}): ReactNode {
  const toolsMenu = useToolsMenu({ threadId, offered: tools, store: toolsStore, state })
  const drawer = usePaneTerminalMenuItem(threadId, terminal)
  const rows = [beside, toolsMenu?.item, drawer, ...layout].filter((item): item is PaneMenuItem => item != null)
  return <PaneMenu groups={[rows, ...groups]} mark={toolsMenu?.mark} description={toolsMenu?.description}
    opens={toolsMenu ? TOOLS_OPENER : undefined} buttonRef={toolsMenu?.buttonRef} />
}
