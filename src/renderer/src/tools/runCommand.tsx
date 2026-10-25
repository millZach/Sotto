import React, { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { TerminalBridge } from '../../../shared/terminal'
import { paneDomId } from '../agents/ThreadPanes'
import { useOwlFeature } from '../state/owlFeature'
import { defaultDrawerHeight, drawerShellSize } from './PaneTerminalDrawer'
import { paneTerminalChromeStore, paneTerminalStore, type PaneTerminalChromeStore } from './paneTerminalStore'
import { windowTerminalBridge, type TerminalStore } from './terminalStore'

/** Runs a reply's command in a new shell in its pane's Terminal drawer (ADR-0136); true once the shell started with it. */
export type RunCommand = (command: string) => Promise<boolean>

/** The pane's runner, or undefined where nothing may run: the feature off, a paired host's thread, outside a thread pane. */
export const RunCommandContext = createContext<RunCommand | undefined>(undefined)

export function useRunCommand(): RunCommand | undefined { return useContext(RunCommandContext) }

/** What the pane already shows of its drawer, so a new shell starts at about the size it will be drawn. */
function startSize(threadId: string, chromeStore: PaneTerminalChromeStore): { cols: number; rows: number } | undefined {
  const pane = typeof document === 'undefined' ? null : document.getElementById(paneDomId(threadId))
  if (!pane) return undefined
  const height = Math.min(chromeStore.get(threadId).height ?? defaultDrawerHeight(pane.clientHeight), Math.max(0, pane.clientHeight - 320))
  return drawerShellSize(pane.clientWidth, height)
}

/**
 * Lists the thread's drawer shells if this window has not yet, starts the shell with the command, then opens the
 * drawer. The store marks itself busy before its first wait, so the drawer opening alongside does not start a
 * second, empty shell of its own; main types the command, so no replay in the window can drop it.
 */
export async function runInDrawer(threadId: string, command: string, bridge: TerminalBridge, store: TerminalStore = paneTerminalStore,
  chromeStore: PaneTerminalChromeStore = paneTerminalChromeStore): Promise<boolean> {
  if (!store.thread(threadId)?.workspace) await store.activate(bridge, threadId)
  const started = store.create(bridge, threadId, startSize(threadId, chromeStore), command)
  chromeStore.setOpen(threadId, true)
  return started
}

/** Offers Run on the commands in a thread pane's replies, while the feature is on and the pane has a drawer (`offered`). */
export function RunCommands({ threadId, offered, children, bridge, store, chromeStore }: {
  readonly threadId: string; readonly offered: boolean; readonly children: ReactNode; readonly bridge?: TerminalBridge | undefined
  readonly store?: TerminalStore; readonly chromeStore?: PaneTerminalChromeStore
}): ReactNode {
  const enabled = useOwlFeature('run-command')
  const resolved = bridge ?? windowTerminalBridge()
  const run = useMemo<RunCommand | undefined>(() => offered && enabled && resolved ? command => runInDrawer(threadId, command, resolved, store, chromeStore) : undefined,
    [offered, enabled, resolved, threadId, store, chromeStore])
  return <RunCommandContext.Provider value={run}>{children}</RunCommandContext.Provider>
}
