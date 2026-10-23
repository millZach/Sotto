import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowRight, Check, ChevronDown, Cloud } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { GitRef, GitRefsPage, GitRefsRequest } from '../../../shared/gitRefs'

/** How the picker reads a thread's branches: the branch picker's own host operation (ADR-0027, `git-refs`). */
export type RefsReader = (request: GitRefsRequest) => Promise<GitRefsPage>

function bridgeRefs(): RefsReader | undefined {
  return window.sotto?.agents?.gitRefs
}

/** One row of the picker: a branch name, with its local branch and the primary remote's copy when each exists. */
export interface BaseChoice { readonly id: string; readonly label: string; readonly local: string | null; readonly remote: string | null }

/** Locals and remotes as T3 lists them: one row per branch name, `origin/x` joining the local `x`; another remote's refs stand alone. */
export function baseChoices(refs: readonly GitRef[]): BaseChoice[] {
  const choices = new Map<string, { id: string; label: string; local: string | null; remote: string | null }>()
  for (const ref of refs) {
    if (ref.remote === undefined) {
      const existing = choices.get(ref.name)
      if (existing) existing.local = ref.name; else choices.set(ref.name, { id: ref.name, label: ref.name, local: ref.name, remote: null })
      continue
    }
    const short = ref.name.slice(ref.remote.length + 1)
    if (!short || short === 'HEAD') continue
    const key = ref.remote === 'origin' ? short : ref.name
    const existing = choices.get(key)
    if (existing) existing.remote = ref.name; else choices.set(key, { id: key, label: key, local: null, remote: ref.name })
  }
  return [...choices.values()]
}

/** The ref a row stands for: the version already chosen, else the local branch, else the remote one. */
export function choiceValue(choice: BaseChoice, selected: string | null): string {
  if (choice.remote !== null && selected === choice.remote) return choice.remote
  return choice.local ?? choice.remote!
}

/**
 * The base Branch changes compares against, T3's comparison target: the branch it compares, an arrow, and the
 * base as a button that opens the list. The list starts with **Automatic** (the base Sotto works out), then each
 * branch with a **Use remote version** switch where both a local and a remote copy exist and a mark where only the
 * remote one does.
 */
export function ChangesBasePicker({ threadId, selected, resolved, refs, onPick }: {
  readonly threadId: string
  /** The base asked for; null is Automatic. */
  readonly selected: string | null
  /** What the last comparison resolved: the base it used and the branch it compared. */
  readonly resolved?: { readonly base: string | null; readonly automatic: boolean; readonly head: string | null } | undefined
  readonly refs?: RefsReader | undefined
  readonly onPick: (base: string | null) => void
}): ReactNode {
  const { t } = useLingui()
  const read = refs ?? bridgeRefs()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<{ readonly status: 'loading' } | { readonly status: 'ready'; readonly choices: readonly BaseChoice[] } | { readonly status: 'error' }>({ status: 'loading' })
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    let current = true
    setPage({ status: 'loading' })
    if (!read) { setPage({ status: 'error' }); return }
    read({ threadId, includeMatchingRemoteRefs: true, limit: 200 })
      .then(result => { if (current) setPage({ status: 'ready', choices: baseChoices(result.refs) }) }, () => { if (current) setPage({ status: 'error' }) })
    return () => { current = false }
  }, [open, read, threadId])
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent): void => {
      if (popover.current?.contains(event.target as Node) || trigger.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [open])
  const close = (): void => { setOpen(false); setQuery(''); trigger.current?.focus() }
  const pick = (base: string | null): void => { onPick(base); close() }
  const automatic = t({ message: 'Automatic', comment: 'The base branch Changes compares against, worked out by Sotto.' })
  const shownBase = resolved?.base ?? (selected ?? automatic)
  const head = resolved?.head ?? 'HEAD'
  const needle = query.trim().toLowerCase()
  const choices = page.status === 'ready' ? page.choices.filter(choice => !needle || choice.label.toLowerCase().includes(needle)) : []
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('.changes-base__ref') ?? [])]
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : items.length - 1
    event.preventDefault()
    items[next]?.focus()
  }
  return <div className="changes-base">
    <span className="changes-base__head" title={head}><bdi>{head}</bdi></span>
    <ArrowRight size={13} aria-hidden="true" className="changes-base__arrow" />
    <button ref={trigger} type="button" className="changes-base__trigger tt-focusable" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-label={selected === null
        ? t({ message: `Change the base. Comparing ${head} with ${shownBase}, chosen automatically`, comment: '{head} and {shownBase} are branch names.' })
        : t({ message: `Change the base. Comparing ${head} with ${shownBase}`, comment: '{head} and {shownBase} are branch names.' })} title={`${head} → ${shownBase}`}
      onClick={() => open ? close() : setOpen(true)}>
      <bdi className="changes-base__value">{shownBase}</bdi><ChevronDown size={13} aria-hidden="true" />
    </button>
    {open ? <div ref={popover} id={id} className="changes-base__popover" role="dialog" aria-label={t`Base to compare with`} onKeyDown={onKeyDown}>
      <input className="changes-base__search tt-focusable" type="search" placeholder={t`Search refs...`} aria-label={t`Search refs`} value={query} autoFocus
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('.changes-base__ref')?.focus() } }} />
      <div className="changes-base__columns" aria-hidden="true"><span>{t({ message: 'Branch', comment: 'Column heading in the base branch list.' })}</span><span>{t({ message: 'Remote', comment: 'Column heading in the base branch list: the remote copy of a branch.' })}</span></div>
      <ul ref={list} className="changes-base__list" aria-label={t`Refs`}>
        {!needle || automatic.toLowerCase().includes(needle) ? <li className="changes-base__row">
          <button type="button" className="changes-base__ref tt-focusable" aria-current={selected === null || undefined} onClick={() => pick(null)}>
            <Check size={13} aria-hidden="true" className="changes-base__check" data-shown={selected === null || undefined} /><span className="changes-base__label">{automatic}</span>
          </button>
        </li> : null}
        {choices.map(choice => {
          const value = choiceValue(choice, selected)
          const branch = choice.label, remote = choice.remote
          const current = selected !== null && (selected === choice.local || selected === choice.remote)
          const both = choice.local !== null && choice.remote !== null
          return <li key={choice.id} className="changes-base__row">
            <button type="button" className="changes-base__ref tt-focusable" aria-current={current || undefined} onClick={() => pick(value)} title={value}>
              <Check size={13} aria-hidden="true" className="changes-base__check" data-shown={current || undefined} /><bdi className="changes-base__label">{choice.label}</bdi>
            </button>
            {both ? <button type="button" role="switch" className="changes-base__switch tt-focusable" aria-checked={selected === choice.remote}
              aria-label={t`Use remote version of ${branch}`} title={t({ message: `Use ${remote}`, comment: '{remote} is a remote branch, as in origin/main.' })}
              onClick={() => onPick(selected === choice.remote ? choice.local : choice.remote)}><span className="changes-base__thumb" /></button>
              : choice.remote !== null ? <span className="changes-base__remote-only" role="img" aria-label={t`Remote only`} title={t`Remote only`}><Cloud size={13} aria-hidden="true" /></span> : null}
          </li>
        })}
      </ul>
      {page.status === 'loading' ? <p className="changes-base__note" role="status">{t`Reading branches…`}</p>
        : page.status === 'error' ? <p className="changes-base__note" role="status">{t`Sotto could not read this repository’s branches.`}</p>
          : choices.length === 0 && needle ? <p className="changes-base__note" role="status">{t`No matching refs.`}</p> : null}
    </div> : null}
  </div>
}
