import React, { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Copy, Folder, FolderGit2, FolderOutput, FolderTree, GitBranch, GitCompare, Globe, Maximize2, Minimize2, PanelRight, Pin, PinOff, RotateCw, SquareTerminal, Users, X, type LucideIcon } from 'lucide-react'
import type { AgentProject, AgentState, AgentThread } from '../../../shared/agents'
import type { BrowserBridge } from '../../../shared/browser'
import type { FilesBridge } from '../../../shared/files'
import type { GitChangesBridge } from '../../../shared/gitChanges'
import type { TerminalBridge } from '../../../shared/terminal'
import type { SubagentsBridge } from '../../../shared/subagents'
import { AgentsSurface } from './AgentsSurface'
import { useOptionalAgents, type AgentConnection } from '../agents/AgentContext'
import { describeWorkingCopy } from '../agents/ThreadWorkingCopy'
import { BrowserTaskPreview } from './BrowserTaskPreview'
import { BrowserSurface } from './BrowserSurface'
import { ChangesSurface } from './ChangesSurface'
import { useThreadChanges } from './changesStore'
import { revealLabel } from './FilePreview'
import { FilesSurface, useThreadFiles } from './FilesSurface'
import type { PathAction } from './filesBrowser'
import { TerminalSurface } from './TerminalSurface'
import type { TerminalViewFactory } from './terminalStore'
import { useTerminalViewFactory } from './terminalViewLoader'
import {
  TOOL_SURFACES, TOOLS_PANEL_MAX_WIDTH, TOOLS_PANEL_MIN_PANE_WIDTH, TOOLS_PANEL_MIN_WIDTH, toolsPanelStore, toolsTarget,
  useToolsPanelChrome, type ToolSurfaceId, type ToolsPanelStore,
} from './toolsPanelStore'
import './tools.css'
import './sidecarSurfaces.css'

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
  const toolsThreadId = pinned ?? paneThreadId ?? agentState?.activeThreadId
  const workingAgents = (agentState?.host.threads.find(thread => thread.id === toolsThreadId)?.subagentSummary?.working ?? 0) > 0
  const pinnedElsewhere = chrome.open && pinned !== null && paneThreadId !== null && paneThreadId !== pinned
  const pinnedTitle = pinnedElsewhere ? agentState?.host.threads.find(thread => thread.id === pinned)?.title ?? 'another thread' : null
  // Icon only in the pane header; the word stays for a screen reader, and as the title when nothing else explains it.
  return <button ref={button} type="button" className="pane-action tt-focusable tools-toggle" aria-pressed={chrome.open} aria-controls={TOOLS_PANEL_ID}
    data-pinned-elsewhere={pinnedElsewhere || undefined} aria-description={[pinnedTitle === null ? null : `Showing ${pinnedTitle}, pinned`, workingAgents ? 'Agents are working' : null].filter(Boolean).join('. ') || undefined}
    title={pinnedTitle === null ? 'Tools' : `Tools are pinned to ${pinnedTitle}`}
    onClick={() => store.toggle()}>
    {pinnedElsewhere ? <Pin size={16} aria-hidden="true" /> : <PanelRight size={16} aria-hidden="true" />}<span className="tt-visually-hidden">Tools</span>
    {workingAgents ? <span className="tools-toggle__agents-dot" aria-hidden="true" /> : null}
  </button>
}

/** Which working copy the panel reads, in the pane chip's words: the project, then its branch or folder. */
function WorkingCopyLine({ thread, project }: { readonly thread: AgentThread; readonly project: AgentProject | undefined }): ReactNode {
  const facts = describeWorkingCopy(thread, project)
  const Icon = facts.status === 'pending' || facts.status === 'error' ? FolderGit2 : facts.mode === 'independent' && facts.branch ? GitBranch : Folder
  const kind = facts.mode === 'independent' && facts.branch ? `Worktree branch ${facts.branch}` : facts.label
  return <div className="tools-panel__copy" title={project ? `${project.title} · ${kind}` : kind}>
    <Icon size={14} aria-hidden="true" />
    {project ? <><span className="tools-panel__project">{project.title}</span><span className="tools-panel__sep" aria-hidden="true">·</span></> : null}
    <span className="tools-panel__label">{facts.label}</span>
  </div>
}

const SURFACE_ICONS: Record<ToolSurfaceId, LucideIcon> = { files: FolderTree, changes: GitCompare, terminal: SquareTerminal, browser: Globe, agents: Users }

/** What the panel says when there is no thread to show, in the words of the surface that is open. */
const NO_THREAD: Record<ToolSurfaceId, string> = {
  files: 'Open a thread to browse its files.', changes: 'Open a thread to review its changes.', terminal: 'Open a thread to use its terminal.',
  browser: 'Open a thread to browse its pages.',
  agents: 'Open a thread to see its agents.',
}

/** The panel's surface tabs. Only implemented surfaces are listed. */
function ToolSurfaceSelector({ value, onChange }: { readonly value: ToolSurfaceId; readonly onChange: (surface: ToolSurfaceId) => void }): ReactNode {
  return <div className="tools-surfaces" role="tablist" aria-label="Tools">
    {TOOL_SURFACES.map((surface, index) => <button key={surface.id} id={`tools-tab-${surface.id}`} type="button" role="tab" className="tools-surfaces__tab tt-focusable"
      aria-selected={value === surface.id} aria-controls={`tools-surface-${surface.id}`} tabIndex={value === surface.id ? 0 : -1}
      onClick={() => onChange(surface.id)} onKeyDown={event => {
        const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!delta) return
        event.preventDefault()
        const next = TOOL_SURFACES[(index + delta + TOOL_SURFACES.length) % TOOL_SURFACES.length]!
        onChange(next.id)
        document.getElementById(`tools-tab-${next.id}`)?.focus()
      }}>
      {React.createElement(SURFACE_ICONS[surface.id], { size: 16, 'aria-hidden': true, className: 'tools-surfaces__icon' })}{surface.label}
    </button>)}
  </div>
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
 * The shared tools panel beside the thread panes. It follows the focused thread unless pinned, keeps each
 * thread's browsing for the session, and docks only while the panes keep a readable width; otherwise it
 * overlays them.
 */
export function ToolsPanel({ focusedThreadId, state, files: filesBridge, gitChanges, terminal, browser, subagents, terminalView, store = toolsPanelStore }: ToolsPanelProps): ReactNode {
  const chrome = useToolsPanelChrome(store)
  const { factory: viewFactory, failed: viewFailed } = useTerminalViewFactory(terminalView, chrome.open && chrome.surface === 'terminal')
  const bridge = filesBridge ?? bridgeFiles()
  const changesBridge = gitChanges ?? bridgeChanges()
  const terminalBridge = terminal ?? bridgeTerminal()
  const browserBridge = browser ?? bridgeBrowser()
  const subagentsBridge = subagents ?? (window.sotto as { subagents?: SubagentsBridge } | undefined)?.subagents
  const platform = bridgePlatform()
  const target = toolsTarget(chrome, focusedThreadId)
  const thread = target === null ? undefined : state.host.threads.find(item => item.id === target)
  const threadFiles = useThreadFiles(store.files, thread ? target : null)
  const threadChanges = useThreadChanges(store.changes, thread ? target : null)
  const aside = useRef<HTMLElement>(null)
  const [available, setAvailable] = useState<number | null>(null)
  const [status, showStatus] = useTransientStatus()
  const open = chrome.open

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

  const threadId = thread?.id
  // Files lists the working folder on every surface, since the panel's path line and its actions read it,
  // and refreshes when its own tab comes back.
  const onFiles = chrome.surface === 'files'
  useEffect(() => {
    if (open && threadId !== undefined && (onFiles || !store.files.thread(threadId))) store.files.activate(bridge, threadId)
  }, [open, threadId, onFiles, bridge, store])
  // Changes watches the working copy only while it is the visible surface.
  useEffect(() => {
    if (!open || threadId === undefined || chrome.surface !== 'changes') return
    store.changes.activate(changesBridge, threadId)
    return () => store.changes.deactivate(changesBridge)
  }, [open, threadId, chrome.surface, changesBridge, store])
  // Terminal sessions live in main; showing the surface only lists them again.
  useEffect(() => {
    if (open && threadId !== undefined && chrome.surface === 'terminal') void store.terminals.activate(terminalBridge, threadId)
  }, [open, threadId, chrome.surface, terminalBridge, store])
  useEffect(() => {
    if (open && threadId !== undefined && chrome.surface === 'browser') void store.browser.activate(browserBridge, threadId)
  }, [open, threadId, chrome.surface, browserBridge, store])

  // Opening moves keyboard focus to the panel's tabs, so keyboard users land where the toggle pointed.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open && !wasOpen.current) document.getElementById(`tools-tab-${chrome.surface}`)?.focus()
    wasOpen.current = open
  }, [open, chrome.surface])

  const preview = <BrowserTaskPreview state={state} focusedThreadId={focusedThreadId} bridge={browserBridge} store={store} />
  if (!open) return preview
  const measured = available !== null && available > 0 ? available : null
  const preferred = chrome.resized || measured === null ? chrome.width : Math.min(TOOLS_PANEL_MAX_WIDTH, Math.max(TOOLS_PANEL_MIN_WIDTH, measured * .56))
  const overlay = chrome.expanded || (measured !== null && measured - preferred < TOOLS_PANEL_MIN_PANE_WIDTH)
  const width = chrome.expanded && measured !== null ? measured : overlay && measured !== null ? Math.max(Math.min(preferred, measured - OVERLAY_GUTTER), Math.min(TOOLS_PANEL_MIN_WIDTH, measured)) : preferred
  const pinned = chrome.pinnedThreadId !== null
  const workspace = threadFiles?.workspace ?? threadChanges?.workspace ?? null

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
  if (target === null) body = <div className="files-problem files-problem--root" role="status"><strong>{NO_THREAD[chrome.surface]}</strong></div>
  else if (!thread) body = <div className="files-problem files-problem--root" role="status"><strong>The pinned thread is no longer listed.</strong>
    <button type="button" className="files-link tt-focusable" onClick={() => { document.getElementById(`tools-tab-${chrome.surface}`)?.focus(); store.unpin() }}>Unpin</button></div>
  else if (chrome.surface === 'agents') body = <AgentsSurface key={thread.id} threadId={thread.id} store={store.subagents} bridge={subagentsBridge} />
  else if (chrome.surface === 'browser') body = <BrowserSurface key={thread.id} threadId={thread.id} store={store.browser} bridge={browserBridge} onStatus={showStatus} />
  else if (chrome.surface === 'terminal') body = <TerminalSurface key={thread.id} threadId={thread.id} store={store.terminals} bridge={terminalBridge} viewFactory={viewFactory} viewFailed={viewFailed} />
  else if (chrome.surface === 'changes') body = <ChangesSurface key={thread.id} threadId={thread.id} store={store.changes} bridge={changesBridge} platform={platform} onStatus={showStatus} />
  else body = <FilesSurface key={thread.id} threadId={thread.id} store={store.files} bridge={bridge} platform={platform} onPathAction={pathAction} />

  return <>{preview}<aside ref={aside} id={TOOLS_PANEL_ID} className="tools-panel" aria-label="Tools" data-mode={overlay ? 'overlay' : 'docked'} data-expanded={chrome.expanded || undefined}
    style={{ '--tools-width': `${Math.round(width)}px` } as React.CSSProperties} onKeyDown={onKeyDown}>
    <div className="tools-panel__sheet">
      <div className="tools-panel__resize" role="separator" aria-orientation="vertical" aria-label="Resize tools panel" tabIndex={chrome.expanded ? -1 : 0}
        aria-valuemin={TOOLS_PANEL_MIN_WIDTH} aria-valuemax={TOOLS_PANEL_MAX_WIDTH} aria-valuenow={Math.round(width)}
        onPointerDown={startResize} onKeyDown={resizeKey} />
      <header className="tools-panel__head">
        <div className="tools-panel__context">
          {thread ? <div className="tools-panel__owner" title={`${thread.title}${workspace ? ` ? ${workspace.workingDirectory}` : ''}`}>
            <WorkingCopyLine thread={thread} project={state.host.projects.find(item => item.id === thread.projectId)} />
            <span className={pinned ? 'tools-panel__pinned-owner' : 'tools-panel__accessible'}><span className="tools-panel__thread-title">{thread.title}</span>{pinned ? <span className="tools-panel__tag">Pinned</span> : null}</span>
          </div> : <span className="tools-panel__empty-title">Tools</span>}
          <div className="tools-panel__actions">
            {thread ? <button type="button" className="files-icon tt-focusable" aria-pressed={pinned} aria-label={pinned ? `Unpin from ${thread.title}` : `Pin to ${thread.title}`} title={pinned ? 'Unpin' : 'Pin to this thread'} onClick={() => pinned ? store.unpin() : store.pin(thread.id)}>{pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}</button> : null}
            <button type="button" className="files-icon tt-focusable" aria-label={chrome.expanded ? 'Restore tools panel' : 'Expand tools panel'} title={chrome.expanded ? 'Restore' : 'Expand'} aria-pressed={chrome.expanded} onClick={() => store.setExpanded(!chrome.expanded)}>{chrome.expanded ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}</button>
            <button type="button" className="files-icon tt-focusable" aria-label="Close tools panel" title="Close" onClick={close}><X size={16} aria-hidden="true" /></button>
          </div>
        </div>
        <div className="tools-panel__bar">
          <ToolSurfaceSelector value={chrome.surface} onChange={surface => store.setSurface(surface)} />
          <div className="tools-panel__folder-actions">
            {thread && chrome.surface === 'files' ? <button type="button" className="files-icon tt-focusable" aria-label="Refresh files" title="Refresh files" data-busy={threadFiles?.refreshing || undefined} onClick={() => void store.files.refresh(bridge, thread.id)}><RotateCw size={15} aria-hidden="true" /></button> : null}
            {workspace ? <>
              <span className="tools-panel__path-text tools-panel__accessible" title={workspace.workingDirectory}>{workspace.workingDirectory}</span>
              <button type="button" className="files-icon tt-focusable" aria-label="Copy working folder path" title={`Copy path: ${workspace.workingDirectory}`} onClick={() => pathAction('copyPath', '')}><Copy size={15} aria-hidden="true" /></button>
              <button type="button" className="files-icon tt-focusable" aria-label={`${revealLabel(platform)}: working folder`} title={`${revealLabel(platform)}: ${workspace.workingDirectory}`} onClick={() => pathAction('reveal', '')}><FolderOutput size={15} aria-hidden="true" /></button>
            </> : null}
          </div>
        </div>
      </header>
      <div className="tools-panel__body" id={`tools-surface-${chrome.surface}`} role="tabpanel" aria-labelledby={`tools-tab-${chrome.surface}`}>{body}</div>
      <p className="tools-panel__status" role="status" aria-live="polite">{status}</p>
    </div>
  </aside></>
}
