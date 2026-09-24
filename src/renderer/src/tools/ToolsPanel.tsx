import React, { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Copy, Folder, FolderGit2, FolderOutput, FolderTree, GitBranch, GitCompare, GitPullRequest, Globe, Maximize2, Minimize2, PanelRight, Pin, PinOff, SquareTerminal, Users, X, type LucideIcon } from 'lucide-react'
import { type AgentProject, type AgentState, type AgentThread } from '../../../shared/agents'
import type { BrowserBridge } from '../../../shared/browser'
import type { FilesBridge } from '../../../shared/files'
import type { GitChangesBridge } from '../../../shared/gitChanges'
import type { TerminalBridge } from '../../../shared/terminal'
import type { SubagentsBridge } from '../../../shared/subagents'
import { AgentsSurface } from './AgentsSurface'
import { useOptionalAgents, type AgentConnection } from '../agents/AgentContext'
import { chordMatches } from '../agents/branchToolbar.logic'
import { useOptionalApp } from '../state/AppContext'
import type { SottoPlatform } from '../../../shared/platform'
import { changesChord, chordBelongsElsewhere } from './changesShortcut'
import { describeWorkingCopy } from '../agents/ThreadWorkingCopy'
import { BrowserTaskPreview } from './BrowserTaskPreview'
import { BrowserSurface } from './BrowserSurface'
import { useBrowserTasks } from './browserStore'
import { ChangesSurface } from './ChangesSurface'
import { PullRequestSurface } from './PullRequestSurface'
import { useThreadChanges } from './changesStore'
import { revealLabel } from './FilePreview'
import { FilesSurface, useThreadFiles } from './FilesSurface'
import { useProactiveChanges } from './proactivePanels'
import type { PathAction } from './filesBrowser'
import { TerminalSurface } from './TerminalSurface'
import { ToolsChrome } from './ToolsChrome'
import type { TerminalViewFactory } from './terminalStore'
import { useTerminalViewFactory } from './terminalViewLoader'
import {
  TOOL_SURFACES, TOOLS_PANEL_MAX_WIDTH, TOOLS_PANEL_MIN_PANE_WIDTH, TOOLS_PANEL_MIN_WIDTH, toolsPanelStore, toolsTarget,
  useToolsPanelChrome, type ToolSurfaceId, type ToolsPanelStore,
} from './toolsPanelStore'
import './tools.css'
import './toolsRail.css'

const TOOLS_PANEL_ID = 'sotto-tools-panel'
const FEEDBACK_MS = 1_600
const RESIZE_STEP = 24
const OVERLAY_GUTTER = 48

export interface ToolsPanelProps {
  readonly focusedThreadId: string | null
  readonly state: AgentState
  /** Accepted for the shared tools slot; Files never sends agent commands or changes selection. */
  readonly command?: AgentConnection['command']
  readonly files?: FilesBridge | undefined
  readonly gitChanges?: GitChangesBridge | undefined
  readonly terminal?: TerminalBridge | undefined
  readonly browser?: BrowserBridge | undefined
  readonly subagents?: SubagentsBridge | undefined
  /** How a terminal session is drawn; tests pass a light stand-in for xterm. */
  readonly terminalView?: TerminalViewFactory
  readonly store?: ToolsPanelStore
}

function bridgeFiles(): FilesBridge | undefined {
  return (window.sotto as { files?: FilesBridge } | undefined)?.files
}

function bridgeChanges(): GitChangesBridge | undefined {
  return (window.sotto as { gitChanges?: GitChangesBridge } | undefined)?.gitChanges
}

function bridgeBrowser(): BrowserBridge | undefined {
  return (window.sotto as { browser?: BrowserBridge } | undefined)?.browser
}

function bridgeTerminal(): TerminalBridge | undefined {
  return (window.sotto as { terminal?: TerminalBridge } | undefined)?.terminal
}

function bridgePlatform(): string | undefined {
  return (window.sotto as { platform?: string } | undefined)?.platform
}

/** The area the panel shares with the panes: its parent, or the parent of a wrapper that holds only the panel. */
function workspaceArea(panel: HTMLElement | null): HTMLElement | null {
  const parent = panel?.parentElement ?? null
  return parent !== null && [...parent.children].filter(child => !child.classList.contains('browser-corner')).length === 1 && parent.parentElement !== null ? parent.parentElement : parent
}

function focusToggle(): void {
  document.querySelector<HTMLElement>(`[aria-controls="${TOOLS_PANEL_ID}"]`)?.focus()
}

/**
 * Opens and closes the shared tools panel. Place it in a pane header; it never changes the focused thread.
 * In a pane whose thread is not the one the panel is pinned to, it gives up its pressed look and says whose files are open.
 * Its dot means the selected thread has agents working or the working-copy target has a browser request waiting;
 * the corner preview can be off or showing another thread, so a waiting request still appears here.
 */
export function ToolsPanelToggle({ store = toolsPanelStore, state }: { readonly store?: ToolsPanelStore; readonly state?: AgentState | undefined }): ReactNode {
  const chrome = useToolsPanelChrome(store)
  const agents = useOptionalAgents()
  const agentState = state ?? agents?.state ?? null
  const button = useRef<HTMLButtonElement>(null)
  const [paneThreadId, setPaneThreadId] = useState<string | null>(null)
  // The header the toggle sits in belongs to one pane's thread.
  useLayoutEffect(() => { setPaneThreadId(button.current?.closest('[data-thread-id]')?.getAttribute('data-thread-id') ?? null) })
  // A panel closed from the keyboard hands focus here, including to a toggle the resulting layout change re-mounted.
  useLayoutEffect(() => {
    const element = button.current
    if (!element || !store.togglePendingFocus()) return
    const active = document.activeElement
    if (active === element) return
    if (active === null || active === document.body || !active.isConnected) element.focus()
    else store.clearToggleFocus()
  }, [chrome.open, store])
  const pinned = chrome.pinnedThreadId
  const selectedThreadId = paneThreadId ?? agentState?.activeThreadId
  const workingCopyThreadId = pinned ?? selectedThreadId
  const workingAgents = (agentState?.host.threads.find(thread => thread.id === selectedThreadId)?.subagentSummary?.working ?? 0) > 0
  const browserTasks = useBrowserTasks(store.browser)
  const browserWaiting = browserTasks.some(task => task.threadId === workingCopyThreadId && task.pendingAction !== null)
  const pinnedElsewhere = chrome.open && chrome.surface !== 'agents' && pinned !== null && paneThreadId !== null && paneThreadId !== pinned
  const pinnedTitle = pinnedElsewhere ? agentState?.host.threads.find(thread => thread.id === pinned)?.title ?? 'another thread' : null
  // Icon only in the pane header; the word stays for a screen reader, and as the title when nothing else explains it.
  return <button ref={button} type="button" className="pane-action tt-focusable tools-toggle" aria-pressed={chrome.open} aria-controls={TOOLS_PANEL_ID}
    data-pinned-elsewhere={pinnedElsewhere || undefined} aria-description={[pinnedTitle === null ? null : `Showing ${pinnedTitle}, pinned`, workingAgents ? 'Agents are working' : null, browserWaiting ? 'A browser request is waiting for your answer' : null].filter(Boolean).join('. ') || undefined}
    title={pinnedTitle === null ? 'Tools' : `Tools are pinned to ${pinnedTitle}`}
    onClick={() => store.toggle()}>
    {pinnedElsewhere ? <Pin size={16} aria-hidden="true" /> : <PanelRight size={16} aria-hidden="true" />}<span className="tt-visually-hidden">Tools</span>
    {workingAgents || browserWaiting ? <span className="tools-toggle__agents-dot" aria-hidden="true" /> : null}
  </button>
}

/**
 * Which working copy the panel reads: the project, then the branch in mono when it is known, then the kind of
 * folder in the pane chip's words. The thread's recorded branch comes first; a project folder with no record
 * takes the branch Changes last read. The branch gives way before the project and the folder's kind.
 */
function WorkingCopyLine({ thread, project, knownBranch }: { readonly thread: AgentThread; readonly project: AgentProject | undefined; readonly knownBranch: string | undefined }): ReactNode {
  const facts = describeWorkingCopy(thread, project)
  const Icon = facts.status === 'pending' || facts.status === 'error' ? FolderGit2 : facts.mode === 'independent' && facts.branch ? GitBranch : Folder
  const branch = facts.branch ?? knownBranch
  // A ready record's label is its branch, which now has its own place; the folder's kind stands in for it.
  const place = facts.status === 'ready' && facts.mode === 'independent' ? 'Worktree' : facts.status === 'ready' && facts.mode === 'shared' && facts.label === facts.branch ? 'Project folder' : facts.label
  const words = [project?.title, branch === undefined ? undefined : `Branch ${branch}`, place].filter(Boolean).join(' · ')
  return <div className="tools-panel__copy" title={words}>
    <Icon size={14} aria-hidden="true" />
    {project ? <><span className="tools-panel__project">{project.title}</span><span className="tools-panel__sep" aria-hidden="true">·</span></> : null}
    {branch !== undefined ? <><bdi className="tools-panel__branch">{branch}</bdi><span className="tools-panel__sep" aria-hidden="true">·</span></> : null}
    <span className="tools-panel__label">{place}</span>
  </div>
}

const SURFACE_ICONS: Record<ToolSurfaceId, LucideIcon> = { files: FolderTree, changes: GitCompare, 'pull-request': GitPullRequest, terminal: SquareTerminal, browser: Globe, agents: Users }
/** A surface's name where its rail word is shortened. */
const SURFACE_NAMES: Partial<Record<ToolSurfaceId, string>> = { 'pull-request': 'Pull request' }

/** What the panel says when there is no thread to show, in the words of the surface that is open. */
const NO_THREAD: Record<ToolSurfaceId, string> = {
  files: 'Open a thread to browse its files.', changes: 'Open a thread to review its changes.', 'pull-request': 'Open a thread to see its pull request.', terminal: 'Open a thread to use its terminal.',
  browser: 'Open a thread to browse its pages.',
  agents: 'Open a thread to see its agents.',
}

/** Rail keys: the rail stands upright, so Up and Down move along it; Left and Right still work as they did on the tab row. */
const RAIL_STEP: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/**
 * The panel's surfaces as a rail on its outer edge: an icon over a short word, the open one raised. A dot marks a
 * surface with something live, and its words are the surface's description in the rail. The open surface draws no
 * dot, since its own line of chrome already says what is live there; a screen reader still hears the words. Only
 * implemented surfaces are listed.
 */
function ToolsRailTabs({ value, live, onChange }: { readonly value: ToolSurfaceId; readonly live: Partial<Record<ToolSurfaceId, string>>; readonly onChange: (surface: ToolSurfaceId) => void }): ReactNode {
  return <div className="tools-rail__tabs" role="tablist" aria-label="Tools" aria-orientation="vertical">
    {TOOL_SURFACES.map((surface, index) => <button key={surface.id} id={`tools-tab-${surface.id}`} type="button" role="tab" className="tools-rail__tab tt-focusable"
      aria-selected={value === surface.id} aria-controls={`tools-surface-${surface.id}`} tabIndex={value === surface.id ? 0 : -1}
      aria-label={SURFACE_NAMES[surface.id]}
      aria-description={live[surface.id]} title={live[surface.id] ? `${SURFACE_NAMES[surface.id] ?? surface.label}: ${live[surface.id]}` : SURFACE_NAMES[surface.id] ?? surface.label}
      onClick={() => onChange(surface.id)} onKeyDown={event => {
        const step = RAIL_STEP[event.key]
        const next = event.key === 'Home' ? TOOL_SURFACES[0] : event.key === 'End' ? TOOL_SURFACES[TOOL_SURFACES.length - 1]
          : step ? TOOL_SURFACES[(index + step + TOOL_SURFACES.length) % TOOL_SURFACES.length] : undefined
        if (!next) return
        event.preventDefault()
        onChange(next.id)
        document.getElementById(`tools-tab-${next.id}`)?.focus()
      }}>
      {React.createElement(SURFACE_ICONS[surface.id], { size: 18, 'aria-hidden': true, className: 'tools-rail__icon' })}
      <span className="tools-rail__word">{surface.label}</span>
      {live[surface.id] && value !== surface.id ? <span className="tools-rail__live" aria-hidden="true" /> : null}
    </button>)}
  </div>
}

/** What is live on each surface of one thread, in the words a screen reader hears for its dot. */
function useLiveSurfaces(store: ToolsPanelStore, thread: AgentThread | undefined, agentsThread: AgentThread | undefined, changed: { readonly count: number; readonly truncated: boolean } | null, changesOpen: boolean): Partial<Record<ToolSurfaceId, string>> {
  const tasks = useBrowserTasks(store.browser)
  const live: Partial<Record<ToolSurfaceId, string>> = {}
  if (thread) {
    const threadTasks = tasks.filter(task => task.threadId === thread.id)
    if (threadTasks.some(task => task.pendingAction !== null)) live.browser = 'A browser request is waiting for your answer'
    else if (threadTasks.some(task => task.status === 'working')) live.browser = 'A browser task is working'
    // Changes reads Git only while it is open. Elsewhere the working copy's own dirty mark is fresher.
    const dirty = thread.worktree?.status === 'ready' ? thread.worktree.dirty : undefined
    if (!changesOpen && dirty !== undefined) { if (dirty) live.changes = 'Has uncommitted changes' }
    else if (changed !== null && changed.count > 0) live.changes = `${changed.count}${changed.truncated ? '+' : ''} changed ${changed.count === 1 && !changed.truncated ? 'file' : 'files'}`
  }
  const working = agentsThread?.subagentSummary?.working ?? 0
  if (working > 0) live.agents = `${working} ${working === 1 ? 'agent is' : 'agents are'} working`
  return live
}

function useTransientStatus(): [string, (message: string) => void] {
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return [message, next => {
    if (timer.current) clearTimeout(timer.current)
    setMessage(next)
    timer.current = setTimeout(() => { setMessage(''); timer.current = null }, FEEDBACK_MS)
  }]
}

/**
 * The shared tools panel beside the thread panes. Agents follows the focused thread; the working-copy surfaces
 * follow the pin when set. The panel docks only while the panes keep a readable width; otherwise it overlays them.
 */
export function ToolsPanel({ focusedThreadId, state, command, files: filesBridge, gitChanges, terminal, browser, subagents, terminalView, store = toolsPanelStore }: ToolsPanelProps): ReactNode {
  const chrome = useToolsPanelChrome(store)
  const { factory: viewFactory, failed: viewFailed } = useTerminalViewFactory(terminalView, chrome.open && chrome.surface === 'terminal')
  const bridge = filesBridge ?? bridgeFiles()
  const changesBridge = gitChanges ?? bridgeChanges()
  const terminalBridge = terminal ?? bridgeTerminal()
  const browserBridge = browser ?? bridgeBrowser()
  const subagentsBridge = subagents ?? (window.sotto as { subagents?: SubagentsBridge } | undefined)?.subagents
  const showBrowserPreviews = useOptionalAgents()?.showBrowserPreviews !== false
  const target = toolsTarget(chrome, focusedThreadId)
  const thread = target === null ? undefined : state.host.threads.find(item => item.id === target)
  const workingCopyTarget = chrome.pinnedThreadId ?? focusedThreadId
  const workingCopyThread = state.host.threads.find(item => item.id === workingCopyTarget)
  const selectedThread = state.host.threads.find(item => item.id === focusedThreadId)
  const threadFiles = useThreadFiles(store.files, thread ? target : null)
  const threadChanges = useThreadChanges(store.changes, thread ? target : null)
  const workingCopyChanges = useThreadChanges(store.changes, workingCopyThread ? workingCopyTarget : null)
  const aside = useRef<HTMLElement>(null)
  const [available, setAvailable] = useState<number | null>(null)
  const [status, showStatus] = useTransientStatus()
  const open = chrome.open
  const app = useOptionalApp()
  // One platform for the whole panel: the app's, or the preload's where there is no app context, so a Mac never reads mod as Ctrl.
  const platform: SottoPlatform = app?.platform ?? (bridgePlatform() as SottoPlatform | undefined) ?? 'win32'
  const chord = changesChord(app?.settings?.hotkey, platform)

  // The Changes shortcut, T3's `mod+d` unless the dictation hotkey has it: it opens the panel on Changes, and closes
  // the panel when Changes is what it shows. A terminal keeps its own Ctrl+D, and an open dialog keeps its keys.
  useEffect(() => {
    if (chord === null) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || !chordMatches(event, chord, platform) || chordBelongsElsewhere(event.target)) return
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      const current = store.getSnapshot()
      if (current.open && current.surface === 'changes') {
        if (aside.current?.contains(document.activeElement)) focusToggle()
        store.requestToggleFocus()
        store.setOpen(false)
        return
      }
      store.setSurface('changes')
      store.setOpen(true)
      requestAnimationFrame(() => document.getElementById('tools-tab-changes')?.focus())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chord, platform, store])

  useLayoutEffect(() => {
    const parent = workspaceArea(aside.current)
    if (!open || !parent) return
    setAvailable(parent.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setAvailable(parent.clientWidth))
    observer.observe(parent)
    return () => observer.disconnect()
  }, [open])

  // Keep mounted conversations (and their state) out of keyboard navigation while the tool fills the workspace.
  const covered = useRef<HTMLElement[]>([])
  useLayoutEffect(() => {
    if (!open || !chrome.expanded) return
    const area = workspaceArea(aside.current)
    covered.current = area ? [...area.children].filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(aside.current)) : []
    const previous = covered.current.map(element => element.inert)
    covered.current.forEach(element => { element.inert = true })
    return () => { covered.current.forEach((element, index) => { element.inert = previous[index] ?? false }); covered.current = [] }
  }, [open, chrome.expanded])

  // A thread on a paired host keeps its tools on that machine; nothing here reads its folder.
  const threadId = thread?.remoteHost ? undefined : thread?.id
  // Files lists the working folder on every surface, since the footer's path and its actions read it,
  // and refreshes when its own surface comes back.
  const onFiles = chrome.surface === 'files'
  useEffect(() => {
    if (open && threadId !== undefined && (onFiles || !store.files.thread(threadId))) store.files.activate(bridge, threadId)
  }, [open, threadId, onFiles, bridge, store])
  // Changes watches the working copy only while it is the visible surface. In the app it waits for settings, so its
  // first read already follows Hide whitespace changes rather than reading once each way on a cold start. Outside
  // the app (a panel rendered on its own) there are no settings to wait for.
  const diffSettingsKnown = app === null || app.settings !== null
  useEffect(() => {
    if (!open || threadId === undefined || chrome.surface !== 'changes' || !diffSettingsKnown) return
    store.changes.activate(changesBridge, threadId)
    return () => store.changes.deactivate(changesBridge)
  }, [open, threadId, chrome.surface, changesBridge, store, diffSettingsKnown])
  // Terminal sessions live in main; showing the surface only lists them again.
  useEffect(() => {
    if (open && threadId !== undefined && chrome.surface === 'terminal') void store.terminals.activate(terminalBridge, threadId)
  }, [open, threadId, chrome.surface, terminalBridge, store])
  useEffect(() => {
    if (open && threadId !== undefined && chrome.surface === 'browser') void store.browser.activate(browserBridge, threadId)
  }, [open, threadId, chrome.surface, browserBridge, store])

  // Opening moves keyboard focus to the rail's open surface, so keyboard users land where the toggle pointed.
  // An open nobody pressed for (Proactive panels) leaves focus where the user is typing.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open && !wasOpen.current && !store.takeQuietOpen()) document.getElementById(`tools-tab-${chrome.surface}`)?.focus()
    wasOpen.current = open
  }, [open, chrome.surface, store])
  useProactiveChanges(state, focusedThreadId, store)

  const changedFiles = workingCopyChanges?.list.status === 'ready' ? { count: workingCopyChanges.list.files.length, truncated: workingCopyChanges.list.truncated } : null
  const live = useLiveSurfaces(store, workingCopyThread, selectedThread, changedFiles, open && chrome.surface === 'changes')

  const preview = <BrowserTaskPreview state={state} focusedThreadId={focusedThreadId} bridge={browserBridge} store={store} enabled={showBrowserPreviews} />
  if (!open) return preview
  const measured = available !== null && available > 0 ? available : null
  const preferred = chrome.resized || measured === null ? chrome.width : Math.min(TOOLS_PANEL_MAX_WIDTH, Math.max(TOOLS_PANEL_MIN_WIDTH, measured * .56))
  const overlay = chrome.expanded || (measured !== null && measured - preferred < TOOLS_PANEL_MIN_PANE_WIDTH)
  const width = chrome.expanded && measured !== null ? measured : overlay && measured !== null ? Math.max(Math.min(preferred, measured - OVERLAY_GUTTER), Math.min(TOOLS_PANEL_MIN_WIDTH, measured)) : preferred
  const pinned = chrome.surface !== 'agents' && chrome.pinnedThreadId !== null
  const workspace = threadFiles?.workspace ?? threadChanges?.workspace ?? null
  const surfaceLabel = SURFACE_NAMES[chrome.surface] ?? TOOL_SURFACES.find(surface => surface.id === chrome.surface)!.label

  // Focus moves before the panel unmounts, so closing never leaves keyboard focus on the page.
  const close = (): void => {
    covered.current.forEach(element => { element.inert = false })
    if (aside.current?.contains(document.activeElement)) focusToggle()
    store.requestToggleFocus()
    store.setOpen(false)
  }
  const pathAction = (action: PathAction, path: string): void => {
    if (!thread) return
    void store.files.pathAction(bridge, thread.id, action, path).then(result => {
      if (action === 'copyPath') showStatus(result.ok ? 'Path copied' : 'Could not copy the path')
      else if (!result.ok) showStatus('Could not open the folder')
    })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && overlay && !event.defaultPrevented) { event.preventDefault(); if (chrome.expanded) store.setExpanded(false); else close() }
  }
  const startResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX
    const startWidth = width
    handle.setPointerCapture?.(event.pointerId)
    const move = (next: globalThis.PointerEvent): void => store.setWidth(startWidth + startX - next.clientX)
    const end = (): void => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end) }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = event.key === 'ArrowLeft' ? width + RESIZE_STEP : event.key === 'ArrowRight' ? width - RESIZE_STEP
      : event.key === 'Home' ? TOOLS_PANEL_MIN_WIDTH : event.key === 'End' ? TOOLS_PANEL_MAX_WIDTH : null
    if (next === null) return
    event.preventDefault()
    store.setWidth(next)
  }

  let body: ReactNode
  if (target === null) body = <><ToolsChrome title={surfaceLabel} /><div className="files-problem files-problem--root" role="status"><strong>{NO_THREAD[chrome.surface]}</strong></div></>
  else if (!thread) body = <><ToolsChrome title={surfaceLabel} /><div className="files-problem files-problem--root" role="status"><strong>{chrome.surface === 'agents' ? 'The selected thread is no longer listed.' : 'The pinned thread is no longer listed.'}</strong>
    {chrome.surface !== 'agents' ? <button type="button" className="files-link tt-focusable" onClick={() => { document.getElementById(`tools-tab-${chrome.surface}`)?.focus(); store.unpin() }}>Unpin</button> : null}</div></>
  // The pull request is read and acted on by the thread's own host, so it works for a thread on a paired host too.
  else if (chrome.surface === 'pull-request') body = <PullRequestSurface key={thread.id} thread={thread} command={command} onStatus={showStatus} />
  else if (thread.remoteHost) body = <><ToolsChrome title={surfaceLabel} /><div className="files-problem files-problem--root" role="status"><strong>{surfaceLabel} is on the host machine.</strong><p>Use this tool on the host. Replies and permission answers remain available here.</p></div></>
  else if (chrome.surface === 'agents') body = <AgentsSurface key={thread.id} threadId={thread.id} store={store.subagents} bridge={subagentsBridge} />
  else if (chrome.surface === 'browser') body = <BrowserSurface key={thread.id} threadId={thread.id} store={store.browser} bridge={browserBridge} onStatus={showStatus} />
  else if (chrome.surface === 'terminal') body = <TerminalSurface key={thread.id} threadId={thread.id} store={store.terminals} bridge={terminalBridge} viewFactory={viewFactory} viewFailed={viewFailed} />
  else if (chrome.surface === 'changes') body = <ChangesSurface key={thread.id} threadId={thread.id} store={store.changes} bridge={changesBridge} platform={platform} onStatus={showStatus}
    onOpenFile={path => { store.files.showFile(bridge, thread.id, path); store.setSurface('files'); requestAnimationFrame(() => document.getElementById('tools-tab-files')?.focus()) }} />
  else body = <FilesSurface key={thread.id} threadId={thread.id} store={store.files} bridge={bridge} platform={platform} onPathAction={pathAction} />

  // The rail comes first in the reading order (surfaces, then the panel's own buttons), then the surface's line
  // of chrome, its work and the working-copy footer; CSS draws the rail on the panel's outer edge.
  return <>{preview}<aside ref={aside} id={TOOLS_PANEL_ID} className="tools-panel" aria-label="Tools" data-mode={overlay ? 'overlay' : 'docked'} data-expanded={chrome.expanded || undefined}
    style={{ '--tools-width': `${Math.round(width)}px` } as React.CSSProperties} onKeyDown={onKeyDown}>
    <div className="tools-panel__sheet">
      <div className="tools-panel__resize" role="separator" aria-orientation="vertical" aria-label="Resize tools panel" tabIndex={chrome.expanded ? -1 : 0}
        aria-valuemin={TOOLS_PANEL_MIN_WIDTH} aria-valuemax={TOOLS_PANEL_MAX_WIDTH} aria-valuenow={Math.round(width)}
        onPointerDown={startResize} onKeyDown={resizeKey} />
      <div className="tools-rail">
        <ToolsRailTabs value={chrome.surface} live={live} onChange={surface => store.setSurface(surface)} />
        <div className="tools-rail__foot">
          {thread && chrome.surface !== 'agents' ? <button type="button" className="files-icon tt-focusable" aria-pressed={pinned} aria-label={pinned ? `Unpin from ${thread.title}` : `Pin to ${thread.title}`} title={pinned ? `Unpin from ${thread.title}` : 'Pin to this thread'} onClick={() => pinned ? store.unpin() : store.pin(thread.id)}>{pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}</button> : null}
          <button type="button" className="files-icon tt-focusable" aria-label={chrome.expanded ? 'Restore tools panel' : 'Expand tools panel'} title={chrome.expanded ? 'Restore' : 'Expand to fill the workspace'} aria-pressed={chrome.expanded} onClick={() => store.setExpanded(!chrome.expanded)}>{chrome.expanded ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}</button>
          <button type="button" className="files-icon tt-focusable" aria-label="Close tools panel" title="Close" onClick={close}><X size={16} aria-hidden="true" /></button>
        </div>
      </div>
      <div className="tools-panel__main">
        <div className="tools-panel__body" id={`tools-surface-${chrome.surface}`} role="tabpanel" aria-labelledby={`tools-tab-${chrome.surface}`}>{body}</div>
        {thread ? <footer className="tools-panel__foot" title={`${thread.title}${workspace ? ` · ${workspace.workingDirectory}` : ''}`}>
          <WorkingCopyLine thread={thread} project={state.host.projects.find(item => item.id === thread.projectId)} knownBranch={threadChanges?.list.status === 'ready' ? threadChanges.list.branch ?? undefined : undefined} />
          <span className={pinned ? 'tools-panel__pinned-owner' : 'tools-panel__accessible'}>{pinned ? <Pin size={12} aria-hidden="true" /> : null}<span className="tools-panel__thread-title">{thread.title}</span>{pinned ? <span className="tools-panel__tag">Pinned</span> : null}</span>
          {workspace ? <span className="tools-panel__foot-actions">
            <span className="tools-panel__path-text tools-panel__accessible" title={workspace.workingDirectory}>{workspace.workingDirectory}</span>
            <button type="button" className="files-icon files-icon--small tt-focusable" aria-label="Copy working folder path" title={`Copy path: ${workspace.workingDirectory}`} onClick={() => pathAction('copyPath', '')}><Copy size={14} aria-hidden="true" /></button>
            <button type="button" className="files-icon files-icon--small tt-focusable" aria-label={`${revealLabel(platform)}: working folder`} title={`${revealLabel(platform)}: ${workspace.workingDirectory}`} onClick={() => pathAction('reveal', '')}><FolderOutput size={14} aria-hidden="true" /></button>
          </span> : null}
        </footer> : null}
        <p className="tools-panel__status" role="status" aria-live="polite">{status}</p>
      </div>
    </div>
  </aside></>
}
