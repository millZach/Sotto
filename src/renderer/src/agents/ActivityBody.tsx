import React, { useEffect, useState, type ReactNode } from 'react'
import { CodeBlock, MessageContent } from './MessageContent'
import type { ActivityBodyView } from './activityBodies'
import './activityBodies.css'

/**
 * A row's body that its host sent cut (ADR-0025, October 18 amendment), drawn the way the user picked, "Prefix first": the
 * row opens at once on the part that came with the thread, a quiet marker says the rest is on its way, and the whole body
 * replaces the part in place. A body cut to nothing says it is on its way in one line, after a moment. A failed read keeps
 * the part and offers Try again; a host that is not connected says the rest shows when it reconnects. None of these is a
 * failure of the work, so none is drawn in the error colour.
 */

export type CutBodyKind = 'output' | 'diff' | 'input' | 'thinking' | 'text'

interface Words { readonly the: string; readonly The: string; readonly getting: string; readonly more: string; readonly only: string; readonly line: string }
function words(kind: CutBodyKind, host: string): Words {
  const rest = `Getting the rest from ${host}…`, after = `⋯ the rest is on ${host}`
  switch (kind) {
    case 'output': return { the: 'this output', The: 'The output', getting: `Getting output from ${host}…`, more: `Getting earlier lines from ${host}…`, only: 'End of the output only', line: `⋯ earlier lines are on ${host}` }
    case 'diff': return { the: 'this diff', The: 'The diff', getting: `Getting the diff from ${host}…`, more: rest, only: 'Start of the diff only', line: after }
    case 'input': return { the: 'this input', The: 'The input', getting: `Getting the input from ${host}…`, more: rest, only: 'Part of the input only', line: after }
    case 'thinking': return { the: 'this thinking', The: 'The thinking', getting: `Getting the thinking from ${host}…`, more: rest, only: '', line: after }
    case 'text': return { the: 'this text', The: 'The text', getting: `Getting the text from ${host}…`, more: rest, only: '', line: after }
  }
}

/** The quiet beat beside the words. Not the activity pulse: that colour means the agent's own work is running. */
const Dot = (): ReactNode => <span className="activity-body__dot" aria-hidden="true" />

/** What a read that failed says, under the part that stays, and the way to ask again. */
function Problem({ view, said, rest }: { readonly view: ActivityBodyView; readonly said: Words; readonly rest: boolean }): ReactNode {
  return <div className="activity-body__problem" role="status">
    <p>Couldn’t get {rest ? said.the.replace(/^this /u, 'the rest of this ') : said.the} from {view.hostName}. Nothing is lost: it is still there.</p>
    <button type="button" className="activity-body__retry tt-focusable" aria-label={`Try again to get ${said.the} from ${view.hostName}`} onClick={view.retry}>Try again</button>
  </div>
}

function Offline({ view, said, rest }: { readonly view: ActivityBodyView; readonly said: Words; readonly rest: boolean }): ReactNode {
  return <p className="activity-body__problem" role="status">
    {view.hostName} is not connected. {rest ? 'The rest shows here when it reconnects.' : `${said.The} is still there and shows here when ${view.hostName} reconnects.`}
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
