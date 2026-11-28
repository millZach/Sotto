import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, ExternalLink, FolderOpen, X } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { BrowserBridge, BrowserDownload, BrowserPage } from '../../../shared/browser'

/** The last part of a folder's path, as the strip names where a file went. */
const folderName = (folder: string | null): string => folder ? folder.split(/[\\/]/u).filter(Boolean).at(-1) ?? folder : ''
/** A size in bytes as people read it. */
function bytes(count: number): string {
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) return `${Math.round(count / 1024)} KB`
  return `${(count / 1024 / 1024).toFixed(1)} MB`
}

/**
 * The thread's downloads this run (ADR-0222), as main keeps them: read when the pane shows them and kept up to date by
 * its download events. `act` answers one; it resolves to the problem in words, or null.
 */
export function useBrowserDownloads(bridge: BrowserBridge | undefined, threadId: string, workspaceId: string | null, enabled: boolean): {
  readonly downloads: readonly BrowserDownload[]
  readonly act: (download: BrowserDownload, action: 'save' | 'save-as' | 'cancel' | 'open' | 'show' | 'dismiss') => Promise<string | null>
} {
  const { t } = useLingui()
  const [downloads, setDownloads] = useState<readonly BrowserDownload[]>([])
  const on = enabled && !!bridge?.downloads && workspaceId !== null
  useEffect(() => {
    setDownloads([])
    if (!on || !bridge || workspaceId === null) return
    let current = true
    const upsert = (download: BrowserDownload, gone = false): void => setDownloads(list => {
      const rest = list.filter(item => item.id !== download.id)
      return gone ? rest : [download, ...rest].sort((a, b) => b.startedAt - a.startedAt)
    })
    const unsubscribe = bridge.onEvent(event => { if (event.type === 'download' && event.download.threadId === threadId) upsert(event.download, event.gone === true) })
    void bridge.downloads!({ threadId, workspaceId }).then(result => { if (current && result.ok) setDownloads(result.value) }, () => undefined)
    return () => { current = false; unsubscribe() }
  }, [on, bridge, threadId, workspaceId])
  const act = useCallback(async (download: BrowserDownload, action: 'save' | 'save-as' | 'cancel' | 'open' | 'show' | 'dismiss'): Promise<string | null> => {
    if (!bridge?.download) return t`This window cannot answer downloads.`
    try {
      const result = await bridge.download({ threadId, workspaceId: download.workspaceId, downloadId: download.id, action })
      if (!result.ok) return result.error.message
      if (result.value) setDownloads(list => list.map(item => item.id === result.value!.id ? result.value! : item))
      else setDownloads(list => list.filter(item => item.id !== download.id))
      return null
    } catch { return t`The browser did not answer. Try again.` }
  }, [bridge, threadId, t])
  return { downloads, act }
}

/** What a download's line says of it: where it came from and what it is waiting for, or where it went. */
function useDownloadWords(): (download: BrowserDownload) => { lead: string; detail: string } {
  const { t } = useLingui()
  return download => {
    const file = download.file, host = download.host, folder = folderName(download.folder)
    const progress = download.totalBytes > 0 ? `${Math.min(100, Math.round(download.receivedBytes / download.totalBytes * 100))}%` : download.receivedBytes > 0 ? bytes(download.receivedBytes) : ''
    if (download.state === 'asking') return {
      lead: download.byAgent
        ? t({ message: `The agent's action started a download from ${host}. Where should it go?`, comment: '{host} is a website, such as example.com. The user chooses where the file is saved.' })
        : t({ message: `${host} wants to download a file. Where should it go?`, comment: '{host} is a website, such as example.com. The user chooses where the file is saved.' }),
      detail: file,
    }
    if (download.state === 'saving') return { lead: t({ message: `Saving ${file}`, comment: '{file} is a downloaded file\'s name.' }), detail: progress }
    if (download.state === 'saved') return { lead: t({ message: `Saved ${file}`, comment: '{file} is a downloaded file\'s name.' }), detail: folder ? t({ message: `in ${folder}`, comment: '{folder} is the folder a downloaded file was saved in, such as Downloads.' }) : '' }
    if (download.state === 'cancelled') return { lead: t({ message: `Cancelled ${file}`, comment: '{file} is a downloaded file\'s name.' }), detail: '' }
    return { lead: t({ message: `${file} could not be saved`, comment: '{file} is a downloaded file\'s name.' }), detail: '' }
  }
}

/** A download's answers: Save to Downloads, Save as and Cancel while it asks; Open and Show in folder once saved. */
function DownloadAnswers({ download, busy, onAct, primaryRef }: { readonly download: BrowserDownload; readonly busy: boolean; readonly onAct: (action: 'save' | 'save-as' | 'cancel' | 'open' | 'show') => void; readonly primaryRef?: React.Ref<HTMLButtonElement> }): ReactNode {
  const { t } = useLingui()
  if (download.state === 'asking') return <>
    <button ref={primaryRef} type="button" className="tt-button tt-button--primary tt-focusable" disabled={busy} onClick={() => onAct('save')}>{t({ message: 'Save to Downloads', comment: 'Saves a file a web page downloaded in the user\'s Downloads folder.' })}</button>
    <button type="button" className="tt-button tt-focusable" disabled={busy} onClick={() => onAct('save-as')}>{t({ message: 'Save as…', comment: 'Opens the system\'s Save dialog for a file a web page downloaded.' })}</button>
    <button type="button" className="tt-button tt-focusable" disabled={busy} onClick={() => onAct('cancel')}>{t({ message: 'Cancel', comment: 'Cancels a file a web page is downloading; nothing is saved.' })}</button>
  </>
  if (download.state === 'saving') return <button type="button" className="tt-button tt-focusable" disabled={busy} onClick={() => onAct('cancel')}>{t({ message: 'Cancel', comment: 'Cancels a file a web page is downloading; nothing is saved.' })}</button>
  if (download.state !== 'saved') return null
  return <>
    {download.opens ? <button type="button" className="tools-chrome__button tt-focusable" disabled={busy} onClick={() => onAct('open')}><ExternalLink size={14} aria-hidden="true" />{t({ message: 'Open', comment: 'Opens a downloaded file with the computer\'s app for it.' })}</button> : null}
    <button type="button" className="tools-chrome__button tt-focusable" disabled={busy} title={download.opens ? undefined : t`Sotto does not open programs or scripts. Open it from its folder if you trust it.`} onClick={() => onAct('show')}>
      <FolderOpen size={14} aria-hidden="true" />{t({ message: 'Show in folder', comment: 'Shows a downloaded file in the computer\'s file manager.' })}</button>
  </>
}

/**
 * A page's download at its foot (ADR-0222): nothing is saved until the user says where, so a download asks here with
 * Save to Downloads, Save as and Cancel, says how far it has got, and once saved offers Open and Show in folder. One
 * shows at a time, a download that asks first; Hide takes a finished one off the page, and the empty pane still lists it.
 */
export function DownloadStrip({ page, downloads, onAct }: { readonly page: BrowserPage; readonly downloads: readonly BrowserDownload[]; readonly onAct: (download: BrowserDownload, action: 'save' | 'save-as' | 'cancel' | 'open' | 'show') => Promise<string | null> }): ReactNode {
  const { t } = useLingui()
  const words = useDownloadWords()
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const mine = downloads.filter(item => item.pageId === page.id && !hidden.has(item.id) && item.state !== 'cancelled')
  const download = mine.find(item => item.state === 'asking') ?? mine[0]
  const id = download?.id
  useEffect(() => { setProblem(null) }, [id])
  if (!download) return null
  const waiting = mine.filter(item => item.state === 'asking').length - (download.state === 'asking' ? 1 : 0)
  const { lead, detail } = words(download)
  const act = (action: 'save' | 'save-as' | 'cancel' | 'open' | 'show'): void => {
    setBusy(true); setProblem(null)
    // A cancelled download leaves the strip when its state says so, not on Cancel: one cancelled too late, as it was
    // being placed, is saved, and stays to say where.
    void onAct(download, action).then(error => { setProblem(error) }).finally(() => setBusy(false))
  }
  return <div className="browser-pane__strip browser-parity__download" data-state={download.state === 'asking' ? 'waiting' : download.state} role="group" aria-labelledby={`browser-download-${download.id}`}>
    <Download size={15} className="browser-parity__download-icon" aria-hidden="true" />
    <p className="browser-pane__strip-text browser-pane__request" id={`browser-download-${download.id}`}>
      <span className="browser-parity__lead" role="status">{lead}</span>
      <span className="browser-parity__words"><bdi>{detail}</bdi>{waiting > 0 ? <span className="browser-parity__more"> · {t({ message: `${waiting} more waiting`, comment: 'How many more downloads wait for the user\'s answer.' })}</span> : null}</span>
    </p>
    <div className="browser-pane__answers">
      <DownloadAnswers download={download} busy={busy} onAct={act} />
      {download.state !== 'asking' && download.state !== 'saving' ? <button type="button" className="files-icon tt-focusable" aria-label={t({ message: `Hide ${download.file}`, comment: '{file} is a downloaded file\'s name. Takes it off the page; the empty pane still lists it.' })}
        title={t`Hide`} onClick={() => setHidden(set => new Set([...set, download.id]))}><X size={14} aria-hidden="true" /></button> : null}
    </div>
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
  </div>
}

/** The thread's downloads this run, in the empty pane (ADR-0222), each with its answers and Remove from list. */
export function DownloadsList({ downloads, onAct }: { readonly downloads: readonly BrowserDownload[]; readonly onAct: (download: BrowserDownload, action: 'save' | 'save-as' | 'cancel' | 'open' | 'show' | 'dismiss') => Promise<string | null> }): ReactNode {
  const { t } = useLingui()
  const words = useDownloadWords()
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  if (downloads.length === 0) return null
  const act = (download: BrowserDownload, action: 'save' | 'save-as' | 'cancel' | 'open' | 'show' | 'dismiss'): void => {
    setBusy(download.id); setProblem(null)
    void onAct(download, action).then(error => {
      setProblem(error)
      // The row goes with Remove, so focus goes to the list's heading rather than to nothing.
      if (!error && action === 'dismiss') requestAnimationFrame(() => heading.current?.focus())
    }).finally(() => setBusy(null))
  }
  return <section className="browser-pane__opened browser-parity__downloads" aria-labelledby="browser-pane-downloads">
    <h2 ref={heading} id="browser-pane-downloads" tabIndex={-1}>{t({ message: 'Downloads this session', comment: 'Heads the files this thread\'s browser pages downloaded since Sotto started.' })}</h2>
    <ul>{downloads.map(download => {
      const { lead, detail } = words(download)
      return <li key={download.id} className="browser-parity__download-row" data-state={download.state}>
        <Download size={15} aria-hidden="true" />
        <span className="browser-parity__download-words"><span className="browser-parity__download-name"><bdi>{download.state === 'asking' ? download.file : lead}</bdi></span>
          <span className="browser-parity__download-note">{download.state === 'asking' ? t({ message: `From ${download.host}, waiting for you`, comment: '{host} is a website. The download waits for the user to choose where it goes.' }) : detail}</span></span>
        <span className="browser-parity__download-actions">
          <DownloadAnswers download={download} busy={busy === download.id} onAct={action => act(download, action)} />
          {download.state !== 'asking' && download.state !== 'saving' ? <button type="button" className="files-icon tt-focusable" aria-label={t({ message: `Remove ${download.file} from the list`, comment: '{file} is a downloaded file\'s name. The file itself stays where it was saved.' })}
            title={t`Remove from the list. The file stays where it was saved.`} disabled={busy === download.id} onClick={() => act(download, 'dismiss')}><X size={14} aria-hidden="true" /></button> : null}
        </span>
      </li>
    })}</ul>
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
  </section>
}
