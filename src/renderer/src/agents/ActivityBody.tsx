import React, { useEffect, useState, type ReactNode } from 'react'
import { t } from '@lingui/core/macro'
import { CodeBlock, MessageContent } from './MessageContent'
import type { ActivityBodyView } from './activityBodies'
import { useInterfaceLanguageState } from '../state/interfaceLanguage'
import './activityBodies.css'

/**
 * A row's body that its host sent cut (ADR-0025, October 18 amendment), drawn the way the user picked, "Prefix first": the
 * row opens at once on the part that came with the thread, a quiet marker says the rest is on its way, and the whole body
 * replaces the part in place. A body cut to nothing says it is on its way in one line, after a moment. A failed read keeps
 * the part and offers Try again; a host that is not connected says the rest shows when it reconnects. None of these is a
 * failure of the work, so none is drawn in the error colour.
 */

export type CutBodyKind = 'output' | 'diff' | 'input' | 'thinking' | 'text'

interface Words {
  readonly getting: string; readonly more: string; readonly only: string; readonly line: string
  /** A failed read, of the whole body and of the rest of it, and the name of the way to ask again. */
  readonly failed: string; readonly failedRest: string; readonly retry: string
  /** The body's host is not connected. */
  readonly offline: string
}
/** Whole sentences for each kind of body, so each language can word them its own way. `host` is the host's name. */
function words(kind: CutBodyKind, host: string): Words {
  const rest = (): string => t`Getting the rest from ${host}…`
  const after = (): string => t({ message: `⋯ the rest is on ${host}`, comment: 'Marks where a body its host sent cut goes on; {host} is the computer it runs on.' })
  switch (kind) {
    case 'output': return {
      getting: t`Getting output from ${host}…`, more: t`Getting earlier lines from ${host}…`, only: t({ message: 'End of the output only', comment: 'A body its host sent cut shows only this part.' }), line: t({ message: `⋯ earlier lines are on ${host}`, comment: 'Marks where command output its host sent cut goes on; {host} is the computer it runs on.' }),
      failed: t`Couldn’t get this output from ${host}. Nothing is lost: it is still there.`,
      failedRest: t`Couldn’t get the rest of this output from ${host}. Nothing is lost: it is still there.`,
      retry: t`Try again to get this output from ${host}`,
      offline: t`${host} is not connected. The output is still there and shows here when ${host} reconnects.`,
    }
    case 'diff': return {
      getting: t`Getting the diff from ${host}…`, more: rest(), only: t({ message: 'Start of the diff only', comment: 'A body its host sent cut shows only this part.' }), line: after(),
      failed: t`Couldn’t get this diff from ${host}. Nothing is lost: it is still there.`,
      failedRest: t`Couldn’t get the rest of this diff from ${host}. Nothing is lost: it is still there.`,
      retry: t`Try again to get this diff from ${host}`,
      offline: t`${host} is not connected. The diff is still there and shows here when ${host} reconnects.`,
    }
    case 'input': return {
      getting: t`Getting the input from ${host}…`, more: rest(), only: t({ message: 'Part of the input only', comment: 'A body its host sent cut shows only this part.' }), line: after(),
      failed: t`Couldn’t get this input from ${host}. Nothing is lost: it is still there.`,
      failedRest: t`Couldn’t get the rest of this input from ${host}. Nothing is lost: it is still there.`,
      retry: t`Try again to get this input from ${host}`,
      offline: t`${host} is not connected. The input is still there and shows here when ${host} reconnects.`,
    }
    case 'thinking': return {
      getting: t`Getting the thinking from ${host}…`, more: rest(), only: '', line: after(),
      failed: t`Couldn’t get this thinking from ${host}. Nothing is lost: it is still there.`,
      failedRest: t`Couldn’t get the rest of this thinking from ${host}. Nothing is lost: it is still there.`,
      retry: t`Try again to get this thinking from ${host}`,
      offline: t`${host} is not connected. The thinking is still there and shows here when ${host} reconnects.`,
    }
    case 'text': return {
      getting: t`Getting the text from ${host}…`, more: rest(), only: '', line: after(),
      failed: t`Couldn’t get this text from ${host}. Nothing is lost: it is still there.`,
      failedRest: t`Couldn’t get the rest of this text from ${host}. Nothing is lost: it is still there.`,
      retry: t`Try again to get this text from ${host}`,
      offline: t`${host} is not connected. The text is still there and shows here when ${host} reconnects.`,
    }
  }
}

/** The quiet beat beside the words. Not the activity pulse: that colour means the agent's own work is running. */
const Dot = (): ReactNode => <span className="activity-body__dot" aria-hidden="true" />

/** What a read that failed says, under the part that stays, and the way to ask again. */
function Problem({ view, said, rest }: { readonly view: ActivityBodyView; readonly said: Words; readonly rest: boolean }): ReactNode {
  return <div className="activity-body__problem" role="status">
    <p className="tt-paragraph">{rest ? said.failedRest : said.failed}</p>
    <button type="button" className="activity-body__retry tt-focusable" aria-label={said.retry} onClick={view.retry}>{t`Try again`}</button>
  </div>
}

function Offline({ view, said, rest }: { readonly view: ActivityBodyView; readonly said: Words; readonly rest: boolean }): ReactNode {
  const host = view.hostName
  return <p className="activity-body__problem tt-paragraph" role="status">
    {rest ? t`${host} is not connected. The rest shows here when it reconnects.` : said.offline}
  </p>
}

/** How long a body cut to nothing waits before saying it is on its way, so a quick read shows no line at all. */
export const CUT_BODY_WAIT_MS = 200

/** A body cut to nothing: one line while it is on its way, shown after a moment, as the user's pick falls back to. */
function Empty({ view, said }: { readonly view: ActivityBodyView; readonly said: Words }): ReactNode {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (view.state !== 'loading') return
    const timer = window.setTimeout(() => setShown(true), CUT_BODY_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [view.state])
  if (view.state === 'failed') return <Problem view={view} said={said} rest={false} />
  if (view.state === 'disconnected') return <Offline view={view} said={said} rest={false} />
  return <p className="activity-body__wait" role="status" data-shown={shown || undefined}><Dot /><span>{said.getting}</span></p>
}

/** Whether the view still shows only the part its host sent. */
const partial = (view: ActivityBodyView): boolean => view.state === 'loading' || view.state === 'failed' || view.state === 'disconnected'

/**
 * A cut body drawn as a code block: command output, a diff or tool input. `cut` says this body was the one cut; a body of
 * the same record that came whole is drawn as it always is. The block is the same element before and after the rest
 * arrives, so the reader keeps their place: output keeps its end in view, text and diffs their start.
 */
export function CutCode({ view, kind, text, language, cut }: {
  readonly view: ActivityBodyView; readonly kind: 'output' | 'diff' | 'input'; readonly text: string; readonly language: string
  readonly cut: boolean
}): ReactNode {
  useInterfaceLanguageState()
  const said = words(kind, view.hostName)
  const waiting = cut && partial(view)
  const code = text.replace(/\n$/u, '')
  if (waiting && !code) return <Empty view={view} said={said} />
  const after = !waiting ? null : view.state === 'failed' ? <Problem view={view} said={said} rest /> : view.state === 'disconnected' ? <Offline view={view} said={said} rest /> : null
  return <>
    <div className="rich-message">
      <CodeBlock code={code} language={language} anchorEnd={kind === 'output' && cut}
        cut={waiting ? { keep: kind === 'output' ? 'end' : 'start', line: said.line,
          status: view.state === 'loading' ? <span className="activity-body__status"><Dot /><span>{said.more}</span></span> : said.only } : undefined} />
    </div>
    {after}
  </>
}

/** A cut body drawn as words: thinking as Markdown, or a tool's plain text. The rest, when it comes, is the same words longer. */
export function CutProse({ view, kind, text, cut }: { readonly view: ActivityBodyView; readonly kind: 'thinking' | 'text'; readonly text: string; readonly cut: boolean }): ReactNode {
  useInterfaceLanguageState()
  const said = words(kind, view.hostName)
  const waiting = cut && partial(view)
  if (waiting && !text) return <Empty view={view} said={said} />
  const body = kind === 'thinking' ? <MessageContent text={text} /> : <p className="thread-activity__text">{text}</p>
  return <>
    {body}
    {!waiting ? null : view.state === 'failed' ? <Problem view={view} said={said} rest />
      : view.state === 'disconnected' ? <Offline view={view} said={said} rest />
        : <p className="activity-body__more" role="status"><Dot /><span>{said.more}</span></p>}
  </>
}
