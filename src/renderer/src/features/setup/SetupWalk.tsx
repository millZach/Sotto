import React, { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Trans, useLingui } from '@lingui/react/macro'

import { formatAccelerator } from '../../../../shared/accelerator'
import { PROVIDER_LABELS, providerIdSchema } from '../../../../shared/agents'
import type { DictationState } from '../../../../shared/dictation'
import type { HostsState } from '../../../../shared/hosts'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { useOptionalAgents } from '../../agents/AgentContext'
import { liveAgentState, localHostId, localProjects, localProviders } from '../../agents/localAgents'
import { stopMicrophoneTests } from '../../audio/microphoneTest'
import { Button } from '../../components/Button'
import { SottoMark } from '../../components/SottoMark'
import { appearancePreview, useAppearancePreviewVersion, type AppearanceChoice } from '../../state/appearance'
import { useHeldProviders } from '../../state/owlFeature'
import { useOmarchySetup } from '../omarchy/OmarchySetup'
import { useTailscale } from '../settings/TailscaleConnect'
import { neighbouringStop, placeNote, setupStops, SIDEBAR_RAIL, stopDone, stopsLeft, type Box, type SetupFacts, type SetupPage, type SetupStopId } from './setupStops'
import './setupWalk.css'

export interface SetupWalkProps {
  readonly settings: AppSettings
  readonly platform: SottoPlatform
  /** Opens a stop's page, as `actions.navigate` does. */
  readonly onOpenPage: (page: SetupPage) => void
  /** The page the app is on now, which a lit control can change: Add host's Open thread goes to Threads. Without it the walk never waits. */
  readonly navigation?: string | undefined
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  /** A speech model is chosen and has not failed. */
  readonly speechModelChosen: boolean
  /** The model setup suggests while none is chosen: the first on this computer, else the first of Sotto's own (ADR-0094). */
  readonly suggestedSpeechModel?: string | null | undefined
  readonly dictation: DictationState
  readonly dictationOn: boolean
  /** Dictation is transcribed by an OpenRouter speech model (ADR-0160): audio leaves this computer, and there is no model to choose here. */
  readonly cloudTranscription?: boolean
  /** Ends the walk: Skip setup, Finish here and the last note's Done. Answers false when a first run's end could not be saved. */
  readonly onClose: (outcome: { readonly microphoneOpened: boolean }) => Promise<boolean>
}

/** How far the lit edge sits outside the control it lights. */
const PAD = 6
/** Frames a stop's control may be missing, while its page is still laying out, before the note stands without it. */
const MISSING_FRAMES = 45
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
/** A dialog one of the lit controls opened (Sign in, Add host, a folder browser): the walk stands aside for it. */
const OTHER_DIALOG = '.tt-dialog-backdrop, dialog[open], [role="alertdialog"], [role="dialog"][aria-modal="true"], [role="menu"]'
/** A list the lit control opened inside itself, such as the composer's file and skill suggestions, which reach past its box. */
const OWN_POPUP = '[role="listbox"]'

function shown(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.getClientRects().length > 0
}

function boxOf(element: HTMLElement): Box | null {
  const rect = element.getBoundingClientRect()
  // The part of the control that is in the window: a card taller than the window is lit as far as it shows.
  const top = Math.max(0, rect.top), left = Math.max(0, rect.left)
  const bottom = Math.min(window.innerHeight, rect.bottom), right = Math.min(window.innerWidth, rect.right)
  return bottom - top > 0 && right - left > 0 ? { top, left, width: right - left, height: bottom - top } : null
}

const sameBox = (a: Box | null, b: Box | null): boolean => a === b || (a !== null && b !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)

/**
 * First-run setup (ADR-0200): a walk of notes over the real pages. Each stop opens its page, lights one real control
 * there, dims the rest of the window, and puts a note beside the control saying what the stop is for and where it
 * stands. The control stays the page's own: pressing it does what it always does, and the note's way forward reads
 * Continue once its task is done and Skip for now until then. Only the lit control and the note take presses and
 * focus; a dialog the control opens has the window to itself until it closes. Skip setup, or Escape, ends the walk. Setup's first part is done when a first
 * thread is open, and everything after is optional.
 */
export function SetupWalk({ settings, platform, onOpenPage, navigation, onUpdateSettings, speechModelChosen, suggestedSpeechModel = null, dictation, dictationOn, cloudTranscription = false, onClose }: SetupWalkProps): ReactNode {
  const { t, i18n } = useLingui()
  useAppearancePreviewVersion()
  const stops = setupStops(platform)
  const [index, setIndex] = useState(0)
  const stop = stops[index]!
  const [target, setTarget] = useState<Box | null>(null)
  /** The lit control is on the page; false while its page lays out, and for a stop with no control. */
  const [standsAside, setStandsAside] = useState(false)
  const [threadOpen, setThreadOpen] = useState(false)
  /** The sidebar is a rail, as in a narrow window, so the stop lights Expand sidebar instead of the control behind it. */
  const [sidebarShut, setSidebarShut] = useState(false)
  const [microphoneHeard, setMicrophoneHeard] = useState(false)
  /** Settings' test got as far as opening the microphone: access is there, which is what dictation needs (ADR-0063). */
  const [microphoneOpened, setMicrophoneOpened] = useState(false)
  const [shortcutTried, setShortcutTried] = useState(false)
  const [hosts, setHosts] = useState<HostsState | null>(null)
  /** What the Hosts page's own Tailscale row says, which follows a connect made there; null until the walk has seen the row. */
  const [pageTailscale, setPageTailscale] = useState<string | null>(null)
  const [noteHeight, setNoteHeight] = useState(220)
  const [view, setView] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [closing, setClosing] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [lookFailed, setLookFailed] = useState(false)
  const note = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const lit = useRef<HTMLElement | null>(null)
  const titleId = useId(), bodyId = useId()

  const agents = useOptionalAgents()
  const held = useHeldProviders()
  const agentState = liveAgentState(agents?.state)
  const providers = agentState ? localProviders(agentState) : []
  const ready = providers.find(provider => provider.connection === 'connected')
  // A host that says nothing of its providers one by one still says whether it is connected: this computer's, while it is the one selected.
  const hostReady = agentState !== null && providers.length === 0 && agentState.connection === 'connected' && (!agentState.connections?.length || agentState.hostId === localHostId(agentState))
  const projects = agentState ? localProjects(agentState) : []
  const hostsBridge = window.sotto?.hosts
  const tailscale = useTailscale(hostsBridge)
  const omarchy = useOmarchySetup(platform === 'linux' && stop.id === 'omarchy')
  const omarchyDone = !!omarchy.state && Object.values(omarchy.state.pieces).some(piece => ['done', 'manual'].includes(piece.status))

  useEffect(() => {
    if (!hostsBridge) return
    let alive = true
    void hostsBridge.get().then(value => { if (alive) setHosts(value) }).catch(() => undefined)
    const off = hostsBridge.onChanged(value => { if (alive) setHosts(value) })
    return () => { alive = false; off() }
  }, [hostsBridge])

  const tailscaleState = pageTailscale ?? tailscale.summary?.state ?? null
  const facts: SetupFacts = {
    agentReady: ready !== undefined || hostReady, projectAdded: projects.length > 0, threadOpen, omarchyDone, microphoneHeard, speechModelChosen, shortcutTried,
    tailscaleOn: tailscaleState === 'running', hostAdded: (hosts?.hosts.length ?? 0) > 0, phoneAccess: settings.phoneAccess, dictationOn, speechModelHere: !cloudTranscription,
  }
  const done = stopDone(stop.id, facts)

  // Each stop opens its own page. The page is the app's, so the app is asked, once per stop.
  const openPage = useRef(onOpenPage)
  openPage.current = onOpenPage
  useEffect(() => { openPage.current(stop.page) }, [stop])

  // A lit control can lead to another page: Add host's Open thread goes to Threads, where its agent asks its questions.
  // Once a stop's own page has shown, any other page means the user was led away. The walk then waits in the corner,
  // with the page they were sent to fully live, until Back to setup or their own way back (Zach's pick, November 10, 2026).
  const arrivedAt = useRef<SetupStopId | null>(null)
  const [waiting, setWaiting] = useState(false)
  useEffect(() => {
    if (navigation === undefined) return
    if (navigation === stop.page.navigation) { arrivedAt.current = stop.id; setWaiting(false) }
    else setWaiting(arrivedAt.current === stop.id)
  }, [navigation, stop])

  // Arriving at the agents stop connects every agent installed on this computer, as setup's step did (ADR-0063
  // decision 3), so each row says where it stands. It signs in to nothing; a row's own Sign in does that.
  const command = agents?.command
  const connected = useRef(false)
  useEffect(() => {
    if (stop.id !== 'agents' || connected.current || !agentState || !command) return
    connected.current = true
    const local = agentState.connections?.length ? localHostId(agentState) : undefined
    void command({ type: 'connect', notice: false, ...(local ? { hostId: local } : {}) }).catch(() => undefined)
  }, [stop.id, agentState, command])

  // Settings' microphone test listens until it is stopped, and the next stop is on the same page with the test's own
  // Stop under the dim: leaving the microphone stop closes the microphone.
  useEffect(() => stop.id === 'microphone' ? () => { stopMicrophoneTests() } : undefined, [stop.id])

  // A dictation that ends in text during the shortcut stop is the shortcut tried.
  useEffect(() => { if (stop.id === 'shortcut' && dictation.status === 'success') setShortcutTried(true) }, [stop.id, dictation.status])

  // Follow the lit control as its page lays out and scrolls, the way an anchored popover does, and read from the page
  // what only the page knows: that a thread's composer is there, and that Settings' microphone test heard a voice.
  useEffect(() => {
    let frame = 0, missing = 0, revealed = false
    const look = (): void => {
      const element = stop.target.map(selector => document.querySelector(selector)).find(shown) ?? null
      const aside = [...document.querySelectorAll(OTHER_DIALOG)].some(popup => shown(popup) && !popup.closest('.setup-walk'))
        || (element !== null && [...element.querySelectorAll(OWN_POPUP)].some(shown))
      setStandsAside(current => current === aside ? current : aside)
      if (element && !revealed) { revealed = true; element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }
      lit.current = element
      const rail = element !== null && element.matches(SIDEBAR_RAIL)
      setSidebarShut(current => current === rail ? current : rail)
      const next = element ? boxOf(element) : null
      missing = next || stop.target.length === 0 ? 0 : missing + 1
      // A control that is on its way keeps the last box for a moment rather than flashing the whole window dim.
      if (next || missing > MISSING_FRAMES || stop.target.length === 0) setTarget(current => sameBox(current, next) ? current : next)
      const composer = shown(document.querySelector('form.thread-prompt'))
      setThreadOpen(current => current === composer ? current : composer)
      if (document.querySelector('.settings-microphone-test[data-heard]')) setMicrophoneHeard(true)
      const row = document.querySelector<HTMLElement>('section.hosts-tailscale')?.dataset.state
      if (row) setPageTailscale(current => current === row ? current : row)
      if (document.querySelector('.settings-microphone-test:is([data-state="ready"], [data-state="closed"])')) setMicrophoneOpened(true)
      const width = window.innerWidth, height = window.innerHeight
      setView(current => current.width === width && current.height === height ? current : { width, height })
      frame = requestAnimationFrame(look)
    }
    look()
    return () => cancelAnimationFrame(frame)
  }, [stop])

  useLayoutEffect(() => { if (note.current) setNoteHeight(current => note.current!.offsetHeight === current ? current : note.current!.offsetHeight) })
  // Focus goes to each note as it arrives, and comes back to it when a dialog a lit control opened has closed.
  useEffect(() => { if (!standsAside && !waiting) heading.current?.focus() }, [index, standsAside, waiting])

  const close = async (): Promise<void> => {
    if (closing) return
    setClosing(true)
    setSaveFailed(false)
    const saved = await onClose({ microphoneOpened }).catch(() => false)
    if (!saved) { setSaveFailed(true); setClosing(false) }
  }
  const forward = (): void => { setIndex(current => neighbouringStop(stops, current, 1, facts)) }
  const back = (): void => { setIndex(current => neighbouringStop(stops, current, -1, facts)) }

  // Focus stays with the note and the control it lights: Tab goes through the note, then the control, and round. It
  // is heard after the page, so a Tab or an Escape the lit control used for itself (the composer taking a suggestion,
  // an opened provider row closing) is not also the walk's. Escape ends the walk, as Skip setup does (Zach's pick,
  // November 10, 2026). No key goes on to the window's own shortcuts, which would move the page out from under a stop.
  const onKeyDown = (event: globalThis.KeyboardEvent): void => {
    // While the walk waits in the corner the page is the user's, keys and all.
    if (standsAside || waiting || !note.current) return
    event.stopPropagation()
    if (event.defaultPrevented) return
    if (event.key === 'Escape') { event.preventDefault(); void close(); return }
    if (event.key !== 'Tab') return
    const within = (root: HTMLElement | null): HTMLElement[] => root ? [...(root.matches(FOCUSABLE) ? [root] : []), ...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shown) : []
    const order = [...within(note.current), ...within(lit.current)]
    if (order.length === 0) return
    event.preventDefault()
    const at = order.indexOf(document.activeElement as HTMLElement)
    const next = at < 0 ? (event.shiftKey ? order.length - 1 : 0) : (at + (event.shiftKey ? order.length - 1 : 1)) % order.length
    order[next]!.focus()
  }
  const keyDown = useRef(onKeyDown)
  keyDown.current = onKeyDown
  useEffect(() => {
    const listen = (event: globalThis.KeyboardEvent): void => keyDown.current(event)
    document.addEventListener('keydown', listen)
    return () => document.removeEventListener('keydown', listen)
  }, [])

  // The look, on the first note: light, dark or the system's, painted at once as Settings › Appearance paints it.
  const look = appearancePreview.effective(settings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const chooseLook = async (appearance: AppearanceChoice['appearance']): Promise<void> => {
    setLookFailed(false)
    const sequence = appearancePreview.choose({ appearance })
    const saved = await onUpdateSettings({ appearance }).catch(() => false)
    appearancePreview.settle(sequence, saved, settingsRef.current)
    setLookFailed(!saved)
  }
  const onLookKey = (event: KeyboardEvent<HTMLElement>): void => {
    const onward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    if (!onward && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') return
    const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const at = radios.findIndex(radio => radio === document.activeElement)
    if (at < 0) return
    event.preventDefault()
    const next = radios[(at + (onward ? 1 : radios.length - 1)) % radios.length]!
    next.focus()
    next.click()
  }

  const system = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : 'Windows'
  const shortcut = formatAccelerator(settings.hotkey, platform, 'editing')
  const agentNames = new Intl.ListFormat(i18n.locale, { style: 'long', type: 'conjunction' }).format(providerIdSchema.options.filter(id => !held.has(id)).map(id => PROVIDER_LABELS[id]))
  const readyName = ready ? PROVIDER_LABELS[ready.id] : ''
  const project = projects[0]?.title ?? ''
  const host = hosts?.hosts[0]?.name ?? ''
  const titles: Record<SetupStopId, string> = {
    welcome: t`Talk to your computer and your coding agents`,
    agents: t`Sign in to a coding agent`,
    project: t`Add a project folder`,
    thread: threadOpen ? t`This is a thread` : t`Start your first thread`,
    omarchy: t`Set up Sotto in Omarchy`,
    microphone: t`Check your microphone`,
    'speech-model': t`Choose a speech model`,
    shortcut: t`Try the shortcut`,
    tailscale: t`Tailscale joins your devices`,
    computers: t`Run threads on another computer`,
    iphone: t`Answer threads from your iPhone`,
    end: t`That’s setup`,
  }
  /** Where each stop's task lives once the walk is over, for the last note. */
  const places: Partial<Record<SetupStopId, string>> = {
    agents: t`Settings › Providers`, project: t`Add project, in the sidebar`, thread: t`New thread, in the sidebar`,
    omarchy: t`Settings › Dictation`, microphone: t`Settings › Dictation`, 'speech-model': t`Settings › Dictation`, shortcut: t`the Dictate page`,
    tailscale: t`Settings › Hosts & phones`, computers: t`Settings › Hosts & phones`, iphone: t`Settings › Hosts & phones`,
  }
  const body = (): string => {
    switch (stop.id) {
      case 'welcome': return dictationOn && cloudTranscription
        ? t`Sotto runs ${agentNames} threads in one window, and turns your voice into text. This walk sets up your first thread, then dictation, other computers and your iPhone. Skip any part. First, pick how Sotto looks.`
        : dictationOn
        ? t`Sotto runs ${agentNames} threads in one window, and turns your voice into text on this computer. This walk sets up your first thread, then dictation, other computers and your iPhone. Skip any part. First, pick how Sotto looks.`
        : t`Sotto runs ${agentNames} threads in one window. This walk sets up your first thread, then other computers and your iPhone. Skip any part. First, pick how Sotto looks.`
      case 'agents': return t`A thread runs on an agent you already have. These are the ones Sotto looked for on this computer. Sign in opens that agent’s own sign-in.`
      case 'project': return sidebarShut
        ? t`A project is a folder your agents work in, usually a Git repository. Open the sidebar, press Add project and choose one.`
        : t`A project is a folder your agents work in, usually a Git repository. Press Add project and choose one.`
      case 'thread': return !threadOpen ? (sidebarShut ? t`Open the sidebar and press New thread.` : project ? t`Press New thread. It opens in ${project}.` : t`Press New thread.`)
        : !dictationOn ? t`Type what you want done. The agent’s work shows here, and it asks you before anything that needs your say.`
        : platform === 'linux' ? t`Type what you want done, or hold F9 and say it. The agent’s work shows here, and it asks you before anything that needs your say.`
        : t`Type what you want done, or press ${shortcut} and say it. The agent’s work shows here, and it asks you before anything that needs your say.`
      case 'omarchy': return t`Three changes to your Omarchy settings: the F9 and Super+Ctrl+X keys, the owl in the bar, and the theme. Remove any of them later here.`
      case 'microphone': return t`Press Test microphone and say a few words. Sotto opens the microphone only while you dictate or run this test.`
      case 'speech-model': return suggestedSpeechModel && !speechModelChosen
        ? t`Sotto turns your voice into text on this computer, and your audio never leaves it. Choose a model here; Sotto suggests ${suggestedSpeechModel}. One that is not on this computer yet downloads when you choose it, and you can carry on while it does.`
        : t`Sotto turns your voice into text on this computer, and your audio never leaves it. Choose a model here. One that is not on this computer yet downloads when you choose it, and you can carry on while it does.`
      case 'shortcut': return platform === 'linux' ? t`Hold F9, say something, and let go. Your words arrive wherever you were typing.` : t`Press ${shortcut}, say something, and press it again. Your words arrive wherever you were typing.`
      case 'tailscale': return t`Other computers and your iPhone reach this computer over Tailscale. Only using this computer? Skip the next three.`
      case 'computers': return t`Add host lists the computers on your tailnet and in your SSH configuration, and sets Sotto up on the one you choose.`
      case 'iphone': return t`Get the beta from TestFlight, turn on Let phones connect, then show a pairing code and enter it in the app.`
      case 'end': return t`Settings has how Sotto looks, and each part of this walk. Set up Sotto, in Help, starts the walk again.`
    }
  }
  /** Where the stop stands: its task done, or what is in its way. */
  const status = (): { readonly tone: 'done' | 'waiting'; readonly text: string } | null => {
    switch (stop.id) {
      case 'agents': return ready ? { tone: 'done', text: t`${readyName} is ready.` } : hostReady ? { tone: 'done', text: t`An agent is ready.` } : { tone: 'waiting', text: t`None is ready yet. A thread needs one.` }
      case 'project': return facts.projectAdded ? { tone: 'done', text: t`${project} is added.` } : null
      case 'thread': return threadOpen ? { tone: 'done', text: t`Your first thread is open. The rest is optional.` } : null
      case 'omarchy': return omarchyDone ? { tone: 'done', text: t`Sotto is set up in Omarchy.` } : null
      case 'microphone': return microphoneHeard ? { tone: 'done', text: t`Sotto heard you. Your microphone works.` } : null
      case 'speech-model': return speechModelChosen ? { tone: 'done', text: t`A speech model is chosen. Dictation works as soon as it is ready.` } : null
      case 'shortcut': return shortcutTried ? { tone: 'done', text: t`That worked.` } : null
      case 'tailscale': return facts.tailscaleOn ? { tone: 'done', text: t`Tailscale is on.` }
        : tailscaleState === 'missing' ? { tone: 'waiting', text: t`Tailscale is not installed on this computer.` }
        : tailscaleState === 'off' ? { tone: 'waiting', text: t`Tailscale is off on this computer.` } : null
      case 'computers': return facts.hostAdded ? { tone: 'done', text: t`${host} is added.` } : null
      case 'iphone': return facts.phoneAccess ? { tone: 'done', text: t`Phones you pair can connect.` } : null
      default: return null
    }
  }
  const said = status()
  const left = stop.id === 'end' ? stopsLeft(stops, facts) : []
  const first = stop.id === 'welcome', last = stop.id === 'end'
  const firstThread = stop.id === 'thread' && threadOpen
  const onward = neighbouringStop(stops, index, 1, facts)
  const forwardLabel = first ? t({ message: 'Start', comment: 'Starts first-run setup’s walk.' })
    : firstThread && stops[onward]?.dictation ? t`Continue to dictation`
    : done ? t`Continue` : t`Skip for now`
  const placed = placeNote(target, () => noteHeight, view)
  const place = placed.note
  const count = index + 1, total = stops.length
  const modes = [['light', t({ message: 'Light', comment: 'Colour scheme' })], ['system', t`Match ${system}`], ['dark', t({ message: 'Dark', comment: 'Colour scheme' })]] as const

  // A dialog a lit control opened has the window to itself: nothing of the walk is drawn until it closes.
  if (standsAside) return null
  const title = titles[stop.id]
  if (waiting) return createPortal(
    <div className="setup-walk setup-walk--waiting" data-stop={stop.id}>
      <div className="setup-walk__waiting" role="region" aria-label={t`Setup`}>
        <h2>{t`Setup is waiting`}</h2>
        <p className="tt-paragraph"><Trans>It was on “{title}”. Come back to it when you are ready.</Trans></p>
        {saveFailed ? <p className="setup-walk__failed tt-paragraph" role="alert"><Trans>Setup could not be saved. Your choices are intact; please try again.</Trans></p> : null}
        <footer>
          <button type="button" className="setup-walk__quit tt-focusable" disabled={closing} onClick={() => void close()}>{t`Skip setup`}</button>
          <span className="setup-walk__actions"><Button onClick={() => openPage.current(stop.page)}><Trans>Back to setup</Trans></Button></span>
        </footer>
      </div>
    </div>,
    document.body,
  )
  const lighted = placed.lit
  const hole = lighted ? { top: lighted.top - PAD, left: lighted.left - PAD, width: lighted.width + PAD * 2, height: lighted.height + PAD * 2 } : null
  return createPortal(
    <div className="setup-walk" data-stop={stop.id}>
      {hole ? <>
        {/* Four panels dim the window and take its presses; the gap between them is the lit control, which stays live. */}
        <div className="setup-walk__dim" style={{ top: 0, left: 0, right: 0, height: Math.max(0, hole.top) }} />
        <div className="setup-walk__dim" style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
        <div className="setup-walk__dim" style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} />
        <div className="setup-walk__dim" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
        <div className="setup-walk__lit" aria-hidden="true" style={hole} />
      </> : <div className="setup-walk__dim" style={{ inset: 0 }} />}
      <div ref={note} className="setup-walk__note" role="dialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={bodyId}
        style={{ top: place.top, left: place.left, width: place.width, maxHeight: view.height - 24 }}>
        {first ? <SottoMark className="setup-walk__mark" /> : null}
        <h2 id={titleId} ref={heading} tabIndex={-1}>{titles[stop.id]}</h2>
        <p className="tt-paragraph" id={bodyId}>{body()}</p>
        {first ? <>
          <div className="setup-walk__looks" role="radiogroup" aria-label={t`Appearance`} onKeyDown={onLookKey}>
            {modes.map(([mode, label]) => <button key={mode} type="button" role="radio" aria-checked={look.appearance === mode} tabIndex={look.appearance === mode ? 0 : -1}
              className="setup-walk__look tt-focusable" onClick={() => void chooseLook(mode)}>{label}</button>)}
          </div>
          {lookFailed ? <p className="setup-walk__failed tt-paragraph" role="alert"><Trans>That look could not be saved. Your previous look is still on. Choose it again to retry.</Trans></p> : null}
          <p className="setup-walk__aside tt-paragraph">{cloudTranscription
            ? <Trans>No Sotto account. Product events are on until you turn them off in Settings.</Trans>
            : <Trans>Your audio never leaves this computer. No Sotto account. Product events are on until you turn them off in Settings.</Trans>}</p>
        </> : null}
        {said ? <p className="setup-walk__status tt-paragraph" data-tone={said.tone} role="status">{said.text}</p> : null}
        {last ? left.length === 0 ? <p className="setup-walk__status tt-paragraph" data-tone="done"><Trans>Everything in the walk is set up.</Trans></p>
          : <><p className="tt-paragraph"><Trans>Still to do:</Trans></p>
            <ul className="setup-walk__left">{left.map(id => { const title = titles[id], where = places[id] ?? ''; return <li key={id}><Trans>{title}: {where}</Trans></li> })}</ul></> : null}
        {saveFailed ? <p className="setup-walk__failed tt-paragraph" role="alert"><Trans>Setup could not be saved. Your choices are intact; please try again.</Trans></p> : null}
        <footer>
          <span className="setup-walk__count"><Trans>{count} of {total}</Trans></span>
          {last ? null : <button type="button" className="setup-walk__quit tt-focusable" disabled={closing} onClick={() => void close()}>{firstThread ? t`Finish here` : t`Skip setup`}</button>}
          <span className="setup-walk__actions">
            {index > 0 && !last ? <Button variant="ghost" onClick={back}><Trans>Back</Trans></Button> : null}
            {last ? <Button disabled={closing} onClick={() => void close()}>{closing ? t`Saving setup...` : t({ message: 'Done', comment: 'Closes a dialog.' })}</Button>
              : <Button variant={done || first ? 'primary' : 'secondary'} onClick={forward}>{forwardLabel}</Button>}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
