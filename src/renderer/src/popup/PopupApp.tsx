import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, ArrowUpRight, ChevronRight, MessageSquareText, MoonStar, SquarePen, Square, X } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import type { AgentCommand, AgentRequest, AgentState, AgentThread } from '../../../shared/agents'
import type { PopupBridge } from '../../../shared/popup'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import { AgentRequestCard } from '../agents/requests/AgentRequestCard'
import type { RequestAnswer, SubmitOutcome } from '../agents/requests/requestAnswers'
import { MessageContent } from '../agents/MessageContent'
import { beginNewThread } from '../agents/newThread'
import { shownWords, type LaterWords } from '../agents/interfaceWords'
import { threadForTarget } from '../watcher/watcherRoom'
import { PopupOwl } from './PopupOwl'
import {
  nextPopupDetail, popupKeyAction, popupProject, readPopupMemory, shownMessages, slashCommandOf, slashCommands, slashMatches, writePopupMemory,
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

/** Main's answer to a command, or null when none came: the popup reads only whether it was refused, and why. */
type Reply = { readonly error: string | null } | null

const storage = (): Storage | undefined => { try { return window.localStorage } catch { return undefined } }

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
  const [thread, setThread] = useState<AgentThread | null>(null)
  const [detail, setDetail] = useState<PopupDetail | null>(null)
  const [input, setInput] = useState('')
  const [menuIndex, setMenuIndex] = useState(0)
  const [notice, setNotice] = useState<LaterWords | null>(null)
  const [echo, setEcho] = useState<{ readonly text: string; readonly after: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState(0)
  const prompt = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const chrome = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

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
  // What is held for another thread is not this one's: nothing shows until this one's arrives.
  const current = thread?.id === threadId ? thread : null
  const running = current !== null && isThreadTurnRunning(current)
  const waiting = (current?.requests.length ?? 0) > 0
  const project = shell === null ? null : popupProject(shell, memory.projectId)

  // Each time the popup is shown it reads its target again: the threads, Watcher's current conversation, and whether the
  // thread it last used is still there. A thread that went is forgotten and the next prompt starts a new one.
  useEffect(() => bridge.onShown(() => setShown(count => count + 1)), [bridge])
  useEffect(() => {
    let live = true
    void (async () => {
      const state = await bridge.shell().catch(() => null)
      if (!live || state === null) return
      setShell(state)
      const room = bridge.watcher ? await bridge.watcher().catch(() => null) : null
      if (!live) return
      const current = room?.status === 'ok' ? room.state.current : null
      const watcherThread = current ? threadForTarget(state, current.target) : undefined
      setWatcher(watcherThread && room?.status === 'ok' ? { threadId: watcherThread.id, handover: room.state.handover != null } : null)
      setMemory(current => {
        const kept = current.threadId !== null && state.host.threads.some(item => item.id === current.threadId && !item.archivedAt) ? current.threadId : null
        if (kept === current.threadId) return current
        const next = { ...current, threadId: kept }
        writePopupMemory(storage(), next)
        return next
      })
      // Said once: the popup stays on the thread from then on, until the user asks for Watcher again.
      if (memory.target === 'watcher' && watcherThread === undefined) { setNotice(msg`Watcher isn’t running, so the popup is on your thread.`); remember({ target: 'thread' }) }
    })()
    prompt.current?.focus()
    return () => { live = false }
  }, [bridge, shown]) // Read on each show: the target remembered then is the one the show finds.

  // The target's thread: observed while the popup shows it, its record from main's pushes and its history read whole once,
  // then kept up by the changes main sends. A change the popup cannot place reads the history whole again.
  // Main lets go of the observation each time the popup hides, so each show observes again and reads what it missed,
  // keeping what it holds on screen until the read lands.
  const observed = useRef<string | null>(null)
  useEffect(() => {
    observed.current = threadId
    pinned.current = true
    void bridge.command({ type: 'observe-threads', threadIds: threadId === null ? [] : [threadId] }).catch(() => undefined)
    if (threadId === null) return
    void bridge.threadDetail(threadId).then(read => { if (observed.current === threadId && read !== null) setDetail(nextPopupDetail(null, read)) }, () => undefined)
  }, [bridge, threadId, shown])
  // The record the show's read found, until main pushes a newer one.
  useEffect(() => {
    const record = threadId === null ? undefined : shell?.host.threads.find(item => item.id === threadId)
    if (record !== undefined) setThread(record)
  }, [shell, threadId])
  useEffect(() => bridge.onThread(record => { if (record.id === observed.current) setThread(record) }), [bridge])
  useEffect(() => bridge.onThreadDetail(update => {
    if (update.threadId !== observed.current) return
    setDetail(held => {
      const next = nextPopupDetail(held, update)
      if (next !== null) return next
      void bridge.threadDetail(update.threadId).then(read => { if (observed.current === update.threadId && read !== null) setDetail(nextPopupDetail(null, read)) }, () => undefined)
      return held
    })
  }), [bridge])

  const shownDetail = detail?.threadId === threadId ? detail : null
  const messages = useMemo(() => shownMessages(shownDetail?.messages ?? []), [shownDetail])
  const live = messages.length > 0 || echo !== null || waiting || running
  const userMessages = useMemo(() => (shownDetail?.messages ?? []).filter(message => message.role === 'user').length, [shownDetail])
  // What the user just sent shows at once, until the thread's own copy of it arrives.
  useEffect(() => { if (echo !== null && userMessages > echo.after) setEcho(null) }, [echo, userMessages])

  // The window is as tall as the card wants to be, which main holds to a share of the screen: the conversation scrolls
  // inside it beyond that, kept at its newest line unless the user scrolled up.
  useLayoutEffect(() => {
    const root = card.current, controls = chrome.current, list = transcript.current
    if (!root || !controls) return undefined
    const report = (): void => {
      const inner = list?.firstElementChild as HTMLElement | null | undefined
      const style = getComputedStyle(root)
      const frame = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, side) => sum + (Number.parseFloat(style[side as 'paddingTop']) || 0), 0)
      // Main holds the window to a share of the screen; a long conversation asks for no more than the channel takes.
      void bridge.fit(Math.min(10_000, Math.ceil(frame + controls.offsetHeight + (inner?.offsetHeight ?? 0)))).catch(() => undefined)
      if (list && pinned.current) list.scrollTop = list.scrollHeight
    }
    const observer = new ResizeObserver(report)
    observer.observe(root)
    observer.observe(controls)
    if (list?.firstElementChild) observer.observe(list.firstElementChild)
    report()
    return () => observer.disconnect()
  }, [bridge, live])

  const command = useCallback((request: AgentCommand): Promise<Reply> => bridge.command(request).catch(() => null), [bridge])

  const switchTarget = (next: PopupTarget): void => {
    if (next === 'watcher' && watcher === null) { setNotice(msg`Watcher isn’t running. Start it in Sotto, then switch again.`); return }
    setInput('')
    setNotice(null)
    setEcho(null)
    remember({ target: next })
    prompt.current?.focus()
  }

  const startOver = (): void => {
    setNotice(null)
    setEcho(null)
    remember({ threadId: null })
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

  /** Sends the prompt: a new thread first when there is none, then the words, queued behind a turn that is running. */
  const send = async (): Promise<void> => {
    const text = input
    const named = slashCommandOf(text, commands)
    if (named !== null) { run(named); return }
    if (text.trim() === '' || busy) return
    if (target === 'watcher' && watcher?.handover) {
      setNotice(msg`Watcher is offering the last Watcher’s handover. Open Watcher’s room to continue with it or put it away, then send again.`)
      return
    }
    setBusy(true)
    setNotice(null)
    setInput('')
    setEcho({ text, after: userMessages })
    pinned.current = true
    const failed = (words: LaterWords): void => { setNotice(words); setInput(text); setEcho(null) }
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
        await command({ type: 'observe-threads', threadIds: [id] })
        void bridge.threadDetail(id).then(read => { if (observed.current === id && read !== null) setDetail(nextPopupDetail(null, read)) }, () => undefined)
      } else if (target === 'thread' && current !== null) remember({ projectId: current.projectId })
      const reply = await command({ type: queue ? 'queue-followup' : 'manual-send', threadId: id, draftId: crypto.randomUUID(), text })
      if (reply === null) failed(msg`Sotto didn’t confirm the prompt. It is back in the box; check the thread before you send it again.`)
      else if (reply.error !== null) failed(reply.error)
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return
    const inPrompt = event.target === prompt.current
    const action = popupKeyAction(event.nativeEvent, { platform: bridge.platform, menu: inPrompt && menu.length > 0, canStop: target === 'thread' && running })
    if (action === null || (!inPrompt && action !== 'hide' && action !== 'stop' && action !== 'open')) return
    if (action === 'newline') return
    event.preventDefault()
    const chosen = menu[Math.min(menuIndex, menu.length - 1)]
    if (action === 'send') void send()
    else if (action === 'run-command' && chosen) run(chosen)
    else if (action === 'complete' && chosen) setInput(`/${chosen} `)
    else if (action === 'menu-next') setMenuIndex(index => (index + 1) % menu.length)
    else if (action === 'menu-previous') setMenuIndex(index => (index - 1 + menu.length) % menu.length)
    else if (action === 'close-menu') setInput('')
    else if (action === 'stop') stop()
    else if (action === 'open') open()
    else if (action === 'hide') void bridge.hide()
  }

  const answer = (request: AgentRequest) => (reply: RequestAnswer): Promise<SubmitOutcome> => current === null ? Promise.resolve(null)
    : command({ type: 'answer', threadId: current.id, requestId: request.id, ...reply }).then(result => result === null ? null : { error: result.error })
  const openLink = (url: string): Promise<{ ok: boolean }> => bridge.openExternalLink(url).catch(() => ({ ok: false }))
  const placeholder = target === 'watcher' ? t`Ask Watcher…` : t`Ask Sotto…`
  const canSend = input.trim() !== '' && menu.length === 0 && !busy
  const showStop = target === 'thread' && running && !canSend
  const where = target === 'watcher' ? 'Watcher' : threadId === null ? project === null ? t`New thread` : t`New thread in ${project.title}` : current?.title ?? t`Thread`

  return (
    <div ref={card} className="popup-card" onKeyDown={onKeyDown}>
      {live ? (
        <div ref={transcript} className="popup-transcript" onScroll={event => {
          const list = event.currentTarget
          pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24
        }}>
          <div className="popup-transcript__inner" role="log" aria-live="polite" aria-label={t`Conversation with ${where}`}>
            {messages.map((message, index) => message.role === 'user'
              ? <div key={message.id} className="popup-entry popup-entry--user"><ChevronRight size={12} aria-hidden="true" /><p>{message.text}</p></div>
              : <div key={message.id} className="popup-entry popup-entry--reply">
                <MessageContent text={message.text} streaming={running && index === messages.length - 1} onOpenLink={openLink} />
              </div>)}
            {echo !== null ? <div className="popup-entry popup-entry--user is-sending"><ChevronRight size={12} aria-hidden="true" /><p>{echo.text}</p></div> : null}
            {current?.requests.map(request => (
              <AgentRequestCard key={request.id} ownerId={current.id} ownerTitle={current.title} request={request} blocked={null}
                onSubmit={answer(request)} onWriteAnswer={open} />
            ))}
            {running || waiting ? (
              <p className="popup-status" role="status">
                <span className="popup-status__spark" aria-hidden="true">✳</span>
                <span className="popup-status__words">{waiting ? <Trans>Waiting for your answer</Trans> : <Trans>Working…</Trans>}</span>
                {!waiting && target === 'thread' ? <span className="popup-status__hint"><Trans>Esc stops it</Trans></span> : null}
              </p>
            ) : null}
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
        <div className="popup-prompt">
          <PopupOwl working={running} />
          <textarea ref={prompt} className="popup-prompt__field" rows={1} value={input} placeholder={placeholder} autoFocus spellCheck
            aria-label={target === 'watcher' ? t`Message Watcher` : t`Message ${where}`}
            {...(menu.length > 0 ? { 'aria-controls': 'popup-commands', 'aria-activedescendant': `popup-command-${menu[Math.min(menuIndex, menu.length - 1)]}` } : {})}
            onChange={event => { setInput(event.target.value); setMenuIndex(0) }} />
          {showStop
            ? <button type="button" className="popup-send is-stop tt-focusable" aria-label={t`Stop the running turn`} title={t`Stop (Esc)`} onClick={stop}><Square size={10} fill="currentColor" aria-hidden="true" /></button>
            : <button type="button" className="popup-send tt-focusable" aria-label={t`Send`} title={t`Send (Return)`} disabled={!canSend} onClick={() => void send()}><ArrowUp size={14} aria-hidden="true" /></button>}
        </div>
        <div className="popup-footer">
          {watcher !== null ? (
            <button type="button" className={`popup-footer__button popup-target tt-focusable${target === 'watcher' ? ' is-watcher' : ''}`}
              aria-label={target === 'watcher' ? t`Talking to Watcher. Switch to the thread` : t`Talking to the thread. Switch to Watcher`}
              onClick={() => switchTarget(target === 'watcher' ? 'thread' : 'watcher')}>
              {target === 'watcher' ? <MoonStar size={12} aria-hidden="true" /> : <MessageSquareText size={12} aria-hidden="true" />}
              <span>{target === 'watcher' ? 'Watcher' : <Trans>Thread</Trans>}</span>
            </button>
          ) : null}
          {target === 'thread' ? <span className="popup-footer__where" title={where}>{where}</span> : null}
          <span className="popup-footer__space" />
          {target === 'thread' ? (
            <button type="button" className="popup-footer__button popup-icon tt-focusable" aria-label={t`New thread`} title={t`New thread (/new)`} onClick={startOver}>
              <SquarePen size={12} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" className="popup-footer__button popup-icon tt-focusable" disabled={threadId === null}
            aria-label={target === 'watcher' ? t`Show Watcher’s room in Sotto` : t`Show this thread in Sotto`}
            title={bridge.platform === 'darwin' ? t`Show in Sotto (⌘O)` : t`Show in Sotto (Ctrl+O)`} onClick={open}>
            <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
