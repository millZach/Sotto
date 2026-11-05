import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, ArrowUpRight, ChevronDown, Paperclip, Square, X } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import type { AgentAttachmentHandle, AgentCommand, AgentMessage, AgentRequest, AgentState, AgentThread } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import type { PopupBridge } from '../../../shared/popup'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import { AgentRequestCard } from '../agents/requests/AgentRequestCard'
import type { RequestAnswer, SubmitOutcome } from '../agents/requests/requestAnswers'
import { AttachmentPreviews, MessageContent } from '../agents/MessageContent'
import { chordClaimed } from '../agents/branchToolbar.logic'
import { beginNewThread } from '../agents/newThread'
import { ScreenshotInput } from '../agents/ScreenshotInput'
import { useThumbnail } from '../agents/stagedImages'
import { clockLabel } from '../agents/threadFacts'
import { shownWords, type LaterWords } from '../agents/interfaceWords'
import { threadForTarget } from '../watcher/watcherRoom'
import { PopupOwl } from './PopupOwl'
import {
  newestExchangeStart, nextPopupDetail, popupKeyAction, popupProject, readPopupMemory, recentThreads, shownMessages, slashCommandOf, slashCommands, slashMatches, splitClosingLines, writePopupMemory,
  type PopupDetail, type PopupMemory, type PopupTarget, type SlashCommand,
} from './popupLogic'
import './popup.css'

const COMMAND_WORDS: Readonly<Record<SlashCommand, ReturnType<typeof msg>>> = {
  new: msg`Start a new thread`,
  stop: msg`Stop the running turn`,
  open: msg`Show it in Sotto`,
  watcher: msg`Ask Watcher instead`,
  thread: msg`Go back to the thread`,
}

const HISTORY_UNAVAILABLE = msg`Could not load this thread’s messages. Open it in Sotto or reopen the popup to try again.`
const THREADS_UNAVAILABLE = msg`Sotto could not read the threads. Reopen the popup and try again.`
const WATCHER_UNAVAILABLE = msg`Sotto could not read Watcher’s room. Reopen the popup and try again.`

/** Main's answer to a command, or null when none came: the popup reads only whether it was refused, and why. */
type Reply = { readonly error: string | null } | null

/** The keys that work wherever the keyboard is in the card; the others are the prompt's. */
const CARD_WIDE_ACTIONS: ReadonlySet<string> = new Set(['hide', 'stop', 'open', 'ask-watcher', 'ask-thread', 'choose-thread', 'new-thread'])
/** The keys of the card's own chords, with Command on a Mac and Ctrl elsewhere. */
const CHORD_KEYS: Readonly<Record<string, string>> = { 'ask-watcher': '1', 'ask-thread': '2', 'choose-thread': 'k', 'new-thread': 'n', open: 'o' }

const storage = (): Storage | undefined => { try { return window.localStorage } catch { return undefined } }

type OpenLink = (url: string) => Promise<{ ok: boolean }>

/** A sent reply: its words, then the labelled lines that close it as one block. */
const PopupReply = memo(function PopupReply({ text, streaming, onOpenLink }: { readonly text: string; readonly streaming: boolean; readonly onOpenLink: OpenLink }): ReactNode {
  const { body, closing } = useMemo(() => splitClosingLines(text), [text])
  return <>
    {body !== '' ? <MessageContent text={body} streaming={streaming && closing === ''} onOpenLink={onOpenLink} /> : null}
    {closing !== '' ? <div className="popup-closing"><MessageContent text={closing} streaming={streaming} onOpenLink={onOpenLink} /></div> : null}
  </>
})

/** One message of the conversation. `newest` marks where the card's opening height starts. */
const PopupEntry = memo(function PopupEntry({ message, threadId, afterReply, newest, streaming, onOpenLink }: { readonly message: AgentMessage; readonly threadId: string
  readonly afterReply: boolean; readonly newest: boolean; readonly streaming: boolean; readonly onOpenLink: OpenLink }): ReactNode {
  const mark = newest ? { 'data-newest': '' } : {}
  const attachments = <AttachmentPreviews attachments={message.attachments ?? []} origin={{ threadId, messageId: message.id }} />
  if (message.role === 'user') return <div className="popup-entry popup-entry--user" {...mark}>
    {attachments}
    {message.text.trim() !== '' ? <div className="popup-bubble"><MessageContent text={message.text} onOpenLink={onOpenLink} /></div> : null}
  </div>
  return <>
    {afterReply ? <div className="popup-rule" {...mark}><time dateTime={message.createdAt}>{clockLabel(Date.parse(message.createdAt))}</time></div> : null}
    <div className="popup-entry popup-entry--reply" {...afterReply ? {} : mark}>
      <PopupReply text={message.text} streaming={streaming} onOpenLink={onOpenLink} />
      {attachments}
    </div>
  </>
})

/** A photo just sent, until the thread's own copy of the message arrives. */
function EchoPhoto({ threadId, photo }: { readonly threadId: string | null; readonly photo: AgentAttachmentHandle }): ReactNode {
  const source = useThumbnail(threadId, photo)
  return source ? <img src={source} alt={photo.name} /> : null
}

/**
 * The popup (ADR-0181): a prompt at the bottom and the conversation growing upward above it as the reply streams in,
 * talking to one thread or to Watcher. It reads and prompts its target through the channels the main window uses, as the
 * same user; every question and permission it shows is answered only by the user's own press.
 */
export function PopupApp({ bridge }: { readonly bridge: PopupBridge }): ReactNode {
  const { t, i18n } = useLingui()
  const [memory, setMemory] = useState<PopupMemory>(() => readPopupMemory(storage()))
  const [shell, setShell] = useState<AgentState | null>(null)
  const [watcher, setWatcher] = useState<{ readonly threadId: string; readonly handover: boolean } | null>(null)
  // Both targets are observed and held while the card shows, so a switch shows the other one at once.
  const [records, setRecords] = useState<Readonly<Record<string, AgentThread>>>({})
  const [details, setDetails] = useState<Readonly<Record<string, PopupDetail>>>({})
  const [input, setInput] = useState('')
  const [photos, setPhotos] = useState<readonly AgentAttachmentHandle[]>([])
  const [reading, setReading] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  const [listOpen, setListOpen] = useState(false)
  const [notice, setNotice] = useState<LaterWords | null>(null)
  const [echo, setEcho] = useState<{ readonly text: string; readonly after: number; readonly photos: readonly AgentAttachmentHandle[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState(0)
  const [hotkey, setHotkey] = useState<string | undefined>(undefined)
  const prompt = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const chrome = useRef<HTMLDivElement>(null)
  const threadList = useRef<HTMLUListElement>(null)
  const pinned = useRef(true)
  /** The tallest the card has asked to be since it was shown: it only grows during one showing, so a switch moves the words and not the window. */
  const held = useRef(0)

  const remember = useCallback((next: Partial<PopupMemory>): void => {
    setMemory(current => {
      const merged = { ...current, ...next }
      writePopupMemory(storage(), merged)
      return merged
    })
  }, [])

  const target: PopupTarget = memory.target === 'watcher' && watcher !== null ? 'watcher' : 'thread'
  const threadId = target === 'watcher' ? watcher?.threadId ?? null : memory.threadId
  const commands = slashCommands(target, watcher !== null)
  const menu = slashMatches(input, commands)
  const current = threadId === null ? null : records[threadId] ?? null
  const running = current !== null && isThreadTurnRunning(current)
  const waiting = (current?.requests.length ?? 0) > 0
  const project = shell === null ? null : popupProject(shell, memory.projectId)
  const myThread = memory.threadId === null ? null : records[memory.threadId] ?? null
  const watcherThread = watcher === null ? null : records[watcher.threadId] ?? null

  // Each time the popup is shown it reads its target again: the threads, Watcher's current conversation, and whether the
  // thread it last used is still there. A thread that went is forgotten and the next prompt starts a new one.
  useEffect(() => bridge.onShown(() => setShown(count => count + 1)), [bridge])
  useEffect(() => {
    void bridge.getSettings().then(settings => setHotkey(settings.hotkey), () => undefined)
    return bridge.onSettingsChanged(settings => setHotkey(settings.hotkey))
  }, [bridge])
  useEffect(() => {
    let live = true
    setListOpen(false)
    void (async () => {
      const state = await bridge.shell().catch(() => null)
      if (!live) return
      if (state === null) { setNotice(THREADS_UNAVAILABLE); return }
      setNotice(current => current === THREADS_UNAVAILABLE ? null : current)
      setShell(state)
      setMemory(current => {
        const kept = current.threadId !== null && state.host.threads.some(item => item.id === current.threadId && !item.archivedAt) ? current.threadId : null
        if (kept === current.threadId) return current
        const next = { ...current, threadId: kept }
        writePopupMemory(storage(), next)
        return next
      })
      const room = bridge.watcher ? await bridge.watcher().catch(() => null) : null
      if (!live) return
      if (bridge.watcher && room === null) { setNotice(WATCHER_UNAVAILABLE); return }
      setNotice(current => current === WATCHER_UNAVAILABLE ? null : current)
      const current = room?.status === 'ok' ? room.state.current : null
      const watcherThread = current ? threadForTarget(state, current.target) : undefined
      setWatcher(watcherThread && room?.status === 'ok' ? { threadId: watcherThread.id, handover: room.state.handover != null } : null)
      // Said once: the popup stays on the thread from then on, until the user asks for Watcher again.
      if (memory.target === 'watcher' && watcherThread === undefined) { setNotice(msg`Watcher isn’t running, so the popup is on your thread.`); remember({ target: 'thread' }) }
    })()
    prompt.current?.focus()
    return () => { live = false }
  }, [bridge, shown]) // Read on each show: the target remembered then is the one the show finds.

  // The two threads: observed while the popup shows them, their records from main's pushes and their histories read whole
  // once, then kept up by the changes main sends. A change the popup cannot place reads that history whole again.
  // Main lets go of the observation each time the popup hides, so each show observes again and reads what it missed,
  // keeping what it holds on screen until the read lands.
  const observedIds = useMemo(() => [...new Set([watcher?.threadId, memory.threadId].filter((id): id is string => id !== undefined && id !== null))], [watcher?.threadId, memory.threadId])
  const observed = useRef<readonly string[]>([])
  const readDetail = useCallback((id: string): void => {
    void bridge.threadDetail(id).then(read => {
      if (!observed.current.includes(id)) return
      const whole = read === null ? null : nextPopupDetail(null, read)
      if (whole !== null) { setDetails(held => ({ ...held, [id]: whole })); setNotice(current => current === HISTORY_UNAVAILABLE ? null : current) }
    }, () => { if (observed.current.includes(id)) setNotice(HISTORY_UNAVAILABLE) })
  }, [bridge])
  const observedKey = observedIds.join('\n')
  const readOnShow = useRef(-1)
  const heldDetails = useRef(details)
  heldDetails.current = details
  useEffect(() => {
    observed.current = observedIds
    pinned.current = true
    void bridge.command({ type: 'observe-threads', threadIds: [...observedIds] }).catch(() => undefined)
    // A show reads what it missed while hidden; a change of thread reads only the thread it does not hold.
    const newShow = readOnShow.current !== shown
    readOnShow.current = shown
    for (const id of observedIds) if (newShow || heldDetails.current[id] === undefined) readDetail(id)
    const keep = <T,>(held: Readonly<Record<string, T>>): Readonly<Record<string, T>> => Object.fromEntries(Object.entries(held).filter(([id]) => observedIds.includes(id)))
    setDetails(keep)
    setRecords(keep)
    return () => { observed.current = [] }
  }, [bridge, observedKey, shown, readDetail])
  // The records a read of the shell found, until main pushes newer ones. A change of thread takes from the shell only the
  // thread it does not hold: the shell is older than what main has pushed for the other since.
  const placedShell = useRef<AgentState | null>(null)
  useEffect(() => {
    if (shell === null) return
    const fresh = placedShell.current !== shell
    placedShell.current = shell
    setRecords(held => {
      const found = shell.host.threads.filter(item => observedIds.includes(item.id) && (fresh || held[item.id] === undefined))
      return found.length === 0 ? held : { ...held, ...Object.fromEntries(found.map(item => [item.id, item])) }
    })
  }, [shell, observedKey])
  useEffect(() => bridge.onThread(record => { if (observed.current.includes(record.id)) setRecords(held => ({ ...held, [record.id]: record })) }), [bridge])
  useEffect(() => bridge.onThreadDetail(update => {
    if (!observed.current.includes(update.threadId)) return
    setDetails(held => {
      const next = nextPopupDetail(held[update.threadId] ?? null, update)
      if (next !== null) return { ...held, [update.threadId]: next }
      readDetail(update.threadId)
      return held
    })
  }), [bridge, readDetail])

  const shownDetail = threadId === null ? null : details[threadId] ?? null
  const messages = useMemo(() => shownMessages(shownDetail?.messages ?? []), [shownDetail])
  const newest = newestExchangeStart(messages)
  const live = messages.length > 0 || echo !== null || waiting || running
  const userMessages = useMemo(() => (shownDetail?.messages ?? []).filter(message => message.role === 'user').length, [shownDetail])
  // What the user just sent shows at once, until the thread's own copy of it arrives.
  useEffect(() => { if (echo !== null && userMessages > echo.after) setEcho(null) }, [echo, userMessages])

  // The window is as tall as the newest exchange wants, which main holds to a share of the screen, and older messages are
  // a scroll up. It keeps the tallest it has been since it was shown, and the conversation stays at its newest line
  // unless the user scrolled up. The list of threads gets the room it needs while it is open.
  useLayoutEffect(() => { held.current = 0 }, [shown])
  useLayoutEffect(() => {
    const root = card.current, inside = root?.firstElementChild, controls = chrome.current, list = transcript.current
    if (!root || !inside || !controls) return undefined
    const report = (): void => {
      const words = list?.firstElementChild as HTMLElement | null | undefined
      const mark = words?.querySelector('[data-newest]')
      const style = getComputedStyle(root)
      const border = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0)
      // The drop overlay lies over the card and takes no room of its own.
      const around = [...inside.children].reduce((sum, child) => child === list || child.matches('.screenshot-input__drop') ? sum : sum + (child as HTMLElement).offsetHeight, 0)
      const opening = !words ? 0 : !mark ? words.offsetHeight
        : words.getBoundingClientRect().bottom - mark.getBoundingClientRect().top + (Number.parseFloat(getComputedStyle(words).paddingTop) || 0)
      held.current = Math.max(held.current, Math.ceil(border + around + opening))
      const forList = threadList.current ? Math.ceil(border + around + threadList.current.offsetHeight + 16) : 0
      // Main holds the window to a share of the screen; a long conversation asks for no more than the channel takes.
      void bridge.fit(Math.min(10_000, Math.max(held.current, forList))).catch(() => undefined)
      if (list && pinned.current) list.scrollTop = list.scrollHeight
    }
    const observer = new ResizeObserver(report)
    observer.observe(root)
    observer.observe(controls)
    if (list?.firstElementChild) observer.observe(list.firstElementChild)
    report()
    return () => observer.disconnect()
  }, [bridge, live, threadId, shown, listOpen, photos.length])

  const command = useCallback((request: AgentCommand): Promise<Reply> => bridge.command(request).catch(() => null), [bridge])

  /** A switch keeps the words and photos going with the next prompt: they go to whoever the prompt goes to when sent. */
  const switchTarget = (next: PopupTarget): void => {
    if (next === 'watcher' && watcher === null) { setNotice(msg`Watcher isn’t running. Start it in Sotto, then switch again.`); return }
    setNotice(null)
    setEcho(null)
    setListOpen(false)
    pinned.current = true
    remember({ target: next })
    prompt.current?.focus()
  }

  const chooseThread = (thread: AgentThread): void => {
    setNotice(null)
    setEcho(null)
    setListOpen(false)
    pinned.current = true
    remember({ target: 'thread', threadId: thread.id, projectId: thread.projectId })
    prompt.current?.focus()
  }

  const startOver = (): void => {
    setNotice(null)
    setEcho(null)
    setListOpen(false)
    held.current = 0
    remember({ target: 'thread', threadId: null })
    prompt.current?.focus()
  }

  const stop = (): void => {
    if (threadId === null || !running) return
    void command({ type: 'interrupt', threadId }).then(reply => { if (reply?.error) setNotice(reply.error) })
  }

  const open = (): void => {
    if (threadId === null) { setNotice(msg`Nothing to show in Sotto yet. Send a prompt first.`); return }
    void bridge.open({ threadId, watcher: target === 'watcher' }).catch(() => setNotice(msg`Sotto could not show it. Open Sotto and choose it there.`))
  }

  const run = (name: SlashCommand): void => {
    setInput('')
    setMenuIndex(0)
    if (name === 'new') startOver()
    else if (name === 'stop') stop()
    else if (name === 'open') open()
    else switchTarget(name === 'watcher' ? 'watcher' : 'thread')
  }

  /** Sends the prompt: a new thread first when there is none, then the words and photos, queued behind a turn that is running. */
  const send = async (): Promise<void> => {
    const text = input
    const named = slashCommandOf(text, commands)
    if (named !== null && photos.length === 0) { run(named); return }
    if ((text.trim() === '' && photos.length === 0) || busy || reading > 0) return
    if (target === 'watcher' && watcher?.handover) {
      setNotice(msg`Watcher is offering the last Watcher’s handover. Open Watcher’s room to continue with it or put it away, then send again.`)
      return
    }
    const sending = photos
    setBusy(true)
    setNotice(null)
    setInput('')
    setPhotos([])
    setEcho({ text, after: userMessages, photos: sending })
    pinned.current = true
    const failed = (words: LaterWords): void => { setNotice(words); setInput(text); setPhotos(sending); setEcho(null) }
    try {
      let id = threadId
      let queue = running || waiting
      if (id === null) {
        const state = await bridge.shell().catch(() => null)
        const where = state === null ? null : popupProject(state, memory.projectId)
        if (state === null || where === null) { failed(msg`There is no project to start a thread in. Add one in Sotto, then send again.`); return }
        const started = await beginNewThread(state, command, where, () => bridge.getSettings())
        if ('error' in started) { failed(started.error); return }
        id = started.thread.id
        queue = false
        setShell(state)
        remember({ threadId: id, projectId: where.id, target: 'thread' })
        const refused = await started.created
        if (refused !== null) { failed(refused); remember({ threadId: null }); return }
        // Observed again now main has it: the first observation may have reached main before the thread did.
        await command({ type: 'observe-threads', threadIds: [...new Set([id, ...observed.current])] })
        readDetail(id)
      } else if (target === 'thread' && current !== null) remember({ projectId: current.projectId })
      const reply = await command({ type: queue ? 'queue-followup' : 'manual-send', threadId: id, draftId: crypto.randomUUID(), text,
        ...(sending.length > 0 ? { attachments: [...sending] } : {}) })
      if (reply === null) failed(msg`Sotto didn’t confirm the prompt. It is back in the box; check the thread before you send it again.`)
      else if (reply.error !== null) failed(reply.error)
    } finally {
      setBusy(false)
    }
  }

  const threadChoices = useMemo(() => listOpen ? recentThreads(shell?.host.threads ?? [], shell?.host.projects ?? []) : [], [listOpen, shell])
  const listLength = threadChoices.length + 1
  const listActive = Math.min(menuIndex, listLength - 1)
  const chooseFromList = (index: number): void => {
    const thread = threadChoices[index]
    setMenuIndex(0)
    if (thread) chooseThread(thread)
    else startOver()
  }
  const toggleList = (): void => {
    const opening = !listOpen
    setMenuIndex(0)
    setListOpen(opening)
    prompt.current?.focus()
    // The list says what is running now, not what was when the card was shown.
    if (opening) void bridge.shell().then(setShell, () => undefined)
  }

  const chordFree = (key: string): boolean => chordClaimed(`mod+${key}`, hotkey, bridge.platform)
  const chordLeftToDictation = (action: string): boolean => { const key = CHORD_KEYS[action]; return key !== undefined && !chordFree(key) }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return
    // The list answers Escape wherever the keyboard is.
    if (listOpen && event.key === 'Escape') { event.preventDefault(); setListOpen(false); prompt.current?.focus(); return }
    const inPrompt = event.target === prompt.current
    const action = popupKeyAction(event.nativeEvent, { platform: bridge.platform, menu: inPrompt && (menu.length > 0 || listOpen), canStop: target === 'thread' && running })
    if (action === null || (!inPrompt && !CARD_WIDE_ACTIONS.has(action))) return
    if (action === 'newline') return
    if (chordLeftToDictation(action)) return
    event.preventDefault()
    const chosen = menu[Math.min(menuIndex, menu.length - 1)]
    const count = listOpen ? listLength : menu.length
    if (action === 'send') void send()
    else if (action === 'run-command' || action === 'complete') {
      if (listOpen) chooseFromList(listActive)
      else if (chosen && action === 'run-command') run(chosen)
      else if (chosen) setInput(`/${chosen} `)
    }
    else if (action === 'menu-next') setMenuIndex(index => (index + 1) % count)
    else if (action === 'menu-previous') setMenuIndex(index => (index - 1 + count) % count)
    else if (action === 'close-menu') setInput('')
    else if (action === 'stop') stop()
    else if (action === 'open') open()
    else if (action === 'hide') void bridge.hide()
    else if (action === 'ask-watcher') { if (bridge.watcher) switchTarget('watcher') }
    else if (action === 'ask-thread') switchTarget('thread')
    else if (action === 'choose-thread') toggleList()
    else if (action === 'new-thread') startOver()
  }

  const answer = (request: AgentRequest) => (reply: RequestAnswer): Promise<SubmitOutcome> => current === null ? Promise.resolve(null)
    : command({ type: 'answer', threadId: current.id, requestId: request.id, ...reply }).then(result => result === null ? null : { error: result.error })
  const openLink = useCallback<OpenLink>(url => bridge.openExternalLink(url).catch(() => ({ ok: false })), [bridge])
  const newThreadWords = project === null ? t`New thread` : t`New thread in ${project.title}`
  const placeholder = target === 'watcher' ? t`Ask Watcher…` : threadId === null ? `${newThreadWords}…` : t`Reply to this thread…`
  const canSend = (input.trim() !== '' || photos.length > 0) && menu.length === 0 && !busy && reading === 0
  const showStop = target === 'thread' && running && !canSend
  const threadName = memory.threadId === null ? t`New thread` : myThread?.title ?? t`Thread`
  const where = target === 'watcher' ? 'Watcher' : threadId === null ? newThreadWords : threadName
  const threadBusy = myThread !== null && (isThreadTurnRunning(myThread) || myThread.requests.length > 0)
  const watcherWaits = (watcherThread?.requests.length ?? 0) > 0
  const models = shell?.host.models ?? []
  const model = current === null ? undefined : resolveModel(models, current.modelId)
  const reads = useMemo(() => ({ pending: false, problem: null, begin: () => { setReading(count => count + 1); return () => setReading(count => count - 1) } }), [])
  const primary = bridge.platform === 'darwin' ? '⌘' : 'Ctrl+'
  /** " (⌘K)", or nothing when the dictation hotkey holds those keys and the card has left them to it. */
  const keys = (key: string): string => chordFree(key) ? ` (${primary}${key.toUpperCase()})` : ''
  const activeId = listOpen ? `popup-thread-${listActive}` : menu.length > 0 ? `popup-command-${menu[Math.min(menuIndex, menu.length - 1)]}` : null

  return (
    <div ref={card} className="popup-card" onKeyDown={onKeyDown} onMouseDown={event => {
      if (listOpen && !(event.target as HTMLElement).closest('.popup-list, .popup-target__more')) setListOpen(false)
    }}>
      <ScreenshotInput target={threadId} attachments={photos} onChange={setPhotos} disabled={false} supported={model?.supportsImages !== false} replyBox={false} reads={reads} errorScope={shown}>
        {live ? (
          <div ref={transcript} className="popup-transcript" onScroll={event => {
            const list = event.currentTarget
            pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24
          }}>
            <div key={threadId ?? 'new'} className="popup-transcript__inner" role="log" aria-live="polite" aria-label={t`Conversation with ${where}`}>
              {threadId !== null ? messages.map((message, index) => (
                <PopupEntry key={message.id} message={message} threadId={threadId} afterReply={target === 'watcher' && index > 0 && messages[index - 1]!.role !== 'user'} newest={index === newest}
                  streaming={running && index === messages.length - 1} onOpenLink={openLink} />
              )) : null}
              {echo !== null ? <div className="popup-entry popup-entry--user is-sending">
                {echo.photos.length > 0 ? <div className="popup-photos">{echo.photos.map(photo => <EchoPhoto key={photo.id} threadId={threadId} photo={photo} />)}</div> : null}
                {echo.text.trim() !== '' ? <div className="popup-bubble"><p>{echo.text}</p></div> : null}
              </div> : null}
              {current?.requests.map(request => (
                <AgentRequestCard key={request.id} ownerId={current.id} ownerTitle={current.title} watcher={target === 'watcher'} request={request} blocked={null}
                  onSubmit={answer(request)} onWriteAnswer={open} />
              ))}
              {running && !waiting ? <p className="popup-status" role="status"><PopupOwl working /><span><Trans>Working…</Trans></span></p> : null}
            </div>
          </div>
        ) : null}
        <div ref={chrome} className="popup-chrome">
          {notice !== null ? (
            <div className="popup-notice" role="alert">
              <p>{shownWords(notice)}</p>
              <button type="button" className="popup-icon tt-focusable" aria-label={t`Dismiss`} title={t`Dismiss`} onClick={() => setNotice(null)}><X size={12} aria-hidden="true" /></button>
            </div>
          ) : null}
          {menu.length > 0 ? (
            <ul className="popup-menu" role="listbox" id="popup-commands" aria-label={t`Commands`}>
              {menu.map((name, index) => (
                <li key={name} role="option" id={`popup-command-${name}`} aria-selected={index === Math.min(menuIndex, menu.length - 1)}
                  className="popup-menu__item" onMouseDown={event => { event.preventDefault(); run(name) }}>
                  <span className="popup-menu__name">/{name}</span>
                  <span className="popup-menu__words">{i18n._(COMMAND_WORDS[name])}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {listOpen ? (
            <ul ref={threadList} className="popup-list" role="listbox" id="popup-threads" aria-label={t`Threads`}>
              {threadChoices.map((thread, index) => {
                const working = isThreadTurnRunning(thread)
                const asks = thread.requests.length > 0
                return (
                  <li key={thread.id} role="option" id={`popup-thread-${index}`} aria-selected={index === listActive} aria-current={target === 'thread' && thread.id === memory.threadId}
                    className="popup-list__row" onMouseDown={event => { event.preventDefault(); chooseFromList(index) }}>
                    <span className="popup-list__name">{thread.title}</span>
                    {asks ? <span className="popup-list__meta is-busy"><Trans>Waiting</Trans></span> : working ? <span className="popup-list__meta is-busy"><Trans>Working</Trans></span> : null}
                  </li>
                )
              })}
              <li role="option" id={`popup-thread-${threadChoices.length}`} aria-selected={listActive === threadChoices.length}
                className="popup-list__row is-new" onMouseDown={event => { event.preventDefault(); chooseFromList(threadChoices.length) }}>
                <span className="popup-list__name">{newThreadWords}</span>
                {chordFree('n') ? <kbd className="popup-list__meta">{primary}N</kbd> : null}
              </li>
            </ul>
          ) : null}
          <textarea ref={prompt} className="popup-prompt" rows={1} value={input} placeholder={placeholder} autoFocus spellCheck
            aria-label={target === 'watcher' ? t`Message Watcher` : t`Message ${where}`}
            {...(activeId !== null ? { 'aria-controls': listOpen ? 'popup-threads' : 'popup-commands', 'aria-activedescendant': activeId } : {})}
            onChange={event => { setInput(event.target.value); setMenuIndex(0); setListOpen(false) }} />
          <div className="popup-tools">
            <button type="button" className="popup-icon tt-focusable" aria-label={t`Attach images`} disabled={model?.supportsImages === false}
              title={model?.supportsImages === false ? t`This model does not read images` : t`Attach images, or paste or drop them`}
              onClick={() => card.current?.querySelector<HTMLInputElement>('.screenshot-input__tools input[type="file"]')?.click()}>
              <Paperclip size={15} aria-hidden="true" />
            </button>
            <div className="popup-targets" role="group" aria-label={t`Who to ask`}>
              {bridge.watcher ? (
                <button type="button" className="popup-target tt-focusable" aria-pressed={target === 'watcher'} aria-label={t`Ask Watcher`} title={`${t`Ask Watcher`}${keys('1')}`} onClick={() => switchTarget('watcher')}>
                  <PopupOwl working={watcherThread !== null && isThreadTurnRunning(watcherThread)} />
                  <span>Watcher</span>
                  {watcherWaits && target !== 'watcher' ? <span className="popup-target__dot" aria-hidden="true" /> : null}
                </button>
              ) : null}
              <button type="button" className="popup-target popup-target--thread tt-focusable" aria-pressed={target === 'thread'} aria-label={t`Ask ${threadName}`} title={`${t`Ask this thread`}${keys('2')}`} onClick={() => switchTarget('thread')}>
                {threadBusy && target !== 'thread' ? <span className="popup-target__dot" aria-hidden="true" /> : null}
                <span className="popup-target__name">{threadName}</span>
              </button>
              <button type="button" className="popup-target__more tt-focusable" aria-haspopup="listbox" aria-expanded={listOpen} aria-label={t`Choose a thread`} title={`${t`Choose a thread`}${keys('k')}`} onClick={toggleList}>
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            </div>
            <span className="popup-tools__space" />
            <button type="button" className="popup-icon tt-focusable" disabled={threadId === null}
              aria-label={target === 'watcher' ? t`Show Watcher’s room in Sotto` : t`Show this thread in Sotto`}
              title={`${t`Show in Sotto`}${keys('o')}`} onClick={open}>
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
            {showStop
              ? <button type="button" className="popup-send is-stop tt-focusable" aria-label={t`Stop the running turn`} title={t`Stop (Esc)`} onClick={stop}><Square size={10} fill="currentColor" aria-hidden="true" /></button>
              : <button type="button" className="popup-send tt-focusable" aria-label={t`Send`} title={t`Send (Return)`} disabled={!canSend} onClick={() => void send()}><ArrowUp size={15} aria-hidden="true" /></button>}
          </div>
        </div>
      </ScreenshotInput>
    </div>
  )
}
