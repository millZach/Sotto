import React, { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Folder, FolderOpen, FolderPlus, Home, Laptop, Search, Server, X } from 'lucide-react'
import type { AgentProject, AgentState } from '../../../shared/agents'
import type { HostFolderCrumb, HostFoldersResult } from '../../../shared/hostFolders'
import type { HostStatus } from '../../../shared/hosts'
import { useOptionalApp } from '../state/AppContext'
import { Button } from '../components/Button'
import { chordClaimed, chordMatches } from './branchToolbar.logic'
import { listedHostName } from './HostBadge'
import { projectAtFolder } from './projectFolders'
import { isCompositionKey } from './composerKeys'
import './newThread.css'
import './folderBrowser.css'

/** A computer a project can live on: this one, or a paired host. A host that is not connected is listed but cannot be browsed. */
export interface BrowsableHost { readonly hostId: string; readonly name: string; readonly kind: 'local' | 'remote'; readonly connected: boolean; readonly off?: boolean }

/**
 * A folder chosen in the browser: its path as the host that will run the project spells it, and its name there. `isNew`
 * marks one named with New folder, which does not exist until adding the project makes it.
 */
export interface FolderChoice { readonly hostId: string; readonly path: string; readonly name: string; readonly isNew?: true }

/**
 * Every paired computer, this one first. Unlike the Threads page's host badges, this counts this computer alone as one
 * host, so the computer step is skipped until a second one is paired. A saved host that is off or has dropped is not
 * among the router's connections, so it comes from the saved hosts, listed but not browsable.
 */
export function browsableHosts(state: Pick<AgentState, 'connections' | 'hostId'>, saved: readonly HostStatus[] = []): readonly BrowsableHost[] {
  const connections = state.connections?.length ? state.connections : [{ hostId: state.hostId ?? '', name: 'This computer', kind: 'local' as const, connected: true }]
  const listed: BrowsableHost[] = [...connections].sort((a, b) => Number(a.kind === 'remote') - Number(b.kind === 'remote'))
    .map(item => ({ hostId: item.hostId, name: listedHostName(item), kind: item.kind, connected: item.connected !== false }))
  const away = saved.filter(item => !listed.some(host => host.hostId === (item.hostId ?? item.id)))
    .map(item => ({ hostId: item.hostId ?? item.id, name: item.name, kind: 'remote' as const, connected: false, off: !item.enabled }))
  return [...listed, ...away]
}

type Listed = Extract<HostFoldersResult, { status: 'listed' }>

/** A folder the user named with New folder: a name until Use this folder, when adding the project makes it on the host. */
interface NamedFolder { readonly parent: Listed; readonly name: string; readonly path: string }

/**
 * Why a name cannot be a new folder here, by the rules of the host's own system: Windows refuses more characters and
 * ignores case, while Linux and macOS refuse only `/`. Only the host joins paths otherwise; a new folder's path is the
 * listed folder's, the separator the host named, and the name.
 */
function folderNameProblem(name: string, listing: Listed): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Type a name for the folder.'
  const windows = listing.separator === '\\'
  const refused = windows ? /[<>:"/\\|?*]/u.test(trimmed) || /[. ]$/u.test(trimmed) : trimmed.includes('/')
  if (refused || /^\.\.?$/u.test(trimmed) || trimmed.length > 255) return 'Choose a name that can be used as a folder name.'
  const same = (folder: string): boolean => windows ? folder.toLowerCase() === trimmed.toLowerCase() : folder === trimmed
  if (listing.folders.some(folder => same(folder.name))) return `A folder named ${trimmed} is already here.`
  return null
}

/** How a host is named in a sentence: this computer, or its saved name. */
const where = (host: Pick<BrowsableHost, 'kind' | 'name'>): string => host.kind === 'local' ? 'this computer' : host.name
const notConnected = (host: BrowsableHost): string => host.off
  ? `${host.name} is switched off, so its folders can't be listed. Nothing was changed. Switch it on in Settings > Hosts, then try again.`
  : `${host.name} is not connected, so its folders can't be listed. Nothing was changed. Connect it in Settings > Hosts, then try again.`
/** A main-process refusal as the sentence it carries, never the IPC wrapper or a bare error code. */
function refusalText(caught: unknown, fallback: string): string {
  const message = caught instanceof Error ? caught.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '').trim() : ''
  return message && !/^[A-Z0-9_]+$/u.test(message) ? message : fallback
}

function hostIcon(host: Pick<BrowsableHost, 'kind'>, size: number): ReactNode {
  return host.kind === 'local' ? <Laptop size={size} aria-hidden="true" /> : <Server size={size} aria-hidden="true" />
}

/**
 * Add project's dialog: which computer the project lives on, then a folder there (the owner's pick A, from the
 * `prototype/host-folder-browser` prototype). The computer step appears only when more than one is paired, and none
 * is chosen for the user. Folders are listed by the host itself, starting in its home folder, so a path is always
 * in that host's own format. This computer also offers its own folder dialog. New thread opens the same browser with
 * its host already chosen.
 */
export function FolderBrowserDialog({ state, hostId: givenHostId, heading, busy = false, error: outsideError = null, onUse, onClose }: {
  readonly state: AgentState
  /** The host to browse, when the caller has chosen it already; otherwise the user chooses. */
  readonly hostId?: string | undefined
  readonly heading: string
  /** The caller is adding the project: the dialog waits rather than taking another choice. */
  readonly busy?: boolean | undefined
  readonly error?: string | null | undefined
  readonly onUse: (choice: FolderChoice) => void
  readonly onClose: () => void
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const computers = useRef<HTMLDivElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const app = useOptionalApp()
  const platform = app?.platform ?? 'win32'
  const mac = platform === 'darwin'
  // Ctrl+Enter (Cmd+Enter on a Mac) uses the folder, unless the dictation hotkey already means those keys.
  const useChord = chordClaimed('mod+enter', app?.settings?.hotkey, platform)
  // The saved hosts are read once the dialog opens; until then it cannot tell whether there is a computer to ask about.
  const [saved, setSaved] = useState<readonly HostStatus[] | null>(() => window.sotto?.hosts?.get ? null : [])
  useEffect(() => {
    const bridge = window.sotto?.hosts
    if (!bridge?.get) return
    let live = true
    bridge.get().then(next => { if (live) setSaved(next.hosts) }, () => { if (live) setSaved([]) })
    const off = bridge.onChanged?.(next => setSaved(next.hosts))
    return () => { live = false; off?.() }
  }, [])
  const hosts = browsableHosts(state, saved ?? [])
  const givenHost = givenHostId === undefined ? undefined : hosts.find(item => item.hostId === givenHostId) ?? { hostId: givenHostId, name: 'This computer', kind: 'local' as const, connected: true }
  const choosing = givenHost === undefined && hosts.length > 1
  const [chosenHostId, setChosenHostId] = useState<string | null>(null)
  const host = givenHost ?? (choosing ? hosts.find(item => item.hostId === chosenHostId) ?? null : saved === null ? null : hosts[0] ?? null)
  const [listing, setListing] = useState<Listed | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(-1)
  /** The New folder field's text while it is open. */
  const [draftName, setDraftName] = useState<string | null>(null)
  const [draftNameError, setDraftNameError] = useState<string | null>(null)
  const [namedFolder, setNamedFolder] = useState<NamedFolder | null>(null)
  /** Counts listings asked for, so an answer to one the user has moved on from is dropped. */
  const listingRequests = useRef(0)

  const read = useCallback(async (target: BrowsableHost, path: string | null | undefined, name?: string): Promise<void> => {
    const bridge = window.sotto?.agents?.hostFolders
    const request = ++listingRequests.current
    if (!bridge) { setError('Folder browsing is unavailable. Reopen Sotto and try again.'); return }
    setLoading(true); setError(null)
    try {
      const result = await bridge({ hostId: target.hostId, ...(path === undefined ? {} : { path }) })
      if (request !== listingRequests.current) return
      if (result.status === 'listed') {
        setListing(result); setQuery(''); setHighlight(result.folders.length ? 0 : -1); setNamedFolder(null); setDraftName(null)
      } else if (result.status === 'unreadable') {
        setError(`Sotto can't read ${name ?? 'this folder'} on ${where(target)}. It may belong to another account. Nothing was changed; choose another folder.`)
      } else setError(`${name ?? 'This folder'} is no longer on ${where(target)}. Nothing was changed; choose another folder.`)
    } catch (caught) {
      if (request !== listingRequests.current) return
      setError(refusalText(caught, `Could not list the folders on ${where(target)}. Nothing was changed. Try again.`))
    } finally { if (request === listingRequests.current) setLoading(false) }
  }, [])

  // The folder step starts in the chosen host's home folder, and starts again when that host reconnects.
  useEffect(() => {
    if (!host) return
    setListing(null); setNamedFolder(null); setDraftName(null); setQuery('')
    if (!host.connected) { setError(notConnected(host)); return }
    void read(host, undefined)
  }, [host?.hostId, host?.connected])

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
  // The field is the keyboard's home once a host is chosen; the list of computers is before that.
  useEffect(() => {
    if (draftName !== null) nameInput.current?.focus()
    else if (host) search.current?.focus()
    else computers.current?.focus()
  }, [host?.hostId, draftName === null])

  const choose = (item: BrowsableHost): void => {
    if (!item.connected) { setError(notConnected(item)); return }
    setError(null); setHighlight(-1); setChosenHostId(item.hostId)
  }
  const back = (): void => { listingRequests.current++; setChosenHostId(null); setListing(null); setNamedFolder(null); setDraftName(null); setError(null); setLoading(false); setHighlight(-1) }

  const shown = listing ? listing.folders.filter(folder => folder.name.toLowerCase().includes(query.trim().toLowerCase())) : []
  const crumbs: readonly HostFolderCrumb[] = namedFolder ? [...namedFolder.parent.crumbs, { name: namedFolder.name, path: namedFolder.path }] : listing?.crumbs ?? []
  const current = crumbs.at(-1) ?? null
  // A project needs a folder of its own: never the list of drives, a drive's root or `/`.
  const atTop = !namedFolder && (listing === null || listing.crumbs.length <= (listing.separator === '\\' ? 2 : 1))
  const chosenPath = namedFolder?.path ?? (atTop ? null : listing?.path ?? null)
  const projectAt = (path: string): AgentProject | undefined => host ? projectAtFolder(state.host.projects, host.hostId, path) : undefined
  const existing = namedFolder || chosenPath === null ? undefined : projectAt(chosenPath)
  const currentName = current && listing && current.path === listing.home ? 'Home' : current?.name ?? ''
  const useLabel = existing ? 'Open project' : 'Use this folder'

  const open = (path: string, name: string): void => { if (host && !busy) void read(host, path, name) }
  const up = (): void => {
    if (!host || busy) return
    if (namedFolder) { setNamedFolder(null); return }
    const parent = listing?.crumbs.at(-2)
    if (parent) void read(host, parent.path, parent.name)
  }
  const use = (): void => {
    if (!host || busy || loading || chosenPath === null || !current) return
    onUse({ hostId: host.hostId, path: chosenPath, name: current.name, ...(namedFolder ? { isNew: true as const } : {}) })
  }
  const nameFolder = (): void => {
    if (!listing || listing.path === null || draftName === null) return
    const problem = folderNameProblem(draftName, listing)
    if (problem) { setDraftNameError(problem); return }
    const name = draftName.trim()
    const path = listing.path.endsWith(listing.separator) ? listing.path + name : listing.path + listing.separator + name
    setNamedFolder({ parent: listing, name, path }); setDraftName(null); setDraftNameError(null); setQuery(''); setHighlight(-1)
  }
  const explorer = async (): Promise<void> => {
    const picker = window.sotto?.agents?.chooseProjectDirectory
    if (!host || !picker || busy) return
    setError(null)
    try {
      const path = await picker()
      if (path) onUse({ hostId: host.hostId, path, name: path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || path })
    } catch { setError('Could not open the folder dialog. Nothing was changed. Try again.') }
  }
  const explorerLabel = mac ? 'Browse with Finder' : 'Browse with File Explorer'

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (isCompositionKey(event.nativeEvent)) return
    if (event.target === nameInput.current) return
    const rows = host ? shown.length : hosts.length
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows) {
      event.preventDefault()
      setHighlight(index => index < 0 ? (event.key === 'ArrowDown' ? 0 : rows - 1) : (index + (event.key === 'ArrowDown' ? 1 : rows - 1)) % rows)
      return
    }
    if (useChord && host && chordMatches(event, 'mod+enter', platform)) { event.preventDefault(); use(); return }
    if (event.key === 'Enter' && (event.target === search.current || event.target === computers.current)) {
      event.preventDefault()
      if (!host) { const item = hosts[highlight]; if (item) choose(item) }
      else { const folder = shown[highlight]; if (folder) open(folder.path, folder.name) }
      return
    }
    if (event.key === 'Backspace' && event.target === search.current && query === '') { event.preventDefault(); up() }
  }
  useEffect(() => { dialog.current?.querySelector('[data-highlighted]')?.scrollIntoView?.({ block: 'nearest' }) }, [highlight])

  const alert = outsideError ?? error
  return <dialog ref={dialog} className="new-thread-dialog folder-browser" aria-labelledby={titleId} aria-busy={busy || loading || undefined}
    onKeyDown={onKeyDown}
    onCancel={event => {
      event.preventDefault(); event.stopPropagation()
      if (busy) return
      if (draftName !== null) { setDraftName(null); setDraftNameError(null); return }
      if (host && choosing) back(); else onClose()
    }}
    onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget && !busy) onClose() }}>
    {!host && !choosing ? <p className="new-thread-dialog__empty" role="status">Finding your computers…</p> : !host ? <>
      <header className="new-thread-dialog__search folder-browser__head">
        <h2 id={titleId}>{heading}</h2>
        <Button variant="ghost" iconOnly aria-label="Close" disabled={busy} onClick={onClose}><X size={16} /></Button>
      </header>
      <p className="folder-browser__lede">Its threads and agents run on the computer you choose. You can follow them from any computer with Sotto.</p>
      <div ref={computers} className="new-thread-dialog__choices folder-browser__computers" tabIndex={-1} aria-label="Computers" role="group">
        <h3>Computers</h3>
        {hosts.map((item, index) => <button key={item.hostId} type="button" className="new-thread-choice" data-highlighted={highlight === index || undefined}
          onMouseEnter={() => setHighlight(index)} onClick={() => choose(item)}>
          {hostIcon(item, 19)}<span><strong>{item.name}</strong><small>{item.connected ? (item.kind === 'local' ? 'This computer' : 'Connected') : item.off ? 'Off' : 'Not connected'}</small></span><ChevronRight size={15} aria-hidden="true" /></button>)}
        {alert ? <p className="agent-error" role="alert">{alert}</p> : null}
      </div>
      <footer className="new-thread-dialog__keys"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Choose</span><span><kbd>Esc</kbd> Close</span></footer>
    </> : <>
      <h2 id={titleId} className="tt-visually-hidden">{heading} Folders on {where(host)}</h2>
      <header className="new-thread-dialog__search">
        {choosing ? <Button variant="ghost" iconOnly aria-label="Back to computers" disabled={busy} onClick={back}><ArrowLeft size={17} /></Button> : null}
        <span className="folder-browser__host">{hostIcon(host, 14)}{host.name}</span>
        <Search size={16} aria-hidden="true" />
        <input ref={search} type="search" aria-label={`Search folders in ${currentName || host.name}`} placeholder={currentName ? `Search in ${currentName}…` : 'Search folders…'}
          value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setHighlight(0) }} />
        <Button variant="ghost" iconOnly aria-label="Close" disabled={busy} onClick={onClose}><X size={16} /></Button>
      </header>
      {crumbs.length ? <nav className="folder-browser__crumbs" aria-label={`Folder on ${host.name}`}>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          const home = listing !== null && crumb.path === listing.home
          return <React.Fragment key={`${index}:${crumb.path ?? ''}`}>
            {index ? <ChevronRight size={12} aria-hidden="true" className="folder-browser__sep" /> : null}
            <button type="button" className="tt-focusable" aria-current={last ? 'location' : undefined} disabled={busy}
              onClick={() => { if (last) return; if (namedFolder && index === crumbs.length - 2) { setNamedFolder(null); return } void read(host, crumb.path, crumb.name) }}>
              {home ? <><Home size={13} aria-hidden="true" />Home</> : crumb.name}
            </button>
          </React.Fragment>
        })}
      </nav> : null}
      <div className="new-thread-dialog__choices folder-browser__list">
        {alert ? <p className="agent-error" role="alert">{alert}</p> : null}
        {draftName !== null ? <>
          <div className="folder-browser__new">
            <FolderPlus size={17} aria-hidden="true" />
            <input ref={nameInput} aria-label="New folder name" placeholder="Folder name" value={draftName}
              onChange={event => { setDraftName(event.target.value); setDraftNameError(null) }}
              onKeyDown={event => {
                if (isCompositionKey(event.nativeEvent)) return
                if (event.key === 'Enter') { event.preventDefault(); nameFolder() }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraftName(null); setDraftNameError(null) }
              }} />
            <Button variant="secondary" onClick={nameFolder}>Name folder</Button>
            <Button variant="ghost" onClick={() => { setDraftName(null); setDraftNameError(null) }}>Cancel</Button>
          </div>
          {draftNameError ? <p className="folder-browser__naming-error" role="alert">{draftNameError}</p> : null}
        </> : null}
        {loading ? <p className="new-thread-dialog__empty" role="status">Reading folders on {where(host)}…</p>
          : namedFolder ? <p className="new-thread-dialog__empty">This folder is new. Sotto makes it on {where(host)} when you press Use this folder.</p>
          : listing ? <>
            {shown.map((folder, index) => <button key={folder.path} type="button" className="new-thread-choice" data-highlighted={highlight === index || undefined} disabled={busy}
              onMouseEnter={() => setHighlight(index)} onClick={() => open(folder.path, folder.name)}>
              <Folder size={17} aria-hidden="true" /><span><strong>{folder.name}</strong></span>
              {folder.git ? <span className="folder-browser__tag">Git</span> : null}
              {projectAt(folder.path) ? <span className="folder-browser__tag folder-browser__tag--project">Project</span> : null}
              <ChevronRight size={15} aria-hidden="true" />
            </button>)}
            {!shown.length ? <p className="new-thread-dialog__empty">{query ? 'No folders match.' : 'No folders in here.'}</p> : null}
            {listing.truncated ? <p className="new-thread-dialog__empty">Only the first {listing.folders.length} folders here are listed.</p> : null}
          </> : null}
      </div>
      <footer className="folder-browser__foot">
        <Button variant="ghost" disabled={busy || loading || !listing || listing.path === null || draftName !== null || namedFolder !== null} onClick={() => { setDraftName(''); setDraftNameError(null) }}><FolderPlus size={15} aria-hidden="true" />New folder</Button>
        {host.kind === 'local' && window.sotto?.agents?.chooseProjectDirectory ? <Button variant="ghost" disabled={busy} onClick={() => void explorer()}><FolderOpen size={15} aria-hidden="true" />{explorerLabel}</Button> : null}
        <span className="folder-browser__target" title={chosenPath ?? undefined}><bdi>{existing ? `Already the project ${existing.title}` : chosenPath ?? ''}</bdi></span>
        <Button disabled={busy || loading || chosenPath === null} onClick={use}>{busy ? 'Adding…' : useLabel}</Button>
      </footer>
      <footer className="new-thread-dialog__keys"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Open folder</span><span><kbd>⌫</kbd> Up a folder</span>{useChord ? <span><kbd>{mac ? '⌘' : 'Ctrl'}</kbd><kbd>Enter</kbd> {useLabel}</span> : null}<span><kbd>Esc</kbd> {choosing ? 'Back' : 'Close'}</span></footer>
    </>}
  </dialog>
}
