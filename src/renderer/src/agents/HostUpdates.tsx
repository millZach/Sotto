import { focusedComposerField } from './promptSelection'
import { useMark } from '../components/marks'
import React, { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AlertTriangle, Check, Clock, Copy, LoaderCircle, Server } from 'lucide-react'
import { plural, t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { HostsBridge } from '../../../shared/hosts'
import { HOST_UPDATE_STEPS, type HostUpdateAction, type HostUpdatePhase, type HostUpdateState, type HostUpdateStep } from '../../../shared/hostUpdates'
import { Button } from '../components/Button'
import { useTransientFlag, writeClipboard } from './richActions'
import { shownCount } from './interfaceWords'
import './hostUpdates.css'

/** How long a finished update's note stays before it goes by itself, unless the pointer or focus is on it. */
export const HOST_UPDATE_DONE_MS = 8_000
/** Which host the pill speaks for when several need it: the one the user most needs to hear about. */
const PILL_ORDER: readonly HostUpdatePhase[] = ['updating', 'failed', 'waiting', 'confirm', 'done', 'needs']
const ipcMessage = (error: unknown): string => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '').trim() : t`The host update did not answer. Nothing was changed. Try again.`

/**
 * Reads the host updates from the hosts state, and keeps the last list while nothing about them changes. The setter takes
 * the state a command answered with, so what a press changed is on screen before the next broadcast.
 */
function useHostUpdateList(bridge: HostsBridge | undefined): [readonly HostUpdateState[], (next: readonly HostUpdateState[] | undefined) => void] {
  const [updates, setUpdates] = useState<readonly HostUpdateState[]>([])
  const take = useCallback((next: readonly HostUpdateState[] | undefined): void => {
    setUpdates(current => JSON.stringify(current) === JSON.stringify(next ?? []) ? current : next ?? [])
  }, [])
  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge.get().then(state => { if (live) take(state.updates) }, () => undefined)
    const off = bridge.onChanged(state => { if (live) take(state.updates) })
    return () => { live = false; off() }
  }, [bridge, take])
  return [updates, take]
}

/** The pill's words for the host it speaks for, or for all of them. */
export function hostUpdatePillText(updates: readonly HostUpdateState[]): { readonly text: string; readonly phase: HostUpdatePhase } {
  const top = [...updates].sort((a, b) => PILL_ORDER.indexOf(a.phase) - PILL_ORDER.indexOf(b.phase))[0]!
  const count = updates.length
  if (count > 1 && top.phase !== 'updating' && top.phase !== 'failed') return { text: plural(count, { one: 'Update for # host', other: 'Updates for # hosts' }), phase: 'needs' }
  const name = top.name
  const step = HOST_UPDATE_STEPS.indexOf(top.step ?? 'download') + 1
  const text = top.phase === 'waiting'
    ? top.clientsUpdating ? t({ message: `${name} waits for its clients`, comment: '{name} is the name of a saved host.' }) : t({ message: `${name} waits to update`, comment: '{name} is the name of a saved host.' })
    : top.phase === 'updating'
      ? top.step === 'restart' && top.clientsUpdating ? t({ message: `Updating ${name} · waits for its clients`, comment: '{name} is the name of a saved host.' }) : t({ message: `Updating ${name} · ${{ step: shownCount(step) }} of 4`, comment: '{name} is the name of a saved host; {step} is the step it is on, of four.' })
      : top.phase === 'done' ? t({ message: `${name} updated`, comment: '{name} is the name of a saved host.' })
        : top.phase === 'failed' ? t({ message: `${name} not updated`, comment: '{name} is the name of a saved host.' })
          : t({ message: `Update for ${name}`, comment: '{name} is the name of a saved host.' })
  return { text, phase: top.phase }
}

function PhaseIcon({ phase, size }: { readonly phase: HostUpdatePhase; readonly size: number }): ReactNode {
  if (phase === 'updating') return <LoaderCircle size={size} aria-hidden="true" className="host-update__spin" />
  if (phase === 'waiting') return <Clock size={size} aria-hidden="true" className="host-update__icon--quiet" />
  if (phase === 'done') return <Check size={size} aria-hidden="true" className="host-update__icon--done" />
  if (phase === 'failed') return <AlertTriangle size={size} aria-hidden="true" className="host-update__icon--failed" />
  return <span className="host-update__dot" aria-hidden="true" />
}

/** The four steps as the panel lists them, each with what it does now or did. */
function Steps({ update }: { readonly update: HostUpdateState }): ReactNode {
  const { t } = useLingui()
  const at = HOST_UPDATE_STEPS.indexOf(update.step ?? 'download')
  const { name, from, to } = update
  const words: Readonly<Record<HostUpdateStep, { readonly title: string; readonly detail: string }>> = {
    download: {
      title: t({ message: `Download ${to}`, comment: '{to} is a version number.' }),
      detail: update.route === 'desktop' ? t({ message: `${name} could not reach GitHub, so this computer is copying it over SSH.`, comment: '{name} is the name of a saved host.' }) : t`From Sotto’s releases on GitHub.`,
    },
    check: { title: t`Check the download`, detail: at > 1 ? t`The checksum matches.` : t`Its checksum has to match the release’s.` },
    install: {
      title: t({ message: `Install beside ${from}`, comment: '{from} is the version the host runs now.' }),
      detail: t({ message: `${from} stays in place until ${to} is running.`, comment: '{from} and {to} are version numbers.' }),
    },
    // A host that starts at boot is restarted by its systemd unit, and still starts at boot after (ADR-0054).
    restart: {
      title: t({ message: `Restart ${name}’s host`, comment: '{name} is the name of a saved host.' }),
      detail: update.boot
        ? t({ message: `Its systemd unit starts ${to}, so it still starts at boot. ${name}’s threads are unavailable for a few seconds.`, comment: '{to} is a version number; {name} is the name of a saved host.' })
        : t({ message: `${name}’s threads are unavailable for a few seconds.`, comment: '{name} is the name of a saved host.' }),
    },
  }
  return <ol className="host-update__steps" aria-label={t({ message: `Steps to update ${name}`, comment: '{name} is the name of a saved host.' })}>
    {HOST_UPDATE_STEPS.map((step, index) => {
      const state = index < at ? 'done' : index === at ? 'now' : 'later'
      return <li key={step} data-state={state}>
        <span className="host-update__step-mark" aria-hidden="true">{state === 'done' ? <Check size={12} /> : state === 'now' ? <LoaderCircle size={12} className="host-update__spin" /> : index + 1}</span>
        <div>
          <div className="host-update__step-title">{words[step].title}<span className="tt-visually-hidden">{state === 'done' ? t({ message: ', done', comment: 'Read after a step\'s name: the step is finished.' }) : state === 'now' ? t({ message: ', in progress', comment: 'Read after a step\'s name: the step is running.' }) : t({ message: ', not started', comment: 'Read after a step\'s name: the step has not begun.' })}</span></div>
          {state === 'later' ? null : <div className="host-update__step-detail">{words[step].detail}</div>}
        </div>
      </li>
    })}
  </ol>
}

interface HostProps {
  readonly update: HostUpdateState
  readonly showCommands: boolean
  readonly refusal: string | undefined
  /** `focus` is the control that should have focus once the press has landed, by its focus key. */
  readonly onAction: (action: HostUpdateAction, focus?: string) => void
  readonly onToggleCommands: () => void
}
/** One host in the panel: where its update stands, what a press does next, and, when it failed, what to run by hand. */
function HostUpdateSection({ update, showCommands, refusal, onAction, onToggleCommands }: HostProps): ReactNode {
  const { t } = useLingui()
  const id = useId()
  const [copied, showCopied] = useTransientFlag<'copied' | 'failed'>()
  const { name, from, to, working } = update
  const copy = (): void => { void writeClipboard(update.commands).then(() => showCopied('copied'), () => showCopied('failed')) }
  const key = (action: string): string => `${action}:${update.id}`
  // Each name starts with the button's own words, which is what someone speaking to the app says, and adds what they leave out.
  const button = (action: HostUpdateAction, label: string, variant: 'primary' | 'secondary' | 'ghost', ariaLabel?: string, focus?: string): ReactNode =>
    <Button variant={variant} data-focus-key={key(action)} aria-label={ariaLabel} onClick={() => onAction(action, focus)}>{label}</Button>
  const notNow = button('not-now', t`Not now`, 'ghost', t`Not now: hide this until Sotto next starts`)
  const leaveOn = t({ message: `Cancel update, and leave ${name} on ${from}`, comment: '{name} is the name of a saved host; {from} is the version it runs now.' })
  const commandsButtons = <>
    <Button variant="secondary" aria-label={t({ message: `Copy commands that update ${name} by hand`, comment: '{name} is the name of a saved host.' })} onClick={copy}><Copy size={14} aria-hidden="true" />{copied === 'copied' ? t`Copied` : copied === 'failed' ? t`Could not copy` : t`Copy commands`}</Button>
    <Button variant="ghost" data-focus-key={key('commands')} aria-expanded={showCommands} aria-controls={`${id}-commands`} onClick={onToggleCommands}>{showCommands ? t`Hide commands` : t`Show commands`}</Button>
  </>
  let label = `${from} → ${to}`
  let body: ReactNode
  let actions: ReactNode
  if (update.phase === 'needs' && !update.owned) {
    body = <><p className="tt-paragraph">{t({ message: `${name} runs Sotto host ${from}. This computer runs ${to}.`, comment: '{name} is the name of a saved host; {from} and {to} are version numbers.' })}</p><p className="host-update__muted tt-paragraph">{t({ message: `Sotto did not start this host, so it cannot restart it. Update it on ${name} with these commands.`, comment: '{name} is the name of a saved host.' })}</p></>
    actions = <>{commandsButtons}{notNow}</>
  } else if (update.phase === 'needs') {
    body = <p className="host-update__muted tt-paragraph">{update.boot
      ? t({ message: `${name}’s threads keep working until you update. Updating restarts its host through its systemd unit, so they are unavailable for a few seconds. It still starts at boot after.`, comment: '{name} is the name of a saved host.' })
      : t({ message: `${name}’s threads keep working until you update. Updating restarts its host, so they are unavailable for a few seconds.`, comment: '{name} is the name of a saved host.' })}</p>
    actions = <>{button('update', t({ message: `Update ${name}`, comment: '{name} is the name of a saved host.' }), 'primary', t({ message: `Update ${name}’s host to ${to}`, comment: '{name} is the name of a saved host; {to} is a version number.' }), key('when-idle'))}{notNow}</>
  } else if (update.phase === 'confirm') {
    body = <><p className="tt-paragraph">{plural(working, {
      one: `# thread on ${name} is working. Updating restarts ${name}’s host, which stops it.`,
      other: `# threads on ${name} are working. Updating restarts ${name}’s host, which stops them.`,
    })}</p>
      <p className="host-update__muted tt-paragraph">{plural(working, { one: 'Only the work in progress on that turn is lost. Drafts and history stay.', other: 'Only the work in progress on those turns is lost. Drafts and history stay.' })}</p></>
    actions = <>{button('when-idle', t`Update when they finish`, 'primary')}
      {button('stop-threads', plural(working, { one: 'Stop # thread and update', other: 'Stop # threads and update' }), 'secondary', plural(working, { one: `Stop # thread and update ${name} now`, other: `Stop # threads and update ${name} now` }))}
      {button('cancel', t`Cancel`, 'ghost', t({ message: `Cancel, and leave ${name} on ${from}`, comment: '{name} is the name of a saved host; {from} is the version it runs now.' }), key('update'))}</>
  } else if (update.phase === 'waiting' && update.clientsUpdating) {
    // The host's client update line is running: its restart would cut a client update off (ADR-0077 decision 2).
    label = t`Clients updating`
    body = <p className="tt-paragraph">{working
      ? plural(working, { one: `${name} updates once its client updates finish. # thread still working.`, other: `${name} updates once its client updates finish. # threads still working.` })
      : t({ message: `${name} updates once its client updates finish.`, comment: '{name} is the name of a saved host.' })}</p>
    actions = <>{working ? button('stop-threads', plural(working, { one: 'Stop # thread', other: 'Stop # threads' }), 'secondary', plural(working, { one: `Stop # thread on ${name}. It still updates once its client updates finish.`, other: `Stop # threads on ${name}. It still updates once its client updates finish.` })) : null}
      {button('cancel', t`Cancel update`, 'ghost', leaveOn, key('update'))}</>
  } else if (update.phase === 'waiting') {
    label = t({ message: `${{ working: shownCount(working) }} working`, comment: '{working} is how many threads are working.' })
    body = <p className="tt-paragraph">{t({ message: `${name} updates when its threads finish. ${{ working: shownCount(working) }} still working.`, comment: '{name} is the name of a saved host; {working} is how many threads are working.' })}</p>
    actions = <>{button('stop-threads', plural(working, { one: 'Stop # thread and update now', other: 'Stop # threads and update now' }), 'secondary')}
      {button('cancel', t`Cancel update`, 'ghost', leaveOn, key('update'))}</>
  } else if (update.phase === 'updating') {
    const step = HOST_UPDATE_STEPS.indexOf(update.step ?? 'download') + 1
    label = t({ message: `Step ${{ step: shownCount(step) }} of 4`, comment: '{step} is the step the update is on, of four.' })
    // A client update running on the host holds the restart, however far the update has come (ADR-0077 decision 2).
    body = <><Steps update={update} />{update.clientsUpdating ? <p className="host-update__muted tt-paragraph">{t({ message: `${name} restarts once its client updates finish.`, comment: '{name} is the name of a saved host.' })}</p> : null}</>
    actions = update.step === 'download' || update.step === 'check' ? button('cancel', t`Cancel update`, 'ghost', leaveOn, key('update')) : null
  } else if (update.phase === 'done') {
    label = to
    body = <p className="tt-paragraph">{t({ message: `${name} runs Sotto ${to}.`, comment: '{name} is the name of a saved host; {to} is a version number.' })}</p>
    actions = button('dismiss', t`Dismiss`, 'ghost', t({ message: `Dismiss the note that ${name} was updated`, comment: '{name} is the name of a saved host.' }))
  } else {
    label = t({ message: `Still ${from}`, comment: '{from} is the version the host still runs.' })
    const notUpdated = t({ message: `${name} was not updated.`, comment: '{name} is the name of a saved host.' })
    body = <>{update.failure ? <><p><strong>{notUpdated}</strong> {update.failure.message}</p><p>{update.failure.kept}</p><p className="host-update__muted">{update.failure.next}</p></> : <p><strong>{notUpdated}</strong></p>}</>
    actions = <>{button('update', t`Try again`, 'primary', t({ message: `Try again to update ${name}`, comment: '{name} is the name of a saved host.' }), key('when-idle'))}{commandsButtons}{notNow}</>
  }
  const offersCommands = update.phase === 'failed' || (update.phase === 'needs' && !update.owned)
  return <section className="host-update__host" data-phase={update.phase} data-host={update.id} aria-labelledby={`${id}-name`}>
    <div className="host-update__name"><Server size={16} aria-hidden="true" /><strong id={`${id}-name`} tabIndex={-1} data-focus-key={key('name')}>{name}</strong><small>{label}</small></div>
    <div className="host-update__body" aria-live="polite">{body}</div>
    {refusal || update.error ? <p className="host-update__refusal tt-paragraph" role="alert">{refusal ?? update.error}</p> : null}
    {offersCommands && showCommands ? <pre id={`${id}-commands`} className="host-update__commands" tabIndex={0} aria-label={t({ message: `Commands to update ${name} by hand`, comment: '{name} is the name of a saved host.' })}>{update.commands}</pre> : null}
    {actions ? <div className="host-update__actions">{actions}</div> : null}
  </section>
}

/**
 * The host update pill and its panel (ADR-0040, variant C of `prototype/host-update`): a pill in the top strip beside
 * the window controls whenever a host runs an older Sotto than this computer, which opens a panel with each such host,
 * its own Update and its steps. It comes before the thread panes in keyboard order, and Escape or a click outside
 * closes the panel. Nothing updates until the user presses Update.
 */
export function HostUpdateControl({ bridge = window.sotto?.hosts, doneMs = HOST_UPDATE_DONE_MS }: { readonly bridge?: HostsBridge | undefined; readonly doneMs?: number }): ReactNode {
  const { t } = useLingui()
  const [updates, take] = useHostUpdateList(bridge)
  useMark('host-update', updates.length > 0)
  const [open, setOpen] = useState(false)
  const [commands, setCommands] = useState<ReadonlySet<string>>(() => new Set())
  const [refusal, setRefusal] = useState<{ readonly id: string; readonly message: string } | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const latest = useRef(updates)
  useEffect(() => { latest.current = updates })

  /** Focus leaves a note that is about to go: to the focused thread's composer, as after any page-level dismissal. */
  const leave = useCallback((): void => {
    if (!container.current?.contains(document.activeElement)) return
    const composer = focusedComposerField() ?? document.querySelector<HTMLElement>('.thread-prompt :is(.prompt-editor, textarea)')
    composer?.focus()
  }, [])
  /** One press. `focus` names the control to focus once it has landed, the host's name by default; null leaves focus alone. */
  const send = useCallback(async (id: string, action: HostUpdateAction, focus?: string | null): Promise<void> => {
    if (!bridge) return
    setRefusal(null)
    const last = latest.current.length === 1 && (action === 'dismiss' || action === 'not-now')
    if (last) leave()
    try {
      take((await bridge.command({ type: 'host-update', id, action })).updates)
      if (!last && focus !== null) setFocusKey(focus ?? `name:${id}`)
    } catch (error) { setRefusal({ id, message: ipcMessage(error) }) }
  }, [bridge, leave, take])

  // Focus follows a press to the control that comes next, or to the host's name when that control is not there.
  useEffect(() => {
    if (focusKey === null || !open) return
    const find = (key: string): HTMLElement | null | undefined => container.current?.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)
    const host = focusKey.slice(focusKey.indexOf(':') + 1)
    const target = find(focusKey) ?? find(`name:${host}`)
    setFocusKey(null)
    target?.focus()
  }, [focusKey, open, updates])

  // Nothing left to show: the panel closes with it.
  useEffect(() => { if (!updates.length) setOpen(false) }, [updates.length])

  // A finished update's note goes after a few seconds, but not while the pointer is over it or a control in it has focus.
  const doneIds = updates.filter(update => update.phase === 'done').map(update => update.id).join(',')
  useEffect(() => {
    if (!doneIds) return
    const timers = new Map<string, number>()
    const held = (id: string): boolean => {
      const box = container.current
      if (!box) return false
      const section = box.querySelector(`[data-host="${CSS.escape(id)}"]`)
      const focused = document.activeElement
      const focusHeld = box.contains(focused) && !(focused instanceof HTMLElement && focused.dataset['focusKey']?.startsWith('name:'))
      return (section?.matches(':hover') ?? false) || pill.current?.matches(':hover') === true || focusHeld
    }
    const arm = (id: string): void => {
      timers.set(id, window.setTimeout(() => { if (held(id)) arm(id); else void send(id, 'dismiss') }, doneMs))
    }
    for (const id of doneIds.split(',')) arm(id)
    return () => { for (const timer of timers.values()) window.clearTimeout(timer) }
  }, [doneIds, doneMs, send])

  // A click anywhere else closes the panel, and leaves focus where the click put it.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])

  if (!updates.length) return null
  const close = (): void => {
    setOpen(false)
    // Escape answers a pending question the way Cancel does: the host is left as it is.
    for (const update of updates) if (update.phase === 'confirm') void send(update.id, 'cancel', null)
    pill.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault(); event.stopPropagation()
    close()
  }
  const { text, phase } = hostUpdatePillText(updates)
  return <div ref={container} className="host-update" onKeyDown={onKeyDown}>
    <button ref={pill} type="button" className="host-update__pill tt-focusable" data-phase={phase} aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={open ? t({ message: `${text}. Hide host updates`, comment: '{text} is what the pill says about the hosts\' updates.' }) : t({ message: `${text}. Show host updates`, comment: '{text} is what the pill says about the hosts\' updates.' })} title={text} data-focus-key="pill"
      onClick={() => { const next = !open; setOpen(next); if (next) setFocusKey(`name:${[...updates].sort((a, b) => PILL_ORDER.indexOf(a.phase) - PILL_ORDER.indexOf(b.phase))[0]!.id}`) }}>
      <PhaseIcon phase={phase} size={14} /><span className="host-update__pill-text">{text}</span>
    </button>
    {open ? <div id={panelId} className="host-update__panel" role="dialog" aria-label={t`Host updates`}>
      <h2 className="host-update__head">{t`Hosts running an older Sotto`}</h2>
      {updates.map(update => <HostUpdateSection key={update.id} update={update} showCommands={commands.has(update.id)}
        refusal={refusal?.id === update.id ? refusal.message : undefined}
        onAction={(action, focus) => void send(update.id, action, focus)}
        onToggleCommands={() => setCommands(current => { const next = new Set(current); if (next.has(update.id)) next.delete(update.id); else next.add(update.id); return next })} />)}
    </div> : null}
  </div>
}
