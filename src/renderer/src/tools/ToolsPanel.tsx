import React, { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Copy, Folder, FolderGit2, FolderOutput, FolderTree, GitBranch, Pin, PinOff, RotateCw, X } from 'lucide-react'
import type { AgentProject, AgentState, AgentThread } from '../../../shared/agents'
import type { FilesBridge } from '../../../shared/files'
import { useOptionalAgents, type AgentConnection } from '../agents/AgentContext'
import { describeWorkingCopy } from '../agents/ThreadWorkingCopy'
import { revealLabel } from './FilePreview'
import { FilesSurface, useThreadFiles } from './FilesSurface'
import type { PathAction } from './filesBrowser'
import {
  TOOL_SURFACES, TOOLS_PANEL_MAX_WIDTH, TOOLS_PANEL_MIN_PANE_WIDTH, TOOLS_PANEL_MIN_WIDTH, toolsPanelStore, toolsTarget,
  useToolsPanelChrome, type ToolSurfaceId, type ToolsPanelStore,
} from './toolsPanelStore'
import './tools.css'

export const TOOLS_PANEL_ID = 'sotto-tools-panel'
const FEEDBACK_MS = 1_600
const RESIZE_STEP = 24
const OVERLAY_GUTTER = 48

export interface ToolsPanelProps {
  readonly focusedThreadId: string | null
  readonly state: AgentState
  /** Accepted for the shared tools slot; Files never sends agent commands or changes selection. */
  readonly command?: AgentConnection['command']
  readonly files?: FilesBridge | undefined
  readonly store?: ToolsPanelStore
}

function bridgeFiles(): FilesBridge | undefined {
  return (window.sotto as { files?: FilesBridge } | undefined)?.files
}

function bridgePlatform(): string | undefined {
  return (window.sotto as { platform?: string } | undefined)?.platform
}

/** The area the panel shares with the panes: its parent, or the parent of a wrapper that holds only the panel. */
function workspaceArea(panel: HTMLElement | null): HTMLElement | null {
  const parent = panel?.parentElement ?? null
  return parent !== null && parent.childElementCount === 1 && parent.parentElement !== null ? parent.parentElement : parent
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
  const pinnedElsewhere = chrome.open && pinned !== null && paneThreadId !== null && paneThreadId !== pinned
  const pinnedTitle = pinnedElsewhere ? agentState?.host.threads.find(thread => thread.id === pinned)?.title ?? 'another thread' : null
  return <button ref={button} type="button" className="tt-button tt-focusable tt-button--ghost tools-toggle" aria-pressed={chrome.open} aria-controls={TOOLS_PANEL_ID}
    data-pinned-elsewhere={pinnedElsewhere || undefined} aria-description={pinnedTitle === null ? undefined : `Showing ${pinnedTitle}, pinned`}
    title={pinnedTitle === null ? undefined : `Files is pinned to ${pinnedTitle}`}
    onClick={() => store.toggle()}>
    {pinnedElsewhere ? <Pin size={16} aria-hidden="true" /> : <FolderTree size={16} aria-hidden="true" />}Files
  </button>
}

/** A folder name longer than this may wrap inside itself; shorter names (a thread's UUID folder) stay whole. */
const WHOLE_PATH_PART = 40

/** Break a path after each separator, so a wrapped path splits between folder names rather than at their hyphens. */
function breakablePath(path: string): ReactNode[] {
  return path.split(/(?<=[\\/])/u).flatMap((part, index) => [
    index === 0 ? null : <wbr key={`break-${index}`} />,
    part.length > WHOLE_PATH_PART ? part : <span key={index} className="tools-panel__path-part">{part}</span>,
  ])
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

/** The panel's surface tabs. Only implemented surfaces are listed. */
export function ToolSurfaceSelector({ value, onChange }: { readonly value: ToolSurfaceId; readonly onChange: (surface: ToolSurfaceId) => void }): ReactNode {
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
      <FolderTree size={16} aria-hidden="true" />{surface.label}
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
export function ToolsPanel({ focusedThreadId, state, files: filesBridge, store = toolsPanelStore }: ToolsPanelProps): ReactNode {
  const chrome = useToolsPanelChrome(store)
  const bridge = filesBridge ?? bridgeFiles()
  const platform = bridgePlatform()
  const target = toolsTarget(chrome, focusedThreadId)
  const thread = target === null ? undefined : state.host.threads.find(item => item.id === target)
  const threadFiles = useThreadFiles(store.files, thread ? target : null)
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

  const threadId = thread?.id
  useEffect(() => {
    if (open && threadId !== undefined && chrome.surface === 'files') store.files.activate(bridge, threadId)
  }, [open, threadId, chrome.surface, bridge, store])

  // Opening moves keyboard focus to the panel's tabs, so keyboard users land where the toggle pointed.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open && !wasOpen.current) document.getElementById(`tools-tab-${chrome.surface}`)?.focus()
    wasOpen.current = open
  }, [open, chrome.surface])

  if (!open) return null
  const overlay = available !== null && available - chrome.width < TOOLS_PANEL_MIN_PANE_WIDTH
  const width = overlay && available !== null ? Math.max(Math.min(chrome.width, available - OVERLAY_GUTTER), Math.min(TOOLS_PANEL_MIN_WIDTH, available)) : chrome.width
  const pinned = chrome.pinnedThreadId !== null
  const workspace = threadFiles?.workspace ?? null

  // Focus moves before the panel unmounts, so closing never leaves keyboard focus on the page.
  const close = (): void => {
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
    if (event.key === 'Escape' && overlay && !event.defaultPrevented) { event.preventDefault(); close() }
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
    const next = event.key === 'ArrowLeft' ? chrome.width + RESIZE_STEP : event.key === 'ArrowRight' ? chrome.width - RESIZE_STEP
      : event.key === 'Home' ? TOOLS_PANEL_MIN_WIDTH : event.key === 'End' ? TOOLS_PANEL_MAX_WIDTH : null
    if (next === null) return
    event.preventDefault()
    store.setWidth(next)
  }

  let body: ReactNode
  if (target === null) body = <div className="files-problem files-problem--root" role="status"><strong>Open a thread to browse its files.</strong></div>
  else if (!thread) body = <div className="files-problem files-problem--root" role="status"><strong>The pinned thread is no longer listed.</strong>
    <button type="button" className="files-link tt-focusable" onClick={() => { document.getElementById(`tools-tab-${chrome.surface}`)?.focus(); store.unpin() }}>Unpin</button></div>
  else body = <FilesSurface key={thread.id} threadId={thread.id} store={store.files} bridge={bridge} platform={platform} onPathAction={pathAction} />

  return <aside ref={aside} id={TOOLS_PANEL_ID} className="tools-panel" aria-label="Tools" data-mode={overlay ? 'overlay' : 'docked'}
    style={{ '--tools-width': `${Math.round(width)}px` } as React.CSSProperties} onKeyDown={onKeyDown}>
    <div className="tools-panel__sheet">
      <div className="tools-panel__resize" role="separator" aria-orientation="vertical" aria-label="Resize tools panel" tabIndex={0}
        aria-valuemin={TOOLS_PANEL_MIN_WIDTH} aria-valuemax={TOOLS_PANEL_MAX_WIDTH} aria-valuenow={Math.round(width)}
        onPointerDown={startResize} onKeyDown={resizeKey} />
      <header className="tools-panel__head">
        <div className="tools-panel__bar">
          <ToolSurfaceSelector value={chrome.surface} onChange={surface => store.setSurface(surface)} />
          <div className="tools-panel__actions">
            {thread ? <button type="button" className="files-icon tt-focusable" aria-label="Refresh files" title="Refresh files" data-busy={threadFiles?.refreshing || undefined}
              onClick={() => void store.files.refresh(bridge, thread.id)}><RotateCw size={16} aria-hidden="true" /></button> : null}
            {target !== null && thread ? <button type="button" className="files-icon tt-focusable" aria-pressed={pinned}
              aria-label={pinned ? `Unpin from ${thread.title}` : `Pin to ${thread.title}`} title={pinned ? 'Unpin' : 'Pin to this thread'}
              onClick={() => pinned ? store.unpin() : store.pin(thread.id)}>{pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}</button> : null}
            <button type="button" className="files-icon tt-focusable" aria-label="Close tools panel" title="Close" onClick={close}><X size={16} aria-hidden="true" /></button>
          </div>
        </div>
        {thread ? <div className="tools-panel__identity">
          <div className="tools-panel__thread">
            <span className="tools-panel__thread-title" title={thread.title}>{thread.title}</span>
            {pinned ? <span className="tools-panel__tag">Pinned</span> : null}
          </div>
          <WorkingCopyLine thread={thread} project={state.host.projects.find(item => item.id === thread.projectId)} />
          {workspace ? <div className="tools-panel__path">
            <span className="tools-panel__path-text" title={workspace.workingDirectory}><bdi>{breakablePath(workspace.workingDirectory)}</bdi></span>
            <button type="button" className="files-icon files-icon--small tt-focusable" aria-label="Copy working folder path" title="Copy path"
              onClick={() => pathAction('copyPath', '')}><Copy size={14} aria-hidden="true" /></button>
            <button type="button" className="files-icon files-icon--small tt-focusable" aria-label={`${revealLabel(platform)}: working folder`} title={revealLabel(platform)}
              onClick={() => pathAction('reveal', '')}><FolderOutput size={14} aria-hidden="true" /></button>
          </div> : null}
        </div> : null}
      </header>
      <div className="tools-panel__body" id={`tools-surface-${chrome.surface}`} role="tabpanel" aria-labelledby={`tools-tab-${chrome.surface}`}>{body}</div>
      <p className="tools-panel__status" role="status" aria-live="polite">{status}</p>
    </div>
  </aside>
}
