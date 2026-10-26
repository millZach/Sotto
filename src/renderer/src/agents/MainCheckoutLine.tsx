import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MainCheckoutBlock, MainCheckoutBridge, MainCheckoutChanges, ProjectMainCheckout } from '../../../shared/mainCheckout'
import { CHANGE_KIND_WORDS, IN_PROGRESS_WORDS, showLabel } from './mainCheckoutLine.logic'
import { shownLocalCount } from '../state/interfaceNumbers'

/**
 * Keep main up to date's line under a project's name (ADR-0142, variant A of the mock-up): why the default branch was
 * left behind, with Show changes listing what is in the way and Open folder beside it; or, after an update that changed a
 * lockfile, that dependencies changed, until dismissed. It says nothing otherwise.
 */
export function MainCheckoutLine({ line, title, bridge = window.sotto?.mainCheckout }: {
  readonly line: ProjectMainCheckout
  /** The project's title, for the accessible names of its presses. */
  readonly title: string
  readonly bridge?: MainCheckoutBridge | undefined
}): ReactNode {
  const { t, i18n } = useLingui()
  const listId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const [changes, setChanges] = useState<MainCheckoutChanges | null>(null)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // The open list is read again whenever what blocks the update changes, so it never lists what no longer stands in the way.
  const blockKey = line.blocked ? JSON.stringify(line.blocked) : null
  useEffect(() => {
    if (!open || blockKey === null || !bridge) return
    let current = true
    setFailed(null)
    void bridge.changes(line.projectId).then(read => { if (current) setChanges(read) }, () => {
      if (current) { setChanges(null); setFailed(t`Sotto could not read the changes. Open the folder to look.`) }
    })
    return () => { current = false }
  }, [open, blockKey, bridge, line.projectId, t])
  if (!bridge) return null
  const blocked = line.blocked
  const deps = line.dependencies
  if (!blocked && !deps) return null
  const close = (): void => { setOpen(false); toggle.current?.focus() }
  const openFolder = (): void => { void bridge.command({ type: 'open-folder', projectId: line.projectId }).catch(() => setFailed(t`Sotto could not open that folder.`)) }
  const label = showLabel(line)
  const branch = line.branch
  const rows = blocked ? (changes?.items ?? []).map(item => ({ kind: i18n._(CHANGE_KIND_WORDS[item.kind]), text: item.text, path: item.kind !== 'commit' }))
    : deps?.map(text => ({ kind: t({ message: 'changed', comment: 'A lockfile the update changed' }), text, path: true })) ?? []
  const hide = t({ message: 'Hide', comment: 'Hides the list under a project' })
  const more = changes ? shownLocalCount(changes.more) : ''
  return <div className="thread-folder__main" onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); close() } }}>
    {blocked ? <p className="thread-folder__main-line tt-paragraph">
      <span className="thread-folder__main-behind"><BehindWords line={line} /></span> · <BlockWords blocked={blocked} />
      {label ? <> · <button ref={toggle} type="button" className="thread-folder__main-press tt-focusable" aria-expanded={open} aria-controls={listId}
        aria-label={open ? t`Hide the list in ${title}` : t({ message: `${label} in ${title}`, comment: '{label} is Show changes or Show commits; {title} is the project.' })} onClick={() => setOpen(!open)}>{open ? hide : label}</button></> : null}
    </p> : <p className="thread-folder__main-line tt-paragraph">
      <span className="thread-folder__main-updated"><Trans comment="{branch} is a Git branch name, such as main.">Updated <bdi dir="ltr">{branch}</bdi></Trans></span> · {t`dependencies changed, run install`} ·{' '}
      <button ref={toggle} type="button" className="thread-folder__main-press tt-focusable" aria-expanded={open} aria-controls={listId}
        aria-label={open ? t`Hide the list in ${title}` : t`What changed in ${title}`} onClick={() => setOpen(!open)}>{open ? hide : t`What changed`}</button>
      <button type="button" className="thread-folder__main-dismiss tt-focusable" aria-label={t`Dismiss dependencies changed in ${title}`}
        onClick={() => { void bridge.command({ type: 'dismiss-dependencies', projectId: line.projectId }).catch(() => undefined) }}><X size={13} aria-hidden="true" /></button>
    </p>}
    {open ? <div id={listId} className="thread-folder__main-list">
      {failed ? <p className="thread-folder__main-failed tt-paragraph" role="status">{failed}</p> : null}
      {rows.length ? <ul aria-label={blocked ? t`What blocks the update` : t`What changed`}>
        {rows.map(row => <li key={`${row.kind}\0${row.text}`}><span className="thread-folder__main-kind">{row.kind}</span><span className="thread-folder__main-path" dir={row.path ? 'ltr' : 'auto'}>{row.text}</span></li>)}
      </ul> : null}
      {blocked && changes && changes.more > 0 ? <p className="thread-folder__main-more tt-paragraph">{t`and ${more} more`}</p> : null}
      {blocked ? <button type="button" className="thread-folder__main-press tt-focusable" aria-label={t`Open the ${title} folder`} onClick={openFolder}>{t`Open folder`}</button> : null}
    </div> : null}
  </div>
}

/** "main is 1,320 behind", the branch in its own left-to-right element. */
function BehindWords({ line }: { readonly line: ProjectMainCheckout }): ReactNode {
  const branch = line.branch
  const behind = shownLocalCount(line.behind)
  return <Trans comment="{branch} is a Git branch name, such as main; {behind} counts commits."><bdi dir="ltr">{branch}</bdi> is {behind} behind</Trans>
}

/** What stopped the update, in the line's words. */
function BlockWords({ blocked }: { readonly blocked: MainCheckoutBlock }): ReactNode {
  const { i18n } = useLingui()
  switch (blocked.reason) {
    case 'changes': return <Trans>local changes block the update</Trans>
    case 'untracked': return <Trans>untracked files are in the way</Trans>
    case 'in-progress': return i18n._(IN_PROGRESS_WORDS[blocked.operation])
    case 'branch': {
      const branch = blocked.checkedOut
      return branch ? <Trans comment="{branch} is a Git branch name."><bdi dir="ltr">{branch}</bdi> is checked out</Trans> : <Trans>no branch is checked out</Trans>
    }
    case 'diverged': return plural(blocked.ahead, { one: 'a local commit blocks the update', other: `${{ commits: shownLocalCount(blocked.ahead) }} local commits block the update` })
  }
}
