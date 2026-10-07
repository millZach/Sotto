import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { RotateCw, Settings as SettingsIcon, Share2, Smartphone, Square, X } from 'lucide-react'
import { TEST_IPHONE, type BrowserBridge } from '../../../shared/browser'
import { CLOUD_IPHONE_PRICE_PER_MINUTE_USD } from '../../../shared/cloudIphone'
import { resolveModel } from '../../../shared/modelCatalog'
import { useOptionalAgents } from '../agents/AgentContext'
import { useOptionalApp } from '../state/AppContext'
import { BrowserTaskDetails } from './BrowserTaskDetails'
import { normalizeAddress, phonePage, useBrowserTasks, useThreadBrowser, type BrowserStore } from './browserStore'
import { bridgeCloudIphone, cloudIphoneStore, useCloudSession, useCloudStatus, type CloudIphoneBridgeLike, type CloudIphoneStore } from './cloudIphoneStore'
import { phonePlayerStore, usePhonePlayerOpen, type PhonePlayerStore } from './phonePlayerStore'
import { ToolsChrome } from './ToolsChrome'
import './iphoneSurface.css'

export interface IPhoneSurfaceProps {
  readonly threadId: string
  readonly store: BrowserStore
  readonly bridge: BrowserBridge | undefined
  readonly phoneStore?: PhonePlayerStore
  readonly cloudStore?: CloudIphoneStore
  readonly cloudBridge?: CloudIphoneBridgeLike
}

/** A thread's cloud iPhone card: the build, device, this month's minutes and this session's, with End session. */
function CloudIphoneCard({ threadId, bridge, store }: { readonly threadId: string; readonly bridge: CloudIphoneBridgeLike; readonly store: CloudIphoneStore }): ReactNode {
  useEffect(() => { store.watch(bridge, threadId); void store.loadStatus(bridge) }, [store, bridge, threadId])
  const session = useCloudSession(threadId, store)
  const status = useCloudStatus(store)
  const app = useOptionalApp()
  const [ending, setEnding] = useState(false)
  if (!session || session.status === 'denied' || session.status === 'refused') {
    if (!status?.keySaved) return <section className="iphone-surface__card iphone-surface__cloud-pointer">
      <p>Native builds can run on a cloud iPhone. Add a run.cloud key in Settings &gt; Cloud iPhone.</p>
      <button type="button" className="tt-button tt-button--secondary tt-focusable" onClick={() => app?.actions.navigate('settings')}><SettingsIcon size={14} aria-hidden="true" />Open Settings</button>
    </section>
    return null
  }
  const live = session.status === 'active' || session.status === 'starting'
  const monthMinutes = status?.monthMinutes ?? 0
  const capMinutes = status?.capMinutes ?? 0
  const idleMinutes = app?.settings?.cloudIphoneIdleMinutes ?? 5
  const end = (): void => { setEnding(true); void store.end(bridge, session).finally(() => setEnding(false)) }
  return <section className="iphone-surface__card" aria-label="Cloud iPhone">
    <h3>Cloud iPhone{live ? <span className="iphone-surface__cloud-badge">Running</span> : null}</h3>
    <dl className="iphone-surface__facts">
      <dt>Build</dt><dd>{session.buildPath}</dd>
      <dt>Device</dt><dd>{session.device ?? 'Starting…'} · run.cloud</dd>
      <dt>This month</dt><dd>{monthMinutes} of {capMinutes} minutes
        <div className="iphone-surface__cloud-meter" role="meter" aria-label="Cloud iPhone minutes used this month" aria-valuenow={monthMinutes} aria-valuemin={0} aria-valuemax={capMinutes}>
          <i style={{ width: `${capMinutes > 0 ? Math.min(100, Math.round(monthMinutes / capMinutes * 100)) : 0}%` }} />
        </div></dd>
      {live ? <><dt>This session</dt><dd>{session.minutes} min · ends after {idleMinutes} minutes idle</dd></> : null}
    </dl>
    {live ? <button type="button" className="tt-button tt-button--secondary tt-focusable" disabled={ending} onClick={end}><Square size={13} aria-hidden="true" />End session</button> : null}
    {session.steps.length > 0 ? <ol className="iphone-surface__cloud-steps">
      {session.steps.map(step => <li key={step.id} data-status={step.status}>{step.action}{step.detail ? `: ${step.detail}` : ''}</li>)}
    </ol> : null}
    <p className="iphone-surface__facts-note">About ${CLOUD_IPHONE_PRICE_PER_MINUTE_USD.toFixed(2)} a minute. A simulator, not a device.</p>
  </section>
}

/**
 * Tools > iPhone: the controls for the thread's test iPhone (ADR-0045). The phone itself floats over the thread in
 * the phone player, so this surface never draws the page; it loads a web build, shares it with the agent, and
 * shows what the agent did there and anything waiting for an answer.
 */
export function IPhoneSurface({ threadId, store, bridge, phoneStore = phonePlayerStore, cloudStore = cloudIphoneStore, cloudBridge = bridgeCloudIphone() }: IPhoneSurfaceProps): ReactNode {
  const browser = useThreadBrowser(store, threadId)
  const tasks = useBrowserTasks(store)
  // A running cloud iPhone is what the thread is testing on; the test iPhone's empty state would only contradict it.
  const cloudSession = useCloudSession(threadId, cloudStore)
  const cloudLive = cloudSession?.status === 'active' || cloudSession?.status === 'starting'
  const agents = useOptionalAgents()
  const owningThread = agents?.state?.host.threads.find(item => item.id === threadId)
  const owningModel = resolveModel(agents?.state?.host.models ?? [], owningThread?.modelId)
  const agentToolsUnavailable = owningThread?.providerId === 'devin' || owningModel?.providerId === 'devin'
  const showing = usePhonePlayerOpen(phoneStore, threadId)
  const page = phonePage(browser)
  const pageId = page?.id ?? null
  const task = page ? tasks.find(item => item.threadId === threadId && item.pageId === page.id) : undefined
  const address = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stoppingGrant, setStoppingGrant] = useState(false)
  useEffect(() => { setDraft(null); setProblem(null) }, [pageId])

  if (!browser || browser.status === 'loading' && !page) return <><ToolsChrome title="iPhone" /><p className="files-preview__loading" role="status">Loading the test iPhone…</p></>
  if (browser.status === 'error' && !page) {
    return <><ToolsChrome title="iPhone" /><div className="files-problem files-problem--root" role="status">
      <strong>{bridge ? browser.error?.message || 'The test iPhone is not available.' : 'The test iPhone is not available in this window.'}</strong>
      {bridge ? <button type="button" className="files-link tt-focusable" onClick={() => void store.activate(bridge, threadId)}>Try again</button> : null}
    </div></>
  }
  const shown = draft ?? page?.url ?? ''

  const load = (event: FormEvent): void => {
    event.preventDefault()
    const parsed = normalizeAddress(shown)
    if ('error' in parsed) { setProblem(parsed.error); address.current?.focus(); return }
    setProblem(null)
    const opened = page ? store.navigate(bridge, threadId, page.id, parsed.url) : store.create(bridge, threadId, parsed.url, 'iphone')
    void opened.then(ok => { if (ok) { setDraft(null); phoneStore.show(threadId) } })
  }
  const share = async (): Promise<void> => {
    if (!bridge || !page) return
    setBusy(true); setProblem(null)
    try {
      const result = await bridge.share({ threadId, workspaceId: page.workspace.workspaceId, pageId: page.id, enabled: !page.sharedOrigin })
      if (result.ok) store.adopt(result.value)
      else setProblem(result.error.message)
    } catch { setProblem('The test iPhone did not answer. Try again.') }
    finally { setBusy(false) }
  }
  // Stop takes its own line away, so focus goes to the address, the next thing the eye reads.
  const stopGrant = (): void => {
    setStoppingGrant(true); setProblem(null)
    void store.stopGrant(bridge, threadId).then(error => {
      if (error) setProblem(error)
      else requestAnimationFrame(() => address.current?.focus())
    }).finally(() => setStoppingGrant(false))
  }

  return <div className="iphone-surface">
    <ToolsChrome title="iPhone" detail={page ? TEST_IPHONE.name : undefined}>
      {page ? <button type="button" className="tools-chrome__button tt-focusable" aria-pressed={showing} title={showing ? 'Hide the test iPhone over the thread' : 'Show the test iPhone over the thread'}
        onClick={() => showing ? phoneStore.hide(threadId) : phoneStore.show(threadId)}>
        <Smartphone size={16} aria-hidden="true" /><span className="tools-chrome__button-label">{showing ? 'Hide phone' : 'Show phone'}</span></button> : null}
    </ToolsChrome>
    {browser.grant ? <div className="browser-grant">
      <span>This thread uses the browser and test iPhone without asking</span><span aria-hidden="true">·</span>
      <button type="button" className="browser-review-link tt-focusable" aria-label="Stop letting this thread use the browser and test iPhone without asking" title="This thread will ask before opening, tapping or typing again" disabled={stoppingGrant} onClick={stopGrant}>Stop</button>
    </div> : null}

    <div className="iphone-surface__body">
      {!page && !cloudLive ? <div className="iphone-surface__empty">
        <Smartphone size={18} aria-hidden="true" />
        <strong>No app on the test iPhone</strong>
        <p>An agent opens your app here when it tests it. You can also load a web build yourself, such as the address <code>npx expo start --web</code> prints.</p>
      </div> : null}

      <section className="iphone-surface__card" aria-labelledby="iphone-web-build">
        <h3 id="iphone-web-build">Web build</h3>
        <form className="iphone-surface__address" onSubmit={load} data-loading={page?.status === 'loading' || undefined}>
          <input ref={address} className="browser-address tt-focusable" type="text" inputMode="url" spellCheck={false} autoComplete="off" autoCapitalize="off"
            aria-label="Address of the web build" placeholder="localhost:8081" value={shown} aria-invalid={problem !== null || undefined} aria-describedby={problem ? 'iphone-address-problem' : undefined}
            onFocus={event => event.currentTarget.select()} onChange={event => { setProblem(null); setDraft(event.currentTarget.value) }}
            onKeyDown={event => { if (event.key === 'Escape' && draft !== null) { event.preventDefault(); event.stopPropagation(); setDraft(null); setProblem(null) } }} />
          <button type="submit" className="tt-button tt-button--primary tt-focusable" disabled={browser.busy || !bridge}>{page ? 'Load' : 'Load app'}</button>
          {page ? <>
            <button type="button" className="files-icon tt-focusable" aria-label="Reload the test iPhone" title="Reload" disabled={browser.busy} onClick={() => void store.history(bridge, threadId, page.id, 'reload')}><RotateCw size={15} aria-hidden="true" /></button>
            <button type="button" className="files-icon tt-focusable" aria-label="Close the app on the test iPhone" title="Close the app" disabled={browser.busy}
              onClick={() => void store.close(bridge, threadId, page.id).then(() => { phoneStore.hide(threadId); requestAnimationFrame(() => address.current?.focus()) })}><X size={15} aria-hidden="true" /></button>
          </> : null}
        </form>
        {problem ? <p className="browser-problem" id="iphone-address-problem" role="alert">{problem}</p> : null}
        {page?.status === 'unavailable' ? <p className="browser-problem" role="status">{page.error ?? 'This page could not load.'} Check that its server is running, then reload.</p>
          : page?.error && !task?.pendingAction ? <p className="browser-problem" role="status">{page.error}</p> : null}
        {browser.notice ? <p className="terminal-notice" role="alert">{browser.notice}</p> : null}
        <dl className="iphone-surface__facts">
          <dt>Runs as</dt><dd>A {TEST_IPHONE.width} by {TEST_IPHONE.height} page in Sotto’s browser with iOS Safari’s user agent and touch. It is not iOS.</dd>
          {page ? <><dt>Agent</dt><dd>{agentToolsUnavailable ? 'This Devin client does not support Sotto browser tools.'
            : page.sharedOrigin ? 'Can read and screenshot this page.' : 'Cannot see this page until you share it.'}
            {!agentToolsUnavailable ? <button type="button" className="browser-review-link tt-focusable" aria-pressed={Boolean(page.sharedOrigin)} disabled={busy} onClick={() => void share()}
              title={page.sharedOrigin ? 'Stop sharing the test iPhone with the agent' : 'Let the agent in this thread read the test iPhone and take screenshots'}>
              <Share2 size={13} aria-hidden="true" />{page.sharedOrigin ? 'Stop sharing' : 'Share with agent'}</button> : null}</dd></> : null}
        </dl>
      </section>

      {task ? <section className="iphone-surface__card" aria-label="What the agent did on the test iPhone">
        <BrowserTaskDetails key={task.id} task={task} store={store} bridge={bridge} />
      </section> : null}

      <CloudIphoneCard threadId={threadId} bridge={cloudBridge} store={cloudStore} />
    </div>
  </div>
}
