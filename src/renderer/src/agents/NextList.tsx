import React, { useLayoutEffect, useRef, type ReactNode } from 'react'
import { ArrowRight, Check, CircleHelp, Flag, type LucideIcon } from 'lucide-react'
import type { NextPrompt, NextPromptIntent } from '../../../shared/nextPrompt'
import './nextPrompt.css'

/** One row of the Next list: an answer to the agent's question, the next prompt itself, or one of four suggestions. */
export interface NextRow {
  readonly kind: 'answer' | 'ghost' | 'suggestion'
  /** What the row's key column shows: Enter for an answer, Tab for the next prompt, 1 to 4 for a suggestion. */
  readonly key: string
  readonly label: string
  readonly text: string
  readonly intent?: NextPromptIntent
}

const INTENTS: Record<NextPromptIntent, { readonly name: string; readonly icon: LucideIcon }> = {
  continue: { name: 'Continue', icon: ArrowRight },
  verify: { name: 'Verify', icon: Check },
  challenge: { name: 'Challenge', icon: CircleHelp },
  wrap: { name: 'Wrap up', icon: Flag },
}

/** The list's rows in the order they are shown: answers first, then the next prompt, then the four suggestions. */
export function nextRows(prompt: NextPrompt): NextRow[] {
  return [
    ...prompt.answers.map((answer): NextRow => ({ kind: 'answer', key: '↵', label: answer.label, text: answer.text })),
    ...(prompt.ghost ? [{ kind: 'ghost', key: 'Tab', label: prompt.ghost, text: prompt.ghost } satisfies NextRow] : []),
    ...prompt.suggestions.map((item, index): NextRow => ({ kind: 'suggestion', key: String(index + 1), label: item.label, text: item.text, intent: item.intent })),
  ]
}

export const nextOptionId = (listId: string, index: number): string => `${listId}-option-${index}`

/**
 * The Next list (ADR-0131): over the transcript, above the composer, like the skills list, so it never takes height
 * from the composer. Focus stays in the prompt, which moves through the rows; a press or Enter chooses one.
 */
export function NextList({ prompt, listId, activeIndex, sends, onHighlight, onChoose }: {
  readonly prompt: NextPrompt
  readonly listId: string
  readonly activeIndex: number
  /** An answer sends at once only into an empty prompt; otherwise it joins what is written. */
  readonly sends: boolean
  readonly onHighlight: (index: number) => void
  readonly onChoose: (row: NextRow) => void
}): ReactNode {
  const list = useRef<HTMLUListElement>(null)
  const rows = nextRows(prompt)
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(nextOptionId(listId, activeIndex))}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, listId])
  const active = rows[activeIndex]
  return <div className="composer-picker next-list" data-kind="next">
    {prompt.headline ? <p className="next-list__headline" id={`${listId}-headline`}>{prompt.headline}</p> : null}
    <ul ref={list} className="composer-picker__list next-list__rows" role="listbox" id={listId} aria-label="Next prompts"
      aria-describedby={prompt.headline ? `${listId}-headline` : undefined}>
      {rows.map((row, index) => {
        const intent = row.intent ? INTENTS[row.intent] : undefined
        const Icon = intent?.icon
        return <li key={`${row.kind}-${index}`} id={nextOptionId(listId, index)} role="option" aria-selected={index === activeIndex}
          className="composer-picker__option next-list__row" data-kind={row.kind} data-active={index === activeIndex || undefined}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (index !== activeIndex) onHighlight(index) }} onClick={() => onChoose(row)}>
          <span className="next-list__key" aria-hidden="true">{row.key}</span>
          <span className="next-list__label">
            {Icon ? <Icon size={13} aria-hidden="true" /> : null}
            {intent ? <span className="tt-visually-hidden">{intent.name}: </span> : null}
            {row.kind === 'answer' ? <span className="tt-visually-hidden">{sends ? 'Send answer: ' : 'Answer: '}</span> : null}
            {row.label}
          </span>
          {row.kind === 'ghost' ? null : <span className="next-list__text">{row.text}</span>}
        </li>
      })}
    </ul>
    <div className="composer-picker__foot next-list__foot">
      <span className="composer-picker__notes">
        <span>↑ ↓ choose</span>
        <span>{active?.kind === 'answer' && sends ? 'Enter sends this answer' : 'Enter puts it in the prompt'}</span>
        {prompt.suggestions.length > 0 ? <span>{prompt.suggestions.length === 1 ? '1 picks it' : `1–${prompt.suggestions.length} pick`}</span> : null}
        <span>Escape closes</span>
      </span>
    </div>
  </div>
}
